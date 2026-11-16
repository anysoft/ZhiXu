import { hasHistoryQuery, historyQueryKeys } from '../shared/historyQuery';
import type { ProxySelection } from '../services/proxyManagement';
import type { Router } from 'express';
import pythonEnvironmentRoutes from '../api/pythonEnvironment';
import nodeEnvironmentRoutes from '../api/nodeEnvironment';
import { operationDto } from '../api/runtime';
import RuntimeOperationLog from '../services/runtimeLog';
import type { OperationType } from '../data/runtime';
import type { ApiCall, ApiHandler, RouteMap, V2Services } from './types';
import type { CandidateRuntimeDomain } from './runtimeDomain';
import { runtimeEnvironmentReferences } from '../services/runtimeDomainScope';
import { fail } from '../services/workspaceV2/errors';
import { object, pathId, number, text, choice } from './taskValidation';

/** Runtime DTOs retain logical resource fields; private executable/root/owner data stays internal. */
export function publicRuntimeValue(value: unknown, dataRoot: string): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return value
      .map((item) => publicRuntimeValue(item, dataRoot))
      .filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        /(?:secret|password|credential|authorization|owner_token|owner_pid|log_identity)/i.test(
          key,
        ) ||
        [
          'root',
          'root_path',
          'root_key',
          'install_root',
          'canonical_root',
          'executable',
          'prefix',
          'venv_path',
          'node_modules_root',
          'nodeModulesRoot',
          'path_entries',
          'python_path_entries',
          'node_path_entries',
        ].includes(key)
      )
        continue;
      const safe = publicRuntimeValue(item, dataRoot);
      if (safe !== undefined) result[key] = safe;
    }
    return result;
  }
  if (typeof value === 'string') {
    let safe = value.split(dataRoot).join('<managed-resource>');
    // Consume public URLs before paths so their slash-separated resource names survive.
    safe = safe.replace(
      /https?:\/\/[^\s'"\]\[()<>]+|(?<![A-Za-z0-9/])\/[^\s'"\]\[()<>]*/g,
      (item) =>
        /^https?:\/\//.test(item)
          ? item.replace(/^(https?:\/\/)[^\s/@]+@/, '$1<redacted>@')
          : '<managed-resource>',
    );
    return safe;
  }
  return value;
}
function options(body: unknown, install = false) {
  const b = object(
    body ?? {},
    ['jobs', 'timeout_seconds', 'proxy', ...(install ? ['version'] : [])],
    install ? ['version'] : [],
  );
  return {
    ...(b.proxy === undefined ? {} : { proxy: b.proxy as ProxySelection }),
    ...(b.jobs === undefined ? {} : { jobs: number(b.jobs, 1, 16) }),
    ...(b.timeout_seconds === undefined
      ? {}
      : { timeout_seconds: number(b.timeout_seconds, 1, 7200) }),
    ...(install ? { version: text(b.version, 20) } : {}),
  };
}

/** Reuse actual retained validators and handlers; registration never starts recovery. */
export function runtimeApiRoutes(
  s: V2Services,
  domain: CandidateRuntimeDomain,
): RouteMap {
  const routes: RouteMap = {};
  const add = (method: string, path: string, handler: any) => {
    routes[`${method} ${path}`] = {
      status: 'IMPLEMENTED',
      service: 'ScopedRuntimeOperationService',
      responseDto:
        'CURRENT_RUNTIME_RESPONSE (safe managed resource projection)',
      handle: async (call) =>
        domain.run(async () => {
          for (const value of Object.values(call.params)) pathId(value);
          const allowed = path.endsWith('/diff')
            ? ['from', 'to']
            : path === '/runtime/operations'
            ? ['language', ...historyQueryKeys]
            : [];
          object(call.query, allowed);
          if (call.query.language !== undefined)
            choice(call.query.language, ['PYTHON', 'NODE']);
          if (path.endsWith('/diff'))
            for (const name of ['from', 'to'])
              if (call.query[name] !== undefined) pathId(call.query[name]);
          let status = 200,
            payload: any;
          const response: any = {
            status(code: number) {
              status = code;
              return response;
            },
            send(value: unknown) {
              payload = value;
              return response;
            },
          };
          await handler(
            {
              params: call.params,
              query: call.query,
              body: call.body ?? {},
              originalUrl: '/api' + path,
            },
            response,
          );
          if (!payload || status >= 400) {
            const code =
              typeof payload?.message === 'string' &&
              /^[A-Z][A-Z0-9_]+$/.test(payload.message)
                ? payload.message
                : 'RUNTIME_OPERATION_FAILED';
            fail(code, status >= 400 ? status : 500);
          }
          (
            call as ApiCall & { setStatus?: (status: 200 | 202) => void }
          ).setStatus?.(status === 202 ? 202 : 200);
          return publicRuntimeValue(payload.data, s.store.dataRoot);
        }),
    };
  };
  const registrar: any = Object.fromEntries(
    ['get', 'post', 'patch', 'delete'].map((method) => [
      method,
      (path: string, handler: any) => add(method.toUpperCase(), path, handler),
    ]),
  );
  // Do not invoke runtimeRoutes(): its v9 default owns eager recovery startup.
  // These two registration functions receive the real explicitly bound domain.
  domain.run(() =>
    pythonEnvironmentRoutes(registrar as Router, domain.operations),
  );
  domain.run(() =>
    nodeEnvironmentRoutes(registrar as Router, domain.operations),
  );
  const expose = (key: string, action: ApiHandler, accepted = false) => {
    routes[key] = {
      status: 'IMPLEMENTED',
      service: 'ScopedRuntimeOperationService',
      responseDto: accepted
        ? 'CURRENT_RUNTIME_OPERATION_RESPONSE'
        : 'CURRENT_RUNTIME_RESPONSE (safe managed resource projection)',
      handle: (c) =>
        domain.run(async () => {
          for (const value of Object.values(c.params)) pathId(value);
          object(
            c.query,
            key === 'GET /runtime/python/operations' ? historyQueryKeys : [],
          );
          if (accepted)
            (
              c as ApiCall & { setStatus?: (status: 200 | 202) => void }
            ).setStatus?.(202);
          return publicRuntimeValue(await action(c), s.store.dataRoot);
        }),
    };
  };
  const base = '/runtime/python',
    runtime = domain.operations;
  expose(`GET ${base}/provider`, async () => runtime.providerHealth());
  expose(`GET ${base}/catalog`, async () => {
    const p = await runtime.getProvider();
    return {
      versions: p.catalog,
      provider_revision: p.provider_revision,
      last_refresh_at: p.last_refresh_at,
    };
  });
  expose(`GET ${base}/installations`, async () => runtime.runtimes());
  expose(`GET ${base}/diagnostics`, async () => ({
    ...(await runtime.diagnostics.inspect()),
    filesystem: await runtime.filesystemDiagnostics(),
  }));
  for (const [action, type] of Object.entries({
    setup: 'PROVIDER_INSTALL',
    update: 'PROVIDER_UPDATE',
    verify: 'PROVIDER_VERIFY',
    repair: 'PROVIDER_REPAIR',
    catalog: 'CATALOG_REFRESH',
  }))
    expose(
      `POST ${base}/provider/${action}`,
      async (c) =>
        operationDto(
          await runtime.request(type as OperationType, options(c.body)),
        ),
      true,
    );
  expose(
    `POST ${base}/installations`,
    async (c) =>
      operationDto(
        await runtime.request('RUNTIME_INSTALL', options(c.body, true)),
      ),
    true,
  );
  for (const [action, type] of Object.entries({
    verify: 'RUNTIME_VERIFY',
    repair: 'RUNTIME_REPAIR',
  }))
    expose(
      `POST ${base}/installations/:id/${action}`,
      async (c) =>
        operationDto(
          await runtime.request(type as OperationType, {
            ...options(c.body),
            runtime_id: pathId(c.params.id),
          }),
        ),
      true,
    );
  expose(`GET ${base}/installations/:id/references`, async (c) => {
    const r = await runtime.runtime(pathId(c.params.id));
    return runtime.references.inspect(r.id);
  });
  expose(
    `DELETE ${base}/installations/:id`,
    async (c) =>
      operationDto(
        await runtime.request('RUNTIME_REMOVE', {
          ...options(c.body),
          runtime_id: pathId(c.params.id),
        }),
      ),
    true,
  );
  expose(`GET ${base}/operations`, async (c) => {
    if (!hasHistoryQuery(c.query))
      return (await runtime.operations()).map(operationDto);
    const result = await runtime.operations({ ...c.query, language: 'PYTHON' });
    return { ...result, items: result.items.map(operationDto) };
  });
  expose(`GET ${base}/operations/:id`, async (c) =>
    operationDto(await runtime.operation(pathId(c.params.id))),
  );
  expose(`GET ${base}/operations/:id/log`, async (c) =>
    runtime.operationLog(pathId(c.params.id)),
  );
  expose(`POST ${base}/operations/:id/cancel`, async (c) => {
    options(c.body);
    return operationDto(await runtime.cancel(pathId(c.params.id)));
  });
  for (const [kind, prefix] of [
    ['PYTHON', '/runtime/python/environments'],
    ['NODE', '/runtime/node/environments'],
  ] as const)
    expose(`GET ${prefix}/:id/references`, async (c) =>
      runtimeEnvironmentReferences(kind, pathId(c.params.id)),
    );
  return routes;
}
