import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  terminalExecutionResult,
  safeExecutionError,
} from '../../shared/execution';
import ExecutionLog from '../executionLog';
import ExecutionRedactor from '../executionRedactor';
import { RuntimeLease } from '../runtimeProcess';
import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLeaseService } from '../workspaceV2/lease';
import { scanWorkspace } from '../workspaceV2/inventory';
import { GitWorkspaceStorageAdapter } from '../workspaceV2/gitStorage';
import { fail, positiveId } from '../workspaceV2/errors';
import { errorCode } from './errors';
import type { FaultHook } from '../workspaceV2/types';
import { WorkspaceExecutionPaths } from './paths';
import { WorkspaceExecutionResolver } from './resolver';
import { WorkspaceAttemptRunner } from './runner';
import type {
  AdmissionSnapshot,
  RunRow,
  RunStatus,
  TriggerType,
  WaitMode,
  AttemptResult,
} from './types';

const PENDING = "('QUEUED','RESOLVING','RUNNING','RECOVERY_REQUIRED')";
const TERMINAL = new Set<RunStatus>([
  'SUCCESS',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
  'INTERRUPTED',
  'SKIPPED',
]);
export interface ExecutionLimits {
  waitTimeoutMs: number;
  maxPerTask: number;
  maxPerWorkspace: number;
  maxQueued: number;
  maxActive: number;
}
const DEFAULTS: ExecutionLimits = {
  waitTimeoutMs: 900000,
  maxPerTask: 32,
  maxPerWorkspace: 128,
  maxQueued: 1024,
  maxActive: 8,
};
export interface SubmitOptions {
  submissionKey?: string;
  triggerType?: TriggerType;
  eventId?: number;
  waitMode?: WaitMode;
}
interface EventRow {
  id: number;
  task_id: number;
  workspace_id: number;
  trigger_type: TriggerType;
  trigger_id: number | null;
  status: string;
  workspace_update_id: number | null;
}

/** One durable queue: TaskRuns. Memory only tracks locally owned process cancellation. */
export class TaskExecutionService {
  readonly paths: WorkspaceExecutionPaths;
  readonly resolver: WorkspaceExecutionResolver;
  readonly limits: ExecutionLimits;
  private active = new Map<
    number,
    { runner: WorkspaceAttemptRunner; done: Promise<void> }
  >();
  private failures = new Map<number, string>();
  private cursor = 0;
  private ticking = false;
  private closed = false;
  private timer?: NodeJS.Timeout;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
    readonly options: {
      limits?: Partial<ExecutionLimits>;
      fault?: FaultHook;
    } = {},
  ) {
    if (store.dataRoot !== roots.dataRoot || store.dataRoot !== leases.dataRoot)
      fail('WORKSPACE_PATH_INVALID');
    this.paths = new WorkspaceExecutionPaths(store.dataRoot);
    this.resolver = new WorkspaceExecutionResolver(store, roots, leases);
    this.limits = { ...DEFAULTS, ...options.limits };
    for (const key of Object.keys(DEFAULTS) as (keyof ExecutionLimits)[])
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > DEFAULTS[key]
      )
        fail('INVALID_REQUEST', 400);
  }
  private now() {
    return new Date().toISOString();
  }
  async get(id: number) {
    const row = (
      await this.store.all<RunRow>('SELECT * FROM TaskRuns WHERE id=?', [
        positiveId(id),
      ])
    )[0];
    if (!row) fail('TASK_RUN_NOT_FOUND', 404);
    return row;
  }
  async events(id: number) {
    await this.get(id);
    return this.store.all(
      'SELECT sequence,type,metadata FROM TaskRunEvents WHERE task_run_id=? ORDER BY sequence',
      [id],
    );
  }
  async attempts(id: number) {
    await this.get(id);
    return this.store.all(
      'SELECT * FROM TaskRunAttempts WHERE task_run_id=? ORDER BY attempt_number,id',
      [id],
    );
  }
  private async event(id: number, type: string, metadata: object = {}) {
    await this.store.run(
      `INSERT INTO TaskRunEvents(task_run_id,sequence,type,metadata)
      SELECT ?,COALESCE(MAX(sequence),0)+1,?,? FROM TaskRunEvents WHERE task_run_id=?`,
      [id, type, JSON.stringify(metadata), id],
    );
  }
  async logs(id: number) {
    await this.get(id);
    await this.safeLog(id);
    return ExecutionLog.read(this.paths, id);
  }
  private async safeLog(id: number) {
    const file = await ExecutionLog.file(this.paths, id);
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (
      stat &&
      (!stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid()))
    )
      fail('EXECUTION_LOG_UNSAFE');
    return file;
  }
  private replay(
    row: RunRow,
    taskId: number,
    trigger: TriggerType,
    mode: WaitMode,
    eventId?: number,
  ) {
    if (
      row.task_id !== taskId ||
      row.trigger_type !== trigger ||
      row.wait_mode !== mode ||
      row.event_id !== (eventId ?? null)
    )
      fail('IDEMPOTENCY_KEY_CONFLICT');
    return row;
  }

  async submit(taskId: number, options: SubmitOptions = {}) {
    positiveId(taskId);
    const trigger = options.triggerType ?? 'MANUAL';
    const automatic = !['MANUAL', 'API'].includes(trigger);
    if (
      ![
        'MANUAL',
        'API',
        'INTERNAL',
        'SCHEDULE',
        'CRON',
        'WEBHOOK',
        'GIT_UPDATE',
      ].includes(trigger) ||
      (options.waitMode !== undefined &&
        !['WAIT', 'SKIP', 'FAIL_FAST'].includes(options.waitMode))
    )
      fail('EXECUTION_SUBMISSION_INVALID', 400);
    if (
      ['CRON', 'WEBHOOK', 'GIT_UPDATE'].includes(trigger) !==
      (options.eventId !== undefined)
    )
      fail('TRIGGER_EVENT_INVALID', 400);
    const mode: WaitMode = automatic ? 'WAIT' : options.waitMode ?? 'WAIT';
    const key =
      options.eventId !== undefined
        ? `event:${positiveId(options.eventId)}`
        : options.submissionKey ?? randomUUID();
    if (
      !/^[A-Za-z0-9:_-]{1,200}$/.test(key) ||
      (options.eventId === undefined && key.startsWith('event:'))
    )
      fail('IDEMPOTENCY_KEY_INVALID', 400);
    const previous = (
      await this.store.all<RunRow>(
        'SELECT * FROM TaskRuns WHERE submission_key=?',
        [key],
      )
    )[0];
    if (previous)
      return this.replay(previous, taskId, trigger, mode, options.eventId);
    // Probe outside the write transaction; Task policy decides whether its result
    // applies. A busy Workspace must not override FORBID or a pending QUEUE turn.
    let probe: { workspaceId: number; busy: boolean } | undefined;
    if (mode === 'FAIL_FAST') {
      const task = await this.resolver.resources.definition(taskId);
      probe = {
        workspaceId: task.workspace.id,
        busy: (await this.leases.probeWorkspace(task.workspace.id)).busy,
      };
    }
    return this.leases.barrier.mutation(() =>
      this.store.transaction(async (tx) => {
        const duplicate = (
          await tx.all<RunRow>(
            'SELECT * FROM TaskRuns WHERE submission_key=?',
            [key],
          )
        )[0];
        if (duplicate)
          return this.replay(duplicate, taskId, trigger, mode, options.eventId);
        const selected = await this.resolver.resources.definition(taskId);
        const expected = await this.resolver.admission(taskId);
        let skip: string | null =
          automatic && !selected.task.enabled ? 'TASK_DISABLED' : null;
        let event: EventRow | undefined;
        if (options.eventId !== undefined) {
          event = (
            await tx.all<EventRow>('SELECT * FROM TriggerEvents WHERE id=?', [
              options.eventId,
            ])
          )[0];
          if (
            !event ||
            event.task_id !== taskId ||
            event.workspace_id !== expected.workspace_id ||
            event.trigger_type !== trigger ||
            !['RECEIVED', 'PROCESSING'].includes(event.status)
          )
            fail('TRIGGER_EVENT_INVALID', 400);
          const tr = (
            await tx.all<{ enabled: number; version: number }>(
              'SELECT enabled,version FROM TaskTriggers WHERE id=?',
              [event.trigger_id],
            )
          )[0];
          if (!tr?.enabled) skip = 'TRIGGER_DISABLED';
          if (trigger === 'GIT_UPDATE') {
            const update = (
              await tx.all<{
                source_generation: number;
                content_revision: number;
                inventory_hash: string;
                after_commit: string;
              }>(
                'SELECT source_generation,content_revision,inventory_hash,after_commit FROM WorkspaceUpdateOutbox WHERE id=? AND workspace_id=?',
                [event.workspace_update_id, expected.workspace_id],
              )
            )[0];
            if (!update) fail('TRIGGER_EVENT_INVALID');
            if (
              update.source_generation !==
                expected.expected_source_generation ||
              update.content_revision !== expected.expected_content_revision ||
              update.inventory_hash !== expected.expected_inventory_hash ||
              update.after_commit !== expected.expected_git_commit
            )
              skip = 'SOURCE_SUPERSEDED';
            Object.assign(expected, {
              expected_source_generation: update.source_generation,
              expected_content_revision: update.content_revision,
              expected_inventory_hash: update.inventory_hash,
              expected_git_commit: update.after_commit,
            });
          }
        }
        const pending = (
          await tx.all<{ n: number }>(
            `SELECT COUNT(*) n FROM TaskRuns WHERE task_id=? AND status IN ${PENDING}`,
            [taskId],
          )
        )[0].n;
        if (!skip && selected.settings.concurrency === 'FORBID' && pending)
          skip = 'TASK_CONCURRENCY_FORBID';
        if (
          !skip &&
          !(selected.settings.concurrency === 'QUEUE' && pending) &&
          probe?.workspaceId === expected.workspace_id &&
          probe.busy
        )
          fail('WORKSPACE_BUSY');
        if (!skip) {
          const counts = (
            await tx.all<{
              task_n: number;
              workspace_n: number;
              total_n: number;
            }>(
              `SELECT
          SUM(CASE WHEN task_id=? THEN 1 ELSE 0 END) task_n,SUM(CASE WHEN workspace_id=? THEN 1 ELSE 0 END) workspace_n,COUNT(*) total_n
          FROM TaskRuns WHERE status='QUEUED'`,
              [taskId, expected.workspace_id],
            )
          )[0];
          if (
            counts.task_n >= this.limits.maxPerTask ||
            counts.workspace_n >= this.limits.maxPerWorkspace ||
            counts.total_n >= this.limits.maxQueued
          ) {
            if (!automatic) fail('EXECUTION_QUEUE_FULL', 429);
            skip = 'EXECUTION_QUEUE_FULL';
          }
        }
        const now = this.now(),
          deadline = new Date(
            Date.now() + this.limits.waitTimeoutMs,
          ).toISOString();
        const result = await tx.run(
          `INSERT INTO TaskRuns(task_id,workspace_id,expected_workspace_version,expected_global_env_version,
        expected_task_definition_version,expected_source_generation,expected_content_revision,expected_git_commit,expected_inventory_hash,
        admission_snapshot,trigger_type,trigger_id,event_id,submission_key,status,submitted_at,finished_at,log_identity,
        concurrency_policy,wait_mode,queue_deadline_at,next_eligible_at,error_code,result_code)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            taskId,
            expected.workspace_id,
            expected.expected_workspace_version,
            expected.expected_global_env_version,
            expected.expected_task_definition_version,
            expected.expected_source_generation,
            expected.expected_content_revision,
            expected.expected_git_commit,
            expected.expected_inventory_hash,
            JSON.stringify(expected),
            trigger,
            event?.trigger_id ?? null,
            event?.id ?? null,
            key,
            skip ? 'SKIPPED' : 'QUEUED',
            now,
            skip ? now : null,
            randomUUID(),
            selected.settings.concurrency,
            mode,
            deadline,
            now,
            skip,
            skip ? 'SKIPPED' : null,
          ],
        );
        await this.event(result.lastID, 'SUBMISSION_IDENTITY', {
          task_id: taskId,
          task_definition_version: selected.task.version,
        });
        if (event)
          await tx.run(
            'UPDATE TriggerEvents SET task_run_id=?,status=? WHERE id=?',
            [result.lastID, skip ? 'SKIPPED' : 'SUBMITTED', event.id],
          );
        return this.get(result.lastID);
      }),
    );
  }

  async cancel(id: number) {
    return this.leases.barrier.mutation(async () => {
      const row = await this.get(id);
      if (row.status === 'RECOVERY_REQUIRED')
        fail('WORKSPACE_RECOVERY_REQUIRED');
      if (TERMINAL.has(row.status)) return row;
      await this.store.transaction(async (tx) => {
        const current = await this.get(id);
        if (current.status === 'QUEUED')
          await tx.run(
            "UPDATE TaskRuns SET status='CANCELLED',cancel_requested=1,finished_at=?,result_code='CANCELLED' WHERE id=? AND status='QUEUED'",
            [this.now(), id],
          );
        else if (['RESOLVING', 'RUNNING'].includes(current.status))
          await tx.run('UPDATE TaskRuns SET cancel_requested=1 WHERE id=?', [
            id,
          ]);
      });
      this.active.get(id)?.runner.cancel();
      return this.get(id);
    }, true);
  }
  start() {
    if (this.timer) return;
    this.closed = false;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 100);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 5));
    for (const value of this.active.values()) value.runner.cancel();
    await Promise.all([...this.active.values()].map((v) => v.done));
  }
  async wait(id: number, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const row = await this.get(id);
      if (TERMINAL.has(row.status) || row.status === 'RECOVERY_REQUIRED')
        return row;
      const failure = this.failures.get(id);
      if (failure) fail(failure);
      if (Date.now() > deadline) fail('EXECUTION_WAIT_TIMEOUT');
      await this.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      for (const [id, value] of this.active)
        if ((await this.get(id)).cancel_requested) value.runner.cancel();
      await this.recover();
      if (this.active.size >= this.limits.maxActive) return;
      const now = this.now();
      await this.leases.barrier
        .mutation(async () => {
          await this.store.run(
            "UPDATE TaskRuns SET status='SKIPPED',error_code='WORKSPACE_WAIT_TIMEOUT',result_code='SKIPPED',finished_at=? WHERE status='QUEUED' AND queue_deadline_at<=?",
            [now, now],
          );
        })
        .catch((error) => {
          if (
            !['PLATFORM_BACKUP_IN_PROGRESS', 'BACKUP_BUSY'].includes(
              errorCode(error),
            )
          )
            throw error;
        });
      const heads = await this.store.all<RunRow>(
        `SELECT r.* FROM TaskRuns r WHERE r.status='QUEUED' AND r.next_eligible_at<=?
        AND NOT EXISTS(SELECT 1 FROM TaskRuns q WHERE q.workspace_id=r.workspace_id AND q.status='QUEUED'
          AND (q.submitted_at<r.submitted_at OR q.submitted_at=r.submitted_at AND q.id<r.id)) ORDER BY r.workspace_id LIMIT ?`,
        [now, this.limits.maxQueued],
      );
      const ordered = [
        ...heads.filter((r) => r.workspace_id > this.cursor),
        ...heads.filter((r) => r.workspace_id <= this.cursor),
      ];
      for (const row of ordered) {
        if (this.closed || this.active.size >= this.limits.maxActive) break;
        if (this.active.has(row.id)) continue;
        const runner = new WorkspaceAttemptRunner(this.store, this.roots, {
          fault: this.options.fault,
          event: (type, metadata) => this.event(row.id, type, metadata),
        });
        const entry = { runner, done: Promise.resolve() };
        this.active.set(row.id, entry);
        this.cursor = row.workspace_id;
        entry.done = this.execute(row, runner)
          .catch((error) => {
            this.failures.set(row.id, errorCode(error));
          })
          .finally(() => this.active.delete(row.id));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async claim(row: RunRow, token: string) {
    return this.store.transaction(async (tx) => {
      const current = await this.get(row.id);
      if (
        current.status !== 'QUEUED' ||
        current.cancel_requested ||
        current.queue_deadline_at <= this.now()
      )
        return false;
      const active = (
        await tx.all<{ n: number }>(
          "SELECT COUNT(*) n FROM TaskRuns WHERE status IN ('RESOLVING','RUNNING')",
        )
      )[0].n;
      if (active >= this.limits.maxActive) return false;
      if (
        current.concurrency_policy !== 'ALLOW' &&
        (
          await tx.all(
            `SELECT id FROM TaskRuns WHERE task_id=? AND status IN ${PENDING}
        AND (submitted_at<? OR submitted_at=? AND id<?) LIMIT 1`,
            [
              current.task_id,
              current.submitted_at,
              current.submitted_at,
              current.id,
            ],
          )
        ).length
      ) {
        await tx.run(
          "UPDATE TaskRuns SET queue_reason='TASK_CONCURRENCY' WHERE id=?",
          [current.id],
        );
        return false;
      }
      const update = await tx.run(
        "UPDATE TaskRuns SET status='RESOLVING',owner_token=? WHERE id=? AND status='QUEUED' AND cancel_requested=0",
        [token, row.id],
      );
      return update.changes === 1;
    });
  }
  private async requeue(row: RunRow, token: string, reason: string) {
    const delay = Math.min(
      5000,
      250 * 2 ** Math.min(row.queue_attempt_count, 4),
    );
    const jitter = Math.floor(Math.random() * delay * 0.1);
    await this.store.run(
      `UPDATE TaskRuns SET status='QUEUED',owner_token=NULL,active_workspace_id=NULL,queue_reason=?,
      queue_attempt_count=queue_attempt_count+1,next_eligible_at=? WHERE id=? AND status='RESOLVING' AND owner_token=?`,
      [
        reason,
        new Date(Date.now() + delay + jitter).toISOString(),
        row.id,
        token,
      ],
    );
  }
  private async terminal(row: RunRow, token: string, result: AttemptResult) {
    await this.store.transaction(async (tx) => {
      await tx.run(
        `UPDATE TaskRuns SET status=?,active_workspace_id=NULL,owner_token=NULL,finished_at=?,result_code=?,
        exit_code=?,signal=?,error_code=?,result=? WHERE id=? AND owner_token=? AND status IN ('RESOLVING','RUNNING','RECOVERY_REQUIRED')`,
        [
          result.status,
          result.finishedAt,
          result.status,
          result.exitCode,
          result.signal,
          result.primaryError?.code ?? null,
          JSON.stringify(result),
          row.id,
          token,
        ],
      );
    });
  }
  private async dirty(row: RunRow, token: string, code: string) {
    await this.store.transaction(async (tx) => {
      await tx.run(
        "UPDATE TaskRuns SET status='RECOVERY_REQUIRED',active_workspace_id=?,error_code=? WHERE id=? AND owner_token=? AND status IN ('RESOLVING','RUNNING','RECOVERY_REQUIRED')",
        [row.workspace_id, code, row.id, token],
      );
      await tx.run(
        "UPDATE Workspaces SET lifecycle_state='RECOVERY_REQUIRED',last_error_code='WORKSPACE_RECOVERY_REQUIRED' WHERE id=? AND lifecycle_state='READY'",
        [row.workspace_id],
      );
    });
  }
  private async stableSource(
    workspaceId: number,
    lease: Parameters<WorkspaceExecutionResolver['resolve']>[1],
  ) {
    const row = await this.store.workspace(workspaceId);
    const owned = await this.roots.requireOwned(row);
    const inventory = await scanWorkspace(owned.root, row.type);
    if (row.type === 'GIT') {
      const git = await new GitWorkspaceStorageAdapter(
        this.store,
        this.roots,
        this.leases,
      ).verify(row, lease);
      await this.store.run(
        'UPDATE GitWorkspaces SET last_verified_commit=? WHERE workspace_id=?',
        [git.head, row.id],
      );
    }
    await this.store.updateInventory(row.id, row.content_revision, inventory);
  }

  private async execute(original: RunRow, runner: WorkspaceAttemptRunner) {
    let claimed = false;
    let leaseAcquired = false;
    const token = randomUUID();
    try {
      await this.leases.barrier.mutation(async () => {
        let owner: RuntimeLease;
        try {
          owner = await this.paths.owner(original.id);
        } catch (error) {
          if (errorCode(error) === 'RUNTIME_BUSY') return;
          throw error;
        }
        try {
          claimed = await this.claim(original, token);
          if (!claimed) return;
          const row = await this.get(original.id);
          await this.options.fault?.('BEFORE_LEASE', {
            run_id: row.id,
            workspace_id: row.workspace_id,
          });
          try {
            await this.leases.withWorkspace(
              row.workspace_id,
              'TASK_EXECUTION',
              async (lease) => {
                await this.store.run(
                  'UPDATE TaskRuns SET active_workspace_id=? WHERE id=? AND owner_token=?',
                  [row.workspace_id, row.id, token],
                );
                leaseAcquired = true;
                await this.options.fault?.('AFTER_LEASE', {
                  run_id: row.id,
                  workspace_id: row.workspace_id,
                });
                if ((await this.get(row.id)).cancel_requested) {
                  await this.terminal(
                    row,
                    token,
                    terminalExecutionResult(
                      row.id,
                      'CANCELLED',
                      'CANCELLED',
                      'RESOLVE',
                    ),
                  );
                  return;
                }
                let resolved: Awaited<
                  ReturnType<WorkspaceExecutionResolver['resolve']>
                >;
                try {
                  resolved = await this.resolver.resolve(
                    row,
                    lease,
                    this.options.fault,
                  );
                } catch (error) {
                  const code = errorCode(error);
                  if (code === 'WORKSPACE_BUSY') throw error;
                  if (code === 'SOURCE_SUPERSEDED') {
                    const reason =
                      error &&
                      typeof error === 'object' &&
                      'reason' in error &&
                      [
                        'SOURCE_CHANGED',
                        'TASK_CHANGED',
                        'RESOURCE_CHANGED',
                      ].includes(String(error.reason))
                        ? String(error.reason)
                        : 'SOURCE_CHANGED';
                    await this.event(row.id, 'SOURCE_SUPERSEDED', { reason });
                    await this.terminal(
                      row,
                      token,
                      terminalExecutionResult(
                        row.id,
                        'SKIPPED',
                        code,
                        'RESOLVE',
                      ),
                    );
                    return;
                  }
                  if (
                    [
                      'RUNTIME_BUSY',
                      'ENVIRONMENT_BUSY',
                      'NODE_ENVIRONMENT_BUSY',
                      'RUNTIME_ENVIRONMENT_BUSY',
                    ].includes(code)
                  ) {
                    await this.requeue(row, token, 'RUNTIME_CAPACITY');
                    return;
                  }
                  if (
                    [
                      'SOURCE_MISSING',
                      'SOURCE_UNVERIFIED',
                      'WORKSPACE_RECOVERY_REQUIRED',
                      'WORKSPACE_PATH_FORBIDDEN',
                      'WORKSPACE_PATH_INVALID',
                    ].includes(code)
                  ) {
                    await this.dirty(row, token, code);
                    return;
                  }
                  await this.terminal(
                    row,
                    token,
                    terminalExecutionResult(row.id, 'FAILED', code, 'RESOLVE'),
                  );
                  return;
                }
                try {
                  const snapshot = {
                    task_id: resolved.context.identity.taskId,
                    task_definition_version:
                      resolved.context.identity.taskDefinitionVersion,
                    source: resolved.source,
                    runtime: {
                      kind: resolved.context.runtime.kind,
                      environment_id: resolved.context.runtime.environmentId,
                      revision_id: resolved.context.runtime.revisionId,
                      build_id: resolved.context.runtime.buildId,
                      runtime_id: resolved.context.runtime.runtimeId,
                      toolchain_id: resolved.context.runtime.toolchainId,
                      provider_id: resolved.context.runtime.providerId,
                      provider_revision:
                        resolved.context.runtime.providerRevision,
                      runtime_version: resolved.context.runtime.runtimeVersion,
                      environment_version:
                        resolved.context.runtime.environmentVersion,
                      toolchain_version:
                        resolved.context.runtime.toolchainVersion,
                    },
                    configs:
                      resolved.source.effective_resource_versions
                        .config_revisions,
                  };
                  const started = await this.store.transaction(async (tx) => {
                    if ((await this.get(row.id)).cancel_requested) return false;
                    return (
                      (
                        await tx.run(
                          `UPDATE TaskRuns SET source_snapshot=?,snapshot_metadata=?,task_definition_version=?,
                    status='RUNNING',started_at=? WHERE id=? AND status='RESOLVING' AND owner_token=?`,
                          [
                            JSON.stringify(resolved.source),
                            JSON.stringify(snapshot),
                            resolved.context.identity.taskDefinitionVersion,
                            this.now(),
                            row.id,
                            token,
                          ],
                        )
                      ).changes === 1
                    );
                  });
                  if (!started) {
                    await this.terminal(
                      row,
                      token,
                      terminalExecutionResult(
                        row.id,
                        'CANCELLED',
                        'CANCELLED',
                        'RESOLVE',
                      ),
                    );
                    return;
                  }
                  await this.safeLog(row.id);
                  const log = await ExecutionLog.open(this.paths, row.id);
                  await this.safeLog(row.id);
                  let logBytes = (await this.get(row.id)).log_size,
                    truncated = false;
                  const sink = async (text: string) => {
                    const bytes = Buffer.byteLength(text);
                    if (logBytes + bytes <= 4 * 1024 * 1024) {
                      await log.write(text);
                      logBytes += bytes;
                    } else if (!truncated) {
                      await log.write('\n[LOG_TRUNCATED]\n');
                      logBytes += 17;
                      truncated = true;
                    }
                  };
                  let logClosed = false;
                  const finishLog = async () => {
                    if (logClosed) return;
                    logClosed = true;
                    await log.close();
                    await this.store.run(
                      'UPDATE TaskRuns SET log_size=?,log_truncated=? WHERE id=?',
                      [logBytes, truncated ? 1 : 0, row.id],
                    );
                  };
                  let result: AttemptResult | undefined;
                  const cancellation = setInterval(() => {
                    void this.get(row.id)
                      .then((r) => {
                        if (r.cancel_requested) runner.cancel();
                      })
                      .catch(() => runner.cancel());
                  }, 50);
                  try {
                    for (
                      let attempt = 1;
                      attempt <= resolved.context.settings.max_attempts;
                      attempt++
                    ) {
                      const now = this.now();
                      await this.store.transaction(async (tx) => {
                        await tx.run(
                          'UPDATE TaskRuns SET attempt_count=? WHERE id=? AND owner_token=?',
                          [attempt, row.id, token],
                        );
                        await tx.run(
                          "INSERT INTO TaskRunAttempts(task_run_id,attempt_number,status,started_at,createdAt,updatedAt) VALUES(?,?,'RUNNING',?,?,?)",
                          [row.id, attempt, now, now, now],
                        );
                      });
                      result = await runner.run(
                        resolved.context,
                        attempt,
                        lease,
                        resolved.pins,
                        sink,
                        [owner.handle.fd],
                      );
                      const retry = runner.retry(result, resolved.context);
                      const delay =
                        resolved.context.settings.initial_delay_seconds *
                        (resolved.context.settings.backoff === 'EXPONENTIAL'
                          ? 2 ** (attempt - 1)
                          : 1);
                      await this.store.run(
                        `UPDATE TaskRunAttempts SET status=?,finished_at=?,exit_code=?,signal=?,error_code=?,duration_ms=?,
                      result=?,retry_decision=?,retry_delay=? WHERE task_run_id=? AND attempt_number=?`,
                        [
                          result.status,
                          result.finishedAt,
                          result.exitCode,
                          result.signal,
                          result.primaryError?.code ?? null,
                          result.duration,
                          JSON.stringify(result),
                          retry ? 1 : 0,
                          retry ? delay : 0,
                          row.id,
                          attempt,
                        ],
                      );
                      if (result.cleanupResult !== 'SUCCESS') {
                        await this.dirty(
                          row,
                          token,
                          'WORKSPACE_RECOVERY_REQUIRED',
                        );
                        return;
                      }
                      if (!retry) break;
                      await this.event(row.id, 'RETRY_SCHEDULED', {
                        attempt,
                        delay_seconds: delay,
                      });
                      await runner.backoff(delay);
                      if (
                        runner.isCancelled ||
                        (await this.get(row.id)).cancel_requested
                      ) {
                        result = terminalExecutionResult(
                          row.id,
                          'CANCELLED',
                          'CANCELLED',
                          'RETRY',
                          result.startedAt,
                          attempt,
                        );
                        break;
                      }
                      const currentWorkspace = await this.store.workspace(
                        row.workspace_id,
                      );
                      const retryInventory = await scanWorkspace(
                        this.roots.path(currentWorkspace),
                        currentWorkspace.type,
                      );
                      const retryGit =
                        currentWorkspace.type === 'GIT'
                          ? await new GitWorkspaceStorageAdapter(
                              this.store,
                              this.roots,
                              this.leases,
                            ).verify(currentWorkspace, lease)
                          : null;
                      if (
                        retryInventory.hash !==
                          resolved.source.inventory_hash ||
                        (retryGit?.head ?? null) !==
                          (resolved.source.git?.commit ?? null)
                      ) {
                        result = terminalExecutionResult(
                          row.id,
                          'FAILED',
                          'SOURCE_SUPERSEDED',
                          'RETRY_SOURCE',
                          result.startedAt,
                          attempt,
                        );
                        await this.event(row.id, 'SOURCE_SUPERSEDED', {
                          reason: 'SOURCE_CHANGED',
                          phase: 'RETRY_SOURCE',
                        });
                        break;
                      }
                    }
                    if (!result) fail('EXECUTION_FAILED');
                    await this.stableSource(row.workspace_id, lease);
                    await finishLog();
                    await this.options.fault?.('BEFORE_TERMINAL_COMMIT', {
                      run_id: row.id,
                      workspace_id: row.workspace_id,
                    });
                    await this.terminal(row, token, result);
                  } catch (error) {
                    await this.dirty(row, token, errorCode(error));
                  } finally {
                    clearInterval(cancellation);
                    await finishLog();
                  }
                } finally {
                  await resolved.release();
                }
              },
            );
          } catch (error) {
            const code = errorCode(error);
            if (code === 'WORKSPACE_BUSY') {
              if (row.wait_mode === 'WAIT')
                await this.requeue(row, token, 'WORKSPACE_LEASE');
              else
                await this.terminal(
                  row,
                  token,
                  terminalExecutionResult(
                    row.id,
                    'SKIPPED',
                    'WORKSPACE_BUSY',
                    'LEASE',
                  ),
                );
            } else if (
              !TERMINAL.has((await this.get(row.id)).status) &&
              (await this.get(row.id)).status !== 'RECOVERY_REQUIRED'
            ) {
              if (leaseAcquired) await this.dirty(row, token, code);
              else
                await this.terminal(
                  row,
                  token,
                  terminalExecutionResult(row.id, 'FAILED', code, 'RESOLVE'),
                );
            }
          }
        } finally {
          await owner.release();
        }
      });
    } catch (error) {
      const code = errorCode(error);
      if (
        claimed &&
        !TERMINAL.has((await this.get(original.id)).status) &&
        (await this.get(original.id)).status !== 'RECOVERY_REQUIRED'
      ) {
        if (leaseAcquired) await this.dirty(original, token, code);
        else
          await this.terminal(
            original,
            token,
            terminalExecutionResult(original.id, 'FAILED', code, 'RESOLVE'),
          );
      } else if (
        ![
          'WORKSPACE_NOT_READY',
          'WORKSPACE_BUSY',
          'PLATFORM_BACKUP_IN_PROGRESS',
          'BACKUP_BUSY',
        ].includes(code)
      )
        throw error;
    }
  }

  /** Restart takes the real run-owner and Workspace FDs before touching journals. No rerun. */
  async recover() {
    const rows = await this.store.all<RunRow>(
      "SELECT * FROM TaskRuns WHERE status IN ('RESOLVING','RUNNING','RECOVERY_REQUIRED') ORDER BY id LIMIT 1024",
    );
    for (const row of rows) {
      if (this.active.has(row.id)) continue;
      try {
        await this.leases.barrier.mutation(async () => {
          let owner: RuntimeLease;
          try {
            owner = await this.paths.owner(row.id);
          } catch (error) {
            if (errorCode(error) === 'RUNTIME_BUSY') return;
            throw error;
          }
          try {
            await this.leases.withWorkspace(
              row.workspace_id,
              'TASK_RECOVERY',
              async (lease) => {
                const current = await this.get(row.id);
                if (
                  !['RESOLVING', 'RUNNING', 'RECOVERY_REQUIRED'].includes(
                    current.status,
                  )
                )
                  return;
                const token = randomUUID();
                const takeover = await this.store.run(
                  'UPDATE TaskRuns SET owner_token=? WHERE id=? AND status=? AND owner_token IS ?',
                  [token, row.id, current.status, current.owner_token],
                );
                if (takeover.changes !== 1) return;
                const runner = new WorkspaceAttemptRunner(
                  this.store,
                  this.roots,
                  {
                    fault: this.options.fault,
                    event: (type, meta) => this.event(row.id, type, meta),
                  },
                );
                try {
                  await runner.recover(row.workspace_id, lease, undefined, {
                    runId: row.id,
                    ownerToken: current.owner_token,
                  });
                  await runner.cleanupRun(row.id);
                  const ws = await this.store.workspace(row.workspace_id);
                  await this.roots.requireOwned(ws);
                  await this.stableSource(row.workspace_id, lease);
                  await this.store.transaction(async (tx) => {
                    await tx.run(
                      "UPDATE TaskRunAttempts SET status='INTERRUPTED',finished_at=?,error_code='EXECUTION_INTERRUPTED' WHERE task_run_id=? AND status IN ('RUNNING','RESOLVING','QUEUED')",
                      [this.now(), row.id],
                    );
                    await this.terminal(
                      row,
                      token,
                      terminalExecutionResult(
                        row.id,
                        'INTERRUPTED',
                        'EXECUTION_INTERRUPTED',
                        'RECOVERY',
                        current.started_at,
                        current.attempt_count,
                      ),
                    );
                    if (
                      ws.lifecycle_state === 'RECOVERY_REQUIRED' &&
                      !(
                        await tx.all(
                          "SELECT id FROM WorkspaceOperations WHERE workspace_id=? AND status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED')",
                          [ws.id],
                        )
                      ).length
                    )
                      await tx.run(
                        "UPDATE Workspaces SET lifecycle_state='READY',last_error_code=NULL WHERE id=? AND storage_state='PRESENT'",
                        [ws.id],
                      );
                  });
                } catch (error) {
                  await this.dirty(row, token, errorCode(error));
                }
              },
            );
          } finally {
            await owner.release();
          }
        }, true);
      } catch (error) {
        if (
          ![
            'WORKSPACE_BUSY',
            'RUNTIME_BUSY',
            'PLATFORM_BACKUP_IN_PROGRESS',
            'BACKUP_BUSY',
          ].includes(errorCode(error))
        )
          throw error;
      }
    }
  }
}
