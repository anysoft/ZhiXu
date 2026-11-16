import { createHmac, timingSafeEqual } from 'crypto';
import type {
  WorkspaceRow,
  GitWorkspaceRow,
  OperationRow,
} from '../services/workspaceV2/types';
import { assertWorkspaceJournalIsolation } from '../services/workspaceV2/journals';
import { fail } from '../services/workspaceV2/errors';
import type { V2Services, RouteMap } from './types';
import * as v from './workspaceValidation';
import { resumeWorkspaceOperation } from './workspaceRecovery';

export async function workspaceDto(s: V2Services, row: WorkspaceRow) {
  const git = (
    await s.store.all<GitWorkspaceRow>(
      'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
      [row.id],
    )
  )[0];
  const tasks = (
    await s.store.all<{ count: number }>(
      'SELECT COUNT(*) count FROM TaskSources WHERE workspace_id=?',
      [row.id],
    )
  )[0].count;
  let accessible = false;
  if (
    row.storage_state === 'PRESENT' &&
    ['READY', 'ARCHIVED'].includes(row.lifecycle_state)
  ) {
    try {
      await s.store.assertAccessible(row.id, false);
      await s.roots.requireOwned(row);
      await assertWorkspaceJournalIsolation(s.store, s.roots, row.id);
      accessible = !(await s.leases.probeWorkspace(row.id)).busy;
    } catch {
      /* Capabilities describe currently admissible operations, not just metadata. */
    }
  }
  const writable = accessible && row.lifecycle_state === 'READY';
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    lifecycle_state: row.lifecycle_state,
    storage_state: row.storage_state,
    version: row.version,
    source_generation: row.source_generation,
    content_revision: row.content_revision,
    content_inventory_hash: row.content_inventory_hash,
    default_env_profile_id: row.default_env_profile_id,
    task_count: tasks,
    last_content_update_at: v.utcTimestamp(row.updatedAt),
    ...(git
      ? {
          git: {
            repository_id: git.repository_id,
            ref_type: git.ref_type,
            ref_name: git.ref_name,
            resolved_commit: git.resolved_commit,
            applied_commit: git.applied_commit,
            last_verified_commit: git.last_verified_commit,
            baseline_established: !!git.baseline_established,
            baseline_sync_run_id: git.baseline_sync_run_id,
          },
        }
      : {}),
    capabilities: {
      read_files: accessible,
      write_files: writable,
      create_task: writable,
      run_task: writable,
      git: accessible && row.type === 'GIT',
      sync: writable && row.type === 'GIT',
      discovery: writable && row.type === 'GIT',
    },
  };
}
export function operationDto(row: OperationRow) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    type: row.operation_type,
    status: row.status,
    phase: row.phase,
    started_at: v.utcTimestamp(row.started_at),
    finished_at: v.utcTimestamp(row.finished_at),
    error_code: row.error_code,
  };
}
interface Entry {
  path: string;
  kind: string;
  size?: number;
  identity?: string;
  hash?: string | null;
}
function signIdentity(row: WorkspaceRow, entry: Entry) {
  if (!row.root_owner_token || !entry.identity)
    fail('WORKSPACE_RECOVERY_REQUIRED');
  const payload = Buffer.from(
    JSON.stringify([row.id, row.source_generation, entry.path, entry.identity]),
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', row.root_owner_token)
    .update(payload)
    .digest('base64url')}`;
}
function verifyIdentity(row: WorkspaceRow, relative: string, token: string) {
  const parts = token.split('.');
  if (parts.length !== 2 || !row.root_owner_token || token.length > 4096)
    fail('WORKSPACE_FILE_CONFLICT');
  const expected = createHmac('sha256', row.root_owner_token)
    .update(parts[0])
    .digest();
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    fail('WORKSPACE_FILE_CONFLICT');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    fail('WORKSPACE_FILE_CONFLICT');
  }
  if (
    !Array.isArray(payload) ||
    payload.length !== 4 ||
    payload[0] !== row.id ||
    payload[1] !== row.source_generation ||
    payload[2] !== relative
  )
    fail('WORKSPACE_FILE_CONFLICT');
  return v.hash(payload[3]);
}
function fileEntry(row: WorkspaceRow, entry: Entry) {
  if (!['file', 'directory'].includes(entry.kind))
    fail('WORKSPACE_PATH_FORBIDDEN', 403);
  return {
    path: entry.path,
    kind: entry.kind === 'file' ? 'FILE' : 'DIRECTORY',
    size_bytes: entry.size ?? 0,
    hash: entry.hash ?? null,
    identity_token: signIdentity(row, entry),
  };
}
export function workspaceApiRoutes(s: V2Services): RouteMap {
  const id = (params: Record<string, string>) => v.pathId(params.id);
  const accepted = async (row: WorkspaceRow, operation?: OperationRow) => {
    const op =
      operation ??
      (
        await s.store.all<OperationRow>(
          'SELECT * FROM WorkspaceOperations WHERE workspace_id=? ORDER BY submitted_at DESC,id DESC LIMIT 1',
          [row.id],
        )
      )[0];
    if (!op) fail('WORKSPACE_OPERATION_NOT_FOUND', 404);
    return {
      workspace: await workspaceDto(s, row),
      operation: operationDto(op),
    };
  };
  const mutation = async (action: () => Promise<unknown>) => {
    const snapshot = await s.files.captureMutationReceipt(action);
    return {
      content_revision: snapshot.workspace.content_revision,
      entry: snapshot.entry
        ? fileEntry(snapshot.workspace, snapshot.entry)
        : null,
    };
  };
  const tree = async (workspaceId: number, query: Record<string, unknown>) => {
    v.object(query, ['path', 'offset', 'limit']);
    const offset = v.integer(query.offset ?? 0, 0),
      limit = v.integer(query.limit ?? 200, 1, 1000);
    const snapshot = await s.files.treeSnapshot(
      workspaceId,
      query.path === undefined ? '' : v.text(query.path, 4096, true),
      offset,
      limit,
    );
    return {
      entries: snapshot.result.entries.map((entry) =>
        fileEntry(snapshot.workspace, entry),
      ),
      offset,
      limit,
      total: snapshot.result.total,
    };
  };
  return {
    'GET /workspaces': async ({ query }) => {
      v.object(query, [
        'page',
        'size',
        'type',
        'lifecycle_state',
        'repository_id',
        'include_tombstones',
        'search',
      ]);
      const { page, size } = v.pagination(query),
        clauses: string[] = [],
        values: unknown[] = [];
      if (!v.queryBoolean(query.include_tombstones))
        clauses.push("w.lifecycle_state<>'TOMBSTONED'");
      if (query.type !== undefined) {
        clauses.push('w.type=?');
        values.push(v.choice(query.type, ['LOCAL', 'GIT']));
      }
      if (query.lifecycle_state !== undefined) {
        clauses.push('w.lifecycle_state=?');
        values.push(
          v.choice(query.lifecycle_state, [
            'CREATING',
            'READY',
            'ARCHIVED',
            'DELETE_REQUESTED',
            'TOMBSTONED',
            'ERROR',
            'RECOVERY_REQUIRED',
          ]),
        );
      }
      if (query.repository_id !== undefined) {
        clauses.push(
          'EXISTS(SELECT 1 FROM GitWorkspaces g WHERE g.workspace_id=w.id AND g.repository_id=?)',
        );
        values.push(v.integer(query.repository_id));
      }
      if (query.search !== undefined) {
        clauses.push("w.name LIKE ? ESCAPE '\\'");
        values.push(
          '%' + v.text(query.search, 255).replace(/[\\%_]/g, '\\$&') + '%',
        );
      }
      const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
      const total = (
        await s.store.all<{ count: number }>(
          'SELECT COUNT(*) count FROM Workspaces w' + where,
          values,
        )
      )[0].count;
      const rows = await s.store.all<WorkspaceRow>(
        'SELECT w.* FROM Workspaces w' +
          where +
          ' ORDER BY w.id LIMIT ? OFFSET ?',
        [...values, size, (page - 1) * size],
      );
      return {
        items: await Promise.all(rows.map((row) => workspaceDto(s, row))),
        page,
        size,
        total,
      };
    },
    'GET /workspaces/:id': async ({ params }) =>
      workspaceDto(s, await s.store.workspace(id(params))),
    'POST /workspaces': async ({ body, idempotencyKey }) => {
      const input = v.object(
        body,
        ['type', 'name', 'git', 'sync_policy', 'discovery'],
        ['type', 'name'],
      );
      const name = v.text(input.name, 255),
        requestKey = v.text(idempotencyKey, 200);
      if (input.type === 'LOCAL') {
        if (
          input.git !== undefined ||
          input.sync_policy !== undefined ||
          input.discovery !== undefined
        )
          fail('INVALID_REQUEST', 400);
        return accepted(await s.lifecycle.createLocal({ name, requestKey }));
      }
      v.choice(input.type, ['GIT']);
      const git = v.object(
        input.git,
        ['repository_id', 'ref_type', 'ref_name'],
        ['repository_id', 'ref_type', 'ref_name'],
      );
      // Lifecycle persists and validates optional initialization before publishing READY.
      return accepted(
        await s.lifecycle.createGit({
          name,
          requestKey,
          repositoryId: v.number(git.repository_id),
          refType: v.choice(git.ref_type, ['branch', 'tag', 'commit']),
          refName: v.text(git.ref_name, 1024),
          initialization: {
            sync_policy: input.sync_policy ?? {
              enabled: true,
              mode: 'MANUAL',
              schedule: null,
            },
            discovery: input.discovery ?? {
              enabled: false,
              includes: ['**/*'],
              excludes: [],
              languages: ['PYTHON', 'JAVASCRIPT', 'TYPESCRIPT', 'SHELL'],
            },
          },
        }),
      );
    },
    'PATCH /workspaces/:id': async ({ params, body }) => {
      const workspaceId = id(params),
        input = v.object(
          body,
          ['name', 'expected_version'],
          ['name', 'expected_version'],
        );
      const name = v.text(input.name, 255).trim(),
        version = v.number(input.expected_version);
      if (!name || /[\x00-\x1f\x7f]/.test(name)) fail('INVALID_REQUEST', 400);
      const row = await s.leases.withWorkspace(
        workspaceId,
        'WORKSPACE_RENAME',
        async () =>
          s.store.transaction(async (tx) => {
            await tx.assertAccessible(workspaceId, false);
            if (
              !(
                await tx.run(
                  'UPDATE Workspaces SET name=?,version=version+1,updatedAt=? WHERE id=? AND version=?',
                  [name, new Date().toISOString(), workspaceId, version],
                )
              ).changes
            )
              fail('WORKSPACE_VERSION_CONFLICT');
            return tx.workspace(workspaceId);
          }),
      );
      return workspaceDto(s, row);
    },
    'DELETE /workspaces/:id': async ({ params, body, idempotencyKey }) => {
      const input = v.object(
        body,
        ['expected_version', 'confirm_reclaim', 'preservation_backup_id'],
        ['expected_version', 'confirm_reclaim', 'preservation_backup_id'],
      );
      if (input.confirm_reclaim !== true) fail('INVALID_REQUEST', 400);
      return accepted(
        await s.reclaim.remove(id(params), v.number(input.expected_version), {
          requestKey: v.text(idempotencyKey, 200),
          ...(input.preservation_backup_id === null
            ? {}
            : { snapshotId: v.text(input.preservation_backup_id, 200) }),
        }),
      );
    },
    'POST /workspaces/:id/archive': async ({
      params,
      body,
      idempotencyKey,
    }) => {
      const input = v.object(body, ['expected_version'], ['expected_version']);
      return accepted(
        await s.lifecycle.archive(
          id(params),
          v.number(input.expected_version),
          { requestKey: v.text(idempotencyKey, 200) },
        ),
      );
    },
    'POST /workspaces/:id/unarchive': async ({
      params,
      body,
      idempotencyKey,
    }) => {
      const input = v.object(body, ['expected_version'], ['expected_version']);
      return accepted(
        await s.lifecycle.unarchive(
          id(params),
          v.number(input.expected_version),
          v.text(idempotencyKey, 200),
        ),
      );
    },
    'POST /workspaces/:id/recover': async ({
      params,
      body,
      idempotencyKey,
    }) => {
      const workspaceId = id(params),
        input = v.object(body, ['expected_version'], ['expected_version']);
      const operation = await resumeWorkspaceOperation(
        s,
        workspaceId,
        v.number(input.expected_version),
        v.text(idempotencyKey, 200),
      );
      return accepted(await s.store.workspace(workspaceId), operation);
    },
    'GET /workspaces/:id/references': async ({ params }) => {
      const workspaceId = id(params),
        row = await s.store.workspace(workspaceId),
        refs = await s.lifecycle.references(workspaceId);
      const operations = (
        await s.store.all<{ count: number }>(
          "SELECT COUNT(*) count FROM WorkspaceOperations WHERE workspace_id=? AND status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED')",
          [workspaceId],
        )
      )[0].count;
      const preserved = (
        await s.store.all<{ count: number }>(
          'SELECT COUNT(*) count FROM WorkspacePreservationHolds WHERE workspace_id=? AND released_at IS NULL AND source_generation=? AND content_revision=? AND inventory_hash=?',
          [
            workspaceId,
            row.source_generation,
            row.content_revision,
            row.content_inventory_hash,
          ],
        )
      )[0].count;
      let ownerUnknown = false,
        residualJournal = false;
      if (row.storage_state === 'PRESENT') {
        try {
          await s.roots.requireOwned(row);
        } catch {
          ownerUnknown = true;
        }
        try {
          await assertWorkspaceJournalIsolation(s.store, s.roots, workspaceId);
        } catch {
          residualJournal = true;
        }
      }
      return {
        tasks_count: refs.tasks,
        historical_runs_count: refs.historicalRuns,
        sync_runs_count: refs.historicalSyncs,
        active_operations_count: operations,
        recovery_required:
          row.lifecycle_state === 'RECOVERY_REQUIRED' ||
          ownerUnknown ||
          residualJournal,
        physical_reclaim_blockers: [
          ...(refs.tasks ? [{ kind: 'TASK_SOURCE', count: refs.tasks }] : []),
          ...(refs.activeRuns
            ? [{ kind: 'ACTIVE_RUN', count: refs.activeRuns }]
            : []),
          ...(refs.activeSyncs
            ? [{ kind: 'ACTIVE_SYNC', count: refs.activeSyncs }]
            : []),
          ...(operations ? [{ kind: 'JOURNAL', count: operations }] : []),
          ...(residualJournal ? [{ kind: 'JOURNAL', count: 1 }] : []),
          ...(ownerUnknown ? [{ kind: 'OWNER_UNKNOWN', count: 1 }] : []),
          ...(!preserved && (row.type === 'GIT' || row.file_count > 0)
            ? [{ kind: 'PRESERVATION', count: 1 }]
            : []),
        ],
        metadata_purge_blockers: [
          ...(refs.historicalRuns
            ? [{ kind: 'TASK_RUN_HISTORY', count: refs.historicalRuns }]
            : []),
          ...(refs.historicalSyncs
            ? [{ kind: 'SYNC_HISTORY', count: refs.historicalSyncs }]
            : []),
        ],
      };
    },
    'GET /workspaces/:id/operations/:operationId': async ({ params }) => {
      const op = await s.lifecycle.operation(v.uuid(params.operationId));
      if (op.workspace_id !== id(params))
        fail('WORKSPACE_OPERATION_NOT_FOUND', 404);
      return operationDto(op);
    },
    'GET /workspaces/:id/tree': async ({ params, query }) =>
      tree(id(params), query),
    'GET /workspaces/:id/entries': async ({ params, query }) =>
      (await tree(id(params), query)).entries,
    'GET /workspaces/:id/files': async ({ params, query }) => {
      const input = v.object(query, ['path'], ['path']),
        snapshot = await s.files.readSnapshot(id(params), v.text(input.path));
      const result = snapshot.result;
      if (
        !('content' in result) ||
        typeof result.content !== 'string' ||
        !('hash' in result) ||
        !result.hash
      )
        fail('WORKSPACE_FILE_TOO_LARGE', 413);
      return {
        ...fileEntry(snapshot.workspace, result),
        kind: 'FILE',
        hash: result.hash,
        content: result.content,
        content_revision: snapshot.workspace.content_revision,
        source_generation: snapshot.workspace.source_generation,
      };
    },
    'GET /workspaces/:id/search': async ({ params, query }) => {
      const input = v.object(query, ['query', 'content', 'limit'], ['query']),
        limit = v.integer(input.limit ?? 200, 1, 200);
      const result = await s.files.search(
        id(params),
        v.text(input.query, 256),
        v.queryBoolean(input.content),
      );
      return {
        matches: result.items.slice(0, limit).map((entry) => ({
          path: entry.path,
          ...(entry.line === undefined
            ? {}
            : { line: entry.line, preview: entry.text }),
        })),
        truncated: result.truncated || result.items.length > limit,
        scanned_files: result.scanned,
        scanned_bytes: result.bytes,
      };
    },
    'PUT /workspaces/:id/files': async ({ params, body }) => {
      const input = v.object(
          body,
          ['path', 'content', 'expected_hash'],
          ['path', 'content', 'expected_hash'],
        ),
        workspaceId = id(params),
        relative = v.text(input.path);
      return mutation(() =>
        s.files.save(
          workspaceId,
          relative,
          v.text(input.content, 2 * 1024 * 1024, true),
          v.hash(input.expected_hash),
        ),
      );
    },
    'POST /workspaces/:id/files': async ({ params, body }) => {
      const input = v.object(
          body,
          ['path', 'content', 'must_not_exist'],
          ['path', 'content', 'must_not_exist'],
        ),
        workspaceId = id(params),
        relative = v.text(input.path);
      if (input.must_not_exist !== true) fail('INVALID_REQUEST', 400);
      return mutation(() =>
        s.files.create(
          workspaceId,
          relative,
          v.text(input.content, 2 * 1024 * 1024, true),
        ),
      );
    },
    'DELETE /workspaces/:id/files': async ({ params, body }) => {
      const input = v.object(
          body,
          ['path', 'expected_hash'],
          ['path', 'expected_hash'],
        ),
        workspaceId = id(params),
        relative = v.text(input.path);
      return mutation(() =>
        s.files.remove(workspaceId, relative, v.hash(input.expected_hash)),
      );
    },
    'POST /workspaces/:id/directories': async ({ params, body }) => {
      const input = v.object(
          body,
          ['path', 'must_not_exist'],
          ['path', 'must_not_exist'],
        ),
        workspaceId = id(params),
        relative = v.text(input.path);
      if (input.must_not_exist !== true) fail('INVALID_REQUEST', 400);
      return mutation(() => s.files.createDirectory(workspaceId, relative));
    },
    'POST /workspaces/:id/rename': async ({ params, body }) => {
      const input = v.object(
        body,
        ['path', 'destination', 'kind', 'expected_hash', 'expected_identity'],
        ['path', 'destination', 'kind'],
      );
      const workspaceId = id(params),
        relative = v.text(input.path),
        destination = v.text(input.destination);
      const kind = v.choice(input.kind, ['FILE', 'DIRECTORY']);
      if (
        (kind === 'FILE' && input.expected_identity !== undefined) ||
        (kind === 'DIRECTORY' && input.expected_hash !== undefined)
      )
        fail('INVALID_REQUEST', 400);
      const expected =
        kind === 'FILE'
          ? v.hash(input.expected_hash)
          : verifyIdentity(
              await s.store.workspace(workspaceId),
              relative,
              v.text(input.expected_identity),
            );
      return mutation(() =>
        s.files.rename(workspaceId, relative, destination, expected, kind),
      );
    },
  };
}
