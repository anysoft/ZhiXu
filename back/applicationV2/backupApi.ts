import type { Express, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { BackupOperations } from '../services/backup/operations';
import { backupId } from '../services/backup/paths';
import { BackupError, openRegular } from '../services/backup/files';
import { RuntimeRestoreReconciler } from '../services/backup/runtimeRestore';
import { WorkspacePreservationService } from '../services/workspaceV2/preservation';
import { fail } from '../services/workspaceV2/errors';
import type { WorkspaceBackupManifest } from '../services/workspaceV2/manifest';
import type { V2Services } from './types';
import * as v from './workspaceValidation';
import type { V2HttpLifetime } from './httpLifetime';

export interface BackupApiHooks {
  pauseProducers(): Promise<void>;
  requestRestart(): void;
  resumeProducers?(): void;
  rebuildRuntime?(): Promise<unknown>;
}
type Action = (req: Request, res: Response) => Promise<unknown>;
function phrase(body: Record<string, unknown>) {
  const input = body.passphrase;
  delete body.passphrase;
  if (
    typeof input !== 'string' ||
    !input.length ||
    Buffer.byteLength(input) > 4096
  )
    fail('BACKUP_PASSPHRASE_INVALID', 400);
  return Buffer.from(input, 'utf8');
}
function publicManifest(manifest: WorkspaceBackupManifest, held = false) {
  const mode = manifest.backup_mode ?? 'FULL';
  return {
    id: manifest.backup_id,
    created_at: v.utcTimestamp(manifest.created_at),
    status: 'READY',
    application_version: null,
    schema: {
      identity: manifest.schema_identity,
      signature: manifest.schema_signature,
    },
    mode: 'FULL_PORTABLE',
    backup_mode: mode,
    restore_requires_remote:
      manifest.restore_requires_remote ?? mode === 'LIGHTWEIGHT',
    size: manifest.total_bytes,
    file_count: manifest.file_count,
    source_os: null,
    source_arch: null,
    components: [
      'database',
      'workspaces',
      'git',
      'config-assets',
      'config',
      'log',
      'other-user-data',
    ],
    excluded: ['runtime', 'locks', 'runtime-cache', 'execution-temporaries'],
    counts: {
      workspaces: manifest.workspaces.length,
      tasks: manifest.workspaces.reduce(
        (sum, entry) => sum + entry.source_references.length,
        0,
      ),
    },
    validation: {
      status: 'PASS',
      warnings: manifest.warnings ?? [],
      historical_missing_log: 0,
    },
    held,
    workspaces: manifest.workspaces.map((entry) => ({
      workspace_id: entry.workspace_id,
      type: entry.workspace_type,
      lifecycle_state: entry.lifecycle_state,
      storage_state: entry.storage_state,
      source_generation: entry.source_generation,
      content_revision: entry.content_revision,
      content_inventory_hash: entry.content_inventory_hash,
      file_count: entry.file_count,
      total_bytes: entry.total_bytes,
    })),
    preserved_snapshots: manifest.preserved_snapshots.map((entry) => ({
      backup_id: entry.backup_id,
      manifest_sha256: entry.manifest_sha256,
    })),
  };
}
async function catalogBytes(root: string) {
  let bytes = 0,
    entries = 0;
  const walk = async (location: string, depth: number): Promise<void> => {
    if (depth > 128 || ++entries > 1000000) fail('BACKUP_QUOTA_EXCEEDED', 413);
    const stat = await fs.lstat(location);
    if (
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      fail('BACKUP_RECOVERY_REQUIRED');
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(location))
        await walk(path.join(location, name), depth + 1);
    } else if (stat.isFile() && stat.nlink === 1) bytes += stat.size;
    else fail('BACKUP_RECOVERY_REQUIRED');
    if (!Number.isSafeInteger(bytes)) fail('BACKUP_QUOTA_EXCEEDED', 413);
  };
  await walk(root, 0);
  return bytes;
}
/** Register only after the application's Panel/Origin/CSRF and JSON middleware.
 * Every coordinator receives explicit candidate paths; no legacy coordinator is imported. */
export function registerBackupApi(
  app: Express,
  s: V2Services,
  hooks: BackupApiHooks,
  lifetime?: V2HttpLifetime,
) {
  const paths = s.backup.paths,
    operations = new BackupOperations(paths);
  const handle = (action: Action) =>
    (lifetime?.handle ?? ((action) => action))(
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const data = await action(req, res);
          if (!res.headersSent) res.json({ code: 200, data: data ?? null });
        } catch (error: unknown) {
          if (error instanceof BackupError)
            next(
              Object.assign(new Error(error.code), {
                error_code: error.code,
                status: 409,
              }),
            );
          else if (error instanceof multer.MulterError)
            next(
              Object.assign(new Error('BACKUP_UPLOAD_INVALID'), {
                error_code: 'BACKUP_UPLOAD_INVALID',
                status: error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
                details: { reason: error.code },
              }),
            );
          else next(error);
        }
      },
    );
  const body = (
    req: Request,
    allowed: string[] = [],
    required: string[] = [],
  ) => v.object(req.body ?? {}, allowed, required);
  const id = (req: Request) => backupId(req.params.id);
  const snapshot = async (
    snapshotId: string,
    source: 'snapshots' | 'imports',
  ) => {
    if (source === 'snapshots') return s.backup.snapshot(snapshotId);
    const outer = await paths.bucket('imports', snapshotId);
    await paths.assertOwned(outer, snapshotId);
    const root = path.join(outer, 'snapshot');
    return { root, manifest: await s.backup.validateRoot(root) };
  };
  const status = async () => {
    const journal = await s.restore.status();
    return journal
      ? {
          id: journal.operation_id,
          snapshot_id: journal.snapshot_id,
          stage: journal.stage,
          restart_required: journal.stage === 'PENDING',
          rebuild_plan:
            journal.stage === 'COMPLETE'
              ? await new RuntimeRestoreReconciler().plan(paths.data)
              : null,
        }
      : null;
  };
  const holdInfo = async (snapshotId: string) =>
    s.store.all<{
      workspace_id: number;
      source_generation: number;
      content_revision: number;
      inventory_hash: string;
      created_at: string;
    }>(
      'SELECT workspace_id,source_generation,content_revision,inventory_hash,created_at FROM WorkspacePreservationHolds WHERE snapshot_key=? AND released_at IS NULL ORDER BY workspace_id',
      [snapshotId],
    );

  app.get(
    '/api/backups',
    handle(async () => {
      const list = await s.backup.list();
      return Promise.all(
        list.map(async (entry) =>
          publicManifest(
            (await s.backup.snapshot(entry.id)).manifest,
            entry.held,
          ),
        ),
      );
    }),
  );
  app.get(
    '/api/backups/usage',
    handle(async () => {
      await paths.initialize();
      const usage = await new WorkspacePreservationService(s.backup).usage(),
        stat = await (
          fs as typeof fs & {
            statfs: (
              root: string,
            ) => Promise<{ bavail: number; bsize: number }>;
          }
        ).statfs(paths.root);
      return {
        ...usage,
        retained_bytes: await catalogBytes(paths.root),
        free_bytes: Math.floor(stat.bavail * stat.bsize),
        limits: {
          snapshot_bytes: s.backup.limits.backupSnapshotBytes,
          retained_bytes: s.backup.limits.backupRetainedBytes,
          temporary_bytes: s.backup.limits.temporaryMaxBytes,
          minimum_free_bytes: s.backup.limits.minimumFreeBytes,
        },
      };
    }),
  );
  app.get(
    '/api/backups/operations/:id',
    handle(async (req) => operations.get(id(req))),
  );
  app.post(
    '/api/backups',
    handle(async (req) => {
      const input = body(req, ['timeout_ms', 'mode']);
      const timeout =
        input.timeout_ms === undefined
          ? 600000
          : v.number(input.timeout_ms, 1, 3600000);
      const mode =
        input.mode === undefined
          ? 'FULL'
          : v.choice(input.mode, ['FULL', 'LIGHTWEIGHT']);
      return operations.start('SNAPSHOT', () => s.backup.create(timeout, mode));
    }),
  );
  app.get(
    '/api/backups/exports/:id/download',
    handle(async (req, res) => {
      const file = path.join(
          await paths.bucket('exports'),
          id(req) + '.encrypted',
        ),
        input = await openRegular(file);
      try {
        const stat = await input.stat();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${id(req)}.platform-backup"`,
        );
        res.setHeader('Content-Length', stat.size);
        await new Promise<void>((resolve, reject) => {
          const stream = input.createReadStream({ autoClose: false });
          const closed = () => {
            stream.destroy();
            resolve();
          };
          res.once('close', closed);
          res.once('finish', closed);
          stream.once('error', reject);
          stream.pipe(res);
        });
      } finally {
        await input.close();
      }
    }),
  );
  app.get(
    '/api/backups/:id',
    handle(async (req) =>
      publicManifest((await s.backup.snapshot(id(req))).manifest),
    ),
  );
  app.get(
    '/api/backups/:id/preservation',
    handle(async (req) => {
      await s.backup.snapshot(id(req));
      return {
        snapshot_id: id(req),
        holds: (await holdInfo(id(req))).map((row) => ({
          ...row,
          created_at: v.utcTimestamp(row.created_at),
        })),
      };
    }),
  );
  app.post(
    '/api/backups/:id/validate',
    handle(async (req) => {
      body(req);
      return operations.start('VALIDATE', async () =>
        publicManifest((await s.backup.snapshot(id(req))).manifest),
      );
    }),
  );
  app.post(
    '/api/backups/:id/export',
    handle(async (req) => {
      const snapshotId = id(req);
      const input = body(req, ['passphrase'], ['passphrase']),
        pass = phrase(input);
      try {
        return await operations.start('EXPORT', async () => {
          try {
            const encrypted = await s.backup.exportPortable(snapshotId, pass),
              name = path.basename(encrypted);
            if (!/^[0-9a-f-]{36}\.encrypted$/.test(name))
              fail('BACKUP_OPERATION_FAILED');
            return backupId(name.slice(0, -10));
          } finally {
            pass.fill(0);
          }
        });
      } catch (error) {
        pass.fill(0);
        throw error;
      }
    }),
  );
  app.delete(
    '/api/backups/:id',
    handle(async (req) => {
      body(req);
      return operations.exclusive(async () => {
        const journal = await s.restore.status();
        if (
          journal?.snapshot_id === id(req) &&
          !['COMPLETE', 'ROLLED_BACK', 'CANCELLED'].includes(journal.stage)
        )
          fail('BACKUP_IN_USE');
        await s.backup.delete(id(req));
        return { deleted: true };
      });
    }),
  );
  app.post(
    '/api/restores/import',
    handle(async (req, res) => {
      await paths.initialize();
      const declared = req.get('Content-Length');
      if (!declared || !/^\d+$/.test(declared))
        fail('BACKUP_UPLOAD_LENGTH_REQUIRED', 400);
      const length = Number(declared);
      if (
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > s.backup.limits.backupSnapshotBytes + 64 * 1024 * 1024 + 16384
      )
        fail('BACKUP_QUOTA_EXCEEDED', 413);
      if (
        (await catalogBytes(paths.root)) + Math.ceil(length * 3) >
        s.backup.limits.backupRetainedBytes
      )
        fail('BACKUP_QUOTA_EXCEEDED', 413);
      await s.backup.reserve(Math.ceil(length * 3));
      const upload = await paths.allocate('.staging');
      let ownedByOperation = false,
        pass: Buffer | undefined;
      try {
        await new Promise<void>((resolve, reject) =>
          multer({
            dest: upload.root,
            limits: {
              files: 1,
              fileSize:
                s.backup.limits.backupSnapshotBytes + 64 * 1024 * 1024 + 80,
              fields: 1,
              fieldSize: 4096,
              parts: 3,
            },
          }).single('file')(req, res, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        if (!req.file) fail('BACKUP_UPLOAD_REQUIRED', 400);
        const input = body(req, ['passphrase'], ['passphrase']);
        pass = phrase(input);
        await fs.chmod(req.file.path, 0o600);
        const secret = pass,
          file = req.file.path;
        const operation = await operations.start('IMPORT', async () => {
          try {
            const result = await s.backup.importPortable(file, secret);
            return { id: result.id, snapshot_id: result.snapshot_id };
          } finally {
            secret.fill(0);
            await paths.remove('.staging', upload.id);
          }
        });
        ownedByOperation = true;
        return operation;
      } finally {
        if (!ownedByOperation) {
          pass?.fill(0);
          await paths.remove('.staging', upload.id);
        }
      }
    }),
  );
  app.post(
    '/api/restores/:id/validate',
    handle(async (req) => {
      body(req);
      return operations.start('VALIDATE_IMPORT', async () => {
        const entry = await snapshot(id(req), 'imports');
        return entry.manifest.total_bytes;
      });
    }),
  );
  app.get(
    '/api/restores/:id/preview',
    handle(async (req) => {
      const query = v.object(req.query, ['source']),
        source =
          query.source === undefined
            ? 'imports'
            : v.choice(query.source, ['snapshots', 'imports']);
      return {
        ...publicManifest((await snapshot(id(req), source)).manifest),
        source,
        restart_required: true,
      };
    }),
  );
  app.post(
    '/api/restores/:id/stage',
    handle(async (req, res) => {
      const input = body(req, ['confirmation', 'source'], ['confirmation']);
      if (input.confirmation !== 'RESTORE')
        fail('RESTORE_CONFIRMATION_REQUIRED', 400);
      const source =
          input.source === undefined
            ? 'imports'
            : v.choice(input.source, ['snapshots', 'imports']),
        snapshotId = id(req);
      let responseFinished = false,
        committed = false,
        restartRequested = false,
        operationId: string | undefined;
      const restart = () => {
        if (responseFinished && committed && !restartRequested) {
          restartRequested = true;
          hooks.requestRestart();
        }
      };
      res.once('finish', () => {
        responseFinished = true;
        restart();
      });
      const operation = await operations.start('STAGE_RESTORE', async () => {
        await hooks.pauseProducers();
        try {
          await s.restore.stage(snapshotId, source);
          // BackupOperations owns the terminal fsync. Restart only after that durable fact.
          setImmediate(() => {
            void (async () => {
              for (let attempt = 0; attempt < 1000; attempt++) {
                if (
                  operationId &&
                  (await operations.get(operationId)).status === 'SUCCESS'
                ) {
                  committed = true;
                  restart();
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            })().catch(() => undefined);
          });
          return status();
        } catch (error) {
          hooks.resumeProducers?.();
          throw error;
        }
      });
      operationId = operation.id;
      res.status(202).json({ code: 202, data: operation });
      return undefined;
    }),
  );
  app.delete(
    '/api/restores/:id/stage',
    handle(async (req) => {
      body(req);
      return operations.exclusive(async () => {
        const result = await s.restore.cancelPending(id(req));
        hooks.resumeProducers?.();
        return result;
      });
    }),
  );
  app.get(
    '/api/restore/status',
    handle(async () => status()),
  );
  app.post(
    '/api/restore/rebuild',
    handle(async (req) => {
      body(req);
      if ((await s.restore.status())?.stage !== 'COMPLETE')
        fail('RESTORE_REBUILD_UNAVAILABLE');
      if (!hooks.rebuildRuntime) fail('RESTORE_REBUILD_REQUIRED');
      return operations.start('REBUILD', () => hooks.rebuildRuntime!());
    }),
  );
  return { operations, recoverOperations: () => operations.recover() };
}
