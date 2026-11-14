import type { WorkspaceStore } from './workspaceV2/store';
import { VerifiedRuntimeArtifactStore } from './runtimeArtifacts';
import { RuntimeError } from '../shared/runtime';

// Boot configuration for this exact database owner. This is never runtime state
// or a current/global domain, and reopening the same DATA creates no binding.
const policies = new WeakMap<
  WorkspaceStore,
  {
    artifacts: VerifiedRuntimeArtifactStore;
    registrations: Set<object>;
  }
>();

export function bindRuntimeArtifacts(
  store: WorkspaceStore,
  artifacts: VerifiedRuntimeArtifactStore,
): () => void {
  if (
    !(artifacts instanceof VerifiedRuntimeArtifactStore) ||
    !Object.isFrozen(artifacts) ||
    store.dataRoot !== artifacts.dataRoot
  )
    throw new RuntimeError('RUNTIME_ARTIFACT_DOMAIN_MISMATCH');
  let binding = policies.get(store);
  if (binding && binding.artifacts !== artifacts)
    throw new RuntimeError('RUNTIME_ARTIFACT_DOMAIN_MISMATCH');
  if (!binding) {
    binding = { artifacts, registrations: new Set() };
    policies.set(store, binding);
  }
  const registration = {};
  binding.registrations.add(registration);
  return () => {
    if (policies.get(store) !== binding) return;
    binding!.registrations.delete(registration);
    if (!binding!.registrations.size) policies.delete(store);
  };
}

export function runtimeArtifactsFor(store: WorkspaceStore) {
  return policies.get(store)?.artifacts;
}
