import { WorkspaceStore } from './workspaceV2/store';
import { fail } from './workspaceV2/errors';
import {
  ProxyManagement,
  proxyEnvironmentKeys,
  holdResolvedProxy,
} from './proxyManagement';
import type { GitAccessContext } from './gitCredentialResolver';

/** Operation-private native Git configuration, never a system/global gitconfig. */
export async function applyGitProxy(
  access: GitAccessContext,
  store: WorkspaceStore,
  repositoryId?: number,
  workspaceId?: number,
): Promise<GitAccessContext> {
  try {
    const resolved = await new ProxyManagement(store).resolve({
      repositoryId,
      workspaceId,
    });
    const release = holdResolvedProxy(store, resolved.profileId);
    const cleanup = access.cleanup;
    access.cleanup = async () => {
      try {
        await cleanup();
      } finally {
        release();
      }
    };
    if (resolved.profileId && /^(ssh:\/\/|[^/]+@[^/]+:)/.test(access.remote))
      fail('PROXY_SSH_UNSUPPORTED', 400);
    for (const key of proxyEnvironmentKeys) delete access.env[key];
    Object.assign(access.env, resolved.env);
    const index = Number(access.env.GIT_CONFIG_COUNT || 0);
    access.env.GIT_CONFIG_COUNT = String(index + 1);
    access.env[`GIT_CONFIG_KEY_${index}`] = 'http.proxy';
    access.env[`GIT_CONFIG_VALUE_${index}`] = resolved.url || '';
    access.secrets.push(...resolved.secretValues);
    return access;
  } catch (error) {
    await access.cleanup();
    throw error;
  }
}
