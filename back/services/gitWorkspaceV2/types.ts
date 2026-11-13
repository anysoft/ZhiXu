import type { WorkspaceRow } from '../workspaceV2/types';
export type SyncStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'NO_CHANGE'
  | 'SUCCESS'
  | 'BLOCKED'
  | 'FAILED'
  | 'RECOVERY_REQUIRED'
  | 'CANCELLED'
  | 'INTERRUPTED';
export interface SyncPolicyRow {
  workspace_id: number;
  enabled: number;
  update_mode: 'MANUAL' | 'SCHEDULED';
  schedule_kind: 'NONE' | 'CRON' | 'INTERVAL';
  cron_expression: string | null;
  timezone: string;
  interval_ms: number | null;
  anchor_at: string | null;
  misfire_policy: 'SKIP' | 'FIRE_ONCE';
  next_due_at: string | null;
  last_claimed_slot: string | null;
  version: number;
  updated_at: string;
}
export type SyncPolicyWrite = { expected_version: number; enabled: boolean } & (
  | { mode: 'MANUAL'; schedule: null }
  | {
      mode: 'SCHEDULED';
      schedule:
        | {
            type: 'CRON';
            expression: string;
            timezone: string;
            misfire_policy: 'SKIP' | 'FIRE_ONCE';
          }
        | {
            type: 'INTERVAL';
            interval_ms: number;
            anchor_at: string;
            misfire_policy: 'SKIP' | 'FIRE_ONCE';
          };
    }
);
export interface SyncAdmission {
  workspace_id: number;
  workspace_version: number;
  source_generation: number;
  content_revision: number;
  inventory_hash: string;
  policy_version: number;
  discovery_policy_version: number;
  git: {
    repository_id: number;
    ref_type: 'branch' | 'tag' | 'commit';
    ref_name: string;
    resolved_commit: string;
    applied_commit: string | null;
    last_verified_commit: string | null;
    baseline_established: number;
  };
  deadline_at: string;
  timeout_ms: number;
  retry_attempt: number;
  retry_of: number | null;
}
export interface SyncRunRow {
  id: number;
  workspace_id: number;
  policy_version: number;
  source_generation: number;
  request_key: string;
  request_hash: string;
  trigger_source: 'MANUAL' | 'CRON' | 'INTERVAL' | 'RECOVERY';
  schedule_slot: string | null;
  initial: number;
  source_snapshot: string;
  before_commit: string | null;
  target_commit: string | null;
  actual_commit: string | null;
  after_commit: string | null;
  status: SyncStatus;
  phase: string;
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
  update_outbox_id: number | null;
  event_status: 'NOT_COMMITTED' | 'PENDING' | 'DISPATCHED' | 'BLOCKED';
  content_revision: number | null;
  owner_token: string | null;
  cancel_requested: number;
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
  submitted_at: string;
  log_identity: string;
}
export interface SyncSubmitOptions {
  requestKey?: string;
  expectedVersion?: number;
  expectedPolicyVersion?: number;
  triggerSource?: 'MANUAL' | 'CRON' | 'INTERVAL';
  scheduleSlot?: string;
  retryOf?: number;
  retryAttempt?: number;
  admission?: SyncAdmission;
}
export interface SyncJournal {
  version: 1;
  run_id: number;
  workspace_id: number;
  repository_id: number;
  owner_token: string;
  source_snapshot_sha256: string;
  policy_version: number;
  source_generation: number;
  phase: 'APPLYING' | 'APPLIED_PENDING_RECONCILIATION' | 'COMMITTED';
  before_commit: string;
  target_commit: string;
  actual_commit: string | null;
  root_identity: { dev: number; ino: number; owner_token: string };
  git_identity: {
    admin_key: string;
    admin_device: number;
    admin_inode: number;
    configuration_sha256: string;
  };
  before_inventory_hash: string;
  before_index_sha256: string;
  created_at: string;
}
export const SYNC_TERMINAL = new Set<SyncStatus>([
  'NO_CHANGE',
  'SUCCESS',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
]);
export function nextContentRevision(workspace: WorkspaceRow, hash: string) {
  return (
    workspace.content_revision +
    (workspace.content_inventory_hash === hash ? 0 : 1)
  );
}
