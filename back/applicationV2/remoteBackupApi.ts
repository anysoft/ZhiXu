import type { Express, Request, Response, NextFunction } from 'express';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { RemoteBackupService } from '../services/backup/remote';
import { BackupOperations } from '../services/backup/operations';
import { BackupError, openRegular } from '../services/backup/files';
import type { V2Services } from './types';
import type { V2HttpLifetime } from './httpLifetime';
import * as v from './workspaceValidation';

/** Shares the existing authenticated backup middleware and operation owner. */
export function registerRemoteBackupApi(
  app: Express,
  services: V2Services,
  operations: BackupOperations,
  lifetime?: V2HttpLifetime,
) {
  const remote = new RemoteBackupService(services.backup, operations);
  const handle = (action: (req: Request, res: Response) => Promise<unknown>) =>
    (lifetime?.handle ?? ((action) => action))(
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const data = await action(req, res);
          if (!res.headersSent) res.json({ code: 200, data: data ?? null });
        } catch (error) {
          if (error instanceof BackupError)
            next(
              Object.assign(new Error(error.code), {
                error_code: error.code,
                status:
                  error.code === 'BACKUP_REMOTE_CONFIGURATION_INVALID'
                    ? 400
                    : 409,
              }),
            );
          else next(error);
        }
      },
    );
  const prefix = '/api/backups/remote';
  const targetId = (req: Request) => v.uuid(req.params.targetId);
  app.get(
    prefix + '/settings',
    handle(() => remote.getSettings()),
  );
  app.put(
    prefix + '/settings',
    handle((req) => remote.saveSettings(req.body)),
  );
  app.get(
    prefix + '/targets',
    handle(() => remote.listTargets()),
  );
  app.post(
    prefix + '/targets',
    handle((req) => remote.saveTarget(req.body)),
  );
  app.put(
    prefix + '/targets/:targetId',
    handle((req) => remote.saveTarget(req.body, targetId(req))),
  );
  app.delete(
    prefix + '/targets/:targetId',
    handle((req) => remote.deleteTarget(targetId(req))),
  );
  app.post(
    prefix + '/targets/:targetId/test',
    handle((req) => remote.testTarget(targetId(req))),
  );
  app.get(
    prefix + '/targets/:targetId/objects',
    handle((req) => remote.listObjects(targetId(req))),
  );
  app.delete(
    prefix + '/targets/:targetId/objects',
    handle((req) => {
      const body = v.object(req.body, ['key'], ['key']);
      return remote.deleteObject(targetId(req), v.text(body.key));
    }),
  );
  app.get(
    prefix + '/targets/:targetId/download',
    handle(async (req, res) => {
      const file = await remote.download(targetId(req), v.text(req.query.key));
      let handle: Awaited<ReturnType<typeof openRegular>> | undefined;
      try {
        handle = await openRegular(file);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="zhixu-backup.encrypted"',
        );
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Length', (await handle.stat()).size);
        await pipeline(
          createReadStream(file, { fd: handle.fd, autoClose: false }),
          res,
        );
      } finally {
        await handle?.close();
        await fs.unlink(file).catch(() => {});
      }
    }),
  );
  app.get(
    prefix + '/uploads',
    handle(() => remote.uploads()),
  );
  app.post(
    prefix + '/uploads',
    handle(async (req) => {
      const body = v.object(
        req.body,
        ['snapshot_id', 'target_id'],
        ['snapshot_id', 'target_id'],
      );
      const upload = await remote.enqueue(
        v.uuid(body.snapshot_id),
        v.uuid(body.target_id),
        'MANUAL',
      );
      await remote.tick();
      return upload;
    }),
  );
  app.post(
    prefix + '/uploads/:uploadId/retry',
    handle(async (req) => {
      const upload = await remote.retry(v.uuid(req.params.uploadId));
      await remote.tick();
      return upload;
    }),
  );
  return remote;
}
