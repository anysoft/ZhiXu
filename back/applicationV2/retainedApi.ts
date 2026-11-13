import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { constants } from 'fs';
import { randomUUID } from 'crypto';
import { isIP } from 'net';
import multer from 'multer';
import { V2PanelAuth } from './auth';
import type { V2Services } from './types';
import * as v from './taskValidation';
import { fail } from '../services/workspaceV2/errors';
import { normalizeClientIp } from '../shared/clientIp';
import { privateDirectory, syncDirectory } from '../services/backup/files';

/** Retained account/settings endpoints use the candidate Auths table and owned files. */
export async function registerRetainedApi(
  app: Express,
  s: V2Services,
  auth: V2PanelAuth,
) {
  const body = (req: Request, keys: string[], required = keys) =>
    v.object(req.body ?? {}, keys, required);
  const endpoint =
    (
      action: (req: Request, res: Response) => Promise<unknown>,
      mutates = false,
    ) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = mutates
          ? await s.leases.barrier.mutation(() => action(req, res))
          : await action(req, res);
        if (!res.headersSent) res.json({ code: 200, data: result ?? null });
      } catch (e) {
        next(e);
      }
    };
  const readConfig = async () => {
    const rows = await s.store.all<any>(
      "SELECT id,info FROM Auths WHERE type='systemConfig'",
    );
    if (rows.length > 1) fail('DATABASE_SCHEMA_CORRUPTED', 503);
    let info: any = {};
    try {
      if (rows[0]) info = JSON.parse(rows[0].info);
    } catch {
      fail('DATABASE_SCHEMA_CORRUPTED', 503);
    }
    return {
      id: rows[0]?.id,
      type: 'systemConfig',
      info: { timezone: 'UTC', lang: 'en-US', ...info },
    };
  };
  const saveConfig = async (patch: Record<string, unknown>) =>
    s.store.transaction(async (tx) => {
      const current = await readConfig(),
        info = { ...current.info, ...patch },
        now = new Date().toISOString();
      let id = current.id;
      if (id)
        await tx.run('UPDATE Auths SET info=?,updatedAt=? WHERE id=?', [
          JSON.stringify(info),
          now,
          id,
        ]);
      else
        id = (
          await tx.run(
            "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('systemConfig',?,?,?)",
            [JSON.stringify(info), now, now],
          )
        ).lastID;
      return { id, type: 'systemConfig', info };
    });
  const proxyValue = (value: unknown) => {
    if (
      typeof value !== 'string' ||
      value.length > 500 ||
      /[\r\n\0]/.test(value)
    )
      fail('INVALID_REQUEST', 400);
    const p = value.trim() || 'false';
    if (/^\d+$/.test(p) && Number(p) > 20) fail('INVALID_REQUEST', 400);
    const resolved =
      p === 'true'
        ? true
        : p === 'false'
        ? false
        : /^\d+$/.test(p)
        ? Number(p)
        : p;
    try {
      express().set('trust proxy', resolved);
    } catch {
      fail('INVALID_REQUEST', 400);
    }
    return { p, resolved };
  };
  const stored = await readConfig();
  app.set(
    'trust proxy',
    proxyValue(stored.info.trustProxy ?? 'false').resolved,
  );
  app.put(
    '/api/user',
    endpoint(
      (req) => auth.updateProfile(body(req, ['username', 'password'])),
      true,
    ),
  );
  app.get(
    '/api/user/two-factor/init',
    endpoint(async (req) => {
      auth.verifyCsrf((req as any).v2auth.token, req.get('X-CSRF-Token'));
      return auth.initTwoFactor();
    }, true),
  );
  app.put(
    '/api/user/two-factor/active',
    endpoint((req) => auth.activateTwoFactor(body(req, ['code']).code), true),
  );
  app.put(
    '/api/user/two-factor/deactivate',
    endpoint(async (req) => {
      body(req, []);
      return auth.deactivateTwoFactor();
    }, true),
  );
  app.get(
    '/api/user/login-log',
    endpoint(async () => {
      const rows = await s.store.all<{ info: string }>(
        "SELECT info FROM Auths WHERE type='loginLog' ORDER BY id DESC LIMIT 100",
      );
      return rows.map((r) => JSON.parse(r.info));
    }),
  );
  app.get(
    '/api/user/ip-blacklist',
    endpoint(async () => (await auth.info())?.info.blockedIps ?? []),
  );
  const blacklist = (remove: boolean) =>
    endpoint(async (req) => {
      const input = body(req, ['ip']);
      if (typeof input.ip !== 'string' || !isIP(input.ip))
        fail('INVALID_REQUEST', 400);
      const ip = normalizeClientIp(input.ip);
      const info = await auth.patch((row) => ({
        ...row,
        blockedIps: remove
          ? (row.blockedIps ?? []).filter((x) => x !== ip)
          : [...new Set([...(row.blockedIps ?? []), ip])],
      }));
      return info.blockedIps;
    }, true);
  app.put('/api/user/ip-blacklist', blacklist(false));
  app.delete('/api/user/ip-blacklist', blacklist(true));
  app.get(
    '/api/user/notification',
    endpoint(async () => ({
      notice: 'Use notification-channels',
      secret_configured:
        (
          await s.store.all<{ n: number }>(
            'SELECT COUNT(*) n FROM NotificationChannels WHERE archived=0 AND secret IS NOT NULL',
          )
        )[0].n > 0,
    })),
  );
  for (const route of ['/api/user/notification', '/api/user/notification/init'])
    app.put(route, (_req, res) =>
      res
        .status(410)
        .json({ code: 410, error_code: 'NOTIFICATION_CHANNEL_API_REQUIRED' }),
    );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 2 },
  });
  app.put(
    '/api/user/avatar',
    upload.single('avatar'),
    endpoint(async (req) => {
      const file = req.file;
      if (!file) fail('INVALID_REQUEST', 400);
      const ext = path.extname(file.originalname).toLowerCase(),
        buf = file.buffer;
      const allowed: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.avif': 'image/avif',
      };
      const magic =
        ext === '.png'
          ? buf
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : ext === '.gif'
          ? /^GIF8[79]a/.test(buf.subarray(0, 6).toString('ascii'))
          : ext === '.webp'
          ? buf.subarray(0, 4).toString() === 'RIFF' &&
            buf.subarray(8, 12).toString() === 'WEBP'
          : ext === '.avif'
          ? buf.subarray(4, 12).toString() === 'ftypavif'
          : ['.jpg', '.jpeg'].includes(ext)
          ? buf[0] === 255 && buf[1] === 216 && buf[2] === 255
          : false;
      if (!magic || allowed[ext] !== file.mimetype)
        fail('INVALID_REQUEST', 400);
      const root = await s.roots.directory('upload/avatars', true),
        name = randomUUID() + ext,
        fd = await fs.open(
          path.join(root, name),
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_WRONLY,
          0o600,
        );
      try {
        await fd.writeFile(buf);
        await fd.sync();
      } finally {
        await fd.close();
        buf.fill(0);
      }
      await syncDirectory(root);
      await auth.patch((row) => ({ ...row, avatar: name }));
      return name;
    }, true),
  );
  app.get(
    '/api/system/config',
    endpoint(async () => readConfig()),
  );
  const settings: Array<[string, string, (x: unknown) => unknown]> = [
    [
      'timezone',
      'timezone',
      (x) => {
        if (x === null || x === '') return 'UTC';
        if (typeof x !== 'string') fail('INVALID_REQUEST', 400);
        try {
          new Intl.DateTimeFormat('en', { timeZone: x });
        } catch {
          fail('INVALID_REQUEST', 400);
        }
        return x;
      },
    ],
    [
      'lang',
      'lang',
      (x) => {
        if (x !== null && !['', 'en-US', 'zh-CN'].includes(String(x)))
          fail('INVALID_REQUEST', 400);
        return x || 'en-US';
      },
    ],
    [
      'panel-title',
      'panelTitle',
      (x) => (x === null ? '' : v.text(x, 100, true)),
    ],
    [
      'log-remove-frequency',
      'logRemoveFrequency',
      (x) => (x === null ? 0 : v.number(x, 0, 3650)),
    ],
  ];
  for (const [route, key, validate] of settings)
    app.put(
      '/api/system/config/' + route,
      endpoint(async (req) => {
        const input = body(req, [key]);
        return saveConfig({ [key]: validate(input[key]) });
      }, true),
    );
  app.put(
    '/api/system/auth/reset',
    endpoint(
      (req) =>
        auth.reset(
          body(
            req,
            ['username', 'password', 'retries', 'twoFactorActivated'],
            [],
          ),
        ),
      true,
    ),
  );
  const proxyConfig = async () => {
    const c = await readConfig();
    return {
      trustProxy: c.info.trustProxy ?? 'false',
      source: c.info.trustProxy ? 'system' : 'default',
      editable: true,
    };
  };
  app.get(
    '/api/system/client-ip/config',
    endpoint(async () => proxyConfig()),
  );
  app.put(
    '/api/system/client-ip/config',
    endpoint(async (req) => {
      const input = body(req, ['trustProxy']),
        proxy = proxyValue(input.trustProxy);
      await saveConfig({ trustProxy: proxy.p });
      app.set('trust proxy', proxy.resolved);
      return proxyConfig();
    }, true),
  );
  app.get(
    '/api/system/client-ip/diagnose',
    endpoint(async (req) => {
      const remoteAddress = normalizeClientIp(req.socket.remoteAddress),
        forwardedFor = String(req.headers['x-forwarded-for'] ?? '')
          .split(',')
          .map(normalizeClientIp)
          .filter(Boolean),
        clientIp = normalizeClientIp(req.ip);
      return {
        ...(await proxyConfig()),
        remoteAddress,
        forwardedFor,
        expressIps: req.ips.map(normalizeClientIp),
        clientIp,
        hops: [remoteAddress, ...forwardedFor.slice().reverse()].map(
          (ip, hop) => ({
            ip,
            hop,
            status: ip === clientIp ? 'client' : 'not_checked',
          }),
        ),
      };
    }),
  );
  // The frozen v2 schema retires Subscription-owned logs. A cleanup cannot invent those entities.
  for (const operation of ['preview', 'cleanup'])
    app.post(
      '/api/system/storage-retention/' + operation,
      endpoint(async (req) => {
        const input = body(
          req,
          operation === 'cleanup'
            ? ['logRetentionDays', 'confirmation']
            : ['logRetentionDays'],
        );
        v.number(input.logRetentionDays, 0, 3650);
        if (operation === 'cleanup' && input.confirmation !== 'CLEAN')
          fail('INVALID_REQUEST', 400);
        fail('SUBSCRIPTION_RETENTION_RETIRED', 410);
      }),
    );
  app.get(
    '/api/system/log',
    endpoint(async (req, res) => {
      v.object(req.query, ['startTime', 'endTime', 'limit']);
      const limit =
        req.query.limit === undefined
          ? 1048576
          : v.number(Number(req.query.limit), 1, 1048576);
      const root = await s.roots.directory('syslog', true);
      const entries = await fs.readdir(root);
      const parts: Buffer[] = [];
      let remaining = limit,
        total = 0;
      for (const name of entries.sort().reverse()) {
        if (!/^[A-Za-z0-9_.-]+\.log$/.test(name)) continue;
        const fd = await fs.open(
          path.join(root, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const st = await fd.stat();
          if (!st.isFile() || st.nlink !== 1 || st.mode & 0o077)
            fail('WORKSPACE_PATH_FORBIDDEN', 403);
          const from = req.query.startTime
              ? Date.parse(String(req.query.startTime))
              : 0,
            to = req.query.endTime
              ? Date.parse(String(req.query.endTime)) + 86400000
              : Infinity;
          if (
            !Number.isFinite(from) ||
            !(to === Infinity || Number.isFinite(to))
          )
            fail('INVALID_REQUEST', 400);
          if (st.mtimeMs < from || st.mtimeMs > to) continue;
          total += st.size;
          if (remaining) {
            const part = Buffer.alloc(Math.min(st.size, remaining));
            await fd.read(part, 0, part.length, st.size - part.length);
            parts.unshift(part);
            remaining -= part.length;
          }
        } finally {
          await fd.close();
        }
      }
      res.setHeader('X-QL-Log-Total', total);
      res.setHeader('X-QL-Log-Truncated', String(total > limit));
      res.type('text/plain').send(Buffer.concat(parts));
    }),
  );
  app.delete(
    '/api/system/log',
    endpoint(async (req) => {
      body(req, []);
      const root = await s.roots.directory('syslog', true);
      for (const name of await fs.readdir(root)) {
        if (!/^[A-Za-z0-9_.-]+\.log$/.test(name)) continue;
        const target = path.join(root, name),
          st = await fs.lstat(target);
        if (
          st.isFile() &&
          !st.isSymbolicLink() &&
          st.nlink === 1 &&
          !(st.mode & 0o077)
        )
          await fs.unlink(target);
      }
      await syncDirectory(root);
      return null;
    }, true),
  );
}
