import { currentRuntimeDomain } from './runtimeDomainScope';
import {
  ProxyManagement,
  ProxySelection,
  holdResolvedProxy,
} from './proxyManagement';
import { RuntimeError } from '../shared/runtime';

/** Kept in the operation owner, never serialized into RuntimeOperation metadata. */
export interface RuntimeProxySnapshot {
  env: Record<string, string>;
  secretValues: string[];
  profileId: string | null;
  release?: () => void;
}
export async function resolveRuntimeProxy(
  override?: ProxySelection,
): Promise<RuntimeProxySnapshot> {
  const store = currentRuntimeDomain()?.store;
  if (!store) {
    if (override !== undefined) throw new RuntimeError('PROXY_CONFIGURATION_UNAVAILABLE');
    return { env: {}, secretValues: [], profileId: null };
  }
  const resolved = await new ProxyManagement(store).resolve({ override });
  return {
    env: Object.freeze({ ...resolved.env }),
    secretValues: [...resolved.secretValues],
    profileId: resolved.profileId,
    release: holdResolvedProxy(store, resolved.profileId),
  };
}
