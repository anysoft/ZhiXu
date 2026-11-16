import { randomUUID } from 'crypto';
import { isIP } from 'net';
import { spawn } from 'child_process';
import { WorkspaceStore } from './workspaceV2/store';
import { PlatformBackupBarrier } from './backup/barrier';
import { fail } from './workspaceV2/errors';

export type ProxyScope = 'platform' | 'workspace' | 'repository' | 'task';
export interface ProxySelection {
  mode: 'INHERIT' | 'DIRECT' | 'PROFILE';
  profile_id?: string | null;
}
export interface ResolvedProxy {
  env: Record<string, string>;
  secretValues: string[];
  profileId: string | null;
  configured: boolean;
  url?: string;
}
interface Profile {
  id: string;
  name: string;
  protocol: 'HTTP' | 'HTTPS' | 'SOCKS5';
  host: string;
  port: number;
  username: string;
  password: string;
  status: 'enabled' | 'disabled';
}
interface Configuration {
  schema: 1;
  profiles: Profile[];
  selections: Record<string, ProxySelection>;
}
interface Reference {
  scope: string;
  id: number;
}
export const proxyEnvironmentKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_noproxy',
];
const activeProfiles = new WeakMap<WorkspaceStore, Map<string, number>>();

/** Keep an admission snapshot referenced until its owning operation disposes it. */
export function holdResolvedProxy(
  store: WorkspaceStore,
  profileId: string | null,
) {
  if (!profileId) return () => {};
  let profiles = activeProfiles.get(store);
  if (!profiles) {
    profiles = new Map();
    activeProfiles.set(store, profiles);
  }
  profiles.set(profileId, (profiles.get(profileId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (profiles!.get(profileId) ?? 1) - 1;
    if (remaining) profiles!.set(profileId, remaining);
    else profiles!.delete(profileId);
  };
}

const scopes: ProxyScope[] = ['platform', 'workspace', 'repository', 'task'];
const tables = {
  workspace: 'Workspaces',
  repository: 'Repositories',
  task: 'Tasks',
};
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('PROXY_CONFIGURATION_INVALID', 400);
  return value as Record<string, any>;
}
function text(value: unknown, max = 255, empty = false) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim()) ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail('PROXY_CONFIGURATION_INVALID', 400);
  return value;
}
export function validateProxySelection(value: unknown): ProxySelection {
  const v = object(value);
  if (
    Object.keys(v).some((k) => !['mode', 'profile_id'].includes(k)) ||
    !['INHERIT', 'DIRECT', 'PROFILE'].includes(v.mode)
  )
    fail('PROXY_CONFIGURATION_INVALID', 400);
  if (v.mode === 'PROFILE')
    return { mode: 'PROFILE', profile_id: text(v.profile_id, 100) };
  if (v.profile_id !== undefined && v.profile_id !== null)
    fail('PROXY_CONFIGURATION_INVALID', 400);
  return { mode: v.mode };
}
export function sanitizeProxyOutput(value: string, secrets: readonly string[]) {
  let result = value;
  for (const secret of [...new Set(secrets)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    result = result.split(secret).join('[REDACTED]');
  return result.replace(
    /\b(https?|socks5h?):\/\/[^\s/@]+@/gi,
    '$1://[REDACTED]@',
  );
}

/** Uses the same private SQLite credential boundary as GitCredentials; never returns stored secrets. */
export class ProxyManagement {
  private readonly barrier: PlatformBackupBarrier;
  constructor(
    readonly store: WorkspaceStore,
    barrier?: PlatformBackupBarrier,
    private readonly options: {
      testTarget?: string;
      testProxyCaPath?: string;
    } = {},
  ) {
    this.barrier =
      barrier ??
      new PlatformBackupBarrier(store.dataRoot + '.platform-control');
  }
  private async read(
    tx = this.store,
  ): Promise<{ id?: number; configuration: Configuration }> {
    const rows = await tx.all<{ id: number; info: string }>(
      "SELECT id,info FROM Auths WHERE type='proxyManagement'",
    );
    if (rows.length > 1) fail('PROXY_CONFIGURATION_CORRUPTED', 503);
    if (!rows.length)
      return { configuration: { schema: 1, profiles: [], selections: {} } };
    try {
      const c = JSON.parse(rows[0].info);
      if (
        c.schema !== 1 ||
        !Array.isArray(c.profiles) ||
        !c.selections ||
        typeof c.selections !== 'object'
      )
        fail('PROXY_CONFIGURATION_CORRUPTED', 503);
      return { id: rows[0].id, configuration: c };
    } catch {
      fail('PROXY_CONFIGURATION_CORRUPTED', 503);
    }
  }
  private async write(
    tx: WorkspaceStore,
    state: { id?: number; configuration: Configuration },
  ) {
    const now = new Date().toISOString(),
      encoded = JSON.stringify(state.configuration);
    if (state.id)
      await tx.run('UPDATE Auths SET info=?,updatedAt=? WHERE id=?', [
        encoded,
        now,
        state.id,
      ]);
    else
      await tx.run(
        "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('proxyManagement',?,?,?)",
        [encoded, now, now],
      );
  }
  private async scopeId(tx: WorkspaceStore, scope: ProxyScope, id = 0) {
    if (
      !scopes.includes(scope) ||
      !Number.isSafeInteger(id) ||
      (scope === 'platform' ? id !== 0 : id < 1)
    )
      fail('PROXY_SCOPE_INVALID', 400);
    if (
      scope !== 'platform' &&
      !(await tx.all(`SELECT id FROM ${tables[scope]} WHERE id=?`, [id])).length
    )
      fail('PROXY_SCOPE_NOT_FOUND', 404);
    return `${scope}:${id}`;
  }
  private profile(c: Configuration, id: string) {
    const p = c.profiles.find((p) => p.id === id);
    if (!p) fail('PROXY_PROFILE_NOT_FOUND', 404);
    return p;
  }
  async setSelectionInTransaction(
    tx: WorkspaceStore,
    scope: ProxyScope,
    id: number,
    input: unknown,
  ) {
    const selection = validateProxySelection(input),
      key = await this.scopeId(tx, scope, id),
      state = await this.read(tx);
    if (scope === 'platform' && selection.mode === 'INHERIT')
      fail('PROXY_CONFIGURATION_INVALID', 400);
    if (
      selection.mode === 'PROFILE' &&
      this.profile(state.configuration, selection.profile_id!).status !==
        'enabled'
    )
      fail('PROXY_PROFILE_DISABLED');
    state.configuration.selections[key] = selection;
    await this.write(tx, state);
    return selection;
  }
  async saveSelection(scope: ProxyScope, id: number, input: unknown) {
    return this.barrier.mutation(() =>
      this.store.transaction((tx) =>
        this.setSelectionInTransaction(tx, scope, id, input),
      ),
    );
  }
  async getSelection(scope: ProxyScope, id = 0): Promise<ProxySelection> {
    const key = await this.scopeId(this.store, scope, id),
      state = await this.read();
    return (
      state.configuration.selections[key] ?? {
        mode: scope === 'platform' ? 'DIRECT' : 'INHERIT',
      }
    );
  }
  private async references(
    c: Configuration,
    profileId: string,
  ): Promise<Reference[]> {
    const refs: Reference[] = [];
    if (activeProfiles.get(this.store)?.get(profileId))
      refs.push({ scope: 'in_flight', id: 0 });
    for (const [key, selection] of Object.entries(c.selections)) {
      if (selection.mode !== 'PROFILE' || selection.profile_id !== profileId)
        continue;
      const [scope, value] = key.split(':'),
        id = Number(value);
      if (
        scope === 'platform' ||
        ((scopes as string[]).includes(scope) &&
          (
            await this.store.all(
              `SELECT id FROM ${
                tables[scope as keyof typeof tables]
              } WHERE id=?`,
              [id],
            )
          ).length)
      )
        refs.push({ scope, id });
    }
    for (const [table, column, scope] of [
      ['RuntimeOperations', 'metadata', 'operation'],
      ['TaskRuns', 'source_snapshot', 'task_run'],
    ]) {
      const rows = await this.store.all<{ id: number; value: string | null }>(
        `SELECT id,${column} value FROM ${table} WHERE status IN ('QUEUED','RUNNING','RESOLVING','RETRY_WAIT')`,
      );
      for (const row of rows) {
        try {
          if (JSON.parse(row.value || '{}').proxy_profile_id === profileId)
            refs.push({ scope, id: row.id });
        } catch {
          fail('PROXY_CONFIGURATION_CORRUPTED', 503);
        }
      }
    }
    return refs;
  }
  private async dto(p: Profile, c: Configuration) {
    const { password, ...visible } = p;
    return {
      ...visible,
      has_password: !!password,
      used_by: await this.references(c, p.id),
    };
  }
  async list() {
    const { configuration } = await this.read();
    return Promise.all(
      configuration.profiles.map((p) => this.dto(p, configuration)),
    );
  }
  async save(input: unknown, id?: string) {
    const v = object(input);
    if (
      Object.keys(v).some(
        (k) =>
          ![
            'name',
            'protocol',
            'host',
            'port',
            'username',
            'password',
            'replace_password',
            'status',
          ].includes(k),
      )
    )
      fail('PROXY_CONFIGURATION_INVALID', 400);
    return this.barrier.mutation(() =>
      this.store.transaction(async (tx) => {
        const state = await this.read(tx),
          c = state.configuration,
          old = id ? this.profile(c, id) : undefined;
        const name = text(v.name ?? old?.name).trim(),
          protocol = v.protocol ?? old?.protocol,
          host = text(v.host ?? old?.host).replace(/^\[|\]$/g, ''),
          port = v.port ?? old?.port;
        if (
          !['HTTP', 'HTTPS', 'SOCKS5'].includes(protocol) ||
          !Number.isSafeInteger(port) ||
          port < 1 ||
          port > 65535 ||
          (!isIP(host) &&
            !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/i.test(
              host,
            ))
        )
          fail('PROXY_CONFIGURATION_INVALID', 400);
        if (
          c.profiles.some(
            (p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase(),
          )
        )
          fail('PROXY_NAME_CONFLICT');
        if (
          v.replace_password !== undefined &&
          typeof v.replace_password !== 'boolean'
        )
          fail('PROXY_CONFIGURATION_INVALID', 400);
        if (old && v.password !== undefined && v.replace_password !== true)
          fail('PROXY_CONFIGURATION_INVALID', 400);
        const password =
          !old || v.replace_password === true
            ? text(v.password ?? '', 4096, true)
            : old.password;
        const username = text(v.username ?? old?.username ?? '', 4096, true),
          status = v.status ?? old?.status ?? 'enabled';
        if (
          !['enabled', 'disabled'].includes(status) ||
          (password && !username)
        )
          fail('PROXY_CONFIGURATION_INVALID', 400);
        const p: Profile = {
          id: old?.id ?? randomUUID(),
          name,
          protocol,
          host,
          port,
          username,
          password,
          status,
        };
        if (old) c.profiles[c.profiles.indexOf(old)] = p;
        else c.profiles.push(p);
        await this.write(tx, state);
        return this.dto(p, c);
      }),
    );
  }
  async remove(id: string) {
    return this.barrier.mutation(() =>
      this.store.transaction(async (tx) => {
        const state = await this.read(tx);
        this.profile(state.configuration, id);
        if ((await this.references(state.configuration, id)).length)
          fail('PROXY_PROFILE_IN_USE');
        state.configuration.profiles = state.configuration.profiles.filter(
          (p) => p.id !== id,
        );
        await this.write(tx, state);
        return { deleted: true };
      }),
    );
  }
  async resolve(
    input: {
      workspaceId?: number;
      repositoryId?: number;
      taskId?: number;
      override?: ProxySelection;
    } = {},
  ): Promise<ResolvedProxy> {
    const { configuration: c } = await this.read();
    if (input.taskId !== undefined) {
      const task = (
        await this.store.all<{ workspace_id: number }>(
          'SELECT workspace_id FROM Tasks WHERE id=?',
          [input.taskId],
        )
      )[0];
      if (!task) fail('PROXY_SCOPE_NOT_FOUND', 404);
      if (
        input.workspaceId !== undefined &&
        input.workspaceId !== task.workspace_id
      )
        fail('PROXY_SCOPE_INVALID', 400);
      input = { ...input, workspaceId: task.workspace_id };
    }
    let selected = c.selections['platform:0'] ?? { mode: 'DIRECT' as const };
    let configured = !!c.selections['platform:0'];
    for (const [scope, id] of [
      ['workspace', input.workspaceId],
      ['repository', input.repositoryId],
      ['task', input.taskId],
    ] as const) {
      if (id === undefined) continue;
      const key = await this.scopeId(this.store, scope, id),
        child = c.selections[key];
      if (child && child.mode !== 'INHERIT') {
        selected = child;
        configured = true;
      }
    }
    if (input.override !== undefined) {
      const override = validateProxySelection(input.override);
      if (override.mode !== 'INHERIT') {
        selected = override;
        configured = true;
      }
    }
    if (selected.mode !== 'PROFILE')
      return Object.freeze({
        env: Object.freeze({}),
        secretValues: Object.freeze([]) as unknown as string[],
        profileId: null,
        configured,
      });
    const p = this.profile(c, selected.profile_id!);
    if (p.status !== 'enabled') fail('PROXY_PROFILE_DISABLED');
    const url = new URL(
      `${p.protocol === 'SOCKS5' ? 'socks5h' : p.protocol.toLowerCase()}://${
        isIP(p.host) === 6 ? `[${p.host}]` : p.host
      }:${p.port}`,
    );
    url.username = p.username;
    url.password = p.password;
    const value = url.href,
      secrets =
        p.username || p.password
          ? [
              value,
              `${encodeURIComponent(p.username)}:${encodeURIComponent(
                p.password,
              )}`,
              Buffer.from(`${p.username}:${p.password}`).toString('base64'),
              ...(p.username
                ? [p.username, encodeURIComponent(p.username)]
                : []),
              ...(p.password
                ? [p.password, encodeURIComponent(p.password)]
                : []),
            ]
          : [];
    const env = Object.fromEntries(
      [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
      ].map((k) => [k, value]),
    );
    return Object.freeze({
      env: Object.freeze(env),
      secretValues: Object.freeze(secrets) as unknown as string[],
      profileId: p.id,
      configured,
      url: value,
    });
  }
  async test(id: string) {
    const resolved = await this.resolve({
      override: { mode: 'PROFILE', profile_id: id },
    });
    const target = this.options.testTarget ?? 'https://example.com/';
    const u = new URL(target);
    if (
      u.protocol !== 'https:' &&
      !(
        u.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
      )
    )
      fail('PROXY_TEST_TARGET_INVALID', 400);
    const start = Date.now(),
      release = holdResolvedProxy(this.store, resolved.profileId);
    return new Promise<{
      status: 'SUCCESS' | 'FAILED';
      diagnostic?: string;
      elapsed_ms: number;
    }>((resolve) => {
      const child = spawn(
        '/usr/bin/curl',
        [
          '-q',
          ...(this.options.testProxyCaPath
            ? ['--proxy-cacert', this.options.testProxyCaPath]
            : []),
          '--silent',
          '--show-error',
          '--output',
          '/dev/null',
          '--write-out',
          '%{http_code}',
          '--connect-timeout',
          '5',
          '--max-time',
          '10',
          '--noproxy',
          '',
          '--proto',
          u.protocol === 'https:' ? '=https' : '=http',
          target,
        ],
        {
          env: {
            PATH: '/usr/bin:/bin',
            HOME: '/dev/null',
            CURL_HOME: '/dev/null',
            ...resolved.env,
            NO_PROXY: '',
            no_proxy: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '',
        bytes = 0,
        settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        release();
        const http = Number(output),
          success = code === 0 && http >= 200 && http < 400;
        resolve({
          status: success ? 'SUCCESS' : 'FAILED',
          ...(success
            ? {}
            : {
                diagnostic:
                  http === 407
                    ? 'PROXY_AUTHENTICATION_FAILED'
                    : code === 60
                    ? 'PROXY_TLS_VALIDATION_FAILED'
                    : 'PROXY_CONNECTION_FAILED',
              }),
          elapsed_ms: Date.now() - start,
        });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(null);
      }, 12000);
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4096) child.kill('SIGKILL');
        else output += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4096) child.kill('SIGKILL');
      });
      child.once('error', () => finish(null));
      child.once('close', finish);
    });
  }
}
