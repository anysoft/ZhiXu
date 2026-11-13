import { cronNext } from '../../shared/triggerDefinition';
import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLeaseService } from '../workspaceV2/lease';
import { positiveId, fail, errorCode } from '../workspaceV2/errors';
import { TaskExecutionService } from './execution';
import { loadTaskDefinition } from './task';

/** Internal S2 Cron producer only; no startup registration or GitUpdate dispatcher. */
export class WorkspaceCronSubmissions {
  private ticking = false;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
    readonly execution: TaskExecutionService,
    readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}
  async create(
    taskId: number,
    input: {
      expression: string;
      timezone: string;
      misfirePolicy: 'SKIP' | 'FIRE_ONCE';
      enabled?: boolean;
    },
  ) {
    const task = await loadTaskDefinition(this.store, positiveId(taskId));
    if (
      !['SKIP', 'FIRE_ONCE'].includes(input.misfirePolicy) ||
      (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    )
      fail('CRON_DEFINITION_INVALID', 400);
    const next = cronNext(
      input.expression,
      input.timezone,
      this.clock.now(),
    ).toISOString();
    return this.leases.withWorkspace(
      task.task.workspace_id,
      'CRON_CREATE',
      async (lease) => {
        const row = await this.store.assertAccessible(
          task.task.workspace_id,
          true,
        );
        await this.roots.requireReady(row, lease);
        return this.store.transaction(async (tx) => {
          const now = this.clock.now().toISOString();
          const tr = await tx.run(
            "INSERT INTO TaskTriggers(task_id,type,origin,enabled,createdAt,updatedAt) VALUES(?,'CRON','USER',?,?,?)",
            [taskId, input.enabled === false ? 0 : 1, now, now],
          );
          await tx.run(
            'INSERT INTO CronTriggers(trigger_id,expression,timezone,misfire_policy,next_fire_at,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)',
            [
              tr.lastID,
              input.expression,
              input.timezone,
              input.misfirePolicy,
              next,
              now,
              now,
            ],
          );
          return tr.lastID;
        });
      },
    );
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock.now();
      await this.leases.barrier.mutation(() =>
        this.store.transaction(async (tx) => {
          const due = await tx.all<{
            trigger_id: number;
            expression: string;
            timezone: string;
            misfire_policy: string;
            next_fire_at: string;
            task_id: number;
            workspace_id: number;
          }>(
            `SELECT c.*,t.task_id,k.workspace_id FROM CronTriggers c JOIN TaskTriggers t ON t.id=c.trigger_id
           JOIN Tasks k ON k.id=t.task_id JOIN Workspaces w ON w.id=k.workspace_id
           WHERE t.enabled=1 AND w.lifecycle_state='READY' AND w.storage_state='PRESENT' AND c.next_fire_at<=?
           AND NOT EXISTS(SELECT 1 FROM WorkspaceOperations o WHERE o.workspace_id=w.id AND o.status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED'))
           ORDER BY c.next_fire_at,c.trigger_id LIMIT 500`,
            [now.toISOString()],
          );
          for (const cron of due) {
            const scheduled = new Date(cron.next_fire_at),
              next = cronNext(cron.expression, cron.timezone, scheduled);
            const missed = next.getTime() <= now.getTime(),
              skip = missed && cron.misfire_policy === 'SKIP';
            await tx.run(
              `INSERT INTO TriggerEvents(trigger_id,origin_trigger_id,task_id,workspace_id,event_key,trigger_type,status,error_code,metadata,received_at)
            VALUES(?,?,?,?,?,'CRON',?,?,?,?) ON CONFLICT(origin_trigger_id,event_key) DO NOTHING`,
              [
                cron.trigger_id,
                cron.trigger_id,
                cron.task_id,
                cron.workspace_id,
                `cron:${scheduled.getTime()}`,
                skip ? 'SKIPPED' : 'RECEIVED',
                skip ? 'CRON_MISFIRE_SKIPPED' : null,
                JSON.stringify({ scheduled_at: scheduled.toISOString() }),
                now.toISOString(),
              ],
            );
            await tx.run(
              'UPDATE CronTriggers SET last_fire_at=?,next_fire_at=? WHERE trigger_id=?',
              [
                scheduled.toISOString(),
                (missed
                  ? cronNext(cron.expression, cron.timezone, now)
                  : next
                ).toISOString(),
                cron.trigger_id,
              ],
            );
          }
        }),
      );
      // Event+occurrence are durable before admission. A restart replays the same
      // event identity, never reconstructs missed slots or creates a second Run.
      for (const event of await this.store.all<{ id: number; task_id: number }>(
        "SELECT id,task_id FROM TriggerEvents WHERE trigger_type='CRON' AND status='RECEIVED' ORDER BY id LIMIT 500",
      )) {
        try {
          await this.execution.submit(event.task_id, {
            triggerType: 'CRON',
            eventId: event.id,
          });
        } catch (error) {
          if (
            ![
              'WORKSPACE_BUSY',
              'WORKSPACE_NOT_READY',
              'PLATFORM_BACKUP_IN_PROGRESS',
              'RUNTIME_NOT_READY',
              'CONFIGURATION_REQUIRED',
            ].includes(errorCode(error))
          )
            throw error;
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
