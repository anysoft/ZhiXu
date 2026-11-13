/** Internal S1.A foundation only. Never bind these identities to the v9 runtime. */
export type WorkspaceType = 'LOCAL' | 'GIT';
export type WorkspaceLifecycle =
  | 'CREATING'
  | 'READY'
  | 'ARCHIVED'
  | 'DELETE_REQUESTED'
  | 'TOMBSTONED'
  | 'ERROR'
  | 'RECOVERY_REQUIRED';
export type WorkspaceStorage =
  | 'PROVISIONING'
  | 'PRESENT'
  | 'RECLAIMING'
  | 'RECLAIMED';

export interface WorkspaceRow {
  id: number;
  name: string;
  type: WorkspaceType;
  root_key: string;
  lifecycle_state: WorkspaceLifecycle;
  storage_state: WorkspaceStorage;
  version: number;
  content_revision: number;
  source_generation: number;
  file_count: number;
  total_bytes: number;
  content_inventory_hash: string | null;
  root_device: number | null;
  root_inode: number | null;
  root_owner_token: string | null;
  default_env_profile_id: number | null;
  last_error_code: string | null;
  deleted_at: string | null;
  reclaimed_at: string | null;
  metadata_purge_after: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitWorkspaceRow {
  workspace_id: number;
  workspace_type: 'GIT';
  repository_id: number;
  ref_type: 'branch' | 'tag' | 'commit';
  ref_name: string;
  private_branch: string | null;
  resolved_commit: string;
  last_verified_commit: string | null;
  baseline_established: number;
  baseline_sync_run_id: number | null;
  applied_commit: string | null;
  dirty_state: 'UNKNOWN' | 'CLEAN' | 'DIRTY' | 'CONFLICT';
  status_snapshot: string;
  last_update_at: string | null;
  last_error_code: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationRow {
  id: string;
  workspace_id: number;
  operation_type:
    | 'CREATE'
    | 'ARCHIVE'
    | 'UNARCHIVE'
    | 'DELETE_RECLAIM'
    | 'RECOVER'
    | 'FILE_MUTATION';
  status:
    | 'PENDING'
    | 'RUNNING'
    | 'DRAINING'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'CANCELLED'
    | 'RECOVERY_REQUIRED';
  phase: string;
  request_key: string;
  request_hash: string;
  expected_workspace_version: number;
  owner_token: string | null;
  journal_key: string;
  root_marker: string;
  preservation_receipt: string | null;
  error_code: string | null;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface InventoryEntry {
  path: string;
  kind: 'file' | 'directory';
  mode: number;
  size: number;
  sha256?: string;
}
export interface Inventory {
  hash: string;
  fileCount: number;
  totalBytes: number;
  entryCount: number;
  entries: InventoryEntry[];
}
export type FaultHook = (
  phase: string,
  details?: Record<string, unknown>,
) => Promise<void>;

export interface RunResult {
  changes: number;
  lastID: number;
}
