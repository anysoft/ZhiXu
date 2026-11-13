import { WorkspaceStore } from '../services/workspaceV2/store';
import { WorkspaceRootResolver } from '../services/workspaceV2/roots';
import { WorkspaceLeaseService } from '../services/workspaceV2/lease';
import { WorkspaceLifecycleService } from '../services/workspaceV2/lifecycle';
import { WorkspaceFileService } from '../services/workspaceV2/files';
import { WorkspaceReclaimService } from '../services/workspaceV2/reclaim';
import { WorkspacePreservationService } from '../services/workspaceV2/preservation';
import { WorkspaceBackupService } from '../services/workspaceV2/backup';
import { WorkspaceRestoreService } from '../services/workspaceV2/restore';
import { TaskService } from '../services/taskExecutionV2/task';
import { TaskExecutionService } from '../services/taskExecutionV2/execution';
import { WorkspaceEnvironmentService } from '../services/taskExecutionV2/environment';
import { TaskResourceResolver } from '../services/taskExecutionV2/resources';
import { WorkspaceCronSubmissions } from '../services/taskExecutionV2/cron';
import { WorkspaceGitAdapter } from '../services/gitWorkspaceV2/git';
import { GitWorkspaceDiscovery } from '../services/gitWorkspaceV2/discovery';
import { GitWorkspaceSyncService } from '../services/gitWorkspaceV2/sync';
import { WorkspaceSyncScheduler } from '../services/gitWorkspaceV2/scheduler';
import {
  WorkspaceGitUpdateOutbox,
  WorkspaceGitUpdateTriggers,
} from '../services/gitWorkspaceV2/outbox';
import { PlatformBackupBarrier } from '../services/backup/barrier';
import { errorCode } from '../services/workspaceV2/errors';
import type { V2Services } from './types';

export function createV2Services(
  store: WorkspaceStore,
  backupRoot: string,
  options: {
    git?: ConstructorParameters<typeof WorkspaceGitAdapter>[2];
    recoverRuntime?: () => Promise<void>;
    recoverInbox?: () => Promise<void>;
  } = {},
) {
  const roots = new WorkspaceRootResolver(store.dataRoot),
    leases = new WorkspaceLeaseService(
      store.dataRoot,
      new PlatformBackupBarrier(store.dataRoot + '.platform-control'),
    );
  const lifecycle = new WorkspaceLifecycleService(store, roots, leases),
    files = new WorkspaceFileService(store, roots, leases);
  const backup = new WorkspaceBackupService(store, roots, leases, backupRoot),
    restore = new WorkspaceRestoreService(backup);
  const reclaim = new WorkspaceReclaimService(
    store,
    roots,
    leases,
    new WorkspacePreservationService(backup),
  );
  const tasks = new TaskService(store, roots, leases),
    execution = new TaskExecutionService(store, roots, leases);
  const environment = new WorkspaceEnvironmentService(store, roots, leases),
    resources = new TaskResourceResolver(store, roots, leases);
  const cron = new WorkspaceCronSubmissions(store, roots, leases, execution);
  const git = new WorkspaceGitAdapter(store, roots, options.git),
    discovery = new GitWorkspaceDiscovery(store, roots, leases);
  const outbox = new WorkspaceGitUpdateOutbox(store, roots, leases, execution),
    gitUpdateTriggers = new WorkspaceGitUpdateTriggers(store, roots, leases);
  const sync = new GitWorkspaceSyncService(
      store,
      roots,
      leases,
      git,
      discovery,
      outbox,
    ),
    syncScheduler = new WorkspaceSyncScheduler(sync);
  const services: V2Services = {
    store,
    roots,
    leases,
    lifecycle,
    files,
    reclaim,
    backup,
    restore,
    tasks,
    execution,
    environment,
    resources,
    cron,
    git,
    discovery,
    outbox,
    gitUpdateTriggers,
    sync,
    syncScheduler,
  };
  let timer: NodeJS.Timeout | undefined,
    busy = false,
    stopped = false;
  const phases: string[] = [];
  const recoveryErrors: Array<{ resource_id: number; code: string }> = [];
  const recover = async () => {
    phases.length = 0;
    recoveryErrors.length = 0;
    phases.push('ROOT_OWNERSHIP');
    for (const row of await store.all<any>(
      "SELECT * FROM Workspaces WHERE storage_state='PRESENT' AND lifecycle_state IN ('READY','ARCHIVED')",
    )) {
      try {
        await roots.requireOwned(row);
      } catch (e) {
        recoveryErrors.push({ resource_id: row.id, code: errorCode(e) });
      }
    }
    phases.push('WORKSPACE_RECOVERY');
    const operations = await store.all<{
      workspace_id: number;
      operation_type: string;
    }>(
      "SELECT DISTINCT workspace_id,operation_type FROM WorkspaceOperations WHERE status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED') ORDER BY workspace_id",
    );
    for (const op of operations) {
      try {
        if (op.operation_type === 'FILE_MUTATION')
          await files.recover(op.workspace_id);
        else if (op.operation_type === 'DELETE_RECLAIM')
          await reclaim.recover(op.workspace_id);
        else await lifecycle.recover(op.workspace_id);
      } catch (e) {
        recoveryErrors.push({
          resource_id: op.workspace_id,
          code: errorCode(e),
        });
      }
    }
    phases.push('RUNTIME_RECOVERY');
    await options.recoverRuntime?.();
    phases.push('TASK_CONFIG_RECOVERY');
    await execution.recover();
    phases.push('SYNC_OUTBOX_RECOVERY');
    await sync.recover();
    await outbox.recover();
    phases.push('WEBHOOK_INBOX_RECOVERY');
    await options.recoverInbox?.();
    try {
      if (!(await backup.domain.assertIdle(store)))
        recoveryErrors.push({ resource_id: 0, code: 'BACKUP_SOURCE_NOT_IDLE' });
    } catch (e) {
      recoveryErrors.push({ resource_id: 0, code: errorCode(e) });
    }
    const unresolved = (
      await store.all<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM Workspaces WHERE lifecycle_state IN ('CREATING','ERROR','DELETE_REQUESTED','RECOVERY_REQUIRED'))+(SELECT COUNT(*) FROM TaskRuns WHERE status IN ('RESOLVING','RUNNING','RECOVERY_REQUIRED'))+(SELECT COUNT(*) FROM WorkspaceSyncRuns WHERE status IN ('RUNNING','RECOVERY_REQUIRED')) n`,
      )
    )[0].n;
    return {
      ready: !unresolved && !recoveryErrors.length,
      phases: [...phases],
      errors: [...recoveryErrors],
    };
  };
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await options.recoverInbox?.();
      await cron.tick();
      await syncScheduler.tick();
      await outbox.tick();
      await execution.tick();
    } finally {
      busy = false;
    }
  };
  const start = () => {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => {
      void tick().catch(() => undefined);
    }, 100);
    timer.unref();
  };
  const pause = async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    while (busy) await new Promise((r) => setTimeout(r, 10));
  };
  const close = async () => {
    await pause();
    await syncScheduler.close();
    await sync.close();
    await execution.close();
    await store.close();
  };
  return Object.assign(services, { recover, start, pause, close, tick });
}
export type V2Container = ReturnType<typeof createV2Services>;
