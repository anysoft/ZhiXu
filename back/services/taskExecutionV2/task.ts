import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLeaseService } from '../workspaceV2/lease';
import { fail, positiveId } from '../workspaceV2/errors';
import { relativeWorkspacePath } from '../workspaceV2/inventory';
import {
  taskArguments,
  taskLanguage,
  taskSettings,
  runtimeKind,
} from '../../shared/taskDefinition';

export type TaskLanguage = 'PYTHON' | 'JAVASCRIPT' | 'TYPESCRIPT' | 'SHELL';
export interface WorkspaceTaskSource {
  type: 'WORKSPACE_ENTRYPOINT';
  workspace_id: number;
  relative_entrypoint: string;
  language: TaskLanguage;
  cwd_mode: 'WORKSPACE_ROOT' | 'ENTRYPOINT_DIR' | 'CUSTOM_RELATIVE';
  cwd_relative_path: string | null;
}
export interface RuntimeBinding {
  kind: 'PYTHON' | 'NODE' | 'SHELL';
  python_environment_id: number | null;
  node_environment_id: number | null;
}
export type ExecutionSettings = ReturnType<typeof taskSettings>;
export interface TaskRow {
  id: number;
  workspace_id: number;
  name: string;
  description: string;
  enabled: number;
  origin: 'MANUAL' | 'DISCOVERED';
  discovered_workspace_id: number | null;
  discovery_key: string | null;
  discovery_definition: string | null;
  discovery_state: 'ACTIVE' | 'RETIRED';
  env_profile_id: number | null;
  arguments: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface VariableRow {
  id: number;
  task_id?: number;
  profile_id?: number;
  name: string;
  value: string | null;
  operation: 'SET' | 'UNSET';
  status: 'enabled' | 'disabled';
  is_secret: number;
  position: number;
}
export interface ConfigBindingRow {
  id: number;
  task_id?: number;
  workspace_id?: number;
  asset_id: number | null;
  revision_id: number | null;
  operation: 'ATTACH' | 'MASK';
  target_base: 'WORKSPACE_ROOT' | 'TASK_CWD';
  target_path: string;
  materialization_mode: 'COPY' | 'SYMLINK';
  conflict_policy: 'FAIL_IF_EXISTS' | 'BACKUP_AND_RESTORE';
  writable: number;
  enabled: number;
  version: number;
}
export interface HookRow {
  id: number;
  task_id: number;
  name: string;
  phase: 'BEFORE' | 'AFTER_SUCCESS' | 'AFTER_FAILURE' | 'FINALLY';
  command: string;
  cwd_base: 'TASK_CWD' | 'WORKSPACE_ROOT';
  position: number;
  timeout_seconds: number;
  failure_policy: 'FAIL_EXECUTION' | 'CONTINUE';
  enabled: number;
  version: number;
}
export interface TaskDefinition {
  task: TaskRow;
  source: WorkspaceTaskSource;
  runtimeBinding: RuntimeBinding | null;
  settings: ExecutionSettings;
  variables: VariableRow[];
  configBindings: ConfigBindingRow[];
  hooks: HookRow[];
}
export interface TaskWrite {
  name: string;
  description?: string;
  enabled?: boolean;
  arguments?: string[];
  source: WorkspaceTaskSource;
  runtime?: RuntimeBinding | null;
  execution?: Partial<ExecutionSettings>;
  env_profile_id?: number | null;
}
export interface DiscoveredIdentity {
  discovered_workspace_id: number;
  discovery_key: string;
  discovery_definition: Record<string, unknown>;
}

export function normalizedSource(
  input: WorkspaceTaskSource,
): WorkspaceTaskSource {
  if (
    !input ||
    input.type !== 'WORKSPACE_ENTRYPOINT' ||
    !['PYTHON', 'JAVASCRIPT', 'TYPESCRIPT', 'SHELL'].includes(input.language) ||
    !['WORKSPACE_ROOT', 'ENTRYPOINT_DIR', 'CUSTOM_RELATIVE'].includes(
      input.cwd_mode,
    )
  )
    fail('TASK_SOURCE_INVALID', 400);
  positiveId(input.workspace_id);
  const relative_entrypoint = relativeWorkspacePath(input.relative_entrypoint);
  if (taskLanguage(relative_entrypoint) !== input.language)
    fail('TASK_LANGUAGE_MISMATCH', 400);
  const cwd_relative_path =
    input.cwd_mode === 'CUSTOM_RELATIVE'
      ? relativeWorkspacePath(input.cwd_relative_path!)
      : null;
  if (input.cwd_mode !== 'CUSTOM_RELATIVE' && input.cwd_relative_path != null)
    fail('TASK_CWD_INVALID', 400);
  return {
    type: 'WORKSPACE_ENTRYPOINT',
    workspace_id: input.workspace_id,
    relative_entrypoint,
    language: input.language,
    cwd_mode: input.cwd_mode,
    cwd_relative_path,
  };
}
export function normalizedRuntime(
  input: RuntimeBinding | null | undefined,
  language: TaskLanguage,
): RuntimeBinding | null {
  if (input == null) return null;
  if (input.kind !== runtimeKind(language))
    fail('TASK_RUNTIME_KIND_MISMATCH', 400);
  const py = input.python_environment_id ?? null,
    node = input.node_environment_id ?? null;
  for (const id of [py, node]) if (id !== null) positiveId(id);
  if (
    (input.kind !== 'PYTHON' && py !== null) ||
    (input.kind !== 'NODE' && node !== null)
  )
    fail('TASK_RUNTIME_BINDING_INVALID', 400);
  return {
    kind: input.kind,
    python_environment_id: py,
    node_environment_id: node,
  };
}
export async function loadTaskDefinition(
  store: WorkspaceStore,
  id: number,
): Promise<TaskDefinition> {
  const task = (
    await store.all<TaskRow>('SELECT * FROM Tasks WHERE id=?', [positiveId(id)])
  )[0];
  if (!task) fail('TASK_NOT_FOUND', 404);
  const source = (
    await store.all<WorkspaceTaskSource>(
      'SELECT * FROM TaskSources WHERE task_id=?',
      [id],
    )
  )[0];
  const settings = (
    await store.all<ExecutionSettings>(
      'SELECT * FROM TaskExecutionSettings WHERE task_id=?',
      [id],
    )
  )[0];
  if (!source || !settings) fail('TASK_NOT_READY');
  return {
    task,
    source: normalizedSource(source),
    runtimeBinding:
      (
        await store.all<RuntimeBinding>(
          'SELECT * FROM TaskRuntimeBindings WHERE task_id=?',
          [id],
        )
      )[0] ?? null,
    settings: taskSettings(settings),
    variables: await store.all<VariableRow>(
      'SELECT * FROM TaskEnvVariables WHERE task_id=? ORDER BY position,id',
      [id],
    ),
    configBindings: await store.all<ConfigBindingRow>(
      'SELECT * FROM TaskConfigBindings WHERE task_id=? ORDER BY target_base,target_path,id',
      [id],
    ),
    hooks: await store.all<HookRow>(
      'SELECT * FROM TaskHooks WHERE task_id=? ORDER BY position,id',
      [id],
    ),
  };
}

/** Explicit candidate Store only; no global ORM, Scheduler, Subscription or v9 lock identity. */
export class TaskService {
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
  ) {
    if (store.dataRoot !== roots.dataRoot || store.dataRoot !== leases.dataRoot)
      fail('WORKSPACE_PATH_INVALID', 400);
  }
  get(id: number) {
    return loadTaskDefinition(this.store, id);
  }
  async list(workspaceId?: number, offset = 0, limit = 100) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      fail('INVALID_REQUEST', 400);
    if (workspaceId !== undefined) positiveId(workspaceId);
    return this.store.all<TaskRow>(
      `SELECT * FROM Tasks${
        workspaceId === undefined ? '' : ' WHERE workspace_id=?'
      } ORDER BY id LIMIT ? OFFSET ?`,
      workspaceId === undefined
        ? [limit, offset]
        : [workspaceId, limit, offset],
    );
  }
  private normalize(input: TaskWrite) {
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 255 ||
      /[\x00-\x1f\x7f]/.test(input.name) ||
      typeof (input.description ?? '') !== 'string' ||
      Buffer.byteLength(input.description ?? '') > 65536 ||
      (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    )
      fail('TASK_DEFINITION_INVALID', 400);
    const source = normalizedSource(input.source);
    return {
      name: input.name.trim(),
      description: input.description ?? '',
      enabled: input.enabled ?? false,
      args: taskArguments(input.arguments ?? []),
      source,
      runtime: normalizedRuntime(input.runtime, source.language),
      settings: taskSettings(input.execution ?? {}),
      profileId: input.env_profile_id ?? null,
    };
  }
  private async associations(
    tx: WorkspaceStore,
    workspaceId: number,
    profileId: number | null,
    runtime: RuntimeBinding | null,
  ) {
    if (profileId !== null) {
      positiveId(profileId);
      const p = (
        await tx.all<{ workspace_id: number }>(
          'SELECT workspace_id FROM EnvironmentProfiles WHERE id=?',
          [profileId],
        )
      )[0];
      if (!p || p.workspace_id !== workspaceId)
        fail('ENV_PROFILE_WORKSPACE_MISMATCH');
    }
    if (runtime) {
      const table =
        runtime.kind === 'PYTHON'
          ? 'PythonEnvironments'
          : runtime.kind === 'NODE'
          ? 'NodeEnvironments'
          : null;
      const id =
        runtime.kind === 'PYTHON'
          ? runtime.python_environment_id
          : runtime.node_environment_id;
      if (table && id !== null) {
        if (
          !(
            await tx.all(
              `SELECT id FROM ${table} WHERE id=? AND state<>'DELETING'`,
              [id],
            )
          ).length
        )
          fail('RUNTIME_NOT_READY');
      }
    }
  }
  private async enabledResources(input: ReturnType<TaskService['normalize']>) {
    if (!input.enabled) return;
    const workspace = await this.store.workspace(input.source.workspace_id);
    const profileId = input.profileId ?? workspace.default_env_profile_id;
    if (profileId !== null) {
      const profile = (
        await this.store.all<{ workspace_id: number; status: string }>(
          'SELECT workspace_id,status FROM EnvironmentProfiles WHERE id=?',
          [profileId],
        )
      )[0];
      if (!profile || profile.workspace_id !== workspace.id)
        fail('ENV_PROFILE_WORKSPACE_MISMATCH');
      if (profile.status !== 'enabled') fail('ENV_PROFILE_DISABLED');
    }
    const kind = runtimeKind(input.source.language);
    let environmentId =
      kind === 'PYTHON'
        ? input.runtime?.python_environment_id
        : kind === 'NODE'
        ? input.runtime?.node_environment_id
        : null;
    if (kind !== 'SHELL' && !environmentId) {
      const defaults = (
        await this.store.all<{
          python_environment_id: number | null;
          node_environment_id: number | null;
        }>(
          'SELECT * FROM WorkspaceRuntimeDefaults WHERE workspace_id=? AND kind=?',
          [workspace.id, kind],
        )
      )[0];
      environmentId =
        kind === 'PYTHON'
          ? defaults?.python_environment_id
          : defaults?.node_environment_id;
    }
    const { ManagedRuntimeAdapter } = await import('./runtime');
    await new ManagedRuntimeAdapter(this.store).inspect(
      kind,
      environmentId ?? null,
      input.source.language,
    );
  }
  async create(input: TaskWrite, discovered?: DiscoveredIdentity) {
    const v = this.normalize(input);
    return this.leases.withWorkspace(
      v.source.workspace_id,
      'TASK_CREATE',
      async (lease) => {
        const row = await this.store.assertAccessible(
          v.source.workspace_id,
          true,
        );
        await this.roots.requireReady(row, lease);
        const { validateSourceUnderLease } = await import('./resources');
        const verified = await validateSourceUnderLease(
          this.store,
          this.roots,
          v.source,
          lease,
        );
        await this.enabledResources(v);
        if (
          discovered &&
          (row.type !== 'GIT' ||
            discovered.discovered_workspace_id !== row.id ||
            !/^[a-f0-9]{64}$/.test(discovered.discovery_key))
        )
          fail('TASK_IDENTITY_INVALID', 400);
        const id = await this.store.transaction(async (tx) => {
          const id = await this.insertTask(tx, input, discovered);
          if (verified.git)
            await tx.run(
              'UPDATE GitWorkspaces SET last_verified_commit=? WHERE workspace_id=?',
              [verified.git.head, row.id],
            );
          return id;
        });
        return this.get(id);
      },
    );
  }
  private async insertTask(
    tx: WorkspaceStore,
    input: TaskWrite,
    discovered?: DiscoveredIdentity,
  ) {
    const v = this.normalize(input);
    await this.associations(tx, v.source.workspace_id, v.profileId, v.runtime);
    const result = await tx.run(
      'INSERT INTO Tasks(workspace_id,name,description,enabled,origin,discovered_workspace_id,discovery_key,discovery_definition,env_profile_id,arguments) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        v.source.workspace_id,
        v.name,
        v.description,
        v.enabled ? 1 : 0,
        discovered ? 'DISCOVERED' : 'MANUAL',
        discovered ? v.source.workspace_id : null,
        discovered?.discovery_key ?? null,
        discovered ? JSON.stringify(discovered.discovery_definition) : null,
        v.profileId,
        JSON.stringify(v.args),
      ],
    );
    await tx.run(
      'INSERT INTO TaskSources(task_id,workspace_id,type,relative_entrypoint,language,cwd_mode,cwd_relative_path) VALUES(?,?,?,?,?,?,?)',
      [
        result.lastID,
        v.source.workspace_id,
        'WORKSPACE_ENTRYPOINT',
        v.source.relative_entrypoint,
        v.source.language,
        v.source.cwd_mode,
        v.source.cwd_relative_path,
      ],
    );
    await this.saveChildren(tx, result.lastID, v.runtime, v.settings);
    return result.lastID;
  }
  private async saveChildren(
    tx: WorkspaceStore,
    id: number,
    runtime: RuntimeBinding | null,
    settings: ExecutionSettings,
  ) {
    if (runtime)
      await tx.run(
        'INSERT INTO TaskRuntimeBindings(task_id,kind,python_environment_id,node_environment_id,createdAt,updatedAt) VALUES(?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(task_id) DO UPDATE SET kind=excluded.kind,python_environment_id=excluded.python_environment_id,node_environment_id=excluded.node_environment_id,updatedAt=CURRENT_TIMESTAMP',
        [
          id,
          runtime.kind,
          runtime.python_environment_id,
          runtime.node_environment_id,
        ],
      );
    else await tx.run('DELETE FROM TaskRuntimeBindings WHERE task_id=?', [id]);
    await tx.run(
      `INSERT INTO TaskExecutionSettings(task_id,timeout_seconds,max_attempts,initial_delay_seconds,backoff,concurrency,notification) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET timeout_seconds=excluded.timeout_seconds,max_attempts=excluded.max_attempts,initial_delay_seconds=excluded.initial_delay_seconds,backoff=excluded.backoff,concurrency=excluded.concurrency,notification=excluded.notification`,
      [
        id,
        settings.timeout_seconds,
        settings.max_attempts,
        settings.initial_delay_seconds,
        settings.backoff,
        settings.concurrency,
        settings.notification,
      ],
    );
  }
  async update(id: number, expectedVersion: number, patch: Partial<TaskWrite>) {
    const previous = await this.get(id);
    const input: TaskWrite = {
      name: previous.task.name,
      description: previous.task.description,
      enabled: !!previous.task.enabled,
      arguments: JSON.parse(previous.task.arguments),
      source: previous.source,
      runtime: previous.runtimeBinding,
      execution: previous.settings,
      env_profile_id: previous.task.env_profile_id,
      ...patch,
    };
    const v = this.normalize(input);
    const ids = [
      ...new Set([previous.task.workspace_id, v.source.workspace_id]),
    ].sort((a, b) => a - b);
    let verifiedGitHead: string | null = null;
    const action = async () =>
      this.store.transaction(async (tx) => {
        const fresh = await loadTaskDefinition(tx, id);
        if (fresh.task.version !== expectedVersion)
          fail('TASK_VERSION_CONFLICT');
        await this.associations(
          tx,
          v.source.workspace_id,
          v.profileId,
          v.runtime,
        );
        await tx.run(
          'UPDATE Tasks SET workspace_id=?,name=?,description=?,enabled=?,arguments=?,env_profile_id=?,version=version+1,updatedAt=? WHERE id=? AND version=?',
          [
            v.source.workspace_id,
            v.name,
            v.description,
            v.enabled ? 1 : 0,
            JSON.stringify(v.args),
            v.profileId,
            new Date().toISOString(),
            id,
            expectedVersion,
          ],
        );
        await tx.run(
          'UPDATE TaskSources SET workspace_id=?,relative_entrypoint=?,language=?,cwd_mode=?,cwd_relative_path=? WHERE task_id=?',
          [
            v.source.workspace_id,
            v.source.relative_entrypoint,
            v.source.language,
            v.source.cwd_mode,
            v.source.cwd_relative_path,
            id,
          ],
        );
        await this.saveChildren(tx, id, v.runtime, v.settings);
        if (verifiedGitHead)
          await tx.run(
            'UPDATE GitWorkspaces SET last_verified_commit=? WHERE workspace_id=?',
            [verifiedGitHead, v.source.workspace_id],
          );
      });
    const lock = async (index: number): Promise<void> => {
      if (index === ids.length) {
        await action();
        return;
      }
      await this.leases.withWorkspace(
        ids[index],
        'TASK_UPDATE',
        async (lease) => {
          const ws = await this.store.assertAccessible(ids[index], true);
          await this.roots.requireReady(ws, lease);
          if (ids[index] === v.source.workspace_id) {
            const { validateSourceUnderLease } = await import('./resources');
            const verified = await validateSourceUnderLease(
              this.store,
              this.roots,
              v.source,
              lease,
            );
            verifiedGitHead = verified.git?.head ?? null;
            await this.enabledResources(v);
          }
          await lock(index + 1);
        },
      );
    };
    await lock(0);
    return this.get(id);
  }
  async setEnabled(id: number, expectedVersion: number, enabled: boolean) {
    if (enabled && (await this.readiness(id)).status !== 'READY')
      fail('TASK_NOT_READY');
    return this.update(id, expectedVersion, { enabled });
  }
  async clone(id: number, name?: string) {
    const source = await this.get(id);
    const input: TaskWrite = {
      name: name ?? source.task.name + ' copy',
      description: source.task.description,
      enabled: false,
      arguments: JSON.parse(source.task.arguments),
      source: source.source,
      runtime: source.runtimeBinding,
      execution: source.settings,
      env_profile_id: source.task.env_profile_id,
    };
    const cloneId = await this.leases.withWorkspace(
      source.task.workspace_id,
      'TASK_CLONE',
      async (lease) => {
        await this.store.assertAccessible(source.task.workspace_id, true);
        const { validateSourceUnderLease } = await import('./resources');
        await validateSourceUnderLease(
          this.store,
          this.roots,
          source.source,
          lease,
        );
        return this.store.transaction(async (tx) => {
          const current = await loadTaskDefinition(tx, id);
          if (current.task.version !== source.task.version)
            fail('TASK_VERSION_CONFLICT');
          const idOfClone = await this.insertTask(tx, input);
          for (const [table, columns] of [
            [
              'TaskEnvVariables',
              'name,value,status,operation,is_secret,position,labels',
            ],
            [
              'TaskConfigBindings',
              'asset_id,revision_id,operation,target_base,target_path,materialization_mode,conflict_policy,writable,enabled,version',
            ],
            [
              'TaskHooks',
              'name,phase,command,cwd_base,position,timeout_seconds,failure_policy,enabled,version',
            ],
          ] as const)
            await tx.run(
              `INSERT INTO ${table}(task_id,${columns},createdAt,updatedAt) SELECT ?,${columns},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM ${table} WHERE task_id=?`,
              [idOfClone, id],
            );
          return idOfClone;
        });
      },
    );
    return this.get(cloneId);
  }
  async remove(id: number, expectedVersion: number) {
    const task = await this.get(id);
    return this.leases.withWorkspace(
      task.task.workspace_id,
      'TASK_DELETE',
      async () => {
        const row = await this.store.workspace(task.task.workspace_id);
        if (!['READY', 'ARCHIVED'].includes(row.lifecycle_state))
          fail('WORKSPACE_NOT_READY');
        await this.store.transaction(async (tx) => {
          await tx.assertAccessible(row.id, false);
          if (
            (await loadTaskDefinition(tx, id)).task.version !== expectedVersion
          )
            fail('TASK_VERSION_CONFLICT');
          await tx.run('DELETE FROM Tasks WHERE id=? AND version=?', [
            id,
            expectedVersion,
          ]);
        });
      },
    );
  }
  async references(id: number) {
    await this.get(id);
    return {
      runs: (
        await this.store.all<{ n: number }>(
          'SELECT COUNT(*) n FROM TaskRuns WHERE task_id=?',
          [id],
        )
      )[0].n,
      activeRuns: (
        await this.store.all<{ n: number }>(
          "SELECT COUNT(*) n FROM TaskRuns WHERE task_id=? AND status IN ('QUEUED','RESOLVING','RUNNING','RECOVERY_REQUIRED')",
          [id],
        )
      )[0].n,
      triggers: (
        await this.store.all<{ n: number }>(
          'SELECT COUNT(*) n FROM TaskTriggers WHERE task_id=?',
          [id],
        )
      )[0].n,
    };
  }
  async history(id: number, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      fail('INVALID_REQUEST', 400);
    await this.get(id);
    return this.store.all(
      'SELECT * FROM TaskRuns WHERE task_id=? ORDER BY id DESC LIMIT ?',
      [id, limit],
    );
  }
  async readiness(id: number) {
    const { TaskResourceResolver } = await import('./resources');
    return new TaskResourceResolver(
      this.store,
      this.roots,
      this.leases,
    ).readiness(id);
  }
}
