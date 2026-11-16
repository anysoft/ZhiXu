import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLeaseService } from '../workspaceV2/lease';
import { fail, positiveId } from '../workspaceV2/errors';
import { cronNext } from '../../shared/triggerDefinition';
import type { SyncPolicyRow, SyncPolicyWrite } from './types';
export function utc(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    fail('SYNC_POLICY_INVALID', 400);
  return date;
}
export function nextSyncOccurrence(policy: SyncPolicyRow, after: Date): Date {
  if (policy.schedule_kind === 'CRON')
    return cronNext(policy.cron_expression!, policy.timezone, after);
  if (policy.schedule_kind === 'INTERVAL') {
    const anchor = utc(policy.anchor_at!).getTime(),
      step = policy.interval_ms!;
    const n = Math.max(0, Math.floor((after.getTime() - anchor) / step) + 1),
      time = anchor + n * step;
    if (
      !Number.isSafeInteger(time) ||
      !Number.isFinite(new Date(time).getTime())
    )
      fail('SYNC_POLICY_INVALID', 400);
    return new Date(time);
  }
  fail('SYNC_POLICY_INVALID', 400);
}
export class WorkspaceSyncPolicies {
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
    readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}
  async ensure(tx: WorkspaceStore, id: number) {
    const ws = await tx.workspace(positiveId(id));
    if (ws.type !== 'GIT') fail('WORKSPACE_TYPE_INVALID');
    await tx.run(
      "INSERT OR IGNORE INTO WorkspaceSyncPolicies(workspace_id,enabled,update_mode) VALUES(?,1,'MANUAL')",
      [id],
    );
    return (
      await tx.all<SyncPolicyRow>(
        'SELECT * FROM WorkspaceSyncPolicies WHERE workspace_id=?',
        [id],
      )
    )[0];
  }
  async get(id: number): Promise<SyncPolicyRow> {
    const ws = await this.store.workspace(positiveId(id));
    if (ws.type !== 'GIT') fail('WORKSPACE_TYPE_INVALID');
    return (
      (
        await this.store.all<SyncPolicyRow>(
          'SELECT * FROM WorkspaceSyncPolicies WHERE workspace_id=?',
          [id],
        )
      )[0] ?? {
        workspace_id: id,
        enabled: 1,
        update_mode: 'MANUAL',
        schedule_kind: 'NONE',
        cron_expression: null,
        timezone: 'UTC',
        interval_ms: null,
        anchor_at: null,
        misfire_policy: 'SKIP',
        next_due_at: null,
        last_claimed_slot: null,
        version: 1,
        updated_at: ws.updatedAt,
      }
    );
  }
  async save(id: number, input: SyncPolicyWrite) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !['expected_version', 'enabled', 'mode', 'schedule'].includes(k),
      ) ||
      !Number.isSafeInteger(input.expected_version) ||
      input.expected_version < 1 ||
      typeof input.enabled !== 'boolean' ||
      !['MANUAL', 'SCHEDULED'].includes(input.mode)
    )
      fail('SYNC_POLICY_INVALID', 400);
    let kind: SyncPolicyRow['schedule_kind'] = 'NONE',
      expression: string | null = null,
      zone = 'UTC',
      interval: number | null = null,
      anchor: string | null = null,
      misfire: SyncPolicyRow['misfire_policy'] = 'SKIP';
    if (input.mode === 'MANUAL') {
      if (input.schedule !== null) fail('SYNC_POLICY_INVALID', 400);
    } else {
      const s = input.schedule;
      if (!s || !['SKIP', 'FIRE_ONCE'].includes(s.misfire_policy))
        fail('SYNC_POLICY_INVALID', 400);
      misfire = s.misfire_policy;
      if (s.type === 'CRON') {
        if (
          Object.keys(s).some(
            (k) =>
              !['type', 'expression', 'timezone', 'misfire_policy'].includes(k),
          )
        )
          fail('SYNC_POLICY_INVALID', 400);
        try {
          cronNext(s.expression, s.timezone, this.clock.now());
        } catch {
          fail('SYNC_POLICY_INVALID', 422);
        }
        kind = 'CRON';
        expression = s.expression;
        zone = s.timezone;
      } else if (s.type === 'INTERVAL') {
        if (
          Object.keys(s).some(
            (k) =>
              !['type', 'interval_ms', 'anchor_at', 'misfire_policy'].includes(
                k,
              ),
          ) ||
          !Number.isSafeInteger(s.interval_ms) ||
          s.interval_ms < 1
        )
          fail('SYNC_POLICY_INVALID', 400);
        utc(s.anchor_at);
        kind = 'INTERVAL';
        interval = s.interval_ms;
        anchor = s.anchor_at;
      } else fail('SYNC_POLICY_INVALID', 400);
    }
    return this.leases.withWorkspace(id, 'SYNC_POLICY_WRITE', async (lease) => {
      const ws = await this.store.assertAccessible(id, false);
      if (ws.type !== 'GIT') fail('WORKSPACE_TYPE_INVALID');
      if (ws.lifecycle_state === 'ARCHIVED') {
        if (input.enabled) fail('WORKSPACE_ARCHIVED');
        await lease.assertHeld();
        await this.roots.requireOwned(ws);
      } else await this.roots.requireReady(ws, lease);
      const git = (
        await this.store.all<{ ref_type: string }>(
          'SELECT ref_type FROM GitWorkspaces WHERE workspace_id=?',
          [id],
        )
      )[0];
      if (input.mode === 'SCHEDULED' && git.ref_type !== 'branch')
        fail('SYNC_POLICY_INVALID', 400);
      return this.store.transaction(async (tx) => {
        const old = await this.ensure(tx, id);
        if (old.version !== input.expected_version)
          fail('SYNC_POLICY_VERSION_CONFLICT');
        if (
          ws.lifecycle_state === 'ARCHIVED' &&
          (old.update_mode !== input.mode ||
            old.schedule_kind !== kind ||
            old.cron_expression !== expression ||
            old.timezone !== zone ||
            old.interval_ms !== interval ||
            old.anchor_at !== anchor ||
            old.misfire_policy !== misfire)
        )
          fail('WORKSPACE_ARCHIVED');
        const next = {
          ...old,
          enabled: input.enabled ? 1 : 0,
          update_mode: input.mode,
          schedule_kind: kind,
          cron_expression: expression,
          timezone: zone,
          interval_ms: interval,
          anchor_at: anchor,
          misfire_policy: misfire,
        } as SyncPolicyRow;
        const due =
          input.enabled && kind !== 'NONE'
            ? nextSyncOccurrence(next, this.clock.now()).toISOString()
            : null;
        await tx.run(
          'UPDATE WorkspaceSyncPolicies SET enabled=?,update_mode=?,schedule_kind=?,cron_expression=?,timezone=?,interval_ms=?,anchor_at=?,misfire_policy=?,next_due_at=?,last_claimed_slot=NULL,version=version+1,updated_at=? WHERE workspace_id=? AND version=?',
          [
            next.enabled,
            next.update_mode,
            kind,
            expression,
            zone,
            interval,
            anchor,
            misfire,
            due,
            this.clock.now().toISOString(),
            id,
            old.version,
          ],
        );
        await tx.run(
          "UPDATE WorkspaceSyncRuns SET status='CANCELLED',cancel_requested=1,error_code='SYNC_POLICY_CHANGED',finished_at=? WHERE workspace_id=? AND status='QUEUED' AND policy_version<>?",
          [this.clock.now().toISOString(), id, old.version + 1],
        );
        await tx.run(
          "UPDATE WorkspaceSyncRuns SET cancel_requested=1 WHERE workspace_id=? AND status='RUNNING' AND policy_version<>?",
          [id, old.version + 1],
        );
        return this.get(id);
      });
    });
  }
}
