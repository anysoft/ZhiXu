import {
  ProxyManagement,
  proxyEnvironmentKeys,
  holdResolvedProxy,
} from '../proxyManagement';
import path from 'path';
import fs from 'fs/promises';
import { freezeExecutionSnapshot } from '../../shared/execution';
import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLease, WorkspaceLeaseService } from '../workspaceV2/lease';
import { fail, WorkspaceFoundationError } from '../workspaceV2/errors';
import type { FaultHook, GitWorkspaceRow } from '../workspaceV2/types';
import { TaskResourceResolver } from './resources';
import { ManagedRuntimeAdapter } from './runtime';
import { WorkspaceRevisionReader } from './materialization';
import type {
  AdmissionSnapshot,
  RunRow,
  SourceSnapshot,
  WorkspaceExecutionContext,
} from './types';

export type SupersededReason =
  | 'SOURCE_CHANGED'
  | 'TASK_CHANGED'
  | 'RESOURCE_CHANGED';
class SupersededError extends WorkspaceFoundationError {
  constructor(readonly reason: SupersededReason) {
    super('SOURCE_SUPERSEDED');
  }
}
function changed(
  expected: AdmissionSnapshot,
  current: AdmissionSnapshot,
): SupersededReason {
  if (
    expected.expected_task_definition_version !==
      current.expected_task_definition_version ||
    expected.workspace_id !== current.workspace_id
  )
    return 'TASK_CHANGED';
  if (
    expected.expected_source_generation !==
      current.expected_source_generation ||
    expected.expected_content_revision !== current.expected_content_revision ||
    expected.expected_inventory_hash !== current.expected_inventory_hash ||
    expected.expected_git_commit !== current.expected_git_commit
  )
    return 'SOURCE_CHANGED';
  return 'RESOURCE_CHANGED';
}

/** Pure admission metadata and lease-protected execution are separate capabilities. */
export class WorkspaceExecutionResolver {
  readonly resources: TaskResourceResolver;
  readonly runtimes: ManagedRuntimeAdapter;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
  ) {
    this.resources = new TaskResourceResolver(store, roots, leases);
    this.runtimes = new ManagedRuntimeAdapter(store);
  }

  async admission(taskId: number): Promise<AdmissionSnapshot> {
    const selected = await this.resources.definition(taskId);
    const ws = await this.store.assertAccessible(selected.workspace.id, false);
    if (ws.lifecycle_state !== 'READY') fail('WORKSPACE_NOT_READY');
    if (
      selected.task.origin === 'DISCOVERED' &&
      selected.task.discovery_state === 'RETIRED'
    )
      fail('TASK_NOT_READY');
    if (!ws.content_inventory_hash) fail('SOURCE_UNVERIFIED');
    if (selected.runtime.kind !== 'SHELL' && !selected.runtime.environmentId)
      fail('CONFIGURATION_REQUIRED');
    if (
      (selected.runtime.kind === 'PYTHON' &&
        !selected.effectiveResourceVersions.python) ||
      (selected.runtime.kind === 'NODE' &&
        !selected.effectiveResourceVersions.node)
    )
      fail('RUNTIME_NOT_READY');
    let commit: string | null = null;
    if (ws.type === 'GIT') {
      const git = (
        await this.store.all<GitWorkspaceRow>(
          'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
          [ws.id],
        )
      )[0];
      if (!git) fail('WORKSPACE_TYPE_INVALID');
      commit =
        git.last_verified_commit || git.applied_commit || git.resolved_commit;
    }
    return {
      workspace_id: ws.id,
      workspace_type: ws.type,
      expected_workspace_version: ws.version,
      expected_source_generation: ws.source_generation,
      expected_content_revision: ws.content_revision,
      expected_task_definition_version: selected.task.version,
      expected_global_env_version:
        selected.effectiveResourceVersions.global_env_version,
      expected_inventory_hash: ws.content_inventory_hash,
      expected_git_commit: commit,
      effective_resource_versions: selected.effectiveResourceVersions,
      relative_entrypoint: selected.source.relative_entrypoint,
      language: selected.source.language,
      cwd_mode: selected.source.cwd_mode,
      cwd_relative_path: selected.source.cwd_relative_path,
    };
  }

  async resolve(run: RunRow, lease: WorkspaceLease, fault?: FaultHook) {
    if (!run.task_id || run.workspace_id !== lease.workspaceId)
      fail('SOURCE_UNVERIFIED');
    const expected = JSON.parse(run.admission_snapshot) as AdmissionSnapshot;
    const task = (
      await this.store.all<{ version: number; workspace_id: number }>(
        'SELECT version,workspace_id FROM Tasks WHERE id=?',
        [run.task_id],
      )
    )[0];
    if (
      !task ||
      task.version !== expected.expected_task_definition_version ||
      task.workspace_id !== expected.workspace_id
    )
      throw new SupersededError('TASK_CHANGED');
    const ws = await this.store.workspace(run.workspace_id);
    if (
      ws.source_generation !== expected.expected_source_generation ||
      ws.content_revision !== expected.expected_content_revision ||
      ws.content_inventory_hash !== expected.expected_inventory_hash
    )
      throw new SupersededError('SOURCE_CHANGED');
    const global = (
      await this.store.all<{ version: number }>(
        'SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1',
      )
    )[0];
    if (
      ws.version !== expected.expected_workspace_version ||
      global.version !== expected.expected_global_env_version
    )
      throw new SupersededError('RESOURCE_CHANGED');
    const current = await this.admission(run.task_id);
    if (JSON.stringify(expected) !== JSON.stringify(current))
      throw new SupersededError(changed(expected, current));
    const selected = await this.resources.resolveUnderLease(run.task_id, lease);
    if (
      selected.inventory.hash !== expected.expected_inventory_hash ||
      (selected.git?.head ?? null) !== expected.expected_git_commit
    )
      fail('SOURCE_SUPERSEDED');
    const entryIdentity = await fs.lstat(selected.entrypoint);
    for (const config of selected.configs) {
      const target = path.join(
        config.binding.target_base === 'WORKSPACE_ROOT'
          ? selected.root
          : selected.cwd,
        config.binding.target_path,
      );
      const identity = await fs
        .lstat(target)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      if (
        target === selected.entrypoint ||
        (identity &&
          identity.dev === entryIdentity.dev &&
          identity.ino === entryIdentity.ino)
      )
        fail('CONFIG_TARGET_CONFLICT');
    }
    await fault?.('AFTER_SOURCE_SNAPSHOT', {
      run_id: run.id,
      workspace_id: run.workspace_id,
    });
    const pinned = await this.runtimes.pin(
      selected.runtime,
      selected.source.language,
    );
    let releaseProxy = () => {};
    try {
      const ids =
        pinned.runtime.kind === 'PYTHON'
          ? expected.effective_resource_versions.python
          : pinned.runtime.kind === 'NODE'
          ? expected.effective_resource_versions.node
          : null;
      if (
        ids &&
        (ids.environment_id !== pinned.runtime.environmentId ||
          ids.build_id !== pinned.runtime.buildId ||
          ids.revision_id !== pinned.runtime.revisionId ||
          ids.runtime_id !== pinned.runtime.runtimeId ||
          ('toolchain_id' in ids &&
            ids.toolchain_id !== pinned.runtime.toolchainId))
      )
        throw new SupersededError('RESOURCE_CHANGED');
      await fault?.('AFTER_RUNTIME_PIN', {
        run_id: run.id,
        workspace_id: run.workspace_id,
      });
      // Pin acquisition can await other owners; definitions must still match afterwards.
      const afterPin = await this.admission(run.task_id);
      if (JSON.stringify(expected) !== JSON.stringify(afterPin))
        throw new SupersededError(changed(expected, afterPin));
      const proxy = await new ProxyManagement(this.store).resolve({
        workspaceId: selected.workspace.id,
        taskId: selected.task.id,
      });
      releaseProxy = holdResolvedProxy(this.store, proxy.profileId);
      const variables = { ...selected.environment.variables };
      const origins = { ...selected.environment.origins };
      if (proxy.configured)
        for (const key of proxyEnvironmentKeys) {
          delete variables[key];
          delete origins[key];
        }
      Object.assign(variables, proxy.env);
      for (const key of Object.keys(proxy.env)) origins[key] = 'SYSTEM';
      const secrets = selected.environment.secretNames
        .map((name) => selected.environment.variables[name])
        .filter(Boolean);
      secrets.push(...proxy.secretValues);
      const reader = new WorkspaceRevisionReader(this.store, this.roots);
      for (const config of selected.configs)
        if (config.is_secret)
          secrets.push(
            (await reader.readRevision(config.revision)).toString('utf8'),
          );
      const git: SourceSnapshot['git'] = selected.git
        ? {
            repository_id: selected.git.repository_id,
            commit: selected.git.head,
            ref_type: selected.git.ref_type,
            ref_name: selected.git.ref_name,
          }
        : null;
      const source: SourceSnapshot = {
        proxy_profile_id: proxy.profileId,
        workspace_id: selected.workspace.id,
        workspace_type: selected.workspace.type,
        source_generation: selected.workspace.source_generation,
        content_revision: selected.workspace.content_revision,
        task_definition_version: selected.task.version,
        inventory_hash: selected.inventory.hash,
        entrypoint_checksum: selected.entrypointHash,
        relative_entrypoint: selected.source.relative_entrypoint,
        cwd_mode: selected.source.cwd_mode,
        cwd_relative_path: selected.source.cwd_relative_path,
        git,
        effective_resource_versions: expected.effective_resource_versions,
      };
      const context: WorkspaceExecutionContext = freezeExecutionSnapshot({
        identity: {
          taskId: selected.task.id,
          taskDefinitionVersion: selected.task.version,
          taskRunId: run.id,
        },
        source: {
          workspaceId: source.workspace_id,
          workspaceType: source.workspace_type,
          sourceGeneration: source.source_generation,
          contentRevision: source.content_revision,
          inventoryHash: source.inventory_hash,
          relativeEntrypoint: source.relative_entrypoint,
          absoluteEntrypoint: selected.entrypoint,
          language: selected.source.language,
          cwd: selected.cwd,
          cwdMode: source.cwd_mode,
          cwdRelativePath: source.cwd_relative_path,
          checksum: source.entrypoint_checksum,
          git,
        },
        runtime: pinned.runtime,
        args: JSON.parse(selected.task.arguments) as string[],
        environmentSnapshot: {
          ...selected.environment,
          variables,
          origins,
          unsetVariables: [
            ...new Set([
              ...selected.environment.unsetVariables.filter(
                (key) => !Object.prototype.hasOwnProperty.call(proxy.env, key),
              ),
              ...(proxy.configured
                ? proxyEnvironmentKeys.filter(
                    (key) =>
                      !Object.prototype.hasOwnProperty.call(proxy.env, key),
                  )
                : []),
            ]),
          ],
          secretNames: [
            ...selected.environment.secretNames,
            ...(proxy.secretValues.length ? Object.keys(proxy.env) : []),
          ],
        },
        configSnapshot: selected.configs,
        hookSnapshot: selected.hooks,
        settings: selected.settings,
        workspace: {
          workspaceRoot: selected.root,
          taskDir: path.dirname(selected.entrypoint),
          cwd: selected.cwd,
          resourceKey: lease.resourceKey,
        },
        secretValues: [...new Set(secrets.filter(Boolean))],
      });
      return {
        context,
        source,
        pins: pinned.leases,
        release: async () => {
          try {
            await pinned.release();
          } finally {
            releaseProxy();
          }
        },
      };
    } catch (error) {
      releaseProxy();
      await pinned.release();
      throw error;
    }
  }
}
