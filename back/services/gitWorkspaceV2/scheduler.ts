import { WorkspaceStore } from '../workspaceV2/store';
import { createHash, randomUUID } from 'crypto';
import type { GitWorkspaceRow } from '../workspaceV2/types';
import { errorCode, fail } from '../workspaceV2/errors';
import { GitWorkspaceSyncService } from './sync';
import { nextSyncOccurrence } from './policy';
import type { SyncAdmission, SyncPolicyRow, SyncRunRow } from './types';

/** The policy cursor and unique request key are durable, shared across controllers. */
export class WorkspaceSyncScheduler {
  private ticking = false;
  private timer?: NodeJS.Timeout;
  constructor(
    readonly sync: GitWorkspaceSyncService,
    readonly options: {
      clock?: { now(): Date };
      misfireGraceMs?: number;
      maxRetries?: number;
      retryBaseMs?: number;
    } = {},
  ) {
    if (
      !Number.isSafeInteger(options.maxRetries ?? 3) ||
      (options.maxRetries ?? 3) < 0 ||
      (options.maxRetries ?? 3) > 8 ||
      !Number.isSafeInteger(options.retryBaseMs ?? 1000) ||
      (options.retryBaseMs ?? 1000) < 1 ||
      !Number.isSafeInteger(options.misfireGraceMs ?? 1000) ||
      (options.misfireGraceMs ?? 1000) < 0
    )
      fail('SYNC_POLICY_INVALID');
  }
  get store(): WorkspaceStore {
    return this.sync.store;
  }
  private now() {
    return this.options.clock?.now() ?? new Date();
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      await this.sync.leases.barrier.mutation(async () => {
        const policies = await this.store.all<SyncPolicyRow>(
          `SELECT p.* FROM WorkspaceSyncPolicies p JOIN Workspaces w ON w.id=p.workspace_id JOIN GitWorkspaces g ON g.workspace_id=w.id WHERE p.enabled=1 AND p.update_mode='SCHEDULED' AND p.next_due_at<=? AND w.lifecycle_state='READY' AND w.storage_state='PRESENT' AND g.ref_type='branch' ORDER BY p.next_due_at,p.workspace_id LIMIT 500`,
          [now.toISOString()],
        );
        for (const policy of policies) {
          const due = policy.next_due_at!;
          const misfired =
            now.getTime() - Date.parse(due) >
            (this.options.misfireGraceMs ?? 1000);
          // Consume a missed occurrence once. Never build an unbounded catch-up queue.
          const next = nextSyncOccurrence(policy, now).toISOString();
          let skip:
            | 'SYNC_MISFIRE_SKIPPED'
            | 'SYNC_ALREADY_RUNNING'
            | undefined =
            misfired && policy.misfire_policy === 'SKIP'
              ? 'SYNC_MISFIRE_SKIPPED'
              : undefined;
          if (!(misfired && policy.misfire_policy === 'SKIP')) {
            try {
              await this.sync.submit(policy.workspace_id, {
                requestKey: `schedule:${policy.workspace_id}:${
                  policy.version
                }:${Date.parse(due)}`,
                expectedPolicyVersion: policy.version,
                triggerSource:
                  policy.schedule_kind === 'CRON' ? 'CRON' : 'INTERVAL',
                scheduleSlot: due,
              });
            } catch (error) {
              if (errorCode(error) === 'SYNC_ALREADY_RUNNING')
                skip = 'SYNC_ALREADY_RUNNING';
              if (
                ![
                  'SYNC_ALREADY_RUNNING',
                  'WORKSPACE_RECOVERY_REQUIRED',
                  'WORKSPACE_BUSY',
                  'WORKSPACE_NOT_READY',
                  'SYNC_POLICY_DISABLED',
                  'SYNC_POLICY_VERSION_CONFLICT',
                ].includes(errorCode(error))
              )
                throw error;
            }
          }
          // Admission precedes the short cursor CAS. submit() owns its own
          // atomic identity transaction and may acquire platform admission;
          // no OS lease is acquired while this cursor transaction is open.
          // A crash after submit but before advancing the cursor replays the
          // exact same durable occurrence key and returns the existing Run.
          await this.store.transaction(async (tx) => {
            if (skip)
              await this.recordSkippedOccurrence(tx, policy, due, now, skip);
            await tx.run(
              'UPDATE WorkspaceSyncPolicies SET next_due_at=?,last_claimed_slot=? WHERE workspace_id=? AND version=? AND next_due_at=?',
              [next, due, policy.workspace_id, policy.version, due],
            );
          });
        }
      });
      await this.retryDue(now);
      await this.sync.tick();
    } finally {
      this.ticking = false;
    }
  }
  /** Pure DB audit admission; a skipped occurrence never owns Git or an outbox. */
  private async recordSkippedOccurrence(
    tx: WorkspaceStore,
    policy: SyncPolicyRow,
    due: string,
    now: Date,
    reason: 'SYNC_MISFIRE_SKIPPED' | 'SYNC_ALREADY_RUNNING',
  ) {
    const key = `schedule:${policy.workspace_id}:${policy.version}:${Date.parse(
      due,
    )}`;
    const trigger = policy.schedule_kind === 'CRON' ? 'CRON' : 'INTERVAL';
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          trigger,
          expectedVersion: null,
          expectedPolicyVersion: policy.version,
          slot: due,
          retryOf: null,
          retryAttempt: 0,
          admission: null,
        }),
      )
      .digest('hex');
    const previous = (
      await tx.all<SyncRunRow>(
        'SELECT * FROM WorkspaceSyncRuns WHERE workspace_id=? AND request_key=?',
        [policy.workspace_id, key],
      )
    )[0];
    if (previous) {
      if (previous.request_hash !== requestHash)
        fail('IDEMPOTENCY_KEY_CONFLICT');
      return;
    }
    const current = (
      await tx.all<SyncPolicyRow>(
        'SELECT * FROM WorkspaceSyncPolicies WHERE workspace_id=?',
        [policy.workspace_id],
      )
    )[0];
    if (
      !current ||
      !current.enabled ||
      current.update_mode !== 'SCHEDULED' ||
      current.version !== policy.version ||
      current.next_due_at !== due
    )
      return;
    const ws = await tx.workspace(policy.workspace_id);
    const git = (
      await tx.all<GitWorkspaceRow>(
        'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
        [ws.id],
      )
    )[0];
    if (
      ws.type !== 'GIT' ||
      ws.storage_state !== 'PRESENT' ||
      !['READY', 'RECOVERY_REQUIRED'].includes(ws.lifecycle_state) ||
      !git ||
      git.ref_type !== 'branch'
    )
      return;
    const discovery = (
      await tx.all<{ version: number }>(
        'SELECT version FROM WorkspaceDiscoveryPolicies WHERE workspace_id=?',
        [ws.id],
      )
    )[0];
    const admission: SyncAdmission = {
      workspace_id: ws.id,
      workspace_version: ws.version,
      source_generation: ws.source_generation,
      content_revision: ws.content_revision,
      inventory_hash: ws.content_inventory_hash!,
      policy_version: policy.version,
      discovery_policy_version: discovery?.version ?? 0,
      git: {
        repository_id: git.repository_id,
        ref_type: git.ref_type,
        ref_name: git.ref_name,
        resolved_commit: git.resolved_commit,
        applied_commit: git.applied_commit,
        last_verified_commit: git.last_verified_commit,
        baseline_established: git.baseline_established,
      },
      deadline_at: new Date(now.getTime() + this.sync.timeoutMs).toISOString(),
      timeout_ms: this.sync.timeoutMs,
      retry_attempt: 0,
      retry_of: null,
    };
    await tx.run(
      `INSERT INTO WorkspaceSyncRuns(workspace_id,policy_version,source_generation,request_key,request_hash,trigger_source,schedule_slot,initial,source_snapshot,status,phase,error_code,submitted_at,finished_at,log_identity) VALUES(?,?,?,?,?,?,?,?,?,'BLOCKED',?,?,?,?,?)`,
      [
        ws.id,
        policy.version,
        ws.source_generation,
        key,
        requestHash,
        trigger,
        due,
        git.baseline_established ? 0 : 1,
        JSON.stringify(admission),
        reason === 'SYNC_MISFIRE_SKIPPED'
          ? 'MISFIRE_SKIPPED'
          : 'OCCURRENCE_SKIPPED',
        reason,
        now.toISOString(),
        now.toISOString(),
        randomUUID(),
      ],
    );
  }
  private async retryDue(now: Date) {
    const rows = await this.store.all<SyncRunRow>(
      `SELECT r.* FROM WorkspaceSyncRuns r JOIN WorkspaceSyncPolicies p ON p.workspace_id=r.workspace_id WHERE r.trigger_source IN ('CRON','INTERVAL') AND r.status IN ('FAILED','INTERRUPTED','BLOCKED') AND p.enabled=1 AND p.version=r.policy_version AND r.finished_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM WorkspaceSyncRuns active WHERE active.workspace_id=r.workspace_id AND active.status IN ('QUEUED','RUNNING','RECOVERY_REQUIRED')) ORDER BY r.id DESC LIMIT 500`,
    );
    const considered = new Set<number>();
    for (const row of rows) {
      if (considered.has(row.workspace_id)) continue;
      considered.add(row.workspace_id);
      if (
        ![
          'FETCH_FAILED',
          'GIT_OPERATION_FAILED',
          'GIT_TIMEOUT',
          'GIT_SUPERVISOR_FAILED',
          'SYNC_TIMEOUT',
          'SYNC_INTERRUPTED',
          'WORKSPACE_BUSY',
        ].includes(row.error_code ?? '')
      )
        continue;
      const snapshot = JSON.parse(row.source_snapshot) as SyncAdmission,
        attempt = snapshot.retry_attempt + 1;
      if (
        attempt > (this.options.maxRetries ?? 3) ||
        Date.parse(row.finished_at!) +
          Math.min(
            300000,
            (this.options.retryBaseMs ?? 1000) * 2 ** (attempt - 1),
          ) >
          now.getTime()
      )
        continue;
      const original = snapshot.retry_of ?? row.id;
      // A successful retry leaves its failed ancestor in history. Do not
      // rebuild a different admission under the ancestor's existing key.
      if (
        (
          await this.store.all(
            'SELECT id FROM WorkspaceSyncRuns WHERE workspace_id=? AND request_key=?',
            [row.workspace_id, `retry:${original}:${attempt}`],
          )
        ).length
      )
        continue;
      const admission = {
        ...snapshot,
        deadline_at: new Date(
          Date.parse(row.finished_at!) +
            Math.min(
              300000,
              (this.options.retryBaseMs ?? 1000) * 2 ** (attempt - 1),
            ) +
            snapshot.timeout_ms,
        ).toISOString(),
        retry_attempt: attempt,
        retry_of: original,
      };
      try {
        await this.sync.submit(row.workspace_id, {
          requestKey: `retry:${original}:${attempt}`,
          expectedVersion: snapshot.workspace_version,
          expectedPolicyVersion: row.policy_version,
          triggerSource: row.trigger_source as 'CRON' | 'INTERVAL',
          scheduleSlot: row.schedule_slot!,
          retryOf: original,
          retryAttempt: attempt,
          admission,
        });
      } catch (error) {
        if (
          ![
            'SYNC_ALREADY_RUNNING',
            'SOURCE_SUPERSEDED',
            'WORKSPACE_VERSION_CONFLICT',
            'WORKSPACE_RECOVERY_REQUIRED',
            'SYNC_POLICY_VERSION_CONFLICT',
          ].includes(errorCode(error))
        )
          throw error;
      }
    }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 100);
    this.timer.unref();
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.ticking) await new Promise((r) => setTimeout(r, 5));
  }
}
