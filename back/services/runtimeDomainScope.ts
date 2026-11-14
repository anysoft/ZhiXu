import { AsyncLocalStorage } from 'async_hooks';
import type { Sequelize, ModelStatic, Model, Transaction } from 'sequelize';
import type { WorkspaceStore } from './workspaceV2/store';
import type { PlatformBackupBarrier } from './backup/barrier';
import { RuntimeError } from '../shared/runtime';
import type { VerifiedRuntimeArtifactStore } from './runtimeArtifacts';

export interface RuntimeDomainContext {
  sequelize: Sequelize;
  models: Record<string, ModelStatic<Model>>;
  store: WorkspaceStore;
  barrier: PlatformBackupBarrier;
  artifacts?: VerifiedRuntimeArtifactStore;
}
const scope = new AsyncLocalStorage<RuntimeDomainContext>();
export function withRuntimeDomain<T>(
  context: RuntimeDomainContext,
  action: () => T,
): T {
  return scope.run(context, action);
}
export function currentRuntimeDomain() {
  return scope.getStore();
}

/** Stable lazy proxies preserve legacy imports while binding each async v2 call explicitly. */
function model<T>(name: string, module: string): T {
  const resolve = () => scope.getStore()?.models[name] ?? require(module)[name];
  return new Proxy(function () {}, {
    get(_target, key) {
      const actual = resolve(),
        value = Reflect.get(actual, key);
      return typeof value === 'function' ? value.bind(actual) : value;
    },
    set(_target, key, value) {
      return Reflect.set(resolve(), key, value);
    },
    construct(_target, args) {
      return Reflect.construct(resolve(), args);
    },
  }) as T;
}
export const sequelize: Sequelize = new Proxy({} as Sequelize, {
  get(_target, key) {
    const actual = scope.getStore()?.sequelize ?? require('../data').sequelize,
      value = Reflect.get(actual, key);
    return typeof value === 'function' ? value.bind(actual) : value;
  },
});
export const RuntimeProviderModel = model<
  typeof import('../data/runtime').RuntimeProviderModel
>('RuntimeProviderModel', '../data/runtime');
export const RuntimeInstallationModel = model<
  typeof import('../data/runtime').RuntimeInstallationModel
>('RuntimeInstallationModel', '../data/runtime');
export const RuntimeOperationModel = model<
  typeof import('../data/runtime').RuntimeOperationModel
>('RuntimeOperationModel', '../data/runtime');
export const PythonEnvironmentModel = model<
  typeof import('../data/pythonEnvironment').PythonEnvironmentModel
>('PythonEnvironmentModel', '../data/pythonEnvironment');
export const PythonEnvironmentRevisionModel = model<
  typeof import('../data/pythonEnvironment').PythonEnvironmentRevisionModel
>('PythonEnvironmentRevisionModel', '../data/pythonEnvironment');
export const PythonEnvironmentBuildModel = model<
  typeof import('../data/pythonEnvironment').PythonEnvironmentBuildModel
>('PythonEnvironmentBuildModel', '../data/pythonEnvironment');
export const NodeEnvironmentModel = model<
  typeof import('../data/nodeEnvironment').NodeEnvironmentModel
>('NodeEnvironmentModel', '../data/nodeEnvironment');
export const NodeEnvironmentRevisionModel = model<
  typeof import('../data/nodeEnvironment').NodeEnvironmentRevisionModel
>('NodeEnvironmentRevisionModel', '../data/nodeEnvironment');
export const NodeEnvironmentBuildModel = model<
  typeof import('../data/nodeEnvironment').NodeEnvironmentBuildModel
>('NodeEnvironmentBuildModel', '../data/nodeEnvironment');
export const NodePackageManagerToolchainModel = model<
  typeof import('../data/nodeEnvironment').NodePackageManagerToolchainModel
>('NodePackageManagerToolchainModel', '../data/nodeEnvironment');

/** This decorator changes only retained Runtime domains; global PlatformMutation is untouched. */
export function ScopedRuntimeMutation(drain = false): MethodDecorator {
  return (_target, _name, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;
    descriptor.value = async function (...args: unknown[]) {
      const barrier =
        scope.getStore()?.barrier ??
        (await require('./backup/platform').platformBarrier());
      return barrier.mutation(() => original.apply(this, args), drain);
    };
  };
}
export async function runtimeEnvironmentReferences(
  kind: 'PYTHON' | 'NODE',
  id: number,
  transaction?: Transaction,
) {
  const context = scope.getStore();
  if (!context)
    return new (require('./taskReferences').default)().environment(
      kind,
      id,
      transaction,
    );
  const key =
      kind === 'PYTHON' ? 'python_environment_id' : 'node_environment_id',
    part = kind === 'PYTHON' ? 'python' : 'node';
  const query = async (sql: string) =>
    (await context.sequelize.query(sql, {
      replacements: { id },
      transaction,
      type: 'SELECT' as any,
    })) as any[];
  const tasks = await query(
    `SELECT t.id,t.name FROM Tasks t JOIN TaskRuntimeBindings b ON b.task_id=t.id WHERE b.${key}=:id ORDER BY t.id`,
  );
  const defaults = await query(
    `SELECT w.workspace_id id,w.workspace_id,w.kind,w.${key} environment_id FROM WorkspaceRuntimeDefaults w WHERE w.${key}=:id ORDER BY w.workspace_id`,
  );
  const history = await query(
    `SELECT r.id,r.status FROM TaskRuns r WHERE json_extract(r.admission_snapshot,'$.effective_resource_versions.${part}.environment_id')=:id OR json_extract(r.source_snapshot,'$.effective_resource_versions.${part}.environment_id')=:id`,
  );
  const pending = history.filter((row) =>
    ['QUEUED', 'RESOLVING', 'RUNNING', 'RECOVERY_REQUIRED'].includes(
      row.status,
    ),
  );
  return {
    tasks,
    tasks_count: tasks.length,
    defaults,
    defaults_count: defaults.length,
    history_count: history.length,
    recovery_count: history.filter((row) => row.status === 'RECOVERY_REQUIRED')
      .length,
    pending_count: pending.length,
  };
}
export async function requireUnusedRuntimeEnvironment(
  kind: 'PYTHON' | 'NODE',
  id: number,
  transaction?: Transaction,
) {
  if (!scope.getStore())
    return new (require('./taskReferences').default)().requireUnusedEnvironment(
      kind,
      id,
      transaction,
    );
  const report = await runtimeEnvironmentReferences(kind, id, transaction);
  if (report.tasks_count || report.defaults_count || report.pending_count)
    throw Object.assign(new RuntimeError(kind + '_ENV_TASK_REFERENCED', 409), {
      references: report,
    });
}
