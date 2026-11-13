import type { ExecutionContext, ExecutionResult } from '../../shared/execution';
import type { ResolvedConfig } from '../taskConfig';
import type { TaskHook } from '../../data/configAsset';
import type { WorkspaceRow } from '../workspaceV2/types';

export type WaitMode = 'WAIT' | 'SKIP' | 'FAIL_FAST';
export type RunStatus =
  | 'QUEUED'
  | 'RESOLVING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'SKIPPED'
  | 'RECOVERY_REQUIRED';
export type TriggerType =
  | 'MANUAL'
  | 'API'
  | 'INTERNAL'
  | 'SCHEDULE'
  | 'CRON'
  | 'WEBHOOK'
  | 'GIT_UPDATE';
export interface CandidateEnvironmentSnapshot {
  variables: Readonly<Record<string, string>>;
  unsetVariables: readonly string[];
  origins: Readonly<Record<string, string>>;
  secretNames: readonly string[];
  profile: {
    id: number;
    version: number;
    workspace_id: number;
    name: string;
    status: string;
  } | null;
  metadata: object;
}
export interface CandidateResolvedConfig
  extends Omit<ResolvedConfig, 'source' | 'binding'> {
  source: 'WORKSPACE' | 'TASK';
  binding: Omit<
    ResolvedConfig['binding'],
    'target_base' | 'conflict_policy'
  > & {
    target_base: 'WORKSPACE_ROOT' | 'TASK_CWD';
    conflict_policy: 'FAIL_IF_EXISTS' | 'BACKUP_AND_RESTORE';
  };
}
export interface ResourceVersions {
  global_env_version: number;
  system_allowlist_build_version: string;
  profile: { id: number; version: number } | null;
  python: {
    environment_id: number;
    revision_id: number;
    build_id: number;
    runtime_id: number;
  } | null;
  node: {
    environment_id: number;
    revision_id: number;
    build_id: number;
    runtime_id: number;
    toolchain_id: number;
  } | null;
  config_revisions: {
    asset_id: number;
    revision_id: number;
    binding_id: number;
    binding_version: number;
  }[];
}
export interface AdmissionSnapshot {
  workspace_id: number;
  workspace_type: WorkspaceRow['type'];
  expected_workspace_version: number;
  expected_source_generation: number;
  expected_content_revision: number;
  expected_task_definition_version: number;
  expected_global_env_version: number;
  expected_inventory_hash: string;
  expected_git_commit: string | null;
  effective_resource_versions: ResourceVersions;
  relative_entrypoint: string;
  language: 'PYTHON' | 'JAVASCRIPT' | 'TYPESCRIPT' | 'SHELL';
  cwd_mode: 'WORKSPACE_ROOT' | 'ENTRYPOINT_DIR' | 'CUSTOM_RELATIVE';
  cwd_relative_path: string | null;
}
export interface SourceSnapshot {
  workspace_id: number;
  workspace_type: WorkspaceRow['type'];
  source_generation: number;
  content_revision: number;
  task_definition_version: number;
  inventory_hash: string;
  entrypoint_checksum: string;
  relative_entrypoint: string;
  cwd_mode: AdmissionSnapshot['cwd_mode'];
  cwd_relative_path: string | null;
  git: {
    repository_id: number;
    commit: string;
    ref_type: string;
    ref_name: string;
  } | null;
  effective_resource_versions: ResourceVersions;
}
export interface WorkspaceExecutionContext
  extends Omit<
    ExecutionContext,
    'source' | 'environmentSnapshot' | 'configSnapshot' | 'runtime'
  > {
  runtime: ExecutionContext['runtime'] & {
    providerId?: number;
    providerRevision?: string;
    runtimeVersion?: string;
    environmentVersion?: number;
    toolchainVersion?: string;
  };
  source: {
    workspaceId: number;
    workspaceType: WorkspaceRow['type'];
    sourceGeneration: number;
    contentRevision: number;
    inventoryHash: string;
    relativeEntrypoint: string;
    absoluteEntrypoint: string;
    language: AdmissionSnapshot['language'];
    cwd: string;
    cwdMode: AdmissionSnapshot['cwd_mode'];
    cwdRelativePath: string | null;
    checksum: string;
    git: SourceSnapshot['git'];
  };
  environmentSnapshot: CandidateEnvironmentSnapshot;
  configSnapshot: readonly CandidateResolvedConfig[];
  hookSnapshot: readonly TaskHook[];
}
export interface RunRow {
  id: number;
  task_id: number | null;
  workspace_id: number;
  active_workspace_id: number | null;
  expected_workspace_version: number;
  expected_global_env_version: number;
  expected_task_definition_version: number;
  expected_source_generation: number;
  expected_content_revision: number;
  expected_git_commit: string | null;
  expected_inventory_hash: string;
  admission_snapshot: string;
  source_snapshot: string | null;
  snapshot_metadata: string | null;
  trigger_type: TriggerType;
  trigger_id: number | null;
  event_id: number | null;
  submission_key: string;
  status: RunStatus;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempt_count: number;
  cancel_requested: number;
  log_identity: string;
  concurrency_policy: 'FORBID' | 'QUEUE' | 'ALLOW';
  wait_mode: WaitMode;
  queue_reason: string;
  queue_deadline_at: string;
  next_eligible_at: string;
  queue_attempt_count: number;
  owner_token: string | null;
  error_code: string | null;
  result: string | null;
  log_size: number;
}
export type AttemptResult = ExecutionResult;
