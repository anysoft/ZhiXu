/**
 * S0 contract examples only. This file is NOT a runtime module, ORM model,
 * application route, or permission to implement S1. No production imports.
 * Status: TECHNICAL_CONTRACT_READY_FOR_APPROVAL.
 */
export type WorkspaceType = 'LOCAL' | 'GIT';
export type TaskConcurrencyPolicy = 'FORBID' | 'QUEUE' | 'ALLOW';
export type WaitMode = 'WAIT' | 'SKIP' | 'FAIL_FAST';
export type QueueReason =
  | 'NONE'
  | 'TASK_CONCURRENCY'
  | 'WORKSPACE_LEASE'
  | 'PLATFORM_QUIESCING'
  | 'RUNTIME_CAPACITY';
export type TaskRunStatus =
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
export type SourceSupersededReason =
  | 'SOURCE_CHANGED'
  | 'TASK_CHANGED'
  | 'RESOURCE_CHANGED';
export type Sha256 = string; // Exactly 64 lowercase hex characters at validation.
export type CommitSha = string; // Full repository object-format SHA, validated by Git.
export type UtcTimestamp = string; // Canonical UTC ISO 8601, persisted unambiguously.
export type PositiveId = number; // Safe integer > 0; not an arbitrary container path.

/** Body of the Panel-only task-run endpoint; task ID is parsed from the route. */
export interface SubmitRunRequest {
  wait_mode?: WaitMode; // Default WAIT. Idempotency-Key is an HTTP header.
}

/** Internal normalized command. Automatic events MUST use wait_mode=WAIT. */
export interface TaskExecutionSubmission {
  task_id: PositiveId;
  trigger_type: TriggerType;
  trigger_event_id: PositiveId | null;
  submission_key: string;
  wait_mode: WaitMode;
}

/** Metadata versions only: never serialize a secret ENV value or its value hash. */
export interface EffectiveResourceVersions {
  global_env_version: number;
  system_allowlist_build_version: string;
  profile: { id: PositiveId; version: number } | null;
  python: {
    environment_id: PositiveId;
    revision_id: PositiveId;
    build_id: PositiveId;
    runtime_id: PositiveId;
  } | null;
  node: {
    environment_id: PositiveId;
    revision_id: PositiveId;
    build_id: PositiveId;
    runtime_id: PositiveId;
    toolchain_id: PositiveId;
  } | null;
  config_revisions: ReadonlyArray<{
    asset_id: PositiveId;
    revision_id: PositiveId;
    binding_id: PositiveId;
    binding_version: number;
  }>;
}

/** Immutable when admitted; maps onto expected_* columns plus protected JSON. */
export interface AdmissionSnapshot {
  readonly workspace_id: PositiveId;
  readonly workspace_type: WorkspaceType;
  readonly expected_workspace_version: number;
  readonly expected_source_generation: number;
  readonly expected_content_revision: number;
  readonly expected_task_definition_version: number;
  readonly expected_global_env_version: number;
  readonly expected_inventory_hash: Sha256;
  readonly expected_git_commit: CommitSha | null;
  readonly effective_resource_versions: EffectiveResourceVersions;
  readonly relative_entrypoint: string;
  readonly language: 'PYTHON' | 'JAVASCRIPT' | 'TYPESCRIPT' | 'SHELL';
  readonly cwd_mode: 'WORKSPACE_ROOT' | 'ENTRYPOINT_DIR' | 'CUSTOM_RELATIVE';
  readonly cwd_relative_path: string | null;
}

/** First assigned after lease-protected resolution, then immutable forever. */
export interface TaskRunSourceSnapshot {
  readonly workspace_id: PositiveId;
  readonly workspace_type: WorkspaceType;
  readonly source_generation: number;
  readonly content_revision: number;
  readonly task_definition_version: number;
  readonly inventory_hash: Sha256;
  readonly entrypoint_checksum: Sha256;
  readonly relative_entrypoint: string;
  readonly cwd_mode: AdmissionSnapshot['cwd_mode'];
  readonly cwd_relative_path: string | null;
  readonly git: {
    repository_id: PositiveId;
    commit: CommitSha;
    ref_type: 'branch' | 'tag' | 'commit';
    ref_name: string;
  } | null;
  readonly effective_resource_versions: EffectiveResourceVersions;
}

/** Public safe projection; owner tokens, FDs, roots, ENV, credentials omitted. */
export interface TaskRunQueueDto {
  reason: QueueReason;
  deadline_at: UtcTimestamp;
  next_eligible_at: UtcTimestamp;
  attempt_count: number; // Lease/queue polling count, NOT script attempt_count.
  wait_mode: WaitMode;
}
export interface SubmittedTaskRunDto {
  id: PositiveId;
  task_id: PositiveId | null;
  workspace_id: PositiveId;
  status: TaskRunStatus;
  concurrency_policy: TaskConcurrencyPolicy;
  submitted_at: UtcTimestamp;
  started_at: UtcTimestamp | null;
  finished_at: UtcTimestamp | null;
  queue: TaskRunQueueDto;
  attempt_count: number; // Script attempts; separate from queue.attempt_count polls.
  error_code: string | null;
  source_snapshot: TaskRunSourceSnapshot | null;
}

/** Internal capability only: do not expose these values through API DTOs. */
export interface RootIdentity {
  canonical_root: string;
  storage_key: string;
  dev: string;
  ino: string;
  owner_marker_digest: Sha256;
}
export interface InternalLeaseOwner {
  owner_kind:
    | 'TASK_RUN'
    | 'SYNC_RUN'
    | 'FILE_OPERATION'
    | 'RECOVERY'
    | 'BACKUP';
  owner_id: PositiveId;
  operation_instance: string; // Random token/epoch; PID is diagnostic only.
}
export interface WorkspaceLease {
  readonly workspace_id: PositiveId;
  readonly exclusive: true;
  readonly resource_key: Sha256;
  readonly lock_dev: string;
  readonly lock_ino: string;
  readonly owner: InternalLeaseOwner;
  readonly inherited_fds: ReadonlyArray<number>;
  assert_held(): Promise<void>;
  release(): Promise<void>;
}
export interface ResolvedWorkspaceRoot {
  workspace_id: PositiveId;
  workspace_type: WorkspaceType;
  root_identity: RootIdentity;
  workspace_version: number;
  source_generation: number;
  content_revision: number;
  inventory_hash: Sha256;
  git: { repository_id: PositiveId; actual_commit: CommitSha } | null;
}
export interface WorkspaceRootResolverContract {
  require_ready(
    workspace_id: PositiveId,
    lease: WorkspaceLease,
    expected: AdmissionSnapshot,
  ): Promise<ResolvedWorkspaceRoot>;
}

/** MVP supports only live Workspace execution protected by the EX lease. */
export interface ExecutionSource {
  kind: 'LIVE_WORKSPACE';
  root: ResolvedWorkspaceRoot;
  source_snapshot: TaskRunSourceSnapshot;
  lease: WorkspaceLease;
}
// Future Snapshot/Overlay requires a separate approved contract/version. Adding a
// user-selectable SNAPSHOT mode now would exceed S0 and is intentionally absent.
