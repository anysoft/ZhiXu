import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { fail, errorCode, positiveId } from './errors';
import { WorkspaceStore } from './store';
import { WorkspaceRootResolver } from './roots';
import { WorkspaceLeaseService, WorkspaceLease } from './lease';
import {
  GitWorkspaceInput,
  GitWorkspaceStorageAdapter,
  validateWorkspaceRef,
} from './gitStorage';
import { scanWorkspace, WorkspaceLimits } from './inventory';
import type { FaultHook, OperationRow, WorkspaceRow } from './types';

export interface CreateWorkspaceInput {
  name: string;
  requestKey: string;
}
export interface WorkspaceReferenceCounts {
  tasks: number;
  activeRuns: number;
  activeSyncs: number;
  pendingUpdates: number;
  pendingEvents: number;
  historicalRuns: number;
  historicalSyncs: number;
}

export function requestIdentity(key: string, body: object) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key))
    fail('IDEMPOTENCY_KEY_INVALID', 400);
  return {
    key,
    hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
}
export function objectJson(value: unknown): Record<string, unknown> {
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      fail('WORKSPACE_RECOVERY_REQUIRED');
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    fail('WORKSPACE_RECOVERY_REQUIRED');
  return candidate as Record<string, unknown>;
}

/** Live references and historical identity references are deliberately separate. */
export async function workspaceReferences(
  store: WorkspaceStore,
  id: number,
): Promise<WorkspaceReferenceCounts> {
  positiveId(id);
  const count = async (sql: string) =>
    (await store.all<{ count: number }>(sql, [id]))[0].count;
  return {
    tasks: await count(
      'SELECT COUNT(*) count FROM TaskSources WHERE workspace_id=?',
    ),
    activeRuns: await count(
      "SELECT COUNT(*) count FROM TaskRuns WHERE workspace_id=? AND (active_workspace_id IS NOT NULL OR status IN ('QUEUED','RESOLVING','RUNNING','RECOVERY_REQUIRED'))",
    ),
    activeSyncs: await count(
      "SELECT COUNT(*) count FROM WorkspaceSyncRuns WHERE workspace_id=? AND status IN ('QUEUED','RUNNING','RECOVERY_REQUIRED')",
    ),
    pendingUpdates: await count(
      "SELECT COUNT(*) count FROM WorkspaceUpdateOutbox WHERE workspace_id=? AND status IN ('PENDING','PROCESSING','RETRY')",
    ),
    pendingEvents: await count(
      "SELECT COUNT(*) count FROM TriggerEvents WHERE workspace_id=? AND status IN ('RECEIVED','PROCESSING')",
    ),
    historicalRuns: await count(
      'SELECT COUNT(*) count FROM TaskRuns WHERE workspace_id=?',
    ),
    historicalSyncs: await count(
      'SELECT COUNT(*) count FROM WorkspaceSyncRuns WHERE workspace_id=?',
    ),
  };
}

export async function assertNoResidualMaterialization(
  roots: WorkspaceRootResolver,
) {
  try {
    for (const relative of [
      'tmp/config-materialization',
      'tmp/execution/node-bindings',
    ]) {
      const location = path.join(roots.dataRoot, relative);
      const stat = await fs
        .lstat(location)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
      if (!stat) continue;
      await roots.directory(relative);
      if ((await fs.readdir(location)).length)
        fail('WORKSPACE_RECOVERY_REQUIRED');
    }
  } catch (error: unknown) {
    fail(errorCode(error));
  }
}

export class WorkspaceLifecycleService {
  readonly git: GitWorkspaceStorageAdapter;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
    private readonly options: {
      git?: GitWorkspaceStorageAdapter;
      fault?: FaultHook;
      limits?: Partial<WorkspaceLimits>;
    } = {},
  ) {
    this.git =
      options.git ?? new GitWorkspaceStorageAdapter(store, roots, leases);
  }

  async operation(id: string) {
    const rows = await this.store.all<OperationRow>(
      'SELECT * FROM WorkspaceOperations WHERE id=?',
      [id],
    );
    if (!rows[0]) fail('WORKSPACE_OPERATION_NOT_FOUND', 404);
    return rows[0];
  }

  private async checkpoint(
    operation: OperationRow,
    phase: string,
    rootMarker?: object,
  ) {
    await this.store.run(
      "UPDATE WorkspaceOperations SET status='RUNNING',phase=?,root_marker=COALESCE(?,root_marker),started_at=COALESCE(started_at,?) WHERE id=?",
      [
        phase,
        rootMarker ? JSON.stringify(rootMarker) : null,
        new Date().toISOString(),
        operation.id,
      ],
    );
    await this.options.fault?.(phase, {
      workspace_id: operation.workspace_id,
      operation_id: operation.id,
    });
  }

  private async beginCreate(
    input: CreateWorkspaceInput,
    git?: GitWorkspaceInput,
  ) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name))
      fail('INVALID_REQUEST', 400);
    if (git) validateWorkspaceRef(git.refType, git.refName);
    const type = git ? 'GIT' : 'LOCAL';
    const request = requestIdentity(input.requestKey, {
      type,
      name,
      git: git ?? null,
    });
    return this.store.transaction(async (tx) => {
      const previous = await tx.all<OperationRow>(
        'SELECT * FROM WorkspaceOperations WHERE request_key=?',
        [request.key],
      );
      if (previous[0]) {
        if (
          previous[0].operation_type !== 'CREATE' ||
          previous[0].request_hash !== request.hash
        )
          fail('IDEMPOTENCY_KEY_CONFLICT');
        return previous[0];
      }
      const id = (
        await tx.run('INSERT INTO Workspaces(name,type) VALUES(?,?)', [
          name,
          type,
        ])
      ).lastID;
      const operationId = randomUUID();
      const token = randomUUID();
      await tx.run(
        `INSERT INTO WorkspaceOperations(id,workspace_id,operation_type,status,phase,request_key,request_hash,
        expected_workspace_version,owner_token,journal_key,root_marker,submitted_at)
        VALUES(?,?,'CREATE','PENDING','CREATE_DB',?,?,1,?,?,?,?)`,
        [
          operationId,
          id,
          request.key,
          request.hash,
          token,
          `workspace-v2/${operationId}.json`,
          JSON.stringify({ owner_token: token, git: git ?? null }),
          new Date().toISOString(),
        ],
      );
      return this.operation(operationId);
    });
  }

  async createLocal(input: CreateWorkspaceInput): Promise<WorkspaceRow> {
    const op = await this.beginCreate(input);
    await this.options.fault?.('CREATE_AFTER_DB', {
      workspace_id: op.workspace_id,
      operation_id: op.id,
    });
    return this.completeCreate(op);
  }

  async createGit(
    input: CreateWorkspaceInput & GitWorkspaceInput,
  ): Promise<WorkspaceRow> {
    const git: GitWorkspaceInput = {
      repositoryId: positiveId(input.repositoryId),
      refType: input.refType,
      refName: input.refName,
    };
    const op = await this.beginCreate(input, git);
    await this.options.fault?.('CREATE_AFTER_DB', {
      workspace_id: op.workspace_id,
      operation_id: op.id,
    });
    return this.completeCreate(op);
  }

  private async completeCreate(op: OperationRow): Promise<WorkspaceRow> {
    let row = await this.store.workspace(op.workspace_id);
    if (op.status === 'SUCCEEDED') return row;
    if (
      op.operation_type !== 'CREATE' ||
      !['CREATING', 'ERROR', 'RECOVERY_REQUIRED'].includes(row.lifecycle_state)
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const payload = objectJson(op.root_marker);
    if (typeof payload.owner_token !== 'string' || !payload.owner_token)
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const ownerToken = payload.owner_token;
    let gitInput: GitWorkspaceInput | undefined;
    if (row.type === 'GIT') {
      const source = objectJson(payload.git);
      if (
        typeof source.repositoryId !== 'number' ||
        !['branch', 'tag', 'commit'].includes(String(source.refType)) ||
        typeof source.refName !== 'string'
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      gitInput = {
        repositoryId: positiveId(source.repositoryId),
        refType: source.refType as GitWorkspaceInput['refType'],
        refName: source.refName,
      };
    }
    const create = async (lease: WorkspaceLease) => {
      row = await this.store.workspace(row.id);
      if (row.lifecycle_state !== 'CREATING') {
        if (row.storage_state !== 'PROVISIONING')
          fail('WORKSPACE_RECOVERY_REQUIRED');
        await this.store.run(
          "UPDATE Workspaces SET lifecycle_state='CREATING',last_error_code=NULL WHERE id=?",
          [row.id],
        );
        row = await this.store.workspace(row.id);
      }
      await this.checkpoint(op, 'CREATE_ROOT');
      const gitRow = gitInput
        ? await this.git.prepare(row, gitInput, lease)
        : undefined;
      const populate = gitRow
        ? async (staging: string) =>
            this.git.populate(row, gitRow, staging, lease)
        : undefined;
      const owned = await this.roots.createOwned(
        row,
        ownerToken,
        op.id,
        populate,
        populate,
      );
      await this.checkpoint(op, 'CREATE_ROOT_PUBLISHED', {
        ...payload,
        dev: owned.stat.dev,
        ino: owned.stat.ino,
      });
      if (gitRow) {
        const summary = await this.git.verify(row, lease, true);
        if (summary.head !== gitRow.resolved_commit || summary.dirty)
          fail('WORKSPACE_RECOVERY_REQUIRED');
        await this.store.run(
          `UPDATE GitWorkspaces SET last_verified_commit=?,applied_commit=?,dirty_state='CLEAN',status_snapshot=?,last_update_at=? WHERE workspace_id=?`,
          [
            summary.head,
            summary.head,
            JSON.stringify(summary),
            new Date().toISOString(),
            row.id,
          ],
        );
      }
      const inventory = await scanWorkspace(
        owned.root,
        row.type,
        this.options.limits,
      );
      await this.options.fault?.('CREATE_BEFORE_READY', {
        workspace_id: row.id,
        operation_id: op.id,
      });
      await this.store.transaction(async (tx) => {
        await tx.run(
          `UPDATE Workspaces SET lifecycle_state='READY',storage_state='PRESENT',root_device=?,root_inode=?,root_owner_token=?,
          content_inventory_hash=?,file_count=?,total_bytes=?,last_error_code=NULL,updatedAt=? WHERE id=?`,
          [
            owned.stat.dev,
            owned.stat.ino,
            ownerToken,
            inventory.hash,
            inventory.fileCount,
            inventory.totalBytes,
            new Date().toISOString(),
            row.id,
          ],
        );
        await tx.run(
          "UPDATE WorkspaceOperations SET status='SUCCEEDED',phase='COMPLETE',finished_at=?,error_code=NULL WHERE id=?",
          [new Date().toISOString(), op.id],
        );
      });
      return this.store.workspace(row.id);
    };
    try {
      if (gitInput)
        return await this.leases.withRepository(
          gitInput.repositoryId,
          'WORKSPACE_CREATE',
          async () =>
            this.leases.withWorkspace(row.id, 'WORKSPACE_CREATE', create),
        );
      return await this.leases.withWorkspace(
        row.id,
        'WORKSPACE_CREATE',
        create,
      );
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code !== 'WORKSPACE_BUSY' && code !== 'PLATFORM_BACKUP_IN_PROGRESS') {
        await this.store.transaction(async (tx) => {
          await tx.run(
            "UPDATE Workspaces SET lifecycle_state='RECOVERY_REQUIRED',last_error_code=? WHERE id=? AND lifecycle_state<>'READY'",
            [code, row.id],
          );
          await tx.run(
            "UPDATE WorkspaceOperations SET status='RECOVERY_REQUIRED',error_code=? WHERE id=? AND status<>'SUCCEEDED'",
            [code, op.id],
          );
        });
      }
      fail(code);
    }
  }

  async recover(id: number): Promise<WorkspaceRow> {
    const operations = await this.store.all<OperationRow>(
      "SELECT * FROM WorkspaceOperations WHERE workspace_id=? AND status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED') ORDER BY submitted_at,id",
      [positiveId(id)],
    );
    if (!operations[0]) return this.store.workspace(id);
    if (operations[0].operation_type === 'CREATE')
      return this.completeCreate(operations[0]);
    if (
      operations[0].operation_type === 'ARCHIVE' ||
      operations[0].operation_type === 'UNARCHIVE'
    )
      return this.finishArchive(operations[0], 300000);
    fail('WORKSPACE_RECOVERY_REQUIRED');
  }

  async references(id: number) {
    return workspaceReferences(this.store, id);
  }

  private async beginArchive(
    id: number,
    expectedVersion: number,
    requestKey: string,
    unarchive: boolean,
    drainTimeoutMs = 300000,
    drainDeadline = Date.now() + drainTimeoutMs,
  ) {
    if (
      !Number.isSafeInteger(drainTimeoutMs) ||
      drainTimeoutMs < 1 ||
      drainTimeoutMs > 300000
    )
      fail('INVALID_REQUEST', 400);
    await assertNoResidualMaterialization(this.roots);
    const request = requestIdentity(requestKey, {
      id,
      expectedVersion,
      unarchive,
      drainTimeoutMs,
    });
    return this.store.transaction(async (tx) => {
      const previous = await tx.all<OperationRow>(
        'SELECT * FROM WorkspaceOperations WHERE request_key=?',
        [request.key],
      );
      if (previous[0]) {
        if (previous[0].request_hash !== request.hash)
          fail('IDEMPOTENCY_KEY_CONFLICT');
        return previous[0];
      }
      const row = await tx.workspace(id);
      if (row.version !== expectedVersion) fail('WORKSPACE_VERSION_CONFLICT');
      if (
        row.lifecycle_state !== (unarchive ? 'ARCHIVED' : 'READY') ||
        row.storage_state !== 'PRESENT'
      )
        fail('WORKSPACE_NOT_READY');
      await tx.assertAccessible(id, !unarchive);
      const opId = randomUUID();
      await tx.run(
        `INSERT INTO WorkspaceOperations(id,workspace_id,operation_type,status,phase,request_key,request_hash,expected_workspace_version,
        owner_token,journal_key,root_marker,submitted_at) VALUES(?,?,?,'DRAINING','DRAIN',?,?,?,?,?,?,?)`,
        [
          opId,
          id,
          unarchive ? 'UNARCHIVE' : 'ARCHIVE',
          request.key,
          request.hash,
          expectedVersion,
          randomUUID(),
          `workspace-v2/${opId}.json`,
          JSON.stringify({
            previous_lifecycle: row.lifecycle_state,
            drain_deadline_at: new Date(drainDeadline).toISOString(),
          }),
          new Date().toISOString(),
        ],
      );
      return this.operation(opId);
    });
  }

  async archive(
    id: number,
    expectedVersion: number,
    options: { requestKey?: string; drainTimeoutMs?: number } = {},
  ) {
    positiveId(id);
    const timeoutMs = options.drainTimeoutMs ?? 300000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
      fail('INVALID_REQUEST', 400);
    const deadline = Date.now() + timeoutMs;
    const requestKey = options.requestKey ?? randomUUID();
    let op: OperationRow;
    // The frozen schema permits one active operation per Workspace. Wait for a
    // normal file mutation before installing the archive gate; never replace its
    // journal or create a second admission flag. The original deadline is fixed.
    while (true) {
      try {
        op = await this.beginArchive(
          id,
          expectedVersion,
          requestKey,
          false,
          timeoutMs,
          deadline,
        );
        break;
      } catch (error: unknown) {
        const code = errorCode(error);
        const normalMutation =
          code === 'WORKSPACE_BUSY' &&
          Date.now() < deadline &&
          (
            await this.store.all(
              "SELECT id FROM WorkspaceOperations WHERE workspace_id=? AND operation_type='FILE_MUTATION' AND status IN ('PENDING','RUNNING') LIMIT 1",
              [id],
            )
          ).length > 0;
        if (!normalMutation) fail(code);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(1, Math.min(25, deadline - Date.now()))),
        );
      }
    }
    await this.options.fault?.('ARCHIVE_ADMISSION_CLOSED', {
      workspace_id: id,
      operation_id: op.id,
    });
    return this.finishArchive(op, options.drainTimeoutMs ?? 300000);
  }

  async unarchive(
    id: number,
    expectedVersion: number,
    requestKey = randomUUID(),
  ) {
    return this.finishArchive(
      await this.beginArchive(
        positiveId(id),
        expectedVersion,
        requestKey,
        true,
      ),
      300000,
    );
  }

  private async withArchiveLease<T>(
    op: OperationRow,
    action: (lease: WorkspaceLease) => Promise<T>,
  ) {
    const row = await this.store.workspace(op.workspace_id);
    const execute = () =>
      this.leases.withWorkspace(row.id, op.operation_type, action);
    if (row.type === 'GIT')
      return this.leases.withRepository(
        (await this.git.get(row.id)).repository_id,
        op.operation_type,
        execute,
      );
    return execute();
  }

  private async finishArchive(
    op: OperationRow,
    timeoutMs: number,
  ): Promise<WorkspaceRow> {
    if (op.status === 'SUCCEEDED') return this.store.workspace(op.workspace_id);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
      fail('INVALID_REQUEST', 400);
    const persistedDeadline = objectJson(op.root_marker).drain_deadline_at;
    if (
      typeof persistedDeadline !== 'string' ||
      !Number.isFinite(Date.parse(persistedDeadline))
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const deadline = Math.min(
      Date.now() + timeoutMs,
      Date.parse(persistedDeadline),
    );
    while (true) {
      try {
        if (Date.now() > deadline) fail('WORKSPACE_BUSY');
        return await this.withArchiveLease(op, async (lease) => {
          await assertNoResidualMaterialization(this.roots);
          const row = await this.store.workspace(op.workspace_id);
          await this.roots.requireReady(
            row,
            lease,
            op.operation_type === 'UNARCHIVE',
          );
          if (op.operation_type === 'UNARCHIVE' && row.type === 'GIT')
            await this.git.verify(row, lease);
          const inventory = await scanWorkspace(
            this.roots.path(row),
            row.type,
            this.options.limits,
          );
          if (inventory.hash !== row.content_inventory_hash)
            fail('WORKSPACE_VERSION_CONFLICT');
          await this.store.assertAccessible(
            row.id,
            op.operation_type !== 'UNARCHIVE',
            op.id,
          );
          const busy = await this.store.all<{ count: number }>(
            `SELECT
            (SELECT COUNT(*) FROM TaskRuns WHERE workspace_id=? AND (active_workspace_id IS NOT NULL OR status IN ('RESOLVING','RUNNING','RECOVERY_REQUIRED'))) +
            (SELECT COUNT(*) FROM WorkspaceSyncRuns WHERE workspace_id=? AND status IN ('RUNNING','RECOVERY_REQUIRED')) count`,
            [row.id, row.id],
          );
          if (busy[0].count) fail('WORKSPACE_BUSY');
          await this.options.fault?.('ARCHIVE_BEFORE_COMMIT', {
            workspace_id: row.id,
            operation_id: op.id,
          });
          await this.store.transaction(async (tx) => {
            const now = new Date().toISOString();
            if (op.operation_type === 'ARCHIVE') {
              await tx.run(
                "UPDATE TaskRuns SET status='CANCELLED',error_code='WORKSPACE_ARCHIVED',finished_at=?,cancel_requested=1 WHERE workspace_id=? AND status='QUEUED'",
                [now, row.id],
              );
              await tx.run(
                "UPDATE WorkspaceSyncRuns SET status='CANCELLED',error_code='WORKSPACE_ARCHIVED',finished_at=? WHERE workspace_id=? AND status='QUEUED'",
                [now, row.id],
              );
              await tx.run(
                'UPDATE Tasks SET enabled=0,version=version+1 WHERE workspace_id=?',
                [row.id],
              );
              await tx.run(
                'UPDATE WorkspaceSyncPolicies SET enabled=0,version=version+1 WHERE workspace_id=?',
                [row.id],
              );
            }
            await tx.run(
              'UPDATE Workspaces SET lifecycle_state=?,version=version+1,updatedAt=? WHERE id=?',
              [
                op.operation_type === 'ARCHIVE' ? 'ARCHIVED' : 'READY',
                now,
                row.id,
              ],
            );
            await tx.run(
              "UPDATE WorkspaceOperations SET status='SUCCEEDED',phase='COMPLETE',finished_at=?,error_code=NULL WHERE id=?",
              [now, op.id],
            );
          });
          return this.store.workspace(row.id);
        });
      } catch (error: unknown) {
        const code = errorCode(error);
        if (code === 'WORKSPACE_BUSY' && Date.now() < deadline) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(25, deadline - Date.now())),
          );
          continue;
        }
        await this.store.run(
          "UPDATE WorkspaceOperations SET status=?,phase='DRAIN_FAILED',error_code=?,finished_at=? WHERE id=?",
          [
            code === 'WORKSPACE_RECOVERY_REQUIRED'
              ? 'RECOVERY_REQUIRED'
              : 'FAILED',
            code,
            new Date().toISOString(),
            op.id,
          ],
        );
        if (code === 'WORKSPACE_RECOVERY_REQUIRED')
          await this.store.run(
            "UPDATE Workspaces SET lifecycle_state='RECOVERY_REQUIRED',last_error_code=? WHERE id=?",
            [code, op.workspace_id],
          );
        fail(code);
      }
    }
  }
}
