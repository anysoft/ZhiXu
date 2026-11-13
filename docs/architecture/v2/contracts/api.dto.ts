/**
 * S0 review-only API examples. Not imported by back/, src/, production schemas or CI.
 * TECHNICAL_CONTRACT_READY_FOR_APPROVAL, not APPROVED or implemented.
 * All IDs are positive safe integers; all timestamps are UTC ISO-8601 strings.
 */
import type {
  SubmittedTaskRunDto,
  TaskRunSourceSnapshot,
  TaskRunQueueDto,
} from './execution.dto';
export type Id = number;
export type Version = number;
export type SHA256 = string;
export type CommitSHA = string;
export type WorkspaceType = 'LOCAL' | 'GIT';
export type WorkspaceLifecycle =
  | 'CREATING'
  | 'READY'
  | 'ARCHIVED'
  | 'DELETE_REQUESTED'
  | 'TOMBSTONED'
  | 'ERROR'
  | 'RECOVERY_REQUIRED';
export type WorkspaceStorageState =
  | 'PROVISIONING'
  | 'PRESENT'
  | 'RECLAIMING'
  | 'RECLAIMED';
export type GitRefType = 'branch' | 'tag' | 'commit';
export type OperationType =
  | 'CREATE'
  | 'ARCHIVE'
  | 'UNARCHIVE'
  | 'DELETE_RECLAIM'
  | 'RECOVER'
  | 'FILE_MUTATION';
export type OperationStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'DRAINING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';
export interface Success<T> {
  code: 200 | 202;
  data: T;
}
export interface ApiFailure {
  code: number;
  error_code: string;
  message: string; // fixed safe registry message, never raw exception text
  retryable: boolean;
  resource?: { type: string; id?: Id };
  operation?: string;
  details?: {
    current_version?: Version;
    retry_after_seconds?: number;
    reference_count?: number;
    references?: WorkspaceReferences;
  };
}
export interface Pagination {
  page?: number;
  size?: number;
}
export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
}
export interface ExpectedVersion {
  expected_version: Version;
}
export interface WorkspaceQuery extends Pagination {
  type?: WorkspaceType;
  lifecycle_state?: WorkspaceLifecycle;
  repository_id?: Id;
  include_tombstones?: boolean;
  search?: string;
}
export interface WorkspaceReferences {
  tasks_count: number;
  historical_runs_count: number;
  sync_runs_count: number;
  active_operations_count: number;
  recovery_required: boolean;
  physical_reclaim_blockers: Array<{
    kind:
      | 'TASK_SOURCE'
      | 'ACTIVE_RUN'
      | 'ACTIVE_SYNC'
      | 'JOURNAL'
      | 'OWNER_UNKNOWN'
      | 'PRESERVATION';
    count: number;
  }>;
  metadata_purge_blockers: Array<{ kind: string; count: number }>;
}
export interface GitWorkspacePublic {
  repository_id: Id;
  ref_type: GitRefType;
  ref_name: string;
  resolved_commit: CommitSHA;
  applied_commit: CommitSHA | null;
  last_verified_commit: CommitSHA | null;
  baseline_established: boolean;
  baseline_sync_run_id: Id | null;
  // private branch, checkout path, credentials and raw Git stderr are internal.
}
export interface WorkspaceDto {
  id: Id;
  name: string;
  type: WorkspaceType;
  lifecycle_state: WorkspaceLifecycle;
  storage_state: WorkspaceStorageState;
  version: Version;
  source_generation: number;
  content_revision: number;
  content_inventory_hash: SHA256 | null;
  default_env_profile_id: Id | null;
  task_count: number;
  last_content_update_at: string | null;
  git?: GitWorkspacePublic;
  capabilities: {
    read_files: boolean;
    write_files: boolean;
    create_task: boolean;
    run_task: boolean;
    git: boolean;
    sync: boolean;
    discovery: boolean;
  };
}
export type SyncSchedule =
  | { mode: 'MANUAL'; schedule: null }
  | {
      mode: 'SCHEDULED';
      schedule: {
        type: 'CRON';
        expression: string;
        timezone: string;
        misfire_policy: 'SKIP' | 'FIRE_ONCE';
      };
    }
  | {
      mode: 'SCHEDULED';
      schedule: {
        type: 'INTERVAL';
        interval_ms: number;
        anchor_at: string;
        misfire_policy: 'SKIP' | 'FIRE_ONCE';
      };
    };
export type SyncPolicyWrite = SyncSchedule &
  ExpectedVersion & { enabled: boolean };
export type SyncPolicyDto = SyncSchedule & {
  workspace_id: Id;
  version: Version;
  enabled: boolean;
  next_due_at: string | null;
};
export interface DiscoveryPolicyWrite extends ExpectedVersion {
  enabled: boolean;
  includes: string[];
  excludes: string[];
  languages: TaskLanguage[];
}
export interface DiscoveryPolicyDto {
  workspace_id: Id;
  version: Version;
  enabled: boolean;
  includes: string[];
  excludes: string[];
  languages: TaskLanguage[];
  last_reconciled_at: string | null;
}
export type CreateWorkspace =
  | { type: 'LOCAL'; name: string }
  | {
      type: 'GIT';
      name: string;
      git: { repository_id: Id; ref_type: GitRefType; ref_name: string };
      sync_policy?: SyncSchedule & { enabled: boolean };
      discovery?: Omit<DiscoveryPolicyWrite, 'expected_version'>;
    };
export interface WorkspaceOperationDto {
  id: string;
  workspace_id: Id;
  type: OperationType;
  status: OperationStatus;
  phase: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
}
export interface AcceptedWorkspaceOperation {
  workspace: WorkspaceDto;
  operation: WorkspaceOperationDto;
}
export interface RenameWorkspace extends ExpectedVersion {
  name: string;
}
export interface DeleteWorkspace extends ExpectedVersion {
  confirm_reclaim: true;
  preservation_backup_id: string | null; // null only for a verified empty LOCAL source; no force bypass
}
export interface ReadFileQuery {
  path: string;
}
export interface FileEntry {
  path: string;
  kind: 'FILE' | 'DIRECTORY';
  size_bytes: number;
  hash: SHA256 | null;
  identity_token: string; // authenticated opaque token, not dev/ino/host path
}
export interface TreeQuery {
  path?: string;
  offset?: number;
  limit?: number;
}
export interface FileRead extends FileEntry {
  kind: 'FILE';
  hash: SHA256;
  content: string;
  content_revision: number;
  source_generation: number;
}
export interface SaveFile {
  path: string;
  content: string;
  expected_hash: SHA256;
}
export interface CreateFile {
  path: string;
  content: string;
  must_not_exist: true;
}
export interface RemoveFile {
  path: string;
  expected_hash: SHA256;
}
export interface CreateDirectory {
  path: string;
  must_not_exist: true;
}
export type RenameEntry = { path: string; destination: string } & (
  | { kind: 'FILE'; expected_hash: SHA256 }
  | { kind: 'DIRECTORY'; expected_identity: string }
);
export interface SearchQuery {
  query: string;
  content?: boolean;
  limit?: number;
}
export interface SearchResult {
  matches: Array<{ path: string; line?: number; preview?: string }>;
  truncated: boolean;
  scanned_files: number;
  scanned_bytes: number;
}
export interface ContentMutation {
  content_revision: number;
  entry: FileEntry | null;
}
export interface GitPaths {
  paths: string[];
  expected_content_revision: number;
}
export interface GitDiffQuery {
  path: string;
  staged?: boolean;
}
export interface GitCommitWrite {
  message: string;
  expected_content_revision: number;
}
export interface GitPushWrite {
  remote_branch: string;
  expected_content_revision: number;
}
export interface GitIdentityWrite {
  name: string;
  email: string;
  expected_version: Version;
}
export interface ManualSyncRequest {
  expected_version: Version;
  expected_policy_version: Version;
}
export type SyncRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCESS'
  | 'NO_CHANGE'
  | 'BLOCKED'
  | 'FAILED'
  | 'RECOVERY_REQUIRED'
  | 'CANCELLED'
  | 'INTERRUPTED';
export interface SyncRunDto {
  id: Id;
  initial: boolean;
  workspace_id: Id;
  status: SyncRunStatus;
  phase: string;
  source_generation: number;
  policy_version: Version;
  before_commit: CommitSHA | null;
  target_commit: CommitSHA | null;
  actual_commit: CommitSHA | null;
  after_commit: CommitSHA | null;
  git_update_status:
    | 'NOT_STARTED'
    | 'FETCHING'
    | 'APPLYING'
    | 'APPLIED'
    | 'UNCHANGED'
    | 'FAILED';
  discovery_status:
    | 'NOT_REQUESTED'
    | 'PENDING'
    | 'RUNNING'
    | 'SUCCESS'
    | 'FAILED';
  event_status: 'NOT_COMMITTED' | 'PENDING' | 'DISPATCHED' | 'BLOCKED';
  trigger_source: 'MANUAL' | 'CRON' | 'INTERVAL' | 'RECOVERY';
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
}
export interface DiscoveryPreviewRequest {
  expected_version: Version;
  expected_content_revision: number;
}
export interface DiscoveryPreview {
  preview_token: string; // authenticated bounded token binds all versions/hashes and expires
  workspace_id: Id;
  source_generation: number;
  content_revision: number;
  commit: CommitSHA;
  policy_version: Version;
  expires_at: string;
  actions: Array<{
    discovery_key: SHA256;
    path: string;
    action: 'CREATE' | 'UPDATE' | 'RETIRE' | 'IGNORE' | 'PRESERVE_USER';
  }>;
}
export interface DiscoveryApplyRequest {
  preview_token: string;
  expected_version: Version;
}
export interface DiscoveryApplyResult {
  policy_version: Version;
  created: number;
  updated: number;
  retired: number;
  ignored: number;
}
export interface SuppressionWrite {
  discovery_key: SHA256;
  expected_policy_version: Version;
  reason?: string;
}
export type TaskLanguage = 'PYTHON' | 'JAVASCRIPT' | 'TYPESCRIPT' | 'SHELL';
export interface WorkspaceTaskSource {
  type: 'WORKSPACE_ENTRYPOINT';
  workspace_id: Id;
  relative_entrypoint: string;
  language: TaskLanguage;
  cwd_mode: 'WORKSPACE_ROOT' | 'ENTRYPOINT_DIR' | 'CUSTOM_RELATIVE';
  cwd_relative_path: string | null;
}
export type RuntimeBinding =
  | {
      kind: 'PYTHON';
      python_environment_id: Id | null;
      node_environment_id: null;
    }
  | {
      kind: 'NODE';
      python_environment_id: null;
      node_environment_id: Id | null;
    }
  | { kind: 'SHELL'; python_environment_id: null; node_environment_id: null };
export interface ExecutionSettings {
  timeout_seconds: number | null;
  max_attempts: number;
  initial_delay_seconds: number;
  backoff: 'FIXED' | 'EXPONENTIAL';
  concurrency: 'FORBID' | 'QUEUE' | 'ALLOW';
  notification: 'NONE' | 'FAILURE' | 'SUCCESS' | 'ALWAYS';
}
export interface TaskWrite {
  name: string;
  description: string;
  enabled: boolean;
  arguments: string[];
  source: WorkspaceTaskSource;
  runtime: RuntimeBinding;
  execution: ExecutionSettings;
  env_profile_id: Id | null; // same source.workspace_id only
}
export interface UpdateTask extends TaskWrite, ExpectedVersion {}
export interface TaskDto extends TaskWrite {
  id: Id;
  version: Version;
  origin: 'MANUAL' | 'DISCOVERED';
  discovery_state: 'ACTIVE' | 'RETIRED';
}
export interface SubmitRun {
  wait_mode?: 'WAIT' | 'SKIP' | 'FAIL_FAST';
}
export type RunAccepted = SubmittedTaskRunDto;
export interface RuntimeDefaultWrite extends ExpectedVersion {
  kind: 'PYTHON' | 'NODE';
  environment_id: Id | null;
}
export interface ProfileWrite {
  workspace_id: Id;
  name: string;
  description: string;
  status: 'enabled' | 'disabled';
}
export interface UpdateProfile extends ProfileWrite, ExpectedVersion {
  id: Id;
}
export interface ProfileDto extends ProfileWrite {
  id: Id;
  version: Version;
  variables_count: number;
}
export interface SelectProfile extends ExpectedVersion {
  env_profile_id: Id | null;
}
export interface EnvVariableWrite {
  name: string;
  operation: 'SET' | 'UNSET';
  status: 'enabled' | 'disabled';
  is_secret: boolean;
  value?: string;
  replace_secret?: boolean;
  clear?: boolean;
  position?: number;
}
export interface EnvVariableDto {
  name: string;
  operation: 'SET' | 'UNSET';
  status: 'enabled' | 'disabled';
  is_secret: boolean;
  has_value: boolean;
  value: string | null;
}
export interface ReplaceVariables extends ExpectedVersion {
  variables: EnvVariableWrite[];
}
export interface ConfigBindingWrite {
  operation: 'ATTACH' | 'MASK';
  asset_id: Id | null;
  revision_id: Id | null;
  target_base: 'WORKSPACE_ROOT' | 'TASK_DIR';
  target_path: string;
  materialization_mode: 'COPY' | 'SYMLINK';
  conflict_policy: 'FAIL_IF_EXISTS' | 'REPLACE_RESTORE';
  writable: boolean;
  enabled: boolean;
}
export interface UpdateConfigBinding
  extends ConfigBindingWrite,
    ExpectedVersion {}
export interface ConfigBindingDto extends ConfigBindingWrite {
  id: Id;
  version: Version;
  owner_type: 'WORKSPACE' | 'TASK';
  owner_id: Id;
}
export interface HookWrite {
  name: string;
  phase: 'BEFORE' | 'AFTER_SUCCESS' | 'AFTER_FAILURE' | 'FINALLY';
  command: string;
  cwd_base: 'TASK_CWD' | 'WORKSPACE_ROOT';
  position: number;
  timeout_seconds: number;
  failure_policy: 'FAIL_EXECUTION' | 'CONTINUE';
  enabled: boolean;
}

/** Public read models. Runtime-specific unchanged fields remain in their established domain contract. */
export interface GitStatusDto {
  head: CommitSHA;
  remote_branch: string | null;
  clean: boolean;
  detached: boolean;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  ahead: number | null;
  behind: number | null;
  remote_missing: boolean;
  changed_files: Array<{ path: string; index: string; worktree: string }>;
  content_revision: number;
}
export interface GitDiffDto {
  path: string;
  staged: boolean;
  text: string;
  truncated: boolean;
  content_revision: number;
}
export type GitStatusOrDiff = GitStatusDto | GitDiffDto;
export interface GitMutationResult {
  head: CommitSHA;
  content_revision: number;
  status: GitStatusDto;
}
export interface SyncPreview {
  workspace_id: Id;
  source_generation: number;
  content_revision: number;
  current_commit: CommitSHA;
  target_commit: CommitSHA;
  policy_version: Version;
  readiness: 'READY' | 'BLOCKED';
  error_code: string | null;
}
export interface SuppressionDto {
  workspace_id: Id;
  discovery_key: SHA256;
  reason: string;
  created_at: string;
}
export interface ReadinessDto {
  task_id: Id;
  task_definition_version: Version;
  workspace_id: Id;
  status:
    | 'READY'
    | 'CONFIGURATION_REQUIRED'
    | 'INVALID'
    | 'SOURCE_MISSING'
    | 'RESOURCE_UNAVAILABLE';
  diagnostics: Array<{ code: string; resource_type: string; resource_id?: Id }>;
}
export interface TaskQuery extends Pagination {
  workspace_id?: Id;
  workspace_type?: WorkspaceType;
  enabled?: boolean;
}
export interface RunQuery extends Pagination {
  task_id?: Id;
  workspace_id?: Id;
  status?: string;
}
export type TaskRunDto = SubmittedTaskRunDto;
export interface AttemptDto {
  id: Id;
  task_run_id: Id;
  attempt_number: number;
  status: TaskRunDto['status'];
  error_code: string | null;
}
export interface LogQuery {
  cursor?: string;
  limit_bytes?: number;
}
export interface LogPage {
  text: string;
  next_cursor: string | null;
  complete: boolean;
  truncated: boolean;
}
export interface LogDescriptor {
  run_id: Id;
  started_at: string | null;
  finished_at: string | null;
}
export interface RunEventPage {
  events: Array<{
    sequence: number;
    type: string;
    safe_metadata: Record<string, string | number | boolean | null>;
  }>;
  next_cursor: string | null;
}
export interface SummaryQuery {
  workspace_id?: Id;
}
export interface SummaryDto {
  queued: number;
  running: number;
  success: number;
  failed: number;
  skipped: number;
}
export interface TaskHealthDto {
  task_id: Id;
  consecutive_failures: number;
  last_run_id: Id | null;
}
export interface StatsQuery {
  from?: string;
  to?: string;
}
export interface TaskStatsDto {
  task_id: Id;
  total: number;
  success: number;
  failed: number;
  skipped: number;
}
export interface ResourceReferences {
  kind: 'workspace' | 'repository' | 'python' | 'node';
  id: Id;
  task_ids: Id[];
  workspace_ids: Id[];
  history_count: number;
  recovery_count: number;
}
export interface RuntimeDefaultDto {
  workspace_id: Id;
  kind: 'PYTHON' | 'NODE';
  environment_id: Id;
  version: Version;
}
export interface WorkspaceEnvironmentSummary {
  workspace_id: Id;
  name: string;
  default_env_profile_id: Id | null;
  profiles_count: number;
}
export interface TaskEnvironmentSummary {
  task_id: Id;
  name: string;
  workspace_id: Id;
  env_profile_id: Id | null;
  variables_count: number;
}
export interface EnvironmentContext {
  workspace_id: Id;
  task_id?: Id;
  selected_profile_id: Id | null;
  selected_profile_source: 'TASK' | 'WORKSPACE' | 'NONE';
  profiles: ProfileDto[];
  owner_version: Version;
}
export interface EnvironmentPreview {
  context: EnvironmentContext;
  variables: Array<
    EnvVariableDto & { source: 'SYSTEM' | 'GLOBAL' | 'PROFILE' | 'TASK' }
  >;
}
export interface ConfigContextOrPreview {
  workspace_id: Id;
  task_id: Id;
  workspace_bindings: ConfigBindingDto[];
  task_bindings: ConfigBindingDto[];
  effective: Array<{
    binding_id: Id;
    source: 'WORKSPACE' | 'TASK';
    asset_id: Id;
    revision_id: Id;
    target_base: 'WORKSPACE_ROOT' | 'TASK_DIR';
    target_path: string;
    is_secret: boolean;
  }>;
}
export interface HookDto extends HookWrite {
  id: Id;
  task_id: Id;
  version: Version;
}
export interface HookOrder {
  expected_task_version: Version;
  hooks: Array<{ id: Id; expected_version: Version; position: number }>;
}
