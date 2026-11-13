import type { WorkspaceStore } from '../services/workspaceV2/store';
import type { WorkspaceRootResolver } from '../services/workspaceV2/roots';
import type { WorkspaceLeaseService } from '../services/workspaceV2/lease';
import type { WorkspaceLifecycleService } from '../services/workspaceV2/lifecycle';
import type { WorkspaceFileService } from '../services/workspaceV2/files';
import type { WorkspaceReclaimService } from '../services/workspaceV2/reclaim';
import type { WorkspaceBackupService } from '../services/workspaceV2/backup';
import type { WorkspaceRestoreService } from '../services/workspaceV2/restore';
import type { TaskService } from '../services/taskExecutionV2/task';
import type { TaskExecutionService } from '../services/taskExecutionV2/execution';
import type { WorkspaceEnvironmentService } from '../services/taskExecutionV2/environment';
import type { TaskResourceResolver } from '../services/taskExecutionV2/resources';
import type { WorkspaceCronSubmissions } from '../services/taskExecutionV2/cron';
import type { WorkspaceGitAdapter } from '../services/gitWorkspaceV2/git';
import type { GitWorkspaceDiscovery } from '../services/gitWorkspaceV2/discovery';
import type { GitWorkspaceSyncService } from '../services/gitWorkspaceV2/sync';
import type { WorkspaceSyncScheduler } from '../services/gitWorkspaceV2/scheduler';
import type {
  WorkspaceGitUpdateOutbox,
  WorkspaceGitUpdateTriggers,
} from '../services/gitWorkspaceV2/outbox';

/** One explicit isolated Store; no API handler selects another database or root. */
export interface V2Services {
  store: WorkspaceStore;
  roots: WorkspaceRootResolver;
  leases: WorkspaceLeaseService;
  lifecycle: WorkspaceLifecycleService;
  files: WorkspaceFileService;
  reclaim: WorkspaceReclaimService;
  backup: WorkspaceBackupService;
  restore: WorkspaceRestoreService;
  tasks: TaskService;
  execution: TaskExecutionService;
  environment: WorkspaceEnvironmentService;
  resources: TaskResourceResolver;
  cron: WorkspaceCronSubmissions;
  git: WorkspaceGitAdapter;
  discovery: GitWorkspaceDiscovery;
  sync: GitWorkspaceSyncService;
  syncScheduler: WorkspaceSyncScheduler;
  outbox: WorkspaceGitUpdateOutbox;
  gitUpdateTriggers: WorkspaceGitUpdateTriggers;
}
export interface PanelPrincipal {
  kind: 'PANEL_OWNER';
  username: string;
  platform: string;
}
export interface ApiCall {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: any;
  idempotencyKey?: string;
  ifMatch?: string;
  setHeader?: (name: 'ETag' | 'Cache-Control', value: string) => void;
  setStatus?: (status: 200 | 202) => void;
  principal: PanelPrincipal;
}
/** Returns data only; root adapter owns authentication, origin, status/envelope/errors. */
export type ApiHandler = (call: ApiCall) => Promise<unknown>;
export interface ApiRoute {
  handle?: ApiHandler;
  status:
    | 'IMPLEMENTED'
    | 'DEFERRED_BY_CONTRACT'
    | 'UNSUPPORTED_BY_FROZEN_SCHEMA';
  service: string;
  responseDto: string;
  reason?: string;
}
export type RouteMap = Record<string, ApiHandler | ApiRoute>;
