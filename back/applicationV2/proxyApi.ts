import { ProxyManagement, ProxyScope } from '../services/proxyManagement';
import type { V2Services, RouteMap } from './types';
import { fail } from '../services/workspaceV2/errors';

export function proxyApiRoutes(s: V2Services): RouteMap {
  const manager = new ProxyManagement(s.store, s.leases.barrier);
  const scope = (value: string): ProxyScope => {
    if (!['platform', 'workspace', 'repository', 'task'].includes(value))
      fail('PROXY_SCOPE_INVALID', 400);
    return value as ProxyScope;
  };
  const id = (value: string) => {
    if (
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      fail('PROXY_SCOPE_INVALID', 400);
    return Number(value);
  };
  const selected = async (type: ProxyScope, resourceId: number) => {
    const selection = await manager.getSelection(type, resourceId);
    try {
      let workspaceId: number | undefined;
      if (type === 'task')
        workspaceId = (
          await s.store.all<{ workspace_id: number }>(
            'SELECT workspace_id FROM Tasks WHERE id=?',
            [resourceId],
          )
        )[0]?.workspace_id;
      const resolved = await manager.resolve({
        ...(type === 'workspace'
          ? { workspaceId: resourceId }
          : workspaceId
          ? { workspaceId }
          : {}),
        ...(type === 'repository' ? { repositoryId: resourceId } : {}),
        ...(type === 'task' ? { taskId: resourceId } : {}),
      });
      return { selection, effective: { profile_id: resolved.profileId } };
    } catch (error) {
      const code = (error as { error_code?: string }).error_code;
      if (!code?.startsWith('PROXY_')) throw error;
      return {
        selection,
        effective: {
          profile_id: selection.profile_id ?? null,
          error_code: code,
        },
      };
    }
  };
  return {
    'GET /proxy-profiles': async () => manager.list(),
    'POST /proxy-profiles': async ({ body }) => manager.save(body),
    'PUT /proxy-profiles/:id': async ({ params, body }) =>
      manager.save(body, params.id),
    'DELETE /proxy-profiles/:id': async ({ params }) =>
      manager.remove(params.id),
    'POST /proxy-profiles/:id/test': async ({ params, body }) => {
      if (Object.keys(body ?? {}).length)
        fail('PROXY_CONFIGURATION_INVALID', 400);
      return manager.test(params.id);
    },
    'GET /proxy-selections/:scope/:id': async ({ params }) =>
      selected(scope(params.scope), id(params.id)),
    'PUT /proxy-selections/:scope/:id': async ({ params, body }) => {
      const type = scope(params.scope),
        resourceId = id(params.id);
      await manager.saveSelection(type, resourceId, body);
      return selected(type, resourceId);
    },
  };
}
