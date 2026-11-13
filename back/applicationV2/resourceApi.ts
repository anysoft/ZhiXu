import type { ApiCall, RouteMap, V2Services } from './types';
import type {
  ConfigBindingRow,
  HookRow,
  VariableRow,
} from '../services/taskExecutionV2/task';
import type {
  ConfigBindingWrite,
  HookWrite,
  VariableWrite,
} from '../services/taskExecutionV2/environment';
import { fail } from '../services/workspaceV2/errors';
import { CandidateConfigAssets } from './configAssets';
import {
  object,
  number,
  pathId,
  text,
  boolean,
  choice,
  nullableId,
  pagination,
  json,
  expected,
  strings,
  queryNumber,
  finite,
} from './taskValidation';

/** The only public/SQL Config enum boundary. Internal enums are not accepted as API aliases. */
export function configBindingWrite(
  value: unknown,
  update = false,
): ConfigBindingWrite {
  const keys = [
    'operation',
    'asset_id',
    'revision_id',
    'target_base',
    'target_path',
    'materialization_mode',
    'conflict_policy',
    'writable',
    'enabled',
  ];
  const b = object(
    value,
    [...keys, ...(update ? ['expected_version'] : [])],
    [...keys, ...(update ? ['expected_version'] : [])],
  );
  return {
    operation: choice(b.operation, ['ATTACH', 'MASK']),
    asset_id: nullableId(b.asset_id),
    revision_id: nullableId(b.revision_id),
    target_base:
      choice(b.target_base, ['WORKSPACE_ROOT', 'TASK_DIR']) === 'TASK_DIR'
        ? 'TASK_CWD'
        : 'WORKSPACE_ROOT',
    target_path: text(b.target_path, 4096),
    materialization_mode: choice(b.materialization_mode, ['COPY', 'SYMLINK']),
    conflict_policy:
      choice(b.conflict_policy, ['FAIL_IF_EXISTS', 'REPLACE_RESTORE']) ===
      'REPLACE_RESTORE'
        ? 'BACKUP_AND_RESTORE'
        : 'FAIL_IF_EXISTS',
    writable: boolean(b.writable),
    enabled: boolean(b.enabled),
    ...(update ? { version: number(b.expected_version) } : {}),
  };
}
export function configBindingDto(
  row: ConfigBindingRow,
  ownerType: 'WORKSPACE' | 'TASK',
  ownerId: number,
) {
  return {
    id: row.id,
    version: row.version,
    owner_type: ownerType,
    owner_id: ownerId,
    operation: row.operation,
    asset_id: row.asset_id,
    revision_id: row.revision_id,
    target_base: row.target_base === 'TASK_CWD' ? 'TASK_DIR' : 'WORKSPACE_ROOT',
    target_path: row.target_path,
    materialization_mode: row.materialization_mode,
    conflict_policy:
      row.conflict_policy === 'BACKUP_AND_RESTORE'
        ? 'REPLACE_RESTORE'
        : 'FAIL_IF_EXISTS',
    writable: !!row.writable,
    enabled: !!row.enabled,
  };
}
function publicVariable(row: any, global = false) {
  return {
    name: row.name,
    operation: row.operation,
    status: global ? (row.status === 1 ? 'disabled' : 'enabled') : row.status,
    is_secret: !!row.is_secret,
    has_value: row.value !== null,
    value: row.is_secret ? null : row.value,
  };
}
function variableWrite(value: unknown, previous: any[] = []): VariableWrite[] {
  if (!Array.isArray(value) || value.length > 1000)
    fail('INVALID_REQUEST', 400);
  return value.map((raw) => {
    const b = object(
      raw,
      [
        'name',
        'operation',
        'status',
        'is_secret',
        'value',
        'replace_secret',
        'clear',
        'position',
      ],
      ['name', 'operation', 'status', 'is_secret'],
    );
    const name = text(b.name, 255),
      old = previous.find((x) => x.name === name),
      secret = boolean(b.is_secret);
    if (
      old?.is_secret &&
      (!secret || (b.value !== undefined && b.replace_secret !== true))
    )
      fail('ENV_SECRET_ACTION_INVALID', 400);
    if (b.value === '********' || b.value === '••••••••')
      fail('ENV_SECRET_ACTION_INVALID', 400);
    return {
      name,
      operation: choice(b.operation, ['SET', 'UNSET']),
      status: choice(b.status, ['enabled', 'disabled']),
      is_secret: secret,
      ...(b.value === undefined ? {} : { value: text(b.value, 122880, true) }),
      ...(b.replace_secret === undefined
        ? {}
        : { replace_secret: boolean(b.replace_secret) }),
      ...(b.clear === undefined ? {} : { clear: boolean(b.clear) }),
      ...(b.position === undefined ? {} : { position: finite(b.position) }),
    };
  });
}
function hookWrite(value: unknown, update = false): HookWrite {
  const keys = [
    'name',
    'phase',
    'command',
    'cwd_base',
    'position',
    'timeout_seconds',
    'failure_policy',
    'enabled',
  ];
  const b = object(
    value,
    [...keys, ...(update ? ['expected_version'] : [])],
    [...keys, ...(update ? ['expected_version'] : [])],
  );
  if (update) number(b.expected_version);
  return {
    name: text(b.name, 255),
    phase: choice(b.phase, [
      'BEFORE',
      'AFTER_SUCCESS',
      'AFTER_FAILURE',
      'FINALLY',
    ]),
    command: text(b.command),
    cwd_base: choice(b.cwd_base, ['TASK_CWD', 'WORKSPACE_ROOT']),
    position: number(b.position, 0),
    timeout_seconds: number(b.timeout_seconds, 1, 3600),
    failure_policy: choice(b.failure_policy, ['FAIL_EXECUTION', 'CONTINUE']),
    enabled: boolean(b.enabled),
  };
}
const hookDto = (h: HookRow) => ({
  id: h.id,
  task_id: h.task_id,
  name: h.name,
  phase: h.phase,
  command: h.command,
  cwd_base: h.cwd_base,
  position: h.position,
  timeout_seconds: h.timeout_seconds,
  failure_policy: h.failure_policy,
  enabled: !!h.enabled,
  version: h.version,
});

export function resourceApiRoutes(s: V2Services): RouteMap {
  const assets = new CandidateConfigAssets(s),
    id = (c: ApiCall) => pathId(c.params.id);
  const profileDto = async (profileId: number) => {
    const p = await s.environment.profile(profileId),
      count = (
        await s.store.all<{ n: number }>(
          'SELECT COUNT(*) n FROM WorkspaceProfileVariables WHERE profile_id=?',
          [profileId],
        )
      )[0].n;
    return {
      id: p.id,
      workspace_id: p.workspace_id,
      name: p.name,
      description: p.description,
      status: p.status,
      version: p.version,
      variables_count: count,
    };
  };
  const profiles = async (workspaceId: number) =>
    Promise.all(
      (await s.environment.profiles(workspaceId)).map((p) => profileDto(p.id)),
    );
  const context = async (ownerId: number, task = false) => {
    const definition = task ? await s.tasks.get(ownerId) : null,
      ws = await s.store.workspace(definition?.task.workspace_id ?? ownerId),
      selected = definition?.task.env_profile_id ?? ws.default_env_profile_id;
    return {
      workspace_id: ws.id,
      ...(task ? { task_id: ownerId } : {}),
      selected_profile_id: selected,
      selected_profile_source: definition?.task.env_profile_id
        ? 'TASK'
        : ws.default_env_profile_id
        ? 'WORKSPACE'
        : 'NONE',
      profiles: await profiles(ws.id),
      owner_version: definition?.task.version ?? ws.version,
    };
  };
  const bindings = async (ownerId: number, task = false) => {
    if (task) await s.tasks.get(ownerId);
    else await s.store.workspace(ownerId);
    const rows = await s.store.all<ConfigBindingRow>(
      `SELECT * FROM ${
        task ? 'TaskConfigBindings' : 'WorkspaceConfigBindings'
      } WHERE ${task ? 'task_id' : 'workspace_id'}=? ORDER BY id`,
      [ownerId],
    );
    return rows.map((r) =>
      configBindingDto(r, task ? 'TASK' : 'WORKSPACE', ownerId),
    );
  };
  const binding = async (ownerId: number, bindingId: number, task = false) => {
    const result = (await bindings(ownerId, task)).find(
      (r) => r.id === bindingId,
    );
    if (!result) fail('CONFIG_BINDING_NOT_FOUND', 404);
    return result;
  };
  const ownerVersion = async (ownerId: number, task = false) =>
    task
      ? (await s.tasks.get(ownerId)).task.version
      : (await s.store.workspace(ownerId)).version;
  const hooks = async (taskId: number) => {
    await s.tasks.get(taskId);
    return (
      await s.store.all<HookRow>(
        'SELECT * FROM TaskHooks WHERE task_id=? ORDER BY phase,position,id',
        [taskId],
      )
    ).map(hookDto);
  };
  const hookMutation = async <T>(
    taskId: number,
    allowArchived: boolean,
    action: () => Promise<T>,
  ) => {
    const d = await s.tasks.get(taskId);
    return s.leases.withWorkspace(
      d.task.workspace_id,
      'API_TASK_HOOK',
      async (lease) => {
        const ws = await s.store.assertAccessible(
          d.task.workspace_id,
          !allowArchived,
        );
        if (allowArchived) {
          await lease.assertHeld();
          await s.roots.requireOwned(ws);
        } else await s.roots.requireReady(ws, lease);
        return s.store.transaction(action);
      },
    );
  };
  const globalVariables = async (c: ApiCall) => {
    const revision = (
      await s.store.all<{ version: number }>(
        'SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1',
      )
    )[0].version;
    c.setHeader?.('ETag', `"global-env-${revision}"`);
    c.setHeader?.('Cache-Control', 'no-store');
    return (
      await s.store.all<any>('SELECT * FROM Envs ORDER BY position DESC,name')
    ).map((row) => ({
      ...publicVariable(row, true),
      id: row.id,
      position: row.position,
      labels:
        typeof row.labels === 'string'
          ? json(row.labels, [])
          : row.labels ?? [],
      display: row.is_secret && row.value !== null ? '********' : row.value,
    }));
  };
  const routes: RouteMap = {
    'GET /task-resources/:kind/:id/references': async (c) => {
      object(c.query, []);
      const kind = choice(c.params.kind, [
          'workspace',
          'repository',
          'python',
          'node',
        ]),
        resourceId = id(c);
      let taskIds: number[] = [],
        workspaceIds: number[] = [],
        history = 0,
        recovery = 0;
      if (kind === 'workspace' || kind === 'repository') {
        if (kind === 'workspace') {
          await s.store.workspace(resourceId);
          workspaceIds = [resourceId];
        } else {
          if (
            !(
              await s.store.all('SELECT id FROM Repositories WHERE id=?', [
                resourceId,
              ])
            ).length
          )
            fail('REPOSITORY_NOT_FOUND', 404);
          workspaceIds = (
            await s.store.all<{ workspace_id: number }>(
              'SELECT workspace_id FROM GitWorkspaces WHERE repository_id=? ORDER BY workspace_id',
              [resourceId],
            )
          ).map((r) => r.workspace_id);
        }
        if (workspaceIds.length) {
          const slots = workspaceIds.map(() => '?').join(',');
          taskIds = (
            await s.store.all<{ id: number }>(
              `SELECT id FROM Tasks WHERE workspace_id IN (${slots}) ORDER BY id`,
              workspaceIds,
            )
          ).map((r) => r.id);
          const count = (
            await s.store.all<any>(
              `SELECT COUNT(*) n,SUM(status='RECOVERY_REQUIRED') recovery FROM TaskRuns WHERE workspace_id IN (${slots})`,
              workspaceIds,
            )
          )[0];
          history = count.n;
          recovery = count.recovery ?? 0;
        }
      } else {
        const python = kind === 'python',
          table = python ? 'PythonEnvironments' : 'NodeEnvironments',
          field = python ? 'python_environment_id' : 'node_environment_id',
          part = python ? 'python' : 'node',
          runtimeKind = python ? 'PYTHON' : 'NODE';
        if (
          !(
            await s.store.all(`SELECT id FROM ${table} WHERE id=?`, [
              resourceId,
            ])
          ).length
        )
          fail(
            python ? 'PYTHON_ENV_NOT_FOUND' : 'NODE_ENVIRONMENT_NOT_FOUND',
            404,
          );
        const selected = await s.store.all<{
          id: number;
          workspace_id: number;
        }>(
          `SELECT DISTINCT t.id,t.workspace_id FROM Tasks t JOIN TaskSources source ON source.task_id=t.id LEFT JOIN TaskRuntimeBindings b ON b.task_id=t.id LEFT JOIN WorkspaceRuntimeDefaults d ON d.workspace_id=t.workspace_id AND d.kind=? WHERE b.${field}=? OR (b.${field} IS NULL AND d.${field}=? AND source.language IN (${
            python ? "'PYTHON'" : "'JAVASCRIPT','TYPESCRIPT'"
          })) ORDER BY t.id`,
          [runtimeKind, resourceId, resourceId],
        );
        taskIds = selected.map((r) => r.id);
        workspaceIds = [
          ...new Set([
            ...selected.map((r) => r.workspace_id),
            ...(
              await s.store.all<{ workspace_id: number }>(
                `SELECT workspace_id FROM WorkspaceRuntimeDefaults WHERE ${field}=?`,
                [resourceId],
              )
            ).map((r) => r.workspace_id),
          ]),
        ].sort((a, b) => a - b);
        const count = (
          await s.store.all<any>(
            `SELECT COUNT(*) n,SUM(status='RECOVERY_REQUIRED') recovery FROM TaskRuns WHERE json_extract(admission_snapshot,'$.effective_resource_versions.${part}.environment_id')=? OR json_extract(source_snapshot,'$.effective_resource_versions.${part}.environment_id')=?`,
            [resourceId, resourceId],
          )
        )[0];
        history = count.n;
        recovery = count.recovery ?? 0;
      }
      return {
        kind,
        id: resourceId,
        task_ids: taskIds,
        workspace_ids: workspaceIds,
        history_count: history,
        recovery_count: recovery,
      };
    },
    'GET /workspaces/:id/runtime-defaults': async (c) => {
      object(c.query, []);
      await s.store.workspace(id(c));
      return (
        await s.store.all<any>(
          'SELECT * FROM WorkspaceRuntimeDefaults WHERE workspace_id=? ORDER BY kind',
          [id(c)],
        )
      ).map((r) => ({
        workspace_id: r.workspace_id,
        kind: r.kind,
        environment_id: r.python_environment_id ?? r.node_environment_id,
        version: r.version,
      }));
    },
    'PUT /workspaces/:id/runtime-defaults': async (c) => {
      const b = object(
        c.body,
        ['expected_version', 'kind', 'environment_id'],
        ['expected_version', 'kind', 'environment_id'],
      );
      await s.environment.setRuntimeDefault(
        id(c),
        number(b.expected_version),
        choice(b.kind, ['PYTHON', 'NODE']),
        nullableId(b.environment_id),
      );
      return (
        await s.store.all<any>(
          'SELECT * FROM WorkspaceRuntimeDefaults WHERE workspace_id=? ORDER BY kind',
          [id(c)],
        )
      ).map((r) => ({
        workspace_id: r.workspace_id,
        kind: r.kind,
        environment_id: r.python_environment_id ?? r.node_environment_id,
        version: r.version,
      }));
    },
    'GET /scoped-env/workspaces': async (c) => {
      object(c.query, ['page', 'size']);
      const p = pagination(c.query),
        items = await s.store.all<any>(
          'SELECT w.id workspace_id,w.name,w.default_env_profile_id,COUNT(p.id) profiles_count FROM Workspaces w LEFT JOIN EnvironmentProfiles p ON p.workspace_id=w.id GROUP BY w.id ORDER BY w.id LIMIT ? OFFSET ?',
          [p.size, p.offset],
        ),
        total = (
          await s.store.all<{ n: number }>('SELECT COUNT(*) n FROM Workspaces')
        )[0].n;
      return { items, page: p.page, size: p.size, total };
    },
    'GET /scoped-env/tasks': async (c) => {
      object(c.query, ['page', 'size']);
      const p = pagination(c.query),
        items = await s.store.all<any>(
          'SELECT t.id task_id,t.name,t.workspace_id,t.env_profile_id,COUNT(v.id) variables_count FROM Tasks t LEFT JOIN TaskEnvVariables v ON v.task_id=t.id GROUP BY t.id ORDER BY t.id LIMIT ? OFFSET ?',
          [p.size, p.offset],
        ),
        total = (
          await s.store.all<{ n: number }>('SELECT COUNT(*) n FROM Tasks')
        )[0].n;
      return { items, page: p.page, size: p.size, total };
    },
    'GET /scoped-env/workspaces/:id/profiles': async (c) => {
      object(c.query, []);
      await s.store.workspace(id(c));
      return profiles(id(c));
    },
    'GET /scoped-env/profiles/:id': async (c) => {
      object(c.query, []);
      return profileDto(id(c));
    },
    'GET /scoped-env/workspaces/:id/context': async (c) => {
      object(c.query, []);
      return context(id(c));
    },
    'GET /scoped-env/tasks/:id/context': async (c) => {
      object(c.query, []);
      return context(id(c), true);
    },
    'GET /scoped-env/tasks/:id/preview': async (c) => {
      object(c.query, []);
      const preview = await s.environment.preview(id(c));
      return {
        context: await context(id(c), true),
        variables: preview.variables.map((v) => ({
          name: v.name,
          operation: v.operation,
          status: 'enabled',
          is_secret: v.is_secret,
          has_value: v.operation === 'SET' && (v.is_secret || v.value !== null),
          value: v.value,
          source: v.origin,
        })),
      };
    },
    'POST /scoped-env/profiles': async (c) => {
      const b = object(
          c.body,
          ['workspace_id', 'name', 'description', 'status'],
          ['workspace_id', 'name', 'description', 'status'],
        ),
        workspaceId = number(b.workspace_id),
        ws = await s.store.workspace(workspaceId);
      const result = await s.environment.createProfile(
        workspaceId,
        ws.version,
        {
          name: text(b.name, 255),
          description: text(b.description, 65536, true),
          status: choice(b.status, ['enabled', 'disabled']),
        },
      );
      return profileDto(result.id);
    },
    'PUT /scoped-env/profiles': async (c) => {
      const b = object(
          c.body,
          [
            'id',
            'workspace_id',
            'name',
            'description',
            'status',
            'expected_version',
          ],
          [
            'id',
            'workspace_id',
            'name',
            'description',
            'status',
            'expected_version',
          ],
        ),
        profile = await s.environment.profile(number(b.id));
      if (profile.workspace_id !== number(b.workspace_id))
        fail('ENV_PROFILE_WORKSPACE_MISMATCH', 422);
      const result = await s.environment.updateProfile(
        profile.id,
        number(b.expected_version),
        {
          name: text(b.name, 255),
          description: text(b.description, 65536, true),
          status: choice(b.status, ['enabled', 'disabled']),
        },
      );
      return profileDto(result.id);
    },
    'DELETE /scoped-env/profiles/:id': async (c) => {
      await s.environment.removeProfile(id(c), expected(c.body));
      return null;
    },
    'POST /scoped-env/profiles/:id/clone': async (c) => {
      const b = object(
          c.body,
          ['name', 'expected_version'],
          ['name', 'expected_version'],
        ),
        p = await s.environment.profile(id(c));
      const created = await s.leases.withWorkspace(
        p.workspace_id,
        'API_PROFILE_CLONE',
        async (lease) => {
          const ws = await s.store.assertAccessible(p.workspace_id, true);
          await s.roots.requireReady(ws, lease);
          return s.store.transaction(async (tx) => {
            const current = await s.environment.profile(p.id);
            if (current.version !== number(b.expected_version))
              fail('ENV_PROFILE_SAVE_CONFLICT');
            const row = await tx.run(
              'INSERT INTO EnvironmentProfiles(workspace_id,name,description,status) VALUES(?,?,?,?)',
              [
                p.workspace_id,
                text(b.name, 255),
                current.description,
                current.status,
              ],
            );
            await tx.run(
              'INSERT INTO WorkspaceProfileVariables(profile_id,name,value,operation,status,is_secret,position,labels) SELECT ?,name,value,operation,status,is_secret,position,labels FROM WorkspaceProfileVariables WHERE profile_id=?',
              [row.lastID, p.id],
            );
            return row.lastID;
          });
        },
      );
      return profileDto(created);
    },
    'PUT /scoped-env/workspaces/:id/profile': async (c) => {
      const b = object(
        c.body,
        ['expected_version', 'env_profile_id'],
        ['expected_version', 'env_profile_id'],
      );
      await s.environment.selectWorkspaceProfile(
        id(c),
        number(b.expected_version),
        nullableId(b.env_profile_id),
      );
      return context(id(c));
    },
    'PUT /scoped-env/tasks/:id/profile': async (c) => {
      const b = object(
        c.body,
        ['expected_version', 'env_profile_id'],
        ['expected_version', 'env_profile_id'],
      );
      await s.environment.selectTaskProfile(
        id(c),
        number(b.expected_version),
        nullableId(b.env_profile_id),
      );
      return context(id(c), true);
    },
    'GET /scoped-env/global/variables': async (c) => {
      object(c.query, []);
      return globalVariables(c);
    },
    'PUT /scoped-env/global/variables': async (c) => {
      object(c.query, []);
      const match = /^"global-env-([1-9][0-9]*)"$/.exec(c.ifMatch ?? '');
      if (!match) fail('ENV_VERSION_CONFLICT');
      if (!Array.isArray(c.body) || c.body.length > 1000)
        fail('INVALID_REQUEST', 400);
      const previous = await s.store.all<any>('SELECT * FROM Envs'),
        merged = new Map<string, any>(
          previous.map((row) => [
            row.name,
            {
              name: row.name,
              operation: row.operation,
              status: row.status === 1 ? 'disabled' : 'enabled',
              is_secret: !!row.is_secret,
              ...(row.is_secret || row.operation === 'UNSET'
                ? {}
                : { value: row.value }),
              position: row.position,
              labels:
                typeof row.labels === 'string'
                  ? json(row.labels, [])
                  : row.labels ?? [],
            },
          ]),
        ),
        seen = new Set<string>();
      for (const raw of c.body) {
        const b = object(
            raw,
            [
              'name',
              'value',
              'operation',
              'status',
              'is_secret',
              'position',
              'clear',
              'replace_secret',
              'labels',
            ],
            ['name'],
          ),
          name = text(b.name, 255);
        if (seen.has(name)) fail('ENV_NAME_INVALID', 400);
        seen.add(name);
        if (b.clear === true) {
          if (b.value !== undefined || b.replace_secret === true)
            fail('ENV_SECRET_ACTION_INVALID', 400);
          merged.delete(name);
          continue;
        }
        const old = merged.get(name),
          value = {
            ...old,
            ...b,
            name,
            operation: b.operation ?? old?.operation ?? 'SET',
            status: b.status ?? old?.status ?? 'enabled',
            is_secret: b.is_secret ?? old?.is_secret ?? false,
          };
        if (value.labels !== undefined)
          value.labels = strings(value.labels, 1000, 255);
        if (value.operation === 'UNSET' && b.value === undefined)
          delete value.value;
        merged.set(name, value);
      }
      const definitions = [...merged.values()].map((v) => {
        const labels = v.labels;
        const { labels: _, ...input } = v;
        return { ...variableWrite([input], previous)[0], labels };
      });
      await s.environment.replaceGlobals(number(Number(match[1])), definitions);
      return globalVariables(c);
    },
    'GET /tasks/:id/config-context': async (c) => configContext(c),
    'GET /tasks/:id/config-preview': async (c) => configContext(c),
    'GET /tasks/:id/hooks': async (c) => {
      object(c.query, []);
      return hooks(id(c));
    },
    'POST /tasks/:id/hooks': async (c) => {
      const value = hookWrite(c.body);
      return hookMutation(id(c), false, async () => {
        if (
          (await hooks(id(c))).some(
            (h) => h.phase === value.phase && h.position === value.position,
          )
        )
          fail('CONFIG_EDIT_CONFLICT');
        const result = await s.store.run(
          'INSERT INTO TaskHooks(task_id,name,phase,command,cwd_base,position,timeout_seconds,failure_policy,enabled,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
          [
            id(c),
            value.name,
            value.phase,
            value.command,
            value.cwd_base,
            value.position,
            value.timeout_seconds,
            value.failure_policy,
            value.enabled ? 1 : 0,
          ],
        );
        return (await hooks(id(c))).find((h) => h.id === result.lastID);
      });
    },
    'PUT /tasks/:id/hooks/:hookId': async (c) => {
      const value = hookWrite(c.body, true),
        hookId = pathId(c.params.hookId);
      return hookMutation(id(c), false, async () => {
        const current = (await hooks(id(c))).find((h) => h.id === hookId);
        if (!current) fail('CONFIG_BINDING_NOT_FOUND', 404);
        if (current.version !== number(c.body.expected_version))
          fail('CONFIG_EDIT_CONFLICT');
        if (
          (await hooks(id(c))).some(
            (h) =>
              h.id !== hookId &&
              h.phase === value.phase &&
              h.position === value.position,
          )
        )
          fail('CONFIG_EDIT_CONFLICT');
        await s.store.run(
          'UPDATE TaskHooks SET name=?,phase=?,command=?,cwd_base=?,position=?,timeout_seconds=?,failure_policy=?,enabled=?,version=version+1,updatedAt=CURRENT_TIMESTAMP WHERE id=? AND task_id=? AND version=?',
          [
            value.name,
            value.phase,
            value.command,
            value.cwd_base,
            value.position,
            value.timeout_seconds,
            value.failure_policy,
            value.enabled ? 1 : 0,
            hookId,
            id(c),
            current.version,
          ],
        );
        return (await hooks(id(c))).find((h) => h.id === hookId);
      });
    },
    'DELETE /tasks/:id/hooks/:hookId': async (c) => {
      const version = expected(c.body),
        hookId = pathId(c.params.hookId);
      return hookMutation(id(c), true, async () => {
        const current = (await hooks(id(c))).find((h) => h.id === hookId);
        if (!current) fail('CONFIG_BINDING_NOT_FOUND', 404);
        if (current.version !== version) fail('CONFIG_EDIT_CONFLICT');
        await s.store.run(
          'DELETE FROM TaskHooks WHERE id=? AND task_id=? AND version=?',
          [hookId, id(c), version],
        );
        return null;
      });
    },
    'PUT /tasks/:id/hooks/reorder': async (c) => {
      const b = object(
        c.body,
        ['expected_task_version', 'hooks'],
        ['expected_task_version', 'hooks'],
      );
      if (!Array.isArray(b.hooks) || b.hooks.length > 100)
        fail('INVALID_REQUEST', 400);
      return hookMutation(id(c), false, async () => {
        if (
          (await s.tasks.get(id(c))).task.version !==
          number(b.expected_task_version)
        )
          fail('TASK_VERSION_CONFLICT');
        const current = await hooks(id(c));
        if (current.length !== b.hooks.length) fail('CONFIG_EDIT_CONFLICT');
        const seen = new Set<number>(),
          positions = new Set<string>();
        for (const input of b.hooks) {
          const item = object(
              input,
              ['id', 'expected_version', 'position'],
              ['id', 'expected_version', 'position'],
            ),
            hookId = number(item.id),
            row = current.find((h) => h.id === hookId);
          if (
            !row ||
            seen.has(hookId) ||
            row.version !== number(item.expected_version)
          )
            fail('CONFIG_EDIT_CONFLICT');
          seen.add(hookId);
          const key = row.phase + ':' + number(item.position, 0);
          if (positions.has(key)) fail('CONFIG_EDIT_CONFLICT');
          positions.add(key);
        }
        for (let i = 0; i < b.hooks.length; i++)
          await s.store.run('UPDATE TaskHooks SET position=? WHERE id=?', [
            -1 - i,
            b.hooks[i].id,
          ]);
        for (const item of b.hooks)
          await s.store.run(
            'UPDATE TaskHooks SET position=?,version=version+1,updatedAt=CURRENT_TIMESTAMP WHERE id=?',
            [item.position, item.id],
          );
        return null;
      });
    },
    'GET /config-assets': async (c) => {
      object(c.query, []);
      return assets.list();
    },
    'POST /config-assets': async (c) => assets.save(c.body),
    'PUT /config-assets/:id': async (c) => assets.save(c.body, id(c)),
    'POST /config-assets/:id/revisions': async (c) =>
      assets.save(c.body, id(c)),
    'GET /config-assets/:id/revisions': async (c) => {
      object(c.query, []);
      return assets.revisions(id(c));
    },
    'GET /config-assets/:id/content': async (c) => {
      object(c.query, []);
      return assets.content(id(c));
    },
    'GET /config-assets/:id/usage': async (c) => {
      object(c.query, []);
      return assets.usage(id(c));
    },
    'DELETE /config-assets/:id': async (c) => {
      object(c.query, ['version']);
      object(c.body ?? {}, []);
      return assets.remove(id(c), queryNumber(c.query.version, 0, 1));
    },
  };
  async function configContext(c: ApiCall) {
    object(c.query, []);
    const resolved = await s.resources.definition(id(c));
    return {
      workspace_id: resolved.workspace.id,
      task_id: id(c),
      workspace_bindings: await bindings(resolved.workspace.id),
      task_bindings: await bindings(id(c), true),
      effective: resolved.configs.map((item) => ({
        binding_id: item.binding.id,
        source: item.source,
        asset_id: item.asset_id,
        revision_id: item.revision.id,
        target_base:
          item.binding.target_base === 'TASK_CWD'
            ? 'TASK_DIR'
            : 'WORKSPACE_ROOT',
        target_path: item.binding.target_path,
        is_secret: item.is_secret,
      })),
    };
  }
  for (const task of [false, true]) {
    const base = `/${task ? 'tasks' : 'workspaces'}/:id/config-bindings`,
      type = task ? 'TASK' : 'WORKSPACE';
    routes[`GET ${base}`] = async (c) => {
      object(c.query, []);
      return bindings(id(c), task);
    };
    routes[`POST ${base}`] = async (c) => {
      const value = configBindingWrite(c.body),
        version = await ownerVersion(id(c), task),
        bindingId = await (task
          ? s.environment.saveTaskConfig(id(c), version, value)
          : s.environment.saveWorkspaceConfig(id(c), version, value));
      return binding(id(c), bindingId, task);
    };
    routes[`PUT ${base}/:bindingId`] = async (c) => {
      const value = configBindingWrite(c.body, true),
        bindingId = pathId(c.params.bindingId);
      await binding(id(c), bindingId, task);
      const version = await ownerVersion(id(c), task);
      await (task
        ? s.environment.saveTaskConfig(id(c), version, {
            ...value,
            id: bindingId,
          })
        : s.environment.saveWorkspaceConfig(id(c), version, {
            ...value,
            id: bindingId,
          }));
      return binding(id(c), bindingId, task);
    };
    routes[`DELETE ${base}/:bindingId`] = async (c) => {
      const version = expected(c.body),
        bindingId = pathId(c.params.bindingId);
      await binding(id(c), bindingId, task);
      const owner = await ownerVersion(id(c), task);
      await (task
        ? s.environment.removeTaskConfig(id(c), owner, bindingId, version)
        : s.environment.removeWorkspaceConfig(
            id(c),
            owner,
            bindingId,
            version,
          ));
      return null;
    };
    void type;
  }
  for (const task of [false, true]) {
    const base = `/scoped-env/${task ? 'tasks' : 'profiles'}/:id/variables`,
      table = task ? 'TaskEnvVariables' : 'WorkspaceProfileVariables',
      key = task ? 'task_id' : 'profile_id';
    routes[`GET ${base}`] = async (c) => {
      object(c.query, []);
      if (task) await s.tasks.get(id(c));
      else await s.environment.profile(id(c));
      return (
        await s.store.all<VariableRow>(
          `SELECT * FROM ${table} WHERE ${key}=? ORDER BY position,name`,
          [id(c)],
        )
      ).map((row) => publicVariable(row));
    };
    routes[`PUT ${base}`] = async (c) => {
      const b = object(
          c.body,
          ['expected_version', 'variables'],
          ['expected_version', 'variables'],
        ),
        previous = await s.store.all<VariableRow>(
          `SELECT * FROM ${table} WHERE ${key}=?`,
          [id(c)],
        ),
        values = variableWrite(b.variables, previous);
      await (task
        ? s.environment.replaceTaskVariables(
            id(c),
            number(b.expected_version),
            values,
          )
        : s.environment.replaceProfileVariables(
            id(c),
            number(b.expected_version),
            values,
          ));
      return (
        await s.store.all<VariableRow>(
          `SELECT * FROM ${table} WHERE ${key}=? ORDER BY position,name`,
          [id(c)],
        )
      ).map((row) => publicVariable(row));
    };
  }
  return routes;
}
