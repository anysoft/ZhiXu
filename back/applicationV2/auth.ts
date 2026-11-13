import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { hashPassword, verifyPassword } from '../shared/password';
import { isValidToken } from '../shared/auth';
import type { AuthInfo } from '../data/system';
import { WorkspaceStore } from '../services/workspaceV2/store';
import { fail } from '../services/workspaceV2/errors';
import type { PanelPrincipal } from './types';
import { authenticator } from '@otplib/preset-default';

function credentials(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !['username', 'password'].includes(k))
  )
    fail('INVALID_REQUEST', 400);
  const { username, password } = value as Record<string, unknown>;
  if (
    typeof username !== 'string' ||
    !username.trim() ||
    username.length > 1024 ||
    /[\r\n\0]/.test(username) ||
    typeof password !== 'string' ||
    !password.length ||
    password.length > 1024
  )
    fail('INVALID_REQUEST', 400);
  return { username: username.trim(), password };
}
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
/** Existing scrypt + HS384 + persisted per-platform membership, bound to candidate Auths. */
export class V2PanelAuth {
  constructor(
    readonly getStore: () => WorkspaceStore,
    readonly secret: string,
  ) {}
  async info() {
    const rows = await this.getStore().all<{ id: number; info: string }>(
      'SELECT id,info FROM Auths WHERE type=? ORDER BY id',
      ['authConfig'],
    );
    if (rows.length > 1) fail('DATABASE_SCHEMA_CORRUPTED', 503);
    if (!rows[0]) return null;
    let info: AuthInfo;
    try {
      info = JSON.parse(rows[0].info);
    } catch {
      fail('DATABASE_SCHEMA_CORRUPTED', 503);
    }
    if (
      !info ||
      typeof info.username !== 'string' ||
      typeof info.password !== 'string'
    )
      fail('DATABASE_SCHEMA_CORRUPTED', 503);
    return { id: rows[0].id, info };
  }
  csrf(token: string) {
    return createHmac('sha256', this.secret)
      .update('panel-csrf:' + token)
      .digest('hex');
  }
  setupCsrf() {
    return this.csrf('fresh-v2-owner-initialization');
  }
  async initialized() {
    return !!(await this.info())?.info.initialized;
  }
  async initialize(body: unknown, csrf: string | undefined) {
    if (!csrf || !equal(csrf, this.setupCsrf()))
      fail('PANEL_SESSION_REQUIRED', 403);
    const input = credentials(body);
    if (input.password === 'admin') fail('INVALID_REQUEST', 400);
    const password = await hashPassword(input.password);
    await this.getStore().transaction(async (tx) => {
      if (await this.info()) fail('WORKSPACE_VERSION_CONFLICT');
      const info = {
        initialized: true,
        username: input.username,
        password,
        retries: 0,
        lastlogon: 0,
        lastip: '',
        lastaddr: '',
        platform: 'desktop',
        isTwoFactorChecking: false,
        token: '',
        tokens: { desktop: [], mobile: [] },
        twoFactorActivated: false,
        twoFactorSecret: '',
        avatar: '',
      };
      await tx.run(
        "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('authConfig',?,?,?)",
        [
          JSON.stringify(info),
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
    });
    return { initialized: true, username: input.username };
  }
  async login(body: unknown, platform = 'desktop', ip = '') {
    const input = credentials(body),
      row = await this.info();
    if (!row?.info.initialized) fail('AUTHENTICATION_REQUIRED', 401);
    const old = row.info;
    if (
      old.retries > 2 &&
      Date.now() - old.lastlogon <
        Math.min(900000, 3 ** Math.min(old.retries, 12) * 1000)
    )
      fail('AUTHENTICATION_REQUIRED', 401);
    const matches = await verifyPassword(input.password, old.password);
    if (!matches || !equal(input.username, old.username)) {
      await this.getStore().transaction(async (tx) => {
        const current = await this.info();
        if (current)
          await tx.run('UPDATE Auths SET info=?,updatedAt=? WHERE id=?', [
            JSON.stringify({
              ...current.info,
              retries: (current.info.retries ?? 0) + 1,
              lastlogon: Date.now(),
            }),
            new Date().toISOString(),
            current.id,
          ]);
        await this.loginLog(tx, platform, ip, 1);
      });
      fail('AUTHENTICATION_REQUIRED', 401);
    }
    if (old.twoFactorActivated) {
      await this.patch((info) => ({
        ...info,
        isTwoFactorChecking: true,
        twoFactorExpiresAt: Date.now() + 300000,
      }));
      return { two_factor_required: true };
    }
    return this.issue(old, platform, undefined, ip);
  }
  private async issue(
    old: AuthInfo,
    platform: string,
    twoFactorStep?: number,
    ip = '',
  ) {
    const token = jwt.sign(
      { data: randomBytes(48).toString('hex') },
      this.secret,
      { algorithm: 'HS384', expiresIn: '20d' },
    );
    await this.getStore().transaction(async (tx) => {
      const current = await this.info();
      if (
        !current ||
        current.info.password !== old.password ||
        current.info.username !== old.username ||
        current.info.twoFactorActivated !== old.twoFactorActivated ||
        current.info.twoFactorSecret !== old.twoFactorSecret
      )
        fail('AUTHENTICATION_REQUIRED', 401);
      const prior = Array.isArray(current.info.tokens?.[platform])
        ? (current.info.tokens[platform] as any[])
        : [];
      if (
        twoFactorStep !== undefined &&
        (!current.info.isTwoFactorChecking ||
          !(current.info.twoFactorExpiresAt! > Date.now()) ||
          current.info.lastTwoFactorStep === twoFactorStep)
      )
        fail('AUTHENTICATION_REQUIRED', 401);
      const next = {
        ...current.info,
        retries: 0,
        lastlogon: Date.now(),
        platform,
        isTwoFactorChecking: false,
        twoFactorExpiresAt: 0,
        ...(twoFactorStep === undefined
          ? {}
          : { lastTwoFactorStep: twoFactorStep }),
        tokens: {
          ...current.info.tokens,
          [platform]: [
            ...prior,
            {
              value: token,
              timestamp: Date.now(),
              platform,
              ip: '',
              address: '',
            },
          ].slice(-10),
        },
      };
      await tx.run('UPDATE Auths SET info=?,updatedAt=? WHERE id=?', [
        JSON.stringify(next),
        new Date().toISOString(),
        current.id,
      ]);
      await this.loginLog(tx, platform, ip, 0);
    });
    return { token, csrf_token: this.csrf(token), username: old.username };
  }
  private async loginLog(
    tx: WorkspaceStore,
    platform: string,
    ip: string,
    status: 0 | 1,
  ) {
    const now = new Date().toISOString();
    await tx.run(
      "INSERT INTO Auths(type,ip,info,createdAt,updatedAt) VALUES('loginLog',?,?,?,?)",
      [
        ip,
        JSON.stringify({
          timestamp: Date.now(),
          address: '',
          ip,
          platform,
          status,
        }),
        now,
        now,
      ],
    );
    await tx.run(
      "DELETE FROM Auths WHERE type='loginLog' AND id NOT IN (SELECT id FROM Auths WHERE type='loginLog' ORDER BY id DESC LIMIT 100)",
    );
  }
  async patch(change: (info: AuthInfo) => AuthInfo) {
    return this.getStore().transaction(async (tx) => {
      const row = await this.info();
      if (!row) fail('AUTHENTICATION_REQUIRED', 401);
      const next = change(row.info);
      await tx.run('UPDATE Auths SET info=?,updatedAt=? WHERE id=?', [
        JSON.stringify(next),
        new Date().toISOString(),
        row.id,
      ]);
      return next;
    });
  }
  async updateProfile(body: unknown) {
    const input = credentials(body);
    if (input.password === 'admin') fail('INVALID_REQUEST', 400);
    const password = await hashPassword(input.password);
    await this.patch((info) => ({
      ...info,
      username: input.username,
      password,
      tokens: {},
      token: '',
      isTwoFactorChecking: false,
    }));
    return { username: input.username };
  }
  async reset(body: unknown) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !Object.keys(body).length ||
      Object.keys(body).some(
        (k) =>
          !['username', 'password', 'retries', 'twoFactorActivated'].includes(
            k,
          ),
      )
    )
      fail('INVALID_REQUEST', 400);
    const input = body as Record<string, unknown>;
    if (
      (input.username !== undefined && typeof input.username !== 'string') ||
      (input.password !== undefined && typeof input.password !== 'string')
    )
      fail('INVALID_REQUEST', 400);
    if (
      input.retries !== undefined &&
      (!Number.isSafeInteger(input.retries) ||
        Number(input.retries) < 0 ||
        Number(input.retries) > 100)
    )
      fail('INVALID_REQUEST', 400);
    if (
      input.twoFactorActivated !== undefined &&
      input.twoFactorActivated !== false
    )
      fail('INVALID_REQUEST', 400);
    const row = await this.info();
    if (!row) fail('AUTHENTICATION_REQUIRED', 401);
    const validated = credentials({
      username: input.username ?? row.info.username,
      password: input.password ?? 'validation-only',
    });
    if (input.password === 'admin') fail('INVALID_REQUEST', 400);
    const password =
      input.password === undefined
        ? undefined
        : await hashPassword(validated.password);
    await this.patch((info) => {
      if (
        info.username !== row.info.username ||
        info.password !== row.info.password ||
        info.twoFactorActivated !== row.info.twoFactorActivated ||
        info.twoFactorSecret !== row.info.twoFactorSecret
      )
        fail('AUTHENTICATION_REQUIRED', 401);
      const revoke =
        input.username !== undefined ||
        password !== undefined ||
        input.twoFactorActivated !== undefined;
      return {
        ...info,
        ...(input.username === undefined
          ? {}
          : { username: validated.username }),
        ...(password === undefined ? {} : { password }),
        ...(input.retries === undefined
          ? {}
          : { retries: Number(input.retries) }),
        ...(input.twoFactorActivated === false
          ? {
              twoFactorActivated: false,
              twoFactorSecret: '',
              twoFactorExpiresAt: 0,
            }
          : {}),
        ...(revoke
          ? { tokens: {}, token: '', isTwoFactorChecking: false }
          : {}),
      };
    });
    return null;
  }
  async initTwoFactor() {
    const row = await this.info();
    if (!row || row.info.twoFactorActivated) fail('INVALID_REQUEST', 400);
    const secret = authenticator.generateSecret();
    await this.patch((info) => {
      if (info.twoFactorActivated) fail('INVALID_REQUEST', 400);
      return { ...info, twoFactorSecret: secret };
    });
    return {
      secret,
      url: authenticator.keyuri(row.info.username, 'ZhiXu', secret),
    };
  }
  async activateTwoFactor(code: unknown) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code))
      fail('INVALID_REQUEST', 400);
    await this.patch((info) => {
      if (
        !info.twoFactorSecret ||
        !authenticator.verify({ token: code, secret: info.twoFactorSecret })
      )
        fail('AUTHENTICATION_REQUIRED', 401);
      return {
        ...info,
        twoFactorActivated: true,
        tokens: {},
        token: '',
        isTwoFactorChecking: false,
        twoFactorExpiresAt: 0,
      };
    });
    return true;
  }
  async deactivateTwoFactor() {
    await this.patch((info) => ({
      ...info,
      twoFactorActivated: false,
      twoFactorSecret: '',
      tokens: {},
      token: '',
      isTwoFactorChecking: false,
      twoFactorExpiresAt: 0,
    }));
    return true;
  }
  async twoFactorLogin(body: unknown, platform = 'desktop', ip = '') {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) => !['username', 'password', 'code'].includes(k),
      )
    )
      fail('INVALID_REQUEST', 400);
    const { code, ...input } = body as any;
    const credentialsValue = credentials(input),
      row = await this.info(),
      step = Math.floor(Date.now() / 30000);
    if (
      !row ||
      typeof code !== 'string' ||
      !/^\d{6}$/.test(code) ||
      !row.info.twoFactorActivated ||
      !row.info.isTwoFactorChecking ||
      !(row.info.twoFactorExpiresAt! > Date.now()) ||
      row.info.lastTwoFactorStep === step ||
      credentialsValue.username !== row.info.username ||
      !(await verifyPassword(credentialsValue.password, row.info.password)) ||
      !authenticator.verify({ token: code, secret: row.info.twoFactorSecret })
    ) {
      await this.patch((info) => ({
        ...info,
        retries: (info.retries ?? 0) + 1,
        lastlogon: Date.now(),
      }));
      fail('AUTHENTICATION_REQUIRED', 401);
    }
    return this.issue(row.info, platform, step, ip);
  }
  token(header: unknown, platformHint = 'desktop') {
    if (
      typeof header !== 'string' ||
      !/^Bearer (?:(?:desktop|mobile)-)?[A-Za-z0-9_.-]+$/.test(header)
    )
      return null;
    const token = header.slice(7).replace(/^(desktop|mobile)-/, '');
    return {
      token,
      platform: header.startsWith('Bearer mobile-')
        ? 'mobile'
        : header.startsWith('Bearer desktop-')
        ? 'desktop'
        : platformHint,
    };
  }
  async principal(
    header: unknown,
    platformHint = 'desktop',
  ): Promise<{ principal: PanelPrincipal; token: string }> {
    const parsed = this.token(header, platformHint);
    if (!parsed) fail('AUTHENTICATION_REQUIRED', 401);
    let claims: any;
    try {
      claims = jwt.verify(parsed.token, this.secret, { algorithms: ['HS384'] });
    } catch {
      fail('AUTHENTICATION_REQUIRED', 401);
    }
    const row = await this.info();
    if (
      row &&
      isValidToken(row.info, parsed.token, parsed.platform, this.secret)
    )
      return {
        principal: {
          kind: 'PANEL_OWNER',
          username: row.info.username,
          platform: parsed.platform,
        },
        token: parsed.token,
      };
    const apps = await this.getStore().all<{ tokens: string }>(
      'SELECT tokens FROM Apps',
    );
    for (const app of apps) {
      let entries: any = [];
      try {
        entries = JSON.parse(app.tokens || '[]');
      } catch {}
      if (
        Array.isArray(entries) &&
        entries.some(
          (x) =>
            x?.value === parsed.token &&
            (!x.expiration || x.expiration > Date.now() / 1000),
        )
      )
        fail('PANEL_SESSION_REQUIRED', 403);
    }
    if (claims?.type === 'APP') fail('PANEL_SESSION_REQUIRED', 403);
    fail('AUTHENTICATION_REQUIRED', 401);
  }
  verifyCsrf(token: string, header: unknown) {
    if (typeof header !== 'string' || !equal(header, this.csrf(token)))
      fail('PANEL_SESSION_REQUIRED', 403);
  }
  async current(principal: PanelPrincipal, token: string) {
    const row = await this.info();
    return {
      username: principal.username,
      avatar: row?.info.avatar ?? '',
      twoFactorActivated: !!row?.info.twoFactorActivated,
      initialized: true,
      csrf_token: this.csrf(token),
    };
  }
  async logout(token: string) {
    await this.getStore().transaction(async (tx) => {
      const current = await this.info();
      if (!current) return;
      const tokens = Object.fromEntries(
        Object.entries(current.info.tokens ?? {}).map(([key, rows]) => [
          key,
          Array.isArray(rows) ? rows.filter((x) => x.value !== token) : [],
        ]),
      );
      await tx.run('UPDATE Auths SET info=?,updatedAt=? WHERE id=?', [
        JSON.stringify({ ...current.info, tokens }),
        new Date().toISOString(),
        current.id,
      ]);
    });
    return null;
  }
}
