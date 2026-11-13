import type { AdmissionSnapshot } from './types';
import type { TaskResourceResolver } from './resources';
import { fail } from '../workspaceV2/errors';

type Definition = Awaited<ReturnType<TaskResourceResolver['definition']>>;
export interface GitUpdateAdmissionEvent {
  origin_trigger_id: number;
  task_id: number;
  workspace_id: number;
  workspace_update_id: number | null;
  event_key: string;
  metadata: string;
}
export interface GitUpdateAdmissionFact {
  id: number;
  workspace_id: number;
  source_generation: number;
  content_revision: number;
  inventory_hash: string;
  after_commit: string;
  initial: number;
  trigger_plan: string;
}
const keys = (
  value: unknown,
  expected: string[],
): value is Record<string, unknown> => {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key))
  );
};
const positive = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const relative = (value: unknown) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !value.startsWith('/') &&
  !/[\\\x00-\x1f]/.test(value) &&
  value.split('/').every((part) => !!part && part !== '.' && part !== '..');
function snapshot(value: unknown): asserts value is AdmissionSnapshot {
  if (
    !keys(value, [
      'workspace_id',
      'workspace_type',
      'expected_workspace_version',
      'expected_source_generation',
      'expected_content_revision',
      'expected_task_definition_version',
      'expected_global_env_version',
      'expected_inventory_hash',
      'expected_git_commit',
      'effective_resource_versions',
      'relative_entrypoint',
      'language',
      'cwd_mode',
      'cwd_relative_path',
    ])
  )
    fail('TRIGGER_EVENT_INVALID');
  for (const key of [
    'workspace_id',
    'expected_workspace_version',
    'expected_source_generation',
    'expected_content_revision',
    'expected_task_definition_version',
    'expected_global_env_version',
  ])
    if (!positive(value[key])) fail('TRIGGER_EVENT_INVALID');
  if (
    value.workspace_type !== 'GIT' ||
    typeof value.expected_inventory_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.expected_inventory_hash) ||
    typeof value.expected_git_commit !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.expected_git_commit) ||
    !relative(value.relative_entrypoint) ||
    !['PYTHON', 'JAVASCRIPT', 'TYPESCRIPT', 'SHELL'].includes(
      String(value.language),
    ) ||
    !['WORKSPACE_ROOT', 'ENTRYPOINT_DIR', 'CUSTOM_RELATIVE'].includes(
      String(value.cwd_mode),
    ) ||
    (value.cwd_mode === 'CUSTOM_RELATIVE'
      ? !relative(value.cwd_relative_path)
      : value.cwd_relative_path !== null)
  )
    fail('TRIGGER_EVENT_INVALID');
  const resources = value.effective_resource_versions;
  if (
    !keys(resources, [
      'global_env_version',
      'system_allowlist_build_version',
      'profile',
      'python',
      'node',
      'config_revisions',
    ]) ||
    resources.global_env_version !== value.expected_global_env_version ||
    typeof resources.system_allowlist_build_version !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(resources.system_allowlist_build_version)
  )
    fail('TRIGGER_EVENT_INVALID');
  if (
    resources.profile !== null &&
    (!keys(resources.profile, ['id', 'version']) ||
      !Object.values(resources.profile).every(positive))
  )
    fail('TRIGGER_EVENT_INVALID');
  for (const kind of ['python', 'node']) {
    const runtime = resources[kind];
    const expected = [
      'environment_id',
      'revision_id',
      'build_id',
      'runtime_id',
      ...(kind === 'node' ? ['toolchain_id'] : []),
    ];
    if (
      runtime !== null &&
      (!keys(runtime, expected) || !Object.values(runtime).every(positive))
    )
      fail('TRIGGER_EVENT_INVALID');
  }
  if (
    !Array.isArray(resources.config_revisions) ||
    resources.config_revisions.length > 20000
  )
    fail('TRIGGER_EVENT_INVALID');
  for (const config of resources.config_revisions)
    if (
      !keys(config, [
        'asset_id',
        'revision_id',
        'binding_id',
        'binding_version',
      ]) ||
      !Object.values(config).every(positive)
    )
      fail('TRIGGER_EVENT_INVALID');
}
export function validateGitUpdateSnapshot(
  value: unknown,
): asserts value is AdmissionSnapshot {
  snapshot(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function sameAdmission(
  left: AdmissionSnapshot,
  right: AdmissionSnapshot,
) {
  return canonical(left) === canonical(right);
}

/** Pure safe metadata, including unavailable current resources, for stale-event comparison. */
export function currentGitAdmission(
  selected: Definition,
  commit: string,
): AdmissionSnapshot {
  return {
    workspace_id: selected.workspace.id,
    workspace_type: selected.workspace.type,
    expected_workspace_version: selected.workspace.version,
    expected_source_generation: selected.workspace.source_generation,
    expected_content_revision: selected.workspace.content_revision,
    expected_task_definition_version: selected.task.version,
    expected_global_env_version:
      selected.effectiveResourceVersions.global_env_version,
    expected_inventory_hash: selected.workspace.content_inventory_hash ?? '',
    expected_git_commit: commit,
    effective_resource_versions: selected.effectiveResourceVersions,
    relative_entrypoint: selected.source.relative_entrypoint,
    language: selected.source.language,
    cwd_mode: selected.source.cwd_mode,
    cwd_relative_path: selected.source.cwd_relative_path,
  };
}

/** Event metadata is accepted only when identical to its immutable successful-update plan. */
export function frozenGitUpdateAdmission(
  event: GitUpdateAdmissionEvent,
  fact: GitUpdateAdmissionFact,
  taskId: number,
) {
  if (
    !fact ||
    fact.id !== event.workspace_update_id ||
    fact.workspace_id !== event.workspace_id ||
    typeof event.metadata !== 'string' ||
    Buffer.byteLength(event.metadata) > 16 * 1024 * 1024 ||
    Buffer.byteLength(fact.trigger_plan) > 16 * 1024 * 1024
  )
    fail('TRIGGER_EVENT_INVALID');
  let metadata: unknown, plan: unknown;
  try {
    metadata = JSON.parse(event.metadata);
    plan = JSON.parse(fact.trigger_plan);
  } catch {
    fail('TRIGGER_EVENT_INVALID');
  }
  if (
    !keys(metadata, [
      'frozen_admission',
      'trigger_version',
      'initial',
      'origin_trigger_id',
      'workspace_update_id',
    ]) ||
    !positive(metadata.trigger_version) ||
    metadata.origin_trigger_id !== event.origin_trigger_id ||
    metadata.workspace_update_id !== fact.id ||
    metadata.initial !== !!fact.initial ||
    !Array.isArray(plan) ||
    plan.length > 10000
  )
    fail('TRIGGER_EVENT_INVALID');
  const targets = plan.filter(
    (item) =>
      item &&
      item.origin_trigger_id === event.origin_trigger_id &&
      item.task_id === taskId &&
      item.event_key === event.event_key,
  );
  if (targets.length !== 1) fail('TRIGGER_EVENT_INVALID');
  const target = targets[0] as Record<string, unknown>;
  snapshot(metadata.frozen_admission);
  snapshot(target.admission);
  const expected = metadata.frozen_admission;
  if (
    target.skip_reason !== null ||
    target.trigger_version !== metadata.trigger_version ||
    target.task_definition_version !==
      expected.expected_task_definition_version ||
    !sameAdmission(expected, target.admission) ||
    expected.workspace_id !== fact.workspace_id ||
    expected.expected_source_generation !== fact.source_generation ||
    expected.expected_content_revision !== fact.content_revision ||
    expected.expected_inventory_hash !== fact.inventory_hash ||
    expected.expected_git_commit !== fact.after_commit
  )
    fail('TRIGGER_EVENT_INVALID');
  return expected;
}
