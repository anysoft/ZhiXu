import fs from 'fs/promises';
import path from 'path';
import { openV2Store, validateV2DataRoot } from '../../applicationV2/bootstrap';
import { WorkspaceBackupService } from '../workspaceV2/backup';
import { WorkspaceRestoreService } from '../workspaceV2/restore';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLeaseService } from '../workspaceV2/lease';
import type { FaultHook } from '../workspaceV2/types';
import { backupFailure, backupSource } from '../workspaceV2/manifest';
import type { BackupMode } from '../workspaceV2/manifest';
import type { WorkspaceGitAccessResolver } from '../gitWorkspaceV2/git';
import { backupId, acquireBackendLease } from './paths';
import { PlatformBackupBarrier } from './barrier';
import { RuntimeRestoreReconciler } from './runtimeRestore';
import { BackupError, hashFile } from './files';

export interface OfflineBackupOptions {
  dataRoot: string;
  backupRoot: string;
  projectRoot?: string;
  fault?: FaultHook;
  /** Trusted restore composition only; never selected by CLI flags or HTTP. */
  lightweightGit?: {
    gitToolsRoot?: string;
    accessResolver?: WorkspaceGitAccessResolver;
  };
}

/** Independent v2 catalog and disaster recovery. Read commands never open DATA SQLite. */
export class OfflineBackupManager {
  readonly backup: WorkspaceBackupService;
  readonly restore: WorkspaceRestoreService;
  constructor(readonly options: OfflineBackupOptions) {
    validateV2DataRoot(options);
    this.backup = WorkspaceBackupService.forOfflineCatalog(
      options.dataRoot,
      options.backupRoot,
    );
    this.restore = new WorkspaceRestoreService(this.backup, {
      fault: options.fault,
      lightweightGit: options.lightweightGit,
    });
  }

  async list() {
    return this.backup.withCatalogLock(async () => {
      const entries = [];
      for (const id of await fs.readdir(
        await this.backup.paths.bucket('snapshots'),
      )) {
        try {
          const { manifest } = await this.backup.snapshot(id);
          entries.push({
            id,
            created_at: manifest.created_at,
            bytes: manifest.total_bytes,
            files: manifest.file_count,
            backup_mode: manifest.backup_mode ?? 'FULL',
            source: backupSource(manifest),
            restore_requires_remote:
              manifest.restore_requires_remote ??
              manifest.backup_mode === 'LIGHTWEIGHT',
            warnings: manifest.warnings ?? [],
            verified: true,
          });
        } catch (error) {
          // A bad entry must not hide the remaining independently valid snapshots.
          let code = 'BACKUP_SOURCE_INCOMPLETE';
          try {
            backupFailure(error);
          } catch (normalized) {
            const value = normalized as { error_code?: string; code?: string };
            code = value.error_code ?? value.code ?? code;
          }
          entries.push({ id, verified: false, error_code: code });
        }
      }
      return entries.sort((a, b) =>
        (b.created_at ?? '').localeCompare(a.created_at ?? ''),
      );
    });
  }

  async info(id: string) {
    return this.backup.withCatalogLock(async () => {
      const snapshot = await this.backup.snapshot(backupId(id));
      return {
        id,
        verified: true,
        backup_mode: snapshot.manifest.backup_mode ?? 'FULL',
        source: backupSource(snapshot.manifest),
        restore_requires_remote:
          snapshot.manifest.restore_requires_remote ??
          snapshot.manifest.backup_mode === 'LIGHTWEIGHT',
        warnings: snapshot.manifest.warnings ?? [],
        manifest: snapshot.manifest,
      };
    });
  }

  async verify(id: string) {
    return this.backup.withCatalogLock(async () => {
      const snapshot = await this.backup.snapshot(backupId(id));
      return {
        id,
        verified: true,
        backup_mode: snapshot.manifest.backup_mode ?? 'FULL',
        source: backupSource(snapshot.manifest),
        restore_requires_remote:
          snapshot.manifest.restore_requires_remote ??
          snapshot.manifest.backup_mode === 'LIGHTWEIGHT',
        warnings: snapshot.manifest.warnings ?? [],
        manifest_sha256: (
          await hashFile(path.join(snapshot.root, 'manifest.json'))
        ).sha256,
        bytes: snapshot.manifest.total_bytes,
        files: snapshot.manifest.file_count,
        schema_identity: snapshot.manifest.schema_identity,
      };
    });
  }

  async create(mode: BackupMode = 'FULL') {
    if (!['FULL', 'LIGHTWEIGHT'].includes(mode))
      throw new BackupError('BACKUP_MODE_INVALID');
    const owner = await acquireBackendLease(this.backup.paths);
    try {
      await this.backup.barrier.recoverAbandonedSnapshot();
      const store = await openV2Store({ ...this.options, initialize: false });
      try {
        const roots = new WorkspaceRootResolver(this.options.dataRoot);
        const leases = new WorkspaceLeaseService(
          this.options.dataRoot,
          new PlatformBackupBarrier(this.backup.paths.control),
        );
        const backup = new WorkspaceBackupService(
          store,
          roots,
          leases,
          this.options.backupRoot,
          { fault: this.options.fault },
        );
        return { id: await backup.create(600000, mode), backup_mode: mode };
      } finally {
        await store.close();
      }
    } finally {
      await owner?.release();
    }
  }

  private async completed(
    store: Awaited<ReturnType<WorkspaceRestoreService['recover']>>,
  ) {
    try {
      const journal = await this.restore.status();
      return {
        stage: journal?.stage,
        operation_id: journal?.operation_id,
        snapshot_id: journal?.snapshot_id,
        old_root: journal?.old_root,
        rebuild_plan: await new RuntimeRestoreReconciler().plan(store.dataRoot),
        next_action: 'START_ZHIXU_AND_REBUILD_MISSING_RUNTIMES',
      };
    } finally {
      await store.close();
    }
  }

  async restoreSnapshot(id: string) {
    return this.completed(await this.restore.restoreOffline(backupId(id)));
  }

  async restoreFile(file: string, passphrase: Buffer) {
    // Decryption is the existing Portable format. No target DB is needed or touched.
    const imported = await this.backup.importPortable(file, passphrase);
    return this.completed(
      await this.restore.restoreOffline(imported.id, 'imports'),
    );
  }

  async resume() {
    return this.completed(await this.restore.recover());
  }

  async status() {
    await this.backup.paths.initialize();
    const journal = await this.restore.status();
    const barrier = await this.backup.barrier.state();
    let backend_active = false;
    try {
      const owner = await acquireBackendLease(this.backup.paths);
      await owner?.release();
    } catch (error) {
      if (
        error instanceof BackupError &&
        error.code === 'RESTORE_BACKEND_ACTIVE'
      )
        backend_active = true;
      else throw error;
    }
    return {
      backend_active,
      journal,
      barrier,
      next_action: backend_active
        ? 'STOP_ZHIXU_BEFORE_RESTORE'
        : journal &&
          !['COMPLETE', 'ROLLED_BACK', 'CANCELLED'].includes(journal.stage)
        ? 'RESTORE_RESUME'
        : journal?.stage === 'ROLLED_BACK'
        ? 'REVIEW_PRESERVED_ROOT_AND_SELECT_VALID_BACKUP'
        : journal?.stage === 'COMPLETE'
        ? 'START_ZHIXU_AND_REBUILD_MISSING_RUNTIMES'
        : 'SELECT_VERIFY_AND_RESTORE_BACKUP',
    };
  }
}
