import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLeaseService } from '../workspaceV2/lease';
import { fail, positiveId } from '../workspaceV2/errors';
import {
  validateEnvironmentName,
  validateEnvironmentValue,
} from '../../shared/scopedEnv';
import { targetPath } from '../../shared/configAssets';
import { workspaceLimits } from '../workspaceV2/limits';
import {
  loadTaskDefinition,
  ConfigBindingRow,
  HookRow,
  VariableRow,
} from './task';

export interface ProfileRow {
  id: number;
  workspace_id: number;
  name: string;
  description: string;
  status: 'enabled' | 'disabled';
  version: number;
}
export interface VariableWrite {
  name: string;
  operation: 'SET' | 'UNSET';
  status: 'enabled' | 'disabled';
  is_secret: boolean;
  value?: string;
  replace_secret?: boolean;
  clear?: boolean;
  position?: number;
}
export interface CandidateEnvironmentSnapshot {
  variables: Readonly<Record<string, string>>;
  unsetVariables: readonly string[];
  origins: Readonly<Record<string, 'SYSTEM' | 'GLOBAL' | 'PROFILE' | 'TASK'>>;
  secretNames: readonly string[];
  profile: ProfileRow | null;
  metadata: {
    scoped: true;
    task_id: number;
    workspace_id: number;
    selected_by: 'TASK' | 'WORKSPACE' | 'NONE';
    version: 1;
  };
}
export interface ConfigBindingWrite {
  id?: number;
  version?: number;
  asset_id: number | null;
  revision_id: number | null;
  operation: 'ATTACH' | 'MASK';
  target_base: 'WORKSPACE_ROOT' | 'TASK_CWD';
  target_path: string;
  materialization_mode: 'COPY' | 'SYMLINK';
  conflict_policy: 'FAIL_IF_EXISTS' | 'BACKUP_AND_RESTORE';
  writable: boolean;
  enabled: boolean;
}
export interface HookWrite {
  name: string;
  phase: HookRow['phase'];
  command: string;
  cwd_base: HookRow['cwd_base'];
  position: number;
  timeout_seconds: number;
  failure_policy: HookRow['failure_policy'];
  enabled: boolean;
}

/** Candidate ownership and pure ENV merge. No Repository scope, process.env spread or host secret inheritance. */
export class WorkspaceEnvironmentService {
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
  ) {
    if (store.dataRoot !== roots.dataRoot || store.dataRoot !== leases.dataRoot)
      fail('WORKSPACE_PATH_INVALID', 400);
  }
  private async workspaceMutation<T>(
    id: number,
    expectedVersion: number,
    fn: (tx: WorkspaceStore) => Promise<T>,
    allowArchived = false,
  ) {
    return this.leases.withWorkspace(id, 'WORKSPACE_RESOURCES', async () =>
      this.store.transaction(async (tx) => {
        const ws = await tx.assertAccessible(id, !allowArchived);
        if (ws.version !== expectedVersion) fail('WORKSPACE_VERSION_CONFLICT');
        return fn(tx);
      }),
    );
  }
  private async taskMutation<T>(
    id: number,
    expectedVersion: number,
    fn: (tx: WorkspaceStore) => Promise<T>,
    allowArchived = false,
  ) {
    const task = await loadTaskDefinition(this.store, id);
    return this.leases.withWorkspace(
      task.task.workspace_id,
      'TASK_RESOURCES',
      async () =>
        this.store.transaction(async (tx) => {
          await tx.assertAccessible(task.task.workspace_id, !allowArchived);
          if (
            (await loadTaskDefinition(tx, id)).task.version !== expectedVersion
          )
            fail('TASK_VERSION_CONFLICT');
          return fn(tx);
        }),
    );
  }
  async profile(id: number) {
    const row = (
      await this.store.all<ProfileRow>(
        'SELECT * FROM EnvironmentProfiles WHERE id=?',
        [positiveId(id)],
      )
    )[0];
    if (!row) fail('ENV_PROFILE_NOT_FOUND', 404);
    return row;
  }
  profiles(workspaceId: number) {
    return this.store.all<ProfileRow>(
      'SELECT * FROM EnvironmentProfiles WHERE workspace_id=? ORDER BY id',
      [positiveId(workspaceId)],
    );
  }
  private profileInput(input: {
    name: string;
    description?: string;
    status?: 'enabled' | 'disabled';
  }) {
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 255 ||
      /[\x00-\x1f\x7f]/.test(input.name) ||
      typeof (input.description ?? '') !== 'string' ||
      !['enabled', 'disabled'].includes(input.status ?? 'enabled')
    )
      fail('ENV_PROFILE_INVALID', 400);
    return {
      name: input.name.trim(),
      description: input.description ?? '',
      status: input.status ?? 'enabled',
    };
  }
  async createProfile(
    workspaceId: number,
    expectedWorkspaceVersion: number,
    input: {
      name: string;
      description?: string;
      status?: 'enabled' | 'disabled';
    },
  ) {
    const v = this.profileInput(input);
    const id = await this.workspaceMutation(
      workspaceId,
      expectedWorkspaceVersion,
      async (tx) =>
        (
          await tx.run(
            'INSERT INTO EnvironmentProfiles(workspace_id,name,description,status) VALUES(?,?,?,?)',
            [workspaceId, v.name, v.description, v.status],
          )
        ).lastID,
    );
    return this.profile(id);
  }
  async updateProfile(
    id: number,
    expectedVersion: number,
    input: {
      name: string;
      description?: string;
      status?: 'enabled' | 'disabled';
    },
  ) {
    const p = await this.profile(id),
      v = this.profileInput(input);
    return this.leases.withWorkspace(
      p.workspace_id,
      'PROFILE_UPDATE',
      async () =>
        this.store.transaction(async (tx) => {
          await tx.assertAccessible(p.workspace_id, true);
          if ((await this.profile(id)).version !== expectedVersion)
            fail('ENV_PROFILE_SAVE_CONFLICT');
          await tx.run(
            'UPDATE EnvironmentProfiles SET name=?,description=?,status=?,version=version+1 WHERE id=? AND version=?',
            [v.name, v.description, v.status, id, expectedVersion],
          );
          return this.profile(id);
        }),
    );
  }
  async removeProfile(id: number, expectedVersion: number) {
    const p = await this.profile(id);
    return this.leases.withWorkspace(
      p.workspace_id,
      'PROFILE_DELETE',
      async () =>
        this.store.transaction(async (tx) => {
          await tx.assertAccessible(p.workspace_id, true);
          if ((await this.profile(id)).version !== expectedVersion)
            fail('ENV_PROFILE_SAVE_CONFLICT');
          const refs = await tx.all(
            'SELECT id FROM Tasks WHERE env_profile_id=? UNION SELECT id FROM Workspaces WHERE default_env_profile_id=?',
            [id, id],
          );
          if (refs.length) fail('ENV_PROFILE_REFERENCED');
          await tx.run('DELETE FROM EnvironmentProfiles WHERE id=?', [id]);
        }),
    );
  }
  async selectWorkspaceProfile(
    workspaceId: number,
    expectedVersion: number,
    profileId: number | null,
  ) {
    return this.workspaceMutation(
      workspaceId,
      expectedVersion,
      async (tx) => {
        if (
          profileId !== null &&
          (await this.profile(profileId)).workspace_id !== workspaceId
        )
          fail('ENV_PROFILE_WORKSPACE_MISMATCH');
        await tx.run(
          'UPDATE Workspaces SET default_env_profile_id=?,version=version+1 WHERE id=?',
          [profileId, workspaceId],
        );
        return tx.workspace(workspaceId);
      },
      profileId === null,
    );
  }
  async selectTaskProfile(
    taskId: number,
    expectedVersion: number,
    profileId: number | null,
  ) {
    return this.taskMutation(
      taskId,
      expectedVersion,
      async (tx) => {
        const definition = await loadTaskDefinition(tx, taskId);
        if (
          profileId !== null &&
          (await this.profile(profileId)).workspace_id !==
            definition.task.workspace_id
        )
          fail('ENV_PROFILE_WORKSPACE_MISMATCH');
        await tx.run(
          'UPDATE Tasks SET env_profile_id=?,version=version+1 WHERE id=?',
          [profileId, taskId],
        );
        return loadTaskDefinition(tx, taskId);
      },
      profileId === null,
    );
  }
  private variables(input: VariableWrite[], previous: VariableRow[]) {
    if (
      !Array.isArray(input) ||
      input.length > 1000 ||
      new Set(input.map((x) => x.name)).size !== input.length
    )
      fail('ENV_VARIABLES_INVALID', 400);
    return input.map((v, index) => {
      validateEnvironmentName(v.name);
      if (
        (v.clear && (v.value !== undefined || v.replace_secret)) ||
        (v.replace_secret &&
          (v.operation !== 'SET' || v.value === undefined)) ||
        (v.operation === 'UNSET' && v.replace_secret)
      )
        fail('ENV_SECRET_ACTION_INVALID', 400);
      if (
        !['SET', 'UNSET'].includes(v.operation) ||
        !['enabled', 'disabled'].includes(v.status) ||
        typeof v.is_secret !== 'boolean' ||
        !Number.isFinite(v.position ?? index)
      )
        fail('ENV_VARIABLES_INVALID', 400);
      let value: string | null = null;
      if (v.operation === 'SET') {
        const old = previous.find((p) => p.name === v.name);
        if (v.clear) value = '';
        else if (v.value !== undefined) {
          validateEnvironmentValue(v.value);
          value = v.value;
        } else if (
          v.is_secret &&
          !v.replace_secret &&
          old?.is_secret &&
          old.operation === 'SET'
        )
          value = old.value;
        else fail('ENV_VALUE_INVALID', 400);
        if (value === null) fail('ENV_VALUE_INVALID', 400);
      } else if (v.value !== undefined || v.clear)
        fail('ENV_VALUE_INVALID', 400);
      return { ...v, value, position: v.position ?? index };
    });
  }
  private async replace(
    tx: WorkspaceStore,
    table: 'WorkspaceProfileVariables' | 'TaskEnvVariables',
    key: 'profile_id' | 'task_id',
    id: number,
    input: VariableWrite[],
  ) {
    const previous = await tx.all<VariableRow>(
      `SELECT * FROM ${table} WHERE ${key}=?`,
      [id],
    );
    const rows = this.variables(input, previous);
    await tx.run(`DELETE FROM ${table} WHERE ${key}=?`, [id]);
    for (const v of rows)
      await tx.run(
        `INSERT INTO ${table}(${key},name,value,status,operation,is_secret,position,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [
          id,
          v.name,
          v.value,
          v.status,
          v.operation,
          v.is_secret ? 1 : 0,
          v.position,
        ],
      );
  }
  async replaceProfileVariables(
    profileId: number,
    expectedProfileVersion: number,
    variables: VariableWrite[],
  ) {
    const p = await this.profile(profileId);
    return this.leases.withWorkspace(
      p.workspace_id,
      'PROFILE_VARIABLES',
      async () =>
        this.store.transaction(async (tx) => {
          await tx.assertAccessible(p.workspace_id, true);
          if (
            (await this.profile(profileId)).version !== expectedProfileVersion
          )
            fail('ENV_PROFILE_SAVE_CONFLICT');
          await this.replace(
            tx,
            'WorkspaceProfileVariables',
            'profile_id',
            profileId,
            variables,
          );
          return this.profile(profileId);
        }),
    );
  }
  async replaceTaskVariables(
    taskId: number,
    expectedTaskVersion: number,
    variables: VariableWrite[],
  ) {
    await this.taskMutation(taskId, expectedTaskVersion, (tx) =>
      this.replace(tx, 'TaskEnvVariables', 'task_id', taskId, variables),
    );
    return loadTaskDefinition(this.store, taskId);
  }
  async replaceGlobals(expectedVersion: number, input: VariableWrite[]) {
    return this.leases.barrier.mutation(() =>
      this.store.transaction(async (tx) => {
        const revision = (
          await tx.all<{ version: number }>(
            'SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1',
          )
        )[0];
        if (revision.version !== expectedVersion) fail('ENV_VERSION_CONFLICT');
        const previous = await tx.all<VariableRow>('SELECT * FROM Envs');
        const rows = this.variables(input, previous);
        await tx.run('DELETE FROM Envs');
        for (const v of rows)
          await tx.run(
            'INSERT INTO Envs(name,value,status,operation,is_secret,position,createdAt,updatedAt) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
            [
              v.name,
              v.value,
              v.status === 'enabled' ? 0 : 1,
              v.operation,
              v.is_secret ? 1 : 0,
              v.position,
            ],
          );
        return (
          await tx.all<{ version: number }>(
            'SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1',
          )
        )[0].version;
      }),
    );
  }
  async resolve(
    taskId: number,
    base: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  ): Promise<CandidateEnvironmentSnapshot> {
    const definition = await loadTaskDefinition(this.store, taskId),
      ws = await this.store.workspace(definition.task.workspace_id);
    const profileId =
      definition.task.env_profile_id ?? ws.default_env_profile_id;
    const profile = profileId === null ? null : await this.profile(profileId);
    if (profile && profile.workspace_id !== ws.id)
      fail('ENV_PROFILE_WORKSPACE_MISMATCH');
    if (profile?.status === 'disabled') fail('ENV_PROFILE_DISABLED');
    const variables: Record<string, string> = Object.create(null),
      origins: Record<string, 'SYSTEM' | 'GLOBAL' | 'PROFILE' | 'TASK'> =
        Object.create(null),
      unset = new Set<string>(),
      secrets = new Set<string>();
    for (const [name, value] of Object.entries(base))
      if (
        value !== undefined &&
        /^(?:PATH|HOME|LANG|LC_[A-Za-z_]+|TMPDIR|TZ|TERM)$/.test(name)
      ) {
        variables[name] = value;
        origins[name] = 'SYSTEM';
      }
    const globals = (
      await this.store.all<Omit<VariableRow, 'status'> & { status: number }>(
        'SELECT * FROM Envs ORDER BY position,id',
      )
    ).map((v) => ({
      ...v,
      status: v.status === 1 ? ('disabled' as const) : ('enabled' as const),
    }));
    const profileVars = profile
      ? await this.store.all<VariableRow>(
          'SELECT * FROM WorkspaceProfileVariables WHERE profile_id=? ORDER BY position,id',
          [profile.id],
        )
      : [];
    for (const [rows, origin] of [
      [globals, 'GLOBAL'],
      [profileVars, 'PROFILE'],
      [definition.variables, 'TASK'],
    ] as const)
      for (const v of rows) {
        if (v.status === 'disabled') continue;
        validateEnvironmentName(v.name);
        origins[v.name] = origin;
        if (v.is_secret) secrets.add(v.name);
        if (v.operation === 'UNSET') {
          delete variables[v.name];
          unset.add(v.name);
        } else {
          validateEnvironmentValue(v.value);
          variables[v.name] = v.value;
          unset.delete(v.name);
        }
      }
    return {
      variables: Object.freeze(variables),
      origins: Object.freeze(origins),
      unsetVariables: Object.freeze([...unset]),
      secretNames: Object.freeze([...secrets]),
      profile,
      metadata: {
        scoped: true,
        task_id: taskId,
        workspace_id: ws.id,
        selected_by:
          definition.task.env_profile_id !== null
            ? 'TASK'
            : ws.default_env_profile_id !== null
            ? 'WORKSPACE'
            : 'NONE',
        version: 1,
      },
    };
  }
  async preview(taskId: number, base?: NodeJS.ProcessEnv) {
    const env = await this.resolve(taskId, base);
    return {
      profile: env.profile,
      metadata: env.metadata,
      variables: Object.entries(env.origins).map(([name, origin]) => {
        const secret = env.secretNames.includes(name) || origin === 'SYSTEM';
        return {
          name,
          origin,
          operation: env.unsetVariables.includes(name) ? 'UNSET' : 'SET',
          is_secret: secret,
          value: secret ? null : env.variables[name] ?? null,
          display: secret ? '********' : env.variables[name] ?? null,
        };
      }),
    };
  }
  async setRuntimeDefault(
    workspaceId: number,
    expectedVersion: number,
    kind: 'PYTHON' | 'NODE',
    environmentId: number | null,
  ) {
    if (!['PYTHON', 'NODE'].includes(kind))
      fail('TASK_RUNTIME_BINDING_INVALID', 400);
    return this.workspaceMutation(
      workspaceId,
      expectedVersion,
      async (tx) => {
        if (environmentId === null)
          await tx.run(
            'DELETE FROM WorkspaceRuntimeDefaults WHERE workspace_id=? AND kind=?',
            [workspaceId, kind],
          );
        else {
          positiveId(environmentId);
          if (
            !(
              await tx.all(
                `SELECT id FROM ${
                  kind === 'PYTHON' ? 'PythonEnvironments' : 'NodeEnvironments'
                } WHERE id=? AND state<>'DELETING'`,
                [environmentId],
              )
            ).length
          )
            fail('RUNTIME_NOT_READY');
          await tx.run(
            'INSERT INTO WorkspaceRuntimeDefaults(workspace_id,kind,python_environment_id,node_environment_id) VALUES(?,?,?,?) ON CONFLICT(workspace_id,kind) DO UPDATE SET python_environment_id=excluded.python_environment_id,node_environment_id=excluded.node_environment_id,version=WorkspaceRuntimeDefaults.version+1',
            [
              workspaceId,
              kind,
              kind === 'PYTHON' ? environmentId : null,
              kind === 'NODE' ? environmentId : null,
            ],
          );
        }
        return tx.workspace(workspaceId);
      },
      environmentId === null,
    );
  }
  private config(input: ConfigBindingWrite, workspace: boolean) {
    const target = targetPath(input.target_path);
    if (
      !['WORKSPACE_ROOT', 'TASK_CWD'].includes(input.target_base) ||
      !['COPY', 'SYMLINK'].includes(input.materialization_mode) ||
      !['FAIL_IF_EXISTS', 'BACKUP_AND_RESTORE'].includes(
        input.conflict_policy,
      ) ||
      !['ATTACH', 'MASK'].includes(input.operation) ||
      (workspace && input.operation === 'MASK') ||
      typeof input.enabled !== 'boolean' ||
      typeof input.writable !== 'boolean' ||
      target.split('/').includes('node_modules')
    )
      fail('CONFIG_BINDING_INVALID', 400);
    if (input.operation === 'ATTACH') positiveId(input.asset_id!);
    else if (input.asset_id !== null || input.revision_id !== null)
      fail('CONFIG_BINDING_INVALID', 400);
    if (input.revision_id !== null) positiveId(input.revision_id);
    return { ...input, target_path: target };
  }
  private async saveConfig(
    tx: WorkspaceStore,
    table: 'WorkspaceConfigBindings' | 'TaskConfigBindings',
    ownerKey: 'workspace_id' | 'task_id',
    id: number,
    input: ConfigBindingWrite,
  ) {
    const v = this.config(input, ownerKey === 'workspace_id');
    if (
      v.id === undefined &&
      (
        await tx.all<{ n: number }>(
          `SELECT COUNT(*) n FROM ${table} WHERE ${ownerKey}=?`,
          [id],
        )
      )[0].n >= workspaceLimits().maxWorkspaceEntries
    )
      fail('WORKSPACE_QUOTA_EXCEEDED');
    if (v.operation === 'ATTACH') {
      const asset = (
        await tx.all<{ current_revision_id: number | null }>(
          'SELECT current_revision_id FROM ConfigAssets WHERE id=?',
          [v.asset_id],
        )
      )[0];
      if (!asset) fail('CONFIG_ASSET_NOT_FOUND', 404);
      if (
        v.revision_id !== null &&
        !(
          await tx.all(
            'SELECT id FROM ConfigAssetRevisions WHERE id=? AND asset_id=?',
            [v.revision_id, v.asset_id],
          )
        ).length
      )
        fail('CONFIG_REVISION_NOT_FOUND');
    }
    if (v.id !== undefined) {
      const result = await tx.run(
        `UPDATE ${table} SET asset_id=?,revision_id=?,operation=?,target_base=?,target_path=?,materialization_mode=?,conflict_policy=?,writable=?,enabled=?,version=version+1 WHERE id=? AND ${ownerKey}=? AND version=?`,
        [
          v.asset_id,
          v.revision_id,
          v.operation,
          v.target_base,
          v.target_path,
          v.materialization_mode,
          v.conflict_policy,
          v.writable ? 1 : 0,
          v.enabled ? 1 : 0,
          v.id,
          id,
          v.version,
        ],
      );
      if (result.changes !== 1) fail('CONFIG_EDIT_CONFLICT');
      return v.id;
    }
    return (
      await tx.run(
        `INSERT INTO ${table}(${ownerKey},asset_id,revision_id,operation,target_base,target_path,materialization_mode,conflict_policy,writable,enabled) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          v.asset_id,
          v.revision_id,
          v.operation,
          v.target_base,
          v.target_path,
          v.materialization_mode,
          v.conflict_policy,
          v.writable ? 1 : 0,
          v.enabled ? 1 : 0,
        ],
      )
    ).lastID;
  }
  saveWorkspaceConfig(
    workspaceId: number,
    expectedVersion: number,
    input: ConfigBindingWrite,
  ) {
    return this.workspaceMutation(workspaceId, expectedVersion, (tx) =>
      this.saveConfig(
        tx,
        'WorkspaceConfigBindings',
        'workspace_id',
        workspaceId,
        input,
      ),
    );
  }
  saveTaskConfig(
    taskId: number,
    expectedVersion: number,
    input: ConfigBindingWrite,
  ) {
    return this.taskMutation(taskId, expectedVersion, (tx) =>
      this.saveConfig(tx, 'TaskConfigBindings', 'task_id', taskId, input),
    );
  }
  async removeWorkspaceConfig(
    workspaceId: number,
    expectedVersion: number,
    id: number,
    version: number,
  ) {
    return this.workspaceMutation(
      workspaceId,
      expectedVersion,
      async (tx) => {
        if (
          (
            await tx.run(
              'DELETE FROM WorkspaceConfigBindings WHERE id=? AND workspace_id=? AND version=?',
              [id, workspaceId, version],
            )
          ).changes !== 1
        )
          fail('CONFIG_EDIT_CONFLICT');
      },
      true,
    );
  }
  async removeTaskConfig(
    taskId: number,
    expectedVersion: number,
    id: number,
    version: number,
  ) {
    return this.taskMutation(
      taskId,
      expectedVersion,
      async (tx) => {
        if (
          (
            await tx.run(
              'DELETE FROM TaskConfigBindings WHERE id=? AND task_id=? AND version=?',
              [id, taskId, version],
            )
          ).changes !== 1
        )
          fail('CONFIG_EDIT_CONFLICT');
      },
      true,
    );
  }
  async replaceHooks(
    taskId: number,
    expectedVersion: number,
    input: HookWrite[],
  ) {
    if (!Array.isArray(input) || input.length > 100)
      fail('TASK_HOOK_INVALID', 400);
    for (const h of input)
      if (
        typeof h.name !== 'string' ||
        !h.name.trim() ||
        h.name.length > 255 ||
        typeof h.command !== 'string' ||
        !h.command.trim() ||
        h.command.includes('\0') ||
        Buffer.byteLength(h.command) > 65536 ||
        !['BEFORE', 'AFTER_SUCCESS', 'AFTER_FAILURE', 'FINALLY'].includes(
          h.phase,
        ) ||
        !['TASK_CWD', 'WORKSPACE_ROOT'].includes(h.cwd_base) ||
        !Number.isSafeInteger(h.position) ||
        h.position < 0 ||
        !Number.isSafeInteger(h.timeout_seconds) ||
        h.timeout_seconds < 1 ||
        h.timeout_seconds > 3600 ||
        !['FAIL_EXECUTION', 'CONTINUE'].includes(h.failure_policy) ||
        typeof h.enabled !== 'boolean'
      )
        fail('TASK_HOOK_INVALID', 400);
    await this.taskMutation(taskId, expectedVersion, async (tx) => {
      await tx.run('DELETE FROM TaskHooks WHERE task_id=?', [taskId]);
      for (const h of input)
        await tx.run(
          'INSERT INTO TaskHooks(task_id,name,phase,command,cwd_base,position,timeout_seconds,failure_policy,enabled,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
          [
            taskId,
            h.name,
            h.phase,
            h.command,
            h.cwd_base,
            h.position,
            h.timeout_seconds,
            h.failure_policy,
            h.enabled ? 1 : 0,
          ],
        );
    });
    return loadTaskDefinition(this.store, taskId);
  }
}
