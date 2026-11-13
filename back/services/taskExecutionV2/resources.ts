import fs from 'fs/promises';
import path from 'path';
import { constants } from 'fs';
import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLease, WorkspaceLeaseService } from '../workspaceV2/lease';
import { inspectGitWorkspace } from '../workspaceV2/gitStorage';
import type { GitWorkspaceRow } from '../workspaceV2/types';
import { scanWorkspace, relativeWorkspacePath } from '../workspaceV2/inventory';
import { fail, errorCode } from '../workspaceV2/errors';
import { hashFile, privateDirectory } from '../backup/files';
import { targetPath } from '../../shared/configAssets';
import { assertWorkspaceJournalIsolation } from '../workspaceV2/journals';
import { workspaceLimits } from '../workspaceV2/limits';
import { runtimeKind } from '../../shared/taskDefinition';
import {
  loadTaskDefinition,
  WorkspaceTaskSource,
  ConfigBindingRow,
  TaskDefinition,
} from './task';
import { WorkspaceEnvironmentService } from './environment';
import { ManagedRuntimeAdapter } from './runtime';
import type { CandidateResolvedConfig, ResourceVersions } from './types';

/** Called only inside the candidate Workspace EX lease; never changes source bytes. */
export async function validateSourceUnderLease(
  store: WorkspaceStore,
  roots: WorkspaceRootResolver,
  source: WorkspaceTaskSource,
  lease: WorkspaceLease,
) {
  const ws = await store.assertAccessible(source.workspace_id, false);
  if (ws.lifecycle_state !== 'READY') fail('WORKSPACE_NOT_READY');
  const owned = await roots.requireReady(ws, lease);
  await assertWorkspaceJournalIsolation(store, roots, source.workspace_id);
  const inventory = await scanWorkspace(owned.root, ws.type);
  const entry = inventory.entries.find(
    (e) => e.path === source.relative_entrypoint && e.kind === 'file',
  );
  if (!entry || !entry.sha256) fail('SOURCE_MISSING');
  const entrypoint = path.join(owned.root, source.relative_entrypoint);
  const descriptor = await fs.open(
    entrypoint,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await descriptor.stat(),
      named = await fs.lstat(entrypoint);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      (process.getuid && opened.uid !== process.getuid())
    )
      fail('SOURCE_UNVERIFIED');
  } finally {
    await descriptor.close();
  }
  const cwd =
    source.cwd_mode === 'WORKSPACE_ROOT'
      ? owned.root
      : source.cwd_mode === 'CUSTOM_RELATIVE'
      ? path.join(owned.root, relativeWorkspacePath(source.cwd_relative_path!))
      : path.dirname(entrypoint);
  let cursor = owned.root;
  for (const part of path
    .relative(owned.root, cwd)
    .split(path.sep)
    .filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') fail('SOURCE_MISSING');
      throw e;
    });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      fail('WORKSPACE_PATH_FORBIDDEN');
  }
  await roots.requireOwned(ws);
  await lease.assertHeld();
  const gitRow =
    ws.type === 'GIT'
      ? (
          await store.all<GitWorkspaceRow>(
            'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
            [ws.id],
          )
        )[0]
      : undefined;
  if (ws.type === 'GIT' && !gitRow) fail('WORKSPACE_TYPE_INVALID');
  const git = gitRow
    ? await inspectGitWorkspace(store, store.dataRoot, ws, gitRow, {
        repair: false,
        leaseFds: lease.processLeaseFds,
      })
    : null;
  return {
    workspace: ws,
    root: owned.root,
    entrypoint,
    cwd,
    entrypointHash: entry.sha256,
    inventory,
    git,
  };
}
interface RuntimeChoice {
  kind: 'PYTHON' | 'NODE' | 'SHELL';
  environmentId: number | null;
  selectedBy: 'TASK' | 'WORKSPACE' | 'NONE';
}
export class TaskResourceResolver {
  readonly environments: WorkspaceEnvironmentService;
  readonly managed: ManagedRuntimeAdapter;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
  ) {
    this.environments = new WorkspaceEnvironmentService(store, roots, leases);
    this.managed = new ManagedRuntimeAdapter(store);
  }
  private async configs(
    definition: TaskDefinition,
  ): Promise<CandidateResolvedConfig[]> {
    const effective = new Map<
      string,
      { row: ConfigBindingRow; source: 'WORKSPACE' | 'TASK' }
    >();
    const workspace = await this.store.all<ConfigBindingRow>(
      'SELECT * FROM WorkspaceConfigBindings WHERE workspace_id=? ORDER BY target_base,target_path,id',
      [definition.task.workspace_id],
    );
    for (const [rows, source] of [
      [workspace, 'WORKSPACE'],
      [definition.configBindings, 'TASK'],
    ] as const)
      for (const row of rows) {
        if (!row.enabled) continue;
        targetPath(row.target_path);
        if (
          !['WORKSPACE_ROOT', 'TASK_CWD'].includes(row.target_base) ||
          row.target_path.split('/').includes('node_modules')
        )
          fail('CONFIG_BINDING_INVALID');
        const key = row.target_base + ':' + row.target_path;
        if (row.operation === 'MASK') effective.delete(key);
        else effective.set(key, { row, source });
      }
    if (effective.size > workspaceLimits().maxWorkspaceEntries)
      fail('WORKSPACE_QUOTA_EXCEEDED');
    const output: CandidateResolvedConfig[] = [];
    for (const { row, source } of effective.values()) {
      const asset = (
        await this.store.all<{
          id: number;
          name: string;
          is_secret: number;
          current_revision_id: number | null;
        }>(
          'SELECT id,name,is_secret,current_revision_id FROM ConfigAssets WHERE id=?',
          [row.asset_id],
        )
      )[0];
      const revisionId = row.revision_id ?? asset?.current_revision_id;
      if (!asset || !revisionId) fail('CONFIG_REVISION_NOT_FOUND');
      const revision = (
        await this.store.all<CandidateResolvedConfig['revision']>(
          'SELECT * FROM ConfigAssetRevisions WHERE id=? AND asset_id=?',
          [revisionId, asset.id],
        )
      )[0];
      if (!revision) fail('CONFIG_REVISION_NOT_FOUND');
      output.push({
        asset_id: asset.id,
        asset_name: asset.name,
        is_secret: !!asset.is_secret,
        revision_id: revision.id,
        revision,
        binding: { ...row, writable: !!row.writable, enabled: !!row.enabled },
        source,
      });
    }
    return output;
  }
  private async runtime(definition: TaskDefinition): Promise<RuntimeChoice> {
    const kind = runtimeKind(definition.source.language);
    const task = definition.runtimeBinding;
    if (task && task.kind !== kind) fail('TASK_RUNTIME_KIND_MISMATCH');
    if (kind === 'SHELL')
      return { kind, environmentId: null, selectedBy: task ? 'TASK' : 'NONE' };
    const override =
      kind === 'PYTHON'
        ? task?.python_environment_id
        : task?.node_environment_id;
    if (override) return { kind, environmentId: override, selectedBy: 'TASK' };
    const defaults = (
      await this.store.all<{
        python_environment_id: number | null;
        node_environment_id: number | null;
      }>(
        'SELECT * FROM WorkspaceRuntimeDefaults WHERE workspace_id=? AND kind=?',
        [definition.task.workspace_id, kind],
      )
    )[0];
    const environmentId =
      (kind === 'PYTHON'
        ? defaults?.python_environment_id
        : defaults?.node_environment_id) ?? null;
    return {
      kind,
      environmentId,
      selectedBy: environmentId ? 'WORKSPACE' : 'NONE',
    };
  }
  /** Pure database admission snapshot: no OS locks, FSwalk, Runtime install or materialization. */
  async definition(taskId: number) {
    return this.store.transaction(async () => {
      const definition = await loadTaskDefinition(this.store, taskId),
        workspace = await this.store.workspace(definition.task.workspace_id);
      const environment = await this.environments.resolve(taskId);
      const configs = await this.configs(definition);
      const runtime = await this.runtime(definition);
      const versions: ResourceVersions = {
        global_env_version: (
          await this.store.all<{ version: number }>(
            'SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1',
          )
        )[0].version,
        system_allowlist_build_version: 'workspace-env-v1',
        profile: environment.profile
          ? { id: environment.profile.id, version: environment.profile.version }
          : null,
        python: null,
        node: null,
        config_revisions: configs.map((c) => ({
          asset_id: c.asset_id,
          revision_id: c.revision_id,
          binding_id: c.binding.id,
          binding_version: c.binding.version,
        })),
      };
      if (runtime.environmentId !== null) {
        const prefix = runtime.kind === 'PYTHON' ? 'Python' : 'Node';
        const env = (
          await this.store.all<{
            id: number;
            current_revision_id: number | null;
            current_build_id: number | null;
            runtime_id: number;
          }>(`SELECT * FROM ${prefix}Environments WHERE id=?`, [
            runtime.environmentId,
          ])
        )[0];
        if (env?.current_revision_id && env.current_build_id) {
          const build = (
            await this.store.all<{
              revision_id: number;
              runtime_id: number;
              toolchain_id: number;
            }>(
              `SELECT * FROM ${prefix}EnvironmentBuilds WHERE id=? AND environment_id=?`,
              [env.current_build_id, env.id],
            )
          )[0];
          if (build) {
            const ids = {
              environment_id: env.id,
              revision_id: build.revision_id,
              build_id: env.current_build_id,
              runtime_id: build.runtime_id,
            };
            if (runtime.kind === 'PYTHON') versions.python = ids;
            else versions.node = { ...ids, toolchain_id: build.toolchain_id };
          }
        }
      }
      const hooks = definition.hooks
        .filter((h) => h.enabled)
        .map((h) => ({ ...h, enabled: !!h.enabled }));
      return {
        ...definition,
        definition,
        workspace,
        environment,
        configs,
        runtime,
        hooks,
        settings: definition.settings,
        effectiveResourceVersions: versions,
      };
    });
  }
  metadata(taskId: number) {
    return this.definition(taskId);
  }
  async resolveUnderLease(taskId: number, lease: WorkspaceLease) {
    const selected = await this.definition(taskId);
    if (
      selected.task.origin === 'DISCOVERED' &&
      selected.task.discovery_state === 'RETIRED'
    )
      fail('TASK_NOT_READY');
    const source = await validateSourceUnderLease(
      this.store,
      this.roots,
      selected.source,
      lease,
    );
    if (source.inventory.hash !== source.workspace.content_inventory_hash)
      fail('SOURCE_SUPERSEDED');
    const git = source.git;
    for (const c of selected.configs) {
      const canonical = `asset-${c.revision.asset_id}/revisions/${c.revision.revision_number}/content`;
      if (
        c.revision.storage_key !== canonical &&
        c.revision.storage_key !== 'config-assets/' + canonical
      )
        fail('CONFIG_REVISION_INVALID');
      const file = path.join(this.store.dataRoot, 'config-assets', canonical);
      await privateDirectory(path.dirname(file));
      const actual = await hashFile(file);
      if (
        actual.sha256 !== c.revision.checksum ||
        actual.size !== c.revision.size
      )
        fail('CONFIG_ASSET_INTEGRITY_FAILED');
    }
    return { ...selected, ...source, git };
  }
  async readiness(taskId: number) {
    try {
      const definition = await loadTaskDefinition(this.store, taskId);
      return await this.leases.withWorkspace(
        definition.task.workspace_id,
        'TASK_READINESS',
        async (lease) => {
          const selected = await this.resolveUnderLease(taskId, lease);
          await this.managed.inspect(
            selected.runtime.kind,
            selected.runtime.environmentId,
            selected.source.language,
          );
          return {
            status: 'READY' as const,
            diagnostics: [],
            source_checked: true,
            runtime: { ...selected.runtime },
            workspace_id: selected.workspace.id,
            workspace_type: selected.workspace.type,
          };
        },
      );
    } catch (error) {
      const code = errorCode(error);
      const status =
        code === 'CONFIGURATION_REQUIRED'
          ? 'CONFIGURATION_REQUIRED'
          : code === 'SOURCE_MISSING'
          ? 'SOURCE_MISSING'
          : code.includes('RECOVERY')
          ? 'RECOVERY_REQUIRED'
          : 'RESOURCE_UNAVAILABLE';
      return {
        status,
        diagnostics: [
          {
            code:
              code === 'WORKSPACE_OPERATION_FAILED' ? 'TASK_NOT_READY' : code,
          },
        ],
        source_checked: false,
      };
    }
  }
}
