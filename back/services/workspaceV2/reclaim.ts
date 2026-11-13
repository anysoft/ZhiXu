import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import {
  privateJson,
  readJson,
  syncDirectory,
  openRegular,
  sha256,
} from '../backup/files';
import { WorkspaceStore } from './store';
import {
  WorkspaceRootResolver,
  renameWorkspaceExclusive,
  OWNER_MARKER,
} from './roots';
import { WorkspaceLeaseService, WorkspaceLease } from './lease';
import { GitWorkspaceStorageAdapter, GitReclaimProof } from './gitStorage';
import {
  WorkspacePreservationService,
  PreservationProof,
} from './preservation';
import { objectJson, requestIdentity, workspaceReferences } from './lifecycle';
import { scanWorkspace } from './inventory';
import { fail, errorCode, positiveId } from './errors';
import type { FaultHook, OperationRow, WorkspaceRow } from './types';

interface ReclaimEntry {
  path: string;
  directory: boolean;
  dev: number;
  ino: number;
  size: number;
  hash: string | null;
}
interface ReclaimJournal {
  version: 1;
  operation_id: string;
  workspace_id: number;
  owner_token: string;
  dev: number;
  ino: number;
  quarantine_key: string;
  entries: ReclaimEntry[];
  git: GitReclaimProof | null;
  phase: 'PREPARED' | 'QUARANTINED' | 'REAPING' | 'REAPED';
}
export interface DeleteWorkspaceOptions {
  requestKey: string;
  snapshotId?: string;
}

async function exists(file: string) {
  return fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

async function hashOwnedFile(file: string) {
  const handle = await openRegular(file, false);
  const hash = createHash('sha256');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function hashStableGitIndex(file: string) {
  try {
    const handle = await openRegular(file, false);
    try {
      const before = await handle.stat();
      if (before.size > 64 * 1024 * 1024)
        fail('WORKSPACE_PRESERVATION_REQUIRED');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      const after = await handle.stat();
      const named = await fs.lstat(file);
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1 ||
        named.dev !== before.dev ||
        named.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        fail('WORKSPACE_PRESERVATION_REQUIRED');
      return hash.digest('hex');
    } finally {
      await handle.close();
    }
  } catch {
    fail('WORKSPACE_PRESERVATION_REQUIRED');
  }
}

/** Snapshot catalog → platform admission → repository → Workspace; never wait in a DB write transaction. */
export class WorkspaceReclaimService {
  readonly git: GitWorkspaceStorageAdapter;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
    readonly preservation: WorkspacePreservationService,
    private readonly options: {
      git?: GitWorkspaceStorageAdapter;
      fault?: FaultHook;
    } = {},
  ) {
    this.git =
      options.git ?? new GitWorkspaceStorageAdapter(store, roots, leases);
  }

  private async operation(id: string) {
    const rows = await this.store.all<OperationRow>(
      'SELECT * FROM WorkspaceOperations WHERE id=?',
      [id],
    );
    if (!rows[0] || rows[0].operation_type !== 'DELETE_RECLAIM')
      fail('WORKSPACE_OPERATION_NOT_FOUND', 404);
    return rows[0];
  }

  private async locked<T>(
    row: WorkspaceRow,
    action: (lease: WorkspaceLease) => Promise<T>,
  ) {
    if (row.type === 'GIT') {
      const git = await this.git.get(row.id);
      return this.leases.withRepository(
        git.repository_id,
        'WORKSPACE_RECLAIM',
        async () =>
          this.leases.withWorkspace(row.id, 'WORKSPACE_RECLAIM', action),
      );
    }
    return this.leases.withWorkspace(row.id, 'WORKSPACE_RECLAIM', action);
  }

  private async assertNoForeignJournals() {
    for (const relative of [
      'tmp/config-materialization',
      'tmp/execution/node-bindings',
      'runtime/python/quarantine',
      'runtime/node/quarantine',
    ]) {
      const location = path.join(this.roots.dataRoot, relative);
      const stat = await exists(location);
      if (!stat) continue;
      await this.roots.directory(relative);
      if ((await fs.readdir(location)).length)
        fail('WORKSPACE_RECOVERY_REQUIRED');
    }
  }

  private async capture(root: string): Promise<ReclaimEntry[]> {
    const entries: ReclaimEntry[] = [];
    const walk = async (relative = ''): Promise<void> => {
      for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
        if (name.includes('/') || name === '.' || name === '..')
          fail('WORKSPACE_RECOVERY_REQUIRED');
        const key = relative ? `${relative}/${name}` : name;
        const file = path.join(root, key);
        const stat = await fs.lstat(file);
        if (
          stat.isSymbolicLink() ||
          (!stat.isFile() && !stat.isDirectory()) ||
          (stat.isFile() && stat.nlink !== 1) ||
          (process.getuid && stat.uid !== process.getuid())
        )
          fail('WORKSPACE_RECOVERY_REQUIRED');
        if (stat.isDirectory()) await walk(key);
        const hash = stat.isFile() ? await hashOwnedFile(file) : null;
        const after = await fs.lstat(file);
        if (
          after.dev !== stat.dev ||
          after.ino !== stat.ino ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs
        )
          fail('WORKSPACE_RECOVERY_REQUIRED');
        entries.push({
          path: key,
          directory: stat.isDirectory(),
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          hash,
        });
      }
    };
    await walk();
    // Keep ownership evidence until every source entry has been durably removed.
    return entries.sort((a, b) =>
      a.path === OWNER_MARKER
        ? 1
        : b.path === OWNER_MARKER
        ? -1
        : b.path.split('/').length - a.path.split('/').length ||
          a.path.localeCompare(b.path),
    );
  }

  private assertNoLiveReferences(
    refs: Awaited<ReturnType<typeof workspaceReferences>>,
  ) {
    if (refs.tasks) fail('WORKSPACE_REFERENCED');
    if (
      refs.activeRuns ||
      refs.activeSyncs ||
      refs.pendingUpdates ||
      refs.pendingEvents
    )
      fail('WORKSPACE_BUSY');
  }

  async requestDelete(
    id: number,
    expectedVersion: number,
    options: DeleteWorkspaceOptions,
  ): Promise<OperationRow> {
    positiveId(id);
    const request = requestIdentity(options.requestKey, {
      id,
      expectedVersion,
      snapshotId: options.snapshotId ?? null,
    });
    try {
      return await this.preservation.withCatalogLock(async () => {
        const previous = await this.store.all<OperationRow>(
          'SELECT * FROM WorkspaceOperations WHERE request_key=?',
          [request.key],
        );
        if (previous[0]) {
          if (
            previous[0].operation_type !== 'DELETE_RECLAIM' ||
            previous[0].request_hash !== request.hash
          )
            fail('IDEMPOTENCY_KEY_CONFLICT');
          return previous[0];
        }
        return this.locked(await this.store.workspace(id), async (lease) => {
          await this.assertNoForeignJournals();
          const row = await this.store.assertAccessible(id, false);
          if (row.version !== expectedVersion)
            fail('WORKSPACE_VERSION_CONFLICT');
          this.assertNoLiveReferences(
            await workspaceReferences(this.store, id),
          );
          const owned = await this.roots.requireOwned(row);
          await lease.assertHeld();
          const inventory = await scanWorkspace(owned.root, row.type);
          if (
            inventory.hash !== row.content_inventory_hash ||
            inventory.fileCount !== row.file_count ||
            inventory.totalBytes !== row.total_bytes
          )
            fail('WORKSPACE_VERSION_CONFLICT');
          let proof: PreservationProof | undefined;
          if (options.snapshotId)
            proof = await this.preservation.verifyPreservation(
              options.snapshotId,
              row,
            );
          if ((row.type === 'GIT' || inventory.entryCount > 0) && !proof)
            fail('WORKSPACE_PRESERVATION_REQUIRED');
          const gitProof =
            row.type === 'GIT' ? await this.git.reclaimProof(row, lease) : null;
          if (proof && gitProof) {
            const preservedSnapshot = await this.preservation.backup.snapshot(
              proof.snapshot_key,
            );
            const preserved = preservedSnapshot.manifest.workspaces.find(
              (item) => item.workspace_id === row.id,
            )?.git;
            if (
              !preserved ||
              !('head' in preserved) ||
              preserved.head !== gitProof.head ||
              preserved.git_admin_key !== gitProof.git_admin_key ||
              preserved.storage_key !== gitProof.storage_key ||
              preserved.porcelain !== gitProof.porcelain ||
              preserved.dirty !== gitProof.dirty ||
              preserved.private_branch !== gitProof.private_branch ||
              preserved.repository_id !== gitProof.repository_id ||
              preserved.resolved_commit !== gitProof.resolved_commit
            )
              fail('WORKSPACE_PRESERVATION_REQUIRED');
            const currentIndex = path.join(
              this.roots.dataRoot,
              gitProof.storage_key,
              'worktrees',
              gitProof.git_admin_key,
              'index',
            );
            const preservedIndex = path.join(
              preservedSnapshot.root,
              'data',
              preserved.storage_key,
              'worktrees',
              preserved.git_admin_key,
              'index',
            );
            if (
              (await hashStableGitIndex(currentIndex)) !==
              (await hashStableGitIndex(preservedIndex))
            )
              fail('WORKSPACE_PRESERVATION_REQUIRED');
          }
          const opId = randomUUID();
          const journal: ReclaimJournal = {
            version: 1,
            operation_id: opId,
            workspace_id: id,
            owner_token: owned.marker.owner_token,
            dev: owned.stat.dev,
            ino: owned.stat.ino,
            quarantine_key: `tmp/workspace-v2/quarantine/${opId}`,
            entries: await this.capture(owned.root),
            git: gitProof,
            phase: 'PREPARED',
          };
          if (
            (await scanWorkspace(owned.root, row.type)).hash !==
            row.content_inventory_hash
          )
            fail('WORKSPACE_VERSION_CONFLICT');
          const journalParent = await this.roots.directory(
            'tmp/workspace-v2/reclaim',
            true,
          );
          await this.roots.directory('tmp/workspace-v2/quarantine', true);
          await privateJson(path.join(journalParent, `${opId}.json`), journal);
          await this.store.transaction(async (tx) => {
            if (proof) await this.preservation.installHold(proof, tx);
            this.assertNoLiveReferences(await workspaceReferences(tx, id));
            await tx.run(
              `INSERT INTO WorkspaceOperations(id,workspace_id,operation_type,status,phase,request_key,request_hash,
              expected_workspace_version,owner_token,journal_key,root_marker,preservation_receipt,submitted_at)
              VALUES(?,?,'DELETE_RECLAIM','RUNNING','DELETE_ACCEPTED',?,?,?,?,?,?,?,?)`,
              [
                opId,
                id,
                request.key,
                request.hash,
                expectedVersion,
                owned.marker.owner_token,
                `tmp/workspace-v2/reclaim/${opId}.json`,
                JSON.stringify({
                  dev: journal.dev,
                  ino: journal.ino,
                  owner_token: journal.owner_token,
                  journal_hash: sha256(JSON.stringify(journal)),
                }),
                proof ? JSON.stringify(proof) : null,
                new Date().toISOString(),
              ],
            );
            await tx.run(
              "UPDATE Workspaces SET lifecycle_state='DELETE_REQUESTED',storage_state='RECLAIMING',version=version+1,deleted_at=?,updatedAt=? WHERE id=?",
              [new Date().toISOString(), new Date().toISOString(), id],
            );
          });
          await this.options.fault?.('DELETE_ADMISSION_CLOSED', {
            workspace_id: id,
            operation_id: opId,
          });
          return this.operation(opId);
        });
      });
    } catch (error: unknown) {
      fail(errorCode(error));
    }
  }

  private async load(op: OperationRow): Promise<ReclaimJournal> {
    if (op.journal_key !== `tmp/workspace-v2/reclaim/${op.id}.json`)
      fail('WORKSPACE_RECOVERY_REQUIRED');
    await this.roots.directory('tmp/workspace-v2/reclaim');
    const value: unknown = await readJson(
      path.join(this.roots.dataRoot, op.journal_key),
    );
    const j = objectJson(value);
    if (
      j.version !== 1 ||
      j.operation_id !== op.id ||
      j.workspace_id !== op.workspace_id ||
      j.owner_token !== op.owner_token ||
      !Number.isSafeInteger(j.dev) ||
      !Number.isSafeInteger(j.ino) ||
      j.quarantine_key !== `tmp/workspace-v2/quarantine/${op.id}` ||
      !Array.isArray(j.entries) ||
      !['PREPARED', 'QUARANTINED', 'REAPING', 'REAPED'].includes(
        String(j.phase),
      )
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const marker = objectJson(op.root_marker);
    if (
      marker.dev !== j.dev ||
      marker.ino !== j.ino ||
      marker.owner_token !== j.owner_token ||
      marker.journal_hash !==
        sha256(JSON.stringify({ ...j, phase: 'PREPARED' }))
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const keys = new Set<string>();
    for (const item of j.entries) {
      const e = objectJson(item);
      if (
        typeof e.path !== 'string' ||
        !e.path ||
        path.isAbsolute(e.path) ||
        /[\\\x00-\x1f\x7f]/.test(e.path) ||
        e.path
          .split('/')
          .some((part) => !part || part === '.' || part === '..') ||
        keys.has(e.path) ||
        typeof e.directory !== 'boolean' ||
        !Number.isSafeInteger(e.dev) ||
        !Number.isSafeInteger(e.ino) ||
        !Number.isSafeInteger(e.size) ||
        !(
          e.hash === null ||
          (typeof e.hash === 'string' && /^[0-9a-f]{64}$/.test(e.hash))
        )
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      keys.add(e.path);
    }
    return j as unknown as ReclaimJournal;
  }

  private async persist(op: OperationRow, journal: ReclaimJournal) {
    await privateJson(path.join(this.roots.dataRoot, op.journal_key), journal);
    await this.store.run(
      "UPDATE WorkspaceOperations SET status='RUNNING',phase=?,error_code=NULL,started_at=COALESCE(started_at,?) WHERE id=?",
      [journal.phase, new Date().toISOString(), op.id],
    );
  }

  private async verifyRemaining(root: string, journal: ReclaimJournal) {
    const expected = new Map(journal.entries.map((e) => [e.path, e]));
    const walk = async (relative = ''): Promise<void> => {
      for (const name of await fs.readdir(path.join(root, relative))) {
        const key = relative ? `${relative}/${name}` : name;
        const entry = expected.get(key);
        if (!entry) fail('WORKSPACE_RECOVERY_REQUIRED');
        const file = path.join(root, key);
        const stat = await fs.lstat(file);
        if (
          stat.dev !== entry.dev ||
          stat.ino !== entry.ino ||
          stat.isSymbolicLink() ||
          stat.isDirectory() !== entry.directory ||
          (!entry.directory &&
            (!stat.isFile() ||
              stat.nlink !== 1 ||
              stat.size !== entry.size ||
              (await hashOwnedFile(file)) !== entry.hash))
        )
          fail('WORKSPACE_RECOVERY_REQUIRED');
        if (entry.directory) await walk(key);
      }
    };
    await walk();
  }

  private async cleanupCompleted(op: OperationRow) {
    const file = path.join(this.roots.dataRoot, op.journal_key);
    const before = await exists(file);
    if (!before) return;
    const journal = await this.load(op);
    const row = await this.store.workspace(op.workspace_id);
    if (
      journal.phase !== 'REAPED' ||
      row.lifecycle_state !== 'TOMBSTONED' ||
      row.storage_state !== 'RECLAIMED' ||
      (await exists(this.roots.path(row))) ||
      (await exists(path.join(this.roots.dataRoot, journal.quarantine_key)))
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const after = await fs.lstat(file);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    await fs.unlink(file);
    await syncDirectory(path.dirname(file));
  }

  async reclaim(operationId: string): Promise<WorkspaceRow> {
    const op = await this.operation(operationId);
    if (op.status === 'SUCCEEDED') {
      await this.cleanupCompleted(op);
      return this.store.workspace(op.workspace_id);
    }
    try {
      return await this.preservation.withCatalogLock(async () =>
        this.locked(
          await this.store.workspace(op.workspace_id),
          async (lease) => {
            await this.assertNoForeignJournals();
            const row = await this.store.workspace(op.workspace_id);
            if (
              !['DELETE_REQUESTED', 'RECOVERY_REQUIRED'].includes(
                row.lifecycle_state,
              ) ||
              row.storage_state !== 'RECLAIMING'
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            this.assertNoLiveReferences(
              await workspaceReferences(this.store, row.id),
            );
            const journal = await this.load(op);
            if (
              row.type === 'GIT' ||
              journal.entries.some((entry) => entry.path !== OWNER_MARKER)
            ) {
              const receipt = objectJson(op.preservation_receipt);
              if (typeof receipt.snapshot_key !== 'string')
                fail('WORKSPACE_PRESERVATION_REQUIRED');
              const proof = await this.preservation.verifyPreservation(
                receipt.snapshot_key,
                row,
              );
              if (proof.manifest_hash !== receipt.manifest_hash)
                fail('WORKSPACE_PRESERVATION_REQUIRED');
              await this.preservation.installHold(proof);
            }
            const canonical = this.roots.path(row);
            const quarantine = path.join(
              this.roots.dataRoot,
              journal.quarantine_key,
            );
            await this.roots.directory('tmp/workspace-v2/quarantine');
            let isolated = await exists(quarantine);
            if (!isolated) {
              if (journal.phase !== 'PREPARED') {
                if (
                  (await exists(canonical)) ||
                  (journal.phase !== 'REAPING' && journal.phase !== 'REAPED')
                )
                  fail('WORKSPACE_RECOVERY_REQUIRED');
              } else {
                const owned = await this.roots.requireOwned(row);
                if (
                  owned.stat.dev !== journal.dev ||
                  owned.stat.ino !== journal.ino ||
                  owned.marker.owner_token !== journal.owner_token
                )
                  fail('WORKSPACE_RECOVERY_REQUIRED');
                await this.verifyRemaining(canonical, journal);
                if (
                  (await scanWorkspace(canonical, row.type)).hash !==
                  row.content_inventory_hash
                )
                  fail('WORKSPACE_VERSION_CONFLICT');
                if (journal.git) {
                  await this.git.detach(row, lease, journal.git);
                  await this.options.fault?.('RECLAIM_GIT_DETACHED', {
                    workspace_id: row.id,
                    operation_id: op.id,
                  });
                }
                await renameWorkspaceExclusive(canonical, quarantine);
                await syncDirectory(path.dirname(canonical));
                await syncDirectory(path.dirname(quarantine));
                isolated = await exists(quarantine);
              }
            } else if (await exists(canonical))
              fail('WORKSPACE_RECOVERY_REQUIRED');
            if (isolated) {
              if (
                !isolated.isDirectory() ||
                isolated.isSymbolicLink() ||
                isolated.dev !== journal.dev ||
                isolated.ino !== journal.ino
              )
                fail('WORKSPACE_RECOVERY_REQUIRED');
              const marker = await exists(path.join(quarantine, OWNER_MARKER));
              if (marker) await this.roots.verifyAt(row, quarantine);
              else if (
                journal.phase !== 'REAPING' ||
                (await fs.readdir(quarantine)).length
              )
                fail('WORKSPACE_RECOVERY_REQUIRED');
              if (journal.phase === 'PREPARED') {
                journal.phase = 'QUARANTINED';
                await this.persist(op, journal);
              }
              await this.options.fault?.('DELETE_AFTER_QUARANTINE', {
                workspace_id: row.id,
                operation_id: op.id,
              });
              await this.verifyRemaining(quarantine, journal);
              if (journal.git) await this.git.detach(row, lease, journal.git);
              journal.phase = 'REAPING';
              await this.persist(op, journal);
              for (const entry of journal.entries) {
                const file = path.join(quarantine, entry.path);
                const stat = await exists(file);
                if (!stat) continue;
                if (
                  stat.dev !== entry.dev ||
                  stat.ino !== entry.ino ||
                  stat.isSymbolicLink() ||
                  stat.isDirectory() !== entry.directory ||
                  (!entry.directory &&
                    (!stat.isFile() ||
                      stat.nlink !== 1 ||
                      stat.size !== entry.size ||
                      (await hashOwnedFile(file)) !== entry.hash))
                )
                  fail('WORKSPACE_RECOVERY_REQUIRED');
                if (entry.directory) await fs.rmdir(file);
                else await fs.unlink(file);
                await syncDirectory(path.dirname(file));
                await this.options.fault?.('RECLAIM_ENTRY_REMOVED', {
                  workspace_id: row.id,
                  operation_id: op.id,
                  path: entry.path,
                });
              }
              const final = await fs.lstat(quarantine);
              if (final.dev !== journal.dev || final.ino !== journal.ino)
                fail('WORKSPACE_RECOVERY_REQUIRED');
              await fs.rmdir(quarantine);
              await syncDirectory(path.dirname(quarantine));
            }
            journal.phase = 'REAPED';
            await this.persist(op, journal);
            await this.options.fault?.('RECLAIM_BEFORE_COMMIT', {
              workspace_id: row.id,
              operation_id: op.id,
            });
            await this.store.transaction(async (tx) => {
              const now = new Date().toISOString();
              if (row.lifecycle_state === 'RECOVERY_REQUIRED') {
                await tx.run(
                  "UPDATE Workspaces SET lifecycle_state='DELETE_REQUESTED' WHERE id=?",
                  [row.id],
                );
              }
              await tx.run(
                "UPDATE Workspaces SET lifecycle_state='TOMBSTONED',storage_state='RECLAIMED',root_device=NULL,root_inode=NULL,reclaimed_at=?,metadata_purge_after=?,last_error_code=NULL,updatedAt=? WHERE id=?",
                [
                  now,
                  new Date(Date.now() + 90 * 86400000).toISOString(),
                  now,
                  row.id,
                ],
              );
              await tx.run(
                "UPDATE WorkspaceOperations SET status='SUCCEEDED',phase='COMPLETE',finished_at=?,error_code=NULL WHERE id=?",
                [now, op.id],
              );
            });
            await this.cleanupCompleted(op);
            return this.store.workspace(row.id);
          },
        ),
      );
    } catch (error: unknown) {
      const code = errorCode(error);
      if (!['WORKSPACE_BUSY', 'PLATFORM_BACKUP_IN_PROGRESS'].includes(code)) {
        await this.store.transaction(async (tx) => {
          await tx.run(
            "UPDATE WorkspaceOperations SET status='RECOVERY_REQUIRED',error_code=? WHERE id=?",
            [code, op.id],
          );
          await tx.run(
            "UPDATE Workspaces SET lifecycle_state='RECOVERY_REQUIRED',last_error_code=? WHERE id=? AND lifecycle_state<>'TOMBSTONED'",
            [code, op.workspace_id],
          );
        });
      }
      fail(code);
    }
  }

  async remove(
    id: number,
    expectedVersion: number,
    options: DeleteWorkspaceOptions,
  ) {
    return this.reclaim(
      (await this.requestDelete(id, expectedVersion, options)).id,
    );
  }
  async recover(id: number) {
    const ops = await this.store.all<OperationRow>(
      "SELECT * FROM WorkspaceOperations WHERE workspace_id=? AND operation_type='DELETE_RECLAIM' AND status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED')",
      [positiveId(id)],
    );
    if (!ops[0]) {
      const completed = await this.store.all<OperationRow>(
        "SELECT * FROM WorkspaceOperations WHERE workspace_id=? AND operation_type='DELETE_RECLAIM' AND status='SUCCEEDED'",
        [id],
      );
      for (const operation of completed) await this.cleanupCompleted(operation);
      return this.store.workspace(id);
    }
    return this.reclaim(ops[0].id);
  }
}
