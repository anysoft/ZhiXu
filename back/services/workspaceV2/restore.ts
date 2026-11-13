import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { WorkspaceStore } from './store';
import { WorkspaceRootResolver } from './roots';
import { WorkspaceLeaseService } from './lease';
import { WorkspaceBackupService } from './backup';
import { fail } from './errors';
import type { FaultHook, GitWorkspaceRow, WorkspaceRow } from './types';
import { inspectGitWorkspace } from './gitStorage';
import { acquireBackendLease, BackupPaths, backupId } from '../backup/paths';
import { PlatformBackupBarrier } from '../backup/barrier';
import { backupFailure } from './manifest';
import { RuntimeRestoreReconciler } from '../backup/runtimeRestore';
import { reconcileRepositoryAssets } from './repositoryAssets';
import { copyInventory, inventoryLines } from '../backup/inventory';
import {
  hashFile,
  privateDirectory,
  privateJson,
  readJson,
  sha256,
  syncDirectory,
} from '../backup/files';

type Stage =
  | 'PENDING'
  | 'PREPARING'
  | 'PREPARED'
  | 'OLD_ROOT_MOVED'
  | 'CANDIDATE_PUBLISHED'
  | 'VALIDATING'
  | 'COMPLETE'
  | 'ROLLED_BACK'
  | 'CANCELLED';
interface Identity {
  dev: number;
  ino: number;
}
interface Journal {
  version: 1;
  operation_id: string;
  snapshot_id: string;
  source: 'snapshots' | 'imports';
  manifest_hash: string;
  target: string;
  candidate: string;
  old_root: string;
  failed_root: string;
  stage: Stage;
  candidate_identity: Identity | null;
  old_identity: Identity | null;
}
async function identity(file: string): Promise<Identity | null> {
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail('WORKSPACE_RECOVERY_REQUIRED');
  return { dev: stat.dev, ino: stat.ino };
}
function same(a: Identity | null, b: Identity | null) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}
export async function readWorkspaceRestoreJournal(
  paths: BackupPaths,
): Promise<Journal | null> {
  await paths.initialize();
  const value = (await readJson(
    path.join(paths.control, 'workspace-restore-journal.json'),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })) as { journal?: Journal; checksum?: string } | null;
  if (!value) return null;
  const j = value.journal;
  if (
    !j ||
    j.version !== 1 ||
    value.checksum !== sha256(JSON.stringify(j)) ||
    ![
      'PENDING',
      'PREPARING',
      'PREPARED',
      'OLD_ROOT_MOVED',
      'CANDIDATE_PUBLISHED',
      'VALIDATING',
      'COMPLETE',
      'ROLLED_BACK',
      'CANCELLED',
    ].includes(j.stage) ||
    !['snapshots', 'imports'].includes(j.source)
  )
    fail('WORKSPACE_RECOVERY_REQUIRED');
  backupId(j.operation_id);
  backupId(j.snapshot_id);
  if (
    j.target !== paths.data ||
    j.candidate !== path.join(paths.control, 'candidates', j.operation_id) ||
    j.old_root !== path.join(paths.control, 'quarantine', j.operation_id) ||
    j.failed_root !== path.join(paths.control, 'failed', j.operation_id)
  )
    fail('WORKSPACE_RECOVERY_REQUIRED');
  for (const candidate of [j.candidate_identity, j.old_identity]) {
    if (
      candidate !== null &&
      (!candidate ||
        !Number.isSafeInteger(candidate.dev) ||
        candidate.dev < 0 ||
        !Number.isSafeInteger(candidate.ino) ||
        candidate.ino < 1)
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
  }
  return j;
}

/**
 * Isolated v2 whole-root restore. Composes the production copy/validation and FD
 * primitives and preserves its candidate/old-root journal protocol. It never
 * invokes v9 schema migration or replaces an unknown directory.
 */
export class WorkspaceRestoreService {
  readonly fault: FaultHook;
  constructor(
    readonly backup: WorkspaceBackupService,
    options: { fault?: FaultHook } = {},
  ) {
    this.fault = options.fault || (async () => undefined);
  }
  private get journalFile() {
    return path.join(
      this.backup.paths.control,
      'workspace-restore-journal.json',
    );
  }
  private async write(journal: Journal) {
    await privateJson(this.journalFile, {
      journal,
      checksum: sha256(JSON.stringify(journal)),
    });
  }
  static async recoverAt(
    dataRoot: string,
    backupRoot: string,
    options: { fault?: FaultHook } = {},
  ) {
    try {
      const paths = new BackupPaths(dataRoot, backupRoot);
      const journal = await readWorkspaceRestoreJournal(paths);
      if (!journal) fail('WORKSPACE_RECOVERY_REQUIRED');
      const candidates = [
        {
          root: journal.target,
          identities: [journal.old_identity, journal.candidate_identity],
        },
        { root: journal.old_root, identities: [journal.old_identity] },
        { root: journal.candidate, identities: [journal.candidate_identity] },
      ];
      for (const candidate of candidates) {
        const actual = await identity(candidate.root);
        if (!candidate.identities.some((expected) => same(actual, expected)))
          continue;
        const store = await WorkspaceStore.open(
          path.join(candidate.root, 'db/database.sqlite'),
          candidate.root,
        );
        try {
          const roots = new WorkspaceRootResolver(paths.data);
          const leases = new WorkspaceLeaseService(
            paths.data,
            new PlatformBackupBarrier(paths.control),
          );
          const backup = await WorkspaceBackupService.forRestoreRecovery(
            store,
            roots,
            leases,
            paths.root,
          );
          return await new WorkspaceRestoreService(backup, options).recover();
        } finally {
          await store.close();
        }
      }
      fail('WORKSPACE_RECOVERY_REQUIRED');
    } catch (error) {
      return backupFailure(error);
    }
  }
  async status(): Promise<Journal | null> {
    try {
      return await readWorkspaceRestoreJournal(this.backup.paths);
    } catch (error) {
      return backupFailure(error);
    }
  }

  private async source(journal: Journal) {
    const outer = await this.backup.paths.bucket(
      journal.source,
      journal.snapshot_id,
    );
    await this.backup.paths.assertOwned(outer, journal.snapshot_id);
    const root =
      journal.source === 'imports' ? path.join(outer, 'snapshot') : outer;
    const manifest = await this.backup.validateRoot(root);
    if (
      (await hashFile(path.join(root, 'manifest.json'))).sha256 !==
      journal.manifest_hash
    )
      fail('BACKUP_SOURCE_INCOMPLETE');
    return { root, manifest };
  }

  /** Persist the validated pending journal while the live backend retains its FD.
   * The next exclusive backend owner performs the existing offline root swap. */
  async stage(
    snapshotId: string,
    source: 'snapshots' | 'imports' = 'snapshots',
  ) {
    if (this.backup.store.dataRoot !== this.backup.paths.data)
      fail('WORKSPACE_RECOVERY_REQUIRED');
    await this.backup.withCatalogLock(() =>
      this.backup.barrier.snapshot(
        () => this.backup.idle(),
        async () => {
          const prior = await this.status();
          if (
            prior &&
            !['COMPLETE', 'ROLLED_BACK', 'CANCELLED'].includes(prior.stage)
          )
            fail('RESTORE_PENDING', 503);
          // The constructor's explicit Store already proves a supported candidate DB.
          await this.backup.store.verifySchema();
          await this.backup.domain.collect(this.backup.store);
          const allowed = new Set([
            'db',
            'workspaces',
            'git',
            '.locks',
            'tmp',
            'runtime',
            'config-assets',
            'config',
            'log',
            'syslog',
            'cache',
            'upload',
          ]);
          if (
            (await fs.readdir(this.backup.paths.data)).some(
              (name) => !allowed.has(name),
            )
          )
            fail('WORKSPACE_RECOVERY_REQUIRED');
          const operation = randomUUID();
          const j: Journal = {
            version: 1,
            operation_id: operation,
            snapshot_id: backupId(snapshotId),
            source,
            manifest_hash: '',
            target: this.backup.paths.data,
            candidate: path.join(
              this.backup.paths.control,
              'candidates',
              operation,
            ),
            old_root: path.join(
              this.backup.paths.control,
              'quarantine',
              operation,
            ),
            failed_root: path.join(
              this.backup.paths.control,
              'failed',
              operation,
            ),
            stage: 'PENDING',
            candidate_identity: null,
            old_identity: await identity(this.backup.paths.data),
          };
          const outer = await this.backup.paths.bucket(source, snapshotId);
          await this.backup.paths.assertOwned(outer, snapshotId);
          const snapshot =
            source === 'imports' ? path.join(outer, 'snapshot') : outer;
          const manifest = await this.backup.validateRoot(snapshot);
          j.manifest_hash = (
            await hashFile(path.join(snapshot, 'manifest.json'))
          ).sha256;
          await this.backup.reserve(
            Math.ceil(
              (manifest.total_bytes +
                (
                  await fs.stat(this.backup.store.databasePath)
                ).size) *
                2.2,
            ),
            this.backup.paths.control,
          );
          await this.write(j);
          await privateJson(
            path.join(this.backup.paths.control, 'barrier.json'),
            { version: 1, id: operation, phase: 'RESTORE_PENDING' },
          );
        },
      ),
    );
    return this.status();
  }

  async restore(
    snapshotId: string,
    source: 'snapshots' | 'imports' = 'snapshots',
  ) {
    await this.stage(snapshotId, source);
    await this.backup.store.close();
    return this.recover();
  }

  async cancelPending(operationId: string) {
    return this.backup.withCatalogLock(async () => {
      const journal = await this.status();
      if (
        !journal ||
        journal.operation_id !== backupId(operationId) ||
        journal.stage !== 'PENDING'
      )
        fail('RESTORE_CANCEL_UNAVAILABLE');
      const state = await this.backup.barrier.state();
      if (
        !state ||
        state.phase !== 'RESTORE_PENDING' ||
        state.id !== journal.operation_id ||
        !same(journal.old_identity, await identity(journal.target)) ||
        (await identity(journal.candidate))
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      journal.stage = 'CANCELLED';
      await this.write(journal);
      await this.clearBarrier(journal);
      return { cancelled: true };
    });
  }

  private async reconcile(root: string) {
    await new RuntimeRestoreReconciler().reconcile(root);
    const store = await WorkspaceStore.open(
      path.join(root, 'db/database.sqlite'),
      root,
    );
    try {
      await reconcileRepositoryAssets(store);
      const roots = new WorkspaceRootResolver(root);
      for (const row of await store.all<WorkspaceRow>(
        'SELECT * FROM Workspaces ORDER BY id',
      )) {
        if (row.storage_state !== 'PRESENT') continue;
        const changed = await roots.rebuildOwner(row, roots.path(row));
        await store.run(
          'UPDATE Workspaces SET root_device=?,root_inode=?,root_owner_token=? WHERE id=?',
          [
            changed.identity.dev,
            changed.identity.ino,
            row.root_owner_token,
            row.id,
          ],
        );
        const current = await store.workspace(row.id);
        if (row.type === 'GIT') {
          const git = (
            await store.all<GitWorkspaceRow>(
              'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
              [row.id],
            )
          )[0];
          const verified = await inspectGitWorkspace(
            store,
            root,
            current,
            git,
            {
              repair: true,
            },
          );
          await store.run(
            'UPDATE GitWorkspaces SET last_verified_commit=? WHERE workspace_id=?',
            [verified.head, row.id],
          );
        }
      }
      await this.backup.domain.collect(store);
    } finally {
      await store.close();
    }
  }

  async recover(): Promise<WorkspaceStore> {
    const lifetime = await acquireBackendLease(this.backup.paths);
    try {
      return await this.backup.withCatalogLock(async () => {
        const j = await this.status();
        if (!j) fail('WORKSPACE_RECOVERY_REQUIRED');
        if (j.stage === 'COMPLETE') {
          await this.clearBarrier(j);
          return WorkspaceStore.open(
            path.join(j.target, 'db/database.sqlite'),
            j.target,
          );
        }
        if (j.stage === 'CANCELLED') {
          if (
            !same(j.old_identity, await identity(j.target)) ||
            (await identity(j.candidate))
          )
            fail('WORKSPACE_RECOVERY_REQUIRED');
          await this.clearBarrier(j);
          return WorkspaceStore.open(
            path.join(j.target, 'db/database.sqlite'),
            j.target,
          );
        }
        if (j.stage === 'ROLLED_BACK') fail('WORKSPACE_RECOVERY_REQUIRED');
        const source = await this.source(j);
        await this.backup.materializePreservation(source.root, source.manifest);
        for (const group of ['candidates', 'quarantine', 'failed'])
          await privateDirectory(
            path.join(this.backup.paths.control, group),
            true,
          );
        // A crash may occur after either rollback rename, before its journal fsync.
        if (j.stage === 'VALIDATING') {
          const live = await identity(j.target),
            failed = await identity(j.failed_root),
            old = await identity(j.old_root);
          if (
            !live &&
            same(failed, j.candidate_identity) &&
            same(old, j.old_identity)
          ) {
            await fs.rename(j.old_root, j.target);
            await syncDirectory(path.dirname(j.target));
            j.stage = 'ROLLED_BACK';
            await this.write(j);
            fail('WORKSPACE_RECOVERY_REQUIRED');
          }
          if (
            same(live, j.old_identity) &&
            same(failed, j.candidate_identity) &&
            !old
          ) {
            j.stage = 'ROLLED_BACK';
            await this.write(j);
            fail('WORKSPACE_RECOVERY_REQUIRED');
          }
        }
        if (j.stage === 'PENDING' || j.stage === 'PREPARING') {
          const present = await identity(j.candidate);
          if (present) {
            if (!same(present, j.candidate_identity))
              fail('WORKSPACE_RECOVERY_REQUIRED');
            await fs.rm(j.candidate, { recursive: true });
          }
          await fs.mkdir(j.candidate, { mode: 0o700 });
          j.candidate_identity = await identity(j.candidate);
          j.stage = 'PREPARING';
          await this.write(j);
          const copiedInventory = path.join(
            this.backup.paths.control,
            'candidate-copy-' + j.operation_id + '.ndjson',
          );
          await fs
            .unlink(copiedInventory)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            });
          await copyInventory(
            path.join(source.root, 'data'),
            j.candidate,
            copiedInventory,
            () => false,
            { processed_bytes: 0, processed_files: 0 },
          );
          for await (const entry of inventoryLines(
            path.join(source.root, 'inventory.ndjson'),
          )) {
            if (entry.kind === 'file' || entry.kind === 'directory')
              await fs.chmod(path.join(j.candidate, entry.path), entry.mode);
          }
          await this.fault('restore-after-copy', {
            operation_id: j.operation_id,
          });
          await this.reconcile(j.candidate);
          if (
            !same(j.old_identity, await identity(j.target)) ||
            j.old_identity?.dev !== j.candidate_identity?.dev
          )
            fail('WORKSPACE_RECOVERY_REQUIRED');
          j.stage = 'PREPARED';
          await this.write(j);
          await this.fault('restore-after-candidate-validation', {
            operation_id: j.operation_id,
          });
        }
        if (j.stage === 'PREPARED') {
          const live = await identity(j.target),
            old = await identity(j.old_root);
          if (same(live, j.old_identity) && !old) {
            await fs.rename(j.target, j.old_root);
            await syncDirectory(path.dirname(j.target));
            await syncDirectory(path.dirname(j.old_root));
          } else if (live || !same(old, j.old_identity))
            fail('WORKSPACE_RECOVERY_REQUIRED');
          await this.fault('restore-after-old-rename', {
            operation_id: j.operation_id,
          });
          j.stage = 'OLD_ROOT_MOVED';
          await this.write(j);
        }
        if (j.stage === 'OLD_ROOT_MOVED') {
          const live = await identity(j.target),
            candidate = await identity(j.candidate);
          if (!live && same(candidate, j.candidate_identity)) {
            await fs.rename(j.candidate, j.target);
            await syncDirectory(path.dirname(j.target));
          } else if (candidate || !same(live, j.candidate_identity))
            fail('WORKSPACE_RECOVERY_REQUIRED');
          await this.fault('restore-after-candidate-publish', {
            operation_id: j.operation_id,
          });
          j.stage = 'CANDIDATE_PUBLISHED';
          await this.write(j);
        }
        try {
          if (!same(await identity(j.target), j.candidate_identity))
            fail('WORKSPACE_RECOVERY_REQUIRED');
          j.stage = 'VALIDATING';
          await this.write(j);
          await this.fault('restore-before-final-validation', {
            operation_id: j.operation_id,
          });
          await this.reconcile(j.target);
          await this.fault('restore-after-final-validation', {
            operation_id: j.operation_id,
          });
          await this.fault('restore-before-complete', {
            operation_id: j.operation_id,
          });
          j.stage = 'COMPLETE';
          await this.write(j);
          await this.clearBarrier(j);
          return WorkspaceStore.open(
            path.join(j.target, 'db/database.sqlite'),
            j.target,
          );
        } catch (error) {
          if (
            same(await identity(j.target), j.candidate_identity) &&
            same(await identity(j.old_root), j.old_identity)
          ) {
            await fs.rename(j.target, j.failed_root);
            await syncDirectory(path.dirname(j.target));
            await this.fault('restore-after-failed-rename', {
              operation_id: j.operation_id,
            });
            await fs.rename(j.old_root, j.target);
            await syncDirectory(path.dirname(j.target));
            j.stage = 'ROLLED_BACK';
            await this.write(j);
          }
          throw error;
        }
      });
    } finally {
      await lifetime?.release();
    }
  }
  private async clearBarrier(journal: Journal) {
    const state = await this.backup.barrier.state();
    if (
      state?.phase === 'RESTORE_PENDING' &&
      state.id === journal.operation_id
    ) {
      await fs.unlink(path.join(this.backup.paths.control, 'barrier.json'));
      await syncDirectory(this.backup.paths.control);
    }
  }
}
