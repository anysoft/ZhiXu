import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { relativeGlob, matchesGlob } from '../../shared/triggerDefinition';
import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLeaseService } from '../workspaceV2/lease';
import { fail, positiveId, errorCode } from '../workspaceV2/errors';
import type { FaultHook } from '../workspaceV2/types';
import { TaskResourceResolver } from '../taskExecutionV2/resources';
import { loadTaskDefinition } from '../taskExecutionV2/task';
import type { TaskExecutionService } from '../taskExecutionV2/execution';
import type { AdmissionSnapshot } from '../taskExecutionV2/types';
import { validateGitUpdateSnapshot } from '../taskExecutionV2/gitUpdateAdmission';
import RuntimePathResolver from '../runtimePaths';
import { RuntimeLease } from '../runtimeProcess';
import { withInheritedLease } from '../backup/inheritedLeases';

export interface SuccessfulWorkspaceUpdate {
  id: number;
  workspaceId: number;
  workspaceVersion: number;
  sourceGeneration: number;
  contentRevision: number;
  initial: boolean;
  beforeCommit: string | null;
  afterCommit: string;
  inventoryHash: string;
}
export interface GitUpdateTriggerInput {
  mode: 'ANY_CHANGE' | 'SOURCE_CHANGE' | 'PATH_FILTER';
  pathFilters?: readonly string[];
  fireOnInitial?: boolean;
  enabled?: boolean;
}
export interface GitUpdateTriggerRow {
  id: number;
  task_id: number;
  workspace_id: number;
  enabled: number;
  version: number;
  mode: GitUpdateTriggerInput['mode'];
  path_filters: string;
  fire_on_initial: number;
}
export interface GitUpdatePlanItem {
  origin_trigger_id: number;
  trigger_version: number;
  task_id: number;
  task_definition_version: number;
  event_key: string;
  skip_reason: string | null;
  admission: AdmissionSnapshot;
}
interface OutboxRow {
  id: number;
  workspace_id: number;
  sync_run_id: number;
  source_generation: number;
  content_revision: number;
  initial: number;
  before_commit: string | null;
  after_commit: string;
  inventory_hash: string;
  trigger_plan: string;
  status:
    | 'PENDING'
    | 'PROCESSING'
    | 'DISPATCHED'
    | 'RETRY'
    | 'DEAD'
    | 'CANCELLED';
  attempt_count: number;
  owner_token: string | null;
  claim_expires_at: string | null;
  next_attempt_at: string;
}
interface EventRow {
  id: number;
  trigger_id: number | null;
  task_id: number | null;
  origin_trigger_id: number;
  status: 'RECEIVED' | 'PROCESSING' | 'SUBMITTED' | 'SKIPPED' | 'FAILED';
  task_run_id: number | null;
  owner_token: string | null;
}

function triggerInput(input: GitUpdateTriggerInput) {
  if (
    !input ||
    Object.keys(input).some(
      (key) =>
        !['mode', 'pathFilters', 'fireOnInitial', 'enabled'].includes(key),
    ) ||
    !['ANY_CHANGE', 'SOURCE_CHANGE', 'PATH_FILTER'].includes(input.mode) ||
    (input.fireOnInitial !== undefined &&
      typeof input.fireOnInitial !== 'boolean') ||
    (input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
    (input.pathFilters !== undefined && !Array.isArray(input.pathFilters))
  )
    fail('TRIGGER_FIELDS_INVALID', 400);
  const filters = [...new Set((input.pathFilters ?? []).map(relativeGlob))];
  if (
    filters.length > 200 ||
    (input.mode === 'PATH_FILTER') !== filters.length > 0
  )
    fail('TRIGGER_FIELDS_INVALID', 400);
  return {
    mode: input.mode,
    filters,
    initial: !!input.fireOnInitial,
    enabled: input.enabled !== false,
  };
}

/** Candidate-only trigger ownership; no Subscription, v9 model or public route. */
export class WorkspaceGitUpdateTriggers {
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
  ) {}
  async list(taskId: number) {
    await loadTaskDefinition(this.store, positiveId(taskId));
    return this.store.all<GitUpdateTriggerRow>(
      `SELECT tr.id,tr.task_id,t.workspace_id,tr.enabled,tr.version,g.mode,g.path_filters,g.fire_on_initial
      FROM TaskTriggers tr JOIN GitUpdateTriggers g ON g.trigger_id=tr.id JOIN Tasks t ON t.id=tr.task_id WHERE tr.task_id=? ORDER BY tr.id`,
      [taskId],
    );
  }
  private async get(id: number) {
    const row = (
      await this.store.all<GitUpdateTriggerRow>(
        `SELECT tr.id,tr.task_id,t.workspace_id,tr.enabled,tr.version,g.mode,g.path_filters,g.fire_on_initial
      FROM TaskTriggers tr JOIN GitUpdateTriggers g ON g.trigger_id=tr.id JOIN Tasks t ON t.id=tr.task_id WHERE tr.id=?`,
        [positiveId(id)],
      )
    )[0];
    if (!row) fail('TRIGGER_NOT_FOUND', 404);
    return row;
  }
  async create(
    taskId: number,
    expectedTaskVersion: number,
    input: GitUpdateTriggerInput,
  ) {
    const value = triggerInput(input);
    const definition = await loadTaskDefinition(this.store, positiveId(taskId));
    return this.leases.withWorkspace(
      definition.task.workspace_id,
      'GIT_UPDATE_TRIGGER_CREATE',
      async (lease) => {
        const row = await this.store.assertAccessible(
          definition.task.workspace_id,
          true,
        );
        if (row.type !== 'GIT') fail('WORKSPACE_TYPE_INVALID');
        await this.roots.requireReady(row, lease);
        return this.store.transaction(async (tx) => {
          const current = await loadTaskDefinition(tx, taskId);
          if (current.task.version !== expectedTaskVersion)
            fail('TASK_VERSION_CONFLICT');
          const now = new Date().toISOString();
          const created = await tx.run(
            "INSERT INTO TaskTriggers(task_id,type,origin,enabled,createdAt,updatedAt) VALUES(?,'GIT_UPDATE','USER',?,?,?)",
            [taskId, value.enabled ? 1 : 0, now, now],
          );
          await tx.run(
            'INSERT INTO GitUpdateTriggers(trigger_id,mode,path_filters,fire_on_initial,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
            [
              created.lastID,
              value.mode,
              JSON.stringify(value.filters),
              value.initial ? 1 : 0,
              now,
              now,
            ],
          );
          return this.get(created.lastID);
        });
      },
    );
  }
  async update(
    id: number,
    expectedVersion: number,
    input: GitUpdateTriggerInput,
  ) {
    const value = triggerInput(input),
      previous = await this.get(id);
    return this.leases.withWorkspace(
      previous.workspace_id,
      'GIT_UPDATE_TRIGGER_UPDATE',
      async (lease) => {
        const row = await this.store.assertAccessible(
          previous.workspace_id,
          true,
        );
        await this.roots.requireReady(row, lease);
        return this.store.transaction(async (tx) => {
          const now = new Date().toISOString();
          const updated = await tx.run(
            'UPDATE TaskTriggers SET enabled=?,version=version+1,updatedAt=? WHERE id=? AND version=?',
            [value.enabled ? 1 : 0, now, id, expectedVersion],
          );
          if (updated.changes !== 1) fail('TRIGGER_VERSION_CONFLICT');
          await tx.run(
            'UPDATE GitUpdateTriggers SET mode=?,path_filters=?,fire_on_initial=?,updatedAt=? WHERE trigger_id=?',
            [
              value.mode,
              JSON.stringify(value.filters),
              value.initial ? 1 : 0,
              now,
              id,
            ],
          );
          return this.get(id);
        });
      },
    );
  }
  async remove(id: number, expectedVersion: number) {
    const previous = await this.get(id);
    return this.leases.withWorkspace(
      previous.workspace_id,
      'GIT_UPDATE_TRIGGER_REMOVE',
      async (lease) => {
        const row = await this.store.assertAccessible(
          previous.workspace_id,
          false,
        );
        await this.roots.requireOwned(row);
        await lease.assertHeld();
        return this.store.transaction(async (tx) => {
          if (
            (
              await tx.run(
                'DELETE FROM TaskTriggers WHERE id=? AND version=?',
                [id, expectedVersion],
              )
            ).changes !== 1
          )
            fail('TRIGGER_VERSION_CONFLICT');
        });
      },
    );
  }
}

class OutboxOwnerPaths extends RuntimePathResolver {
  async lock(id: number) {
    return path.join(
      await this.directory('.locks', true),
      `workspace-update-outbox-${positiveId(id)}.lock`,
    );
  }
}

const eventKey = (
  trigger: number,
  source: Pick<
    SuccessfulWorkspaceUpdate,
    'workspaceId' | 'sourceGeneration' | 'afterCommit'
  >,
) =>
  createHash('sha256')
    .update(
      `gitupdate:v2:${trigger}:${source.workspaceId}:${source.sourceGeneration}:${source.afterCommit}`,
    )
    .digest('hex');
const TERMINAL_EVENTS = new Set(['SUBMITTED', 'SKIPPED', 'FAILED']);

/** Durable successful-update dispatcher; TaskRuns remains the only execution queue. */
export class WorkspaceGitUpdateOutbox {
  readonly resources: TaskResourceResolver;
  readonly paths: OutboxOwnerPaths;
  readonly claimMs: number;
  readonly maxAttempts: number;
  readonly dispatchTimeoutMs: number;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
    readonly execution: TaskExecutionService,
    readonly options: {
      fault?: FaultHook;
      clock?: { now(): Date };
      claimMs?: number;
      maxAttempts?: number;
      dispatchTimeoutMs?: number;
    } = {},
  ) {
    if (
      store.dataRoot !== roots.dataRoot ||
      store.dataRoot !== leases.dataRoot ||
      execution.store !== store
    )
      fail('WORKSPACE_PATH_INVALID');
    this.resources = new TaskResourceResolver(store, roots, leases);
    this.paths = new OutboxOwnerPaths(store.dataRoot);
    this.claimMs = options.claimMs ?? 60000;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.dispatchTimeoutMs = options.dispatchTimeoutMs ?? 30000;
    if (
      ![this.claimMs, this.maxAttempts, this.dispatchTimeoutMs].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      this.claimMs > 60000 ||
      this.maxAttempts > 8 ||
      this.dispatchTimeoutMs > 30000
    )
      fail('SYNC_POLICY_INVALID');
  }
  private now() {
    const value = this.options.clock?.now() ?? new Date();
    if (!Number.isFinite(value.getTime())) fail('SYNC_POLICY_INVALID');
    return value;
  }
  async get(id: number) {
    const row = (
      await this.store.all<OutboxRow>(
        'SELECT * FROM WorkspaceUpdateOutbox WHERE id=?',
        [positiveId(id)],
      )
    )[0];
    if (!row) fail('WORKSPACE_SYNC_RUN_NOT_FOUND', 404);
    return row;
  }
  private source(source: SuccessfulWorkspaceUpdate) {
    for (const id of [
      source.id,
      source.workspaceId,
      source.workspaceVersion,
      source.sourceGeneration,
      source.contentRevision,
    ])
      positiveId(id);
    if (
      typeof source.initial !== 'boolean' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.afterCommit) ||
      (source.beforeCommit !== null &&
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.beforeCommit)) ||
      !/^[a-f0-9]{64}$/.test(source.inventoryHash) ||
      (!source.initial && source.beforeCommit === source.afterCommit)
    )
      fail('SYNC_RECOVERY_REQUIRED');
  }
  async preparePlan(
    tx: WorkspaceStore,
    source: SuccessfulWorkspaceUpdate,
    changedPaths: readonly string[],
  ): Promise<GitUpdatePlanItem[]> {
    this.source(source);
    if (
      tx !== this.store ||
      !Array.isArray(changedPaths) ||
      changedPaths.length > 20000
    )
      fail('SYNC_RECOVERY_REQUIRED');
    for (const name of changedPaths) {
      if (
        typeof name !== 'string' ||
        !name ||
        name.length > 4096 ||
        name.startsWith('/') ||
        /[\\\x00-\x1f]/.test(name) ||
        name.split('/').some((part) => !part || part === '..' || part === '.')
      )
        fail('SYNC_RECOVERY_REQUIRED');
    }
    const triggers = await tx.all<GitUpdateTriggerRow>(
      `SELECT tr.id,tr.task_id,t.workspace_id,tr.enabled,tr.version,g.mode,g.path_filters,g.fire_on_initial
      FROM TaskTriggers tr JOIN GitUpdateTriggers g ON g.trigger_id=tr.id JOIN Tasks t ON t.id=tr.task_id WHERE t.workspace_id=? ORDER BY tr.id`,
      [source.workspaceId],
    );
    if (triggers.length > 10000) fail('SYNC_POLICY_INVALID');
    const plan: GitUpdatePlanItem[] = [];
    for (const trigger of triggers) {
      const selected = await this.resources.definition(trigger.task_id);
      if (
        selected.workspace.id !== source.workspaceId ||
        selected.workspace.type !== 'GIT'
      )
        fail('WORKSPACE_TYPE_INVALID');
      const admission: AdmissionSnapshot = {
        workspace_id: source.workspaceId,
        workspace_type: 'GIT',
        expected_workspace_version: source.workspaceVersion,
        expected_source_generation: source.sourceGeneration,
        expected_content_revision: source.contentRevision,
        expected_task_definition_version: selected.task.version,
        expected_global_env_version:
          selected.effectiveResourceVersions.global_env_version,
        expected_inventory_hash: source.inventoryHash,
        expected_git_commit: source.afterCommit,
        effective_resource_versions: selected.effectiveResourceVersions,
        relative_entrypoint: selected.source.relative_entrypoint,
        language: selected.source.language,
        cwd_mode: selected.source.cwd_mode,
        cwd_relative_path: selected.source.cwd_relative_path,
      };
      let skip: string | null = !trigger.enabled
        ? 'TRIGGER_DISABLED'
        : !selected.task.enabled
        ? 'TASK_DISABLED'
        : null;
      if (
        !skip &&
        selected.task.origin === 'DISCOVERED' &&
        selected.task.discovery_state === 'RETIRED'
      )
        skip = 'TASK_NOT_READY';
      if (!skip && source.initial && !trigger.fire_on_initial)
        skip = 'GIT_INITIAL_SYNC_SKIPPED';
      if (
        !skip &&
        selected.runtime.kind !== 'SHELL' &&
        !selected.runtime.environmentId
      )
        skip = 'CONFIGURATION_REQUIRED';
      if (
        !skip &&
        ((selected.runtime.kind === 'PYTHON' &&
          !selected.effectiveResourceVersions.python) ||
          (selected.runtime.kind === 'NODE' &&
            !selected.effectiveResourceVersions.node))
      )
        skip = 'RUNTIME_NOT_READY';
      const filters = JSON.parse(trigger.path_filters) as string[];
      if (!Array.isArray(filters) || filters.length > 200)
        fail('SYNC_POLICY_INVALID');
      filters.forEach(relativeGlob);
      if (
        !skip &&
        trigger.mode === 'SOURCE_CHANGE' &&
        !source.initial &&
        !changedPaths.includes(selected.source.relative_entrypoint)
      )
        skip = 'GIT_SOURCE_UNCHANGED';
      if (
        !skip &&
        trigger.mode === 'PATH_FILTER' &&
        !changedPaths.some((name) =>
          filters.some((pattern) => matchesGlob(pattern, name)),
        )
      )
        skip = 'GIT_PATH_UNMATCHED';
      plan.push({
        origin_trigger_id: trigger.id,
        trigger_version: trigger.version,
        task_id: selected.task.id,
        task_definition_version: selected.task.version,
        event_key: eventKey(trigger.id, source),
        skip_reason: skip,
        admission,
      });
    }
    if (Buffer.byteLength(JSON.stringify(plan)) > 16 * 1024 * 1024)
      fail('SYNC_POLICY_INVALID');
    return plan;
  }
  private plan(
    row: Pick<
      OutboxRow,
      | 'trigger_plan'
      | 'workspace_id'
      | 'source_generation'
      | 'content_revision'
      | 'inventory_hash'
      | 'after_commit'
    >,
  ): GitUpdatePlanItem[] {
    if (Buffer.byteLength(row.trigger_plan) > 16 * 1024 * 1024)
      fail('SYNC_RECOVERY_REQUIRED');
    let value: unknown;
    try {
      value = JSON.parse(row.trigger_plan);
    } catch {
      fail('SYNC_RECOVERY_REQUIRED');
    }
    if (!Array.isArray(value) || value.length > 10000)
      fail('SYNC_RECOVERY_REQUIRED');
    const plan = value as GitUpdatePlanItem[],
      seen = new Set<number>();
    for (const item of plan) {
      if (!item || typeof item !== 'object') fail('SYNC_RECOVERY_REQUIRED');
      if (
        Object.keys(item).length !== 7 ||
        Object.keys(item).some(
          (key) =>
            ![
              'origin_trigger_id',
              'trigger_version',
              'task_id',
              'task_definition_version',
              'event_key',
              'skip_reason',
              'admission',
            ].includes(key),
        )
      )
        fail('SYNC_RECOVERY_REQUIRED');
      validateGitUpdateSnapshot(item.admission);
      const a = item.admission;
      if (
        !item ||
        !a ||
        !Number.isSafeInteger(item.origin_trigger_id) ||
        item.origin_trigger_id < 1 ||
        seen.has(item.origin_trigger_id) ||
        !Number.isSafeInteger(item.task_id) ||
        item.task_id < 1 ||
        !Number.isSafeInteger(item.trigger_version) ||
        item.trigger_version < 1 ||
        item.task_definition_version !== a.expected_task_definition_version ||
        a.workspace_type !== 'GIT' ||
        a.workspace_id !== row.workspace_id ||
        a.expected_source_generation !== row.source_generation ||
        a.expected_content_revision !== row.content_revision ||
        a.expected_inventory_hash !== row.inventory_hash ||
        a.expected_git_commit !== row.after_commit ||
        item.event_key !==
          eventKey(item.origin_trigger_id, {
            workspaceId: row.workspace_id,
            sourceGeneration: row.source_generation,
            afterCommit: row.after_commit,
          }) ||
        (item.skip_reason !== null &&
          ![
            'TRIGGER_DISABLED',
            'TASK_DISABLED',
            'TASK_NOT_READY',
            'GIT_INITIAL_SYNC_SKIPPED',
            'CONFIGURATION_REQUIRED',
            'RUNTIME_NOT_READY',
            'GIT_SOURCE_UNCHANGED',
            'GIT_PATH_UNMATCHED',
          ].includes(item.skip_reason))
      )
        fail('SYNC_RECOVERY_REQUIRED');
      seen.add(item.origin_trigger_id);
    }
    return plan;
  }
  async commit(
    tx: WorkspaceStore,
    source: SuccessfulWorkspaceUpdate,
    plan: readonly GitUpdatePlanItem[],
  ) {
    this.source(source);
    if (tx !== this.store) fail('SYNC_RECOVERY_REQUIRED');
    return tx.transaction(async () => {
      const serialized = JSON.stringify(plan);
      this.plan({
        trigger_plan: serialized,
        workspace_id: source.workspaceId,
        source_generation: source.sourceGeneration,
        content_revision: source.contentRevision,
        inventory_hash: source.inventoryHash,
        after_commit: source.afterCommit,
      });
      const existing = (
        await tx.all<OutboxRow>(
          'SELECT * FROM WorkspaceUpdateOutbox WHERE id=?',
          [source.id],
        )
      )[0];
      if (existing) {
        if (
          existing.workspace_id !== source.workspaceId ||
          existing.source_generation !== source.sourceGeneration ||
          existing.content_revision !== source.contentRevision ||
          existing.after_commit !== source.afterCommit ||
          existing.before_commit !== source.beforeCommit ||
          existing.inventory_hash !== source.inventoryHash ||
          existing.initial !== Number(source.initial) ||
          existing.trigger_plan !== serialized
        )
          fail('SYNC_RECOVERY_REQUIRED');
        return existing;
      }
      await tx.run(
        `INSERT INTO WorkspaceUpdateOutbox(id,workspace_id,sync_run_id,source_generation,content_revision,initial,before_commit,after_commit,inventory_hash,trigger_plan,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          source.id,
          source.workspaceId,
          source.id,
          source.sourceGeneration,
          source.contentRevision,
          Number(source.initial),
          source.beforeCommit,
          source.afterCommit,
          source.inventoryHash,
          serialized,
          this.now().toISOString(),
          this.now().toISOString(),
        ],
      );
      const row = await this.get(source.id);
      for (const item of this.plan(row)) {
        const metadata = {
          frozen_admission: item.admission,
          trigger_version: item.trigger_version,
          initial: source.initial,
          origin_trigger_id: item.origin_trigger_id,
          workspace_update_id: source.id,
        };
        await tx.run(
          `INSERT INTO TriggerEvents(trigger_id,origin_trigger_id,task_id,workspace_id,workspace_update_id,event_key,trigger_type,status,error_code,metadata,received_at)
          VALUES(?,?,?,?,?,?,'GIT_UPDATE',?,?,?,?) ON CONFLICT(origin_trigger_id,event_key) DO NOTHING`,
          [
            item.origin_trigger_id,
            item.origin_trigger_id,
            item.task_id,
            source.workspaceId,
            source.id,
            item.event_key,
            item.skip_reason ? 'SKIPPED' : 'RECEIVED',
            item.skip_reason,
            JSON.stringify(metadata),
            this.now().toISOString(),
          ],
        );
      }
      return row;
    });
  }
  private async event(row: OutboxRow, item: GitUpdatePlanItem) {
    const event = (
      await this.store.all<EventRow>(
        'SELECT * FROM TriggerEvents WHERE origin_trigger_id=? AND event_key=? AND workspace_update_id=?',
        [item.origin_trigger_id, item.event_key, row.id],
      )
    )[0];
    if (!event) fail('SYNC_RECOVERY_REQUIRED');
    return event;
  }
  private async settle(event: EventRow, reason: string) {
    if (TERMINAL_EVENTS.has(event.status)) return;
    await this.store.run(
      "UPDATE TriggerEvents SET status='SKIPPED',error_code=?,owner_token=NULL,claimed_at=NULL,claim_expires_at=NULL,updatedAt=? WHERE id=? AND status IN ('RECEIVED','PROCESSING')",
      [reason, this.now().toISOString(), event.id],
    );
  }
  private async reclaim(row: OutboxRow) {
    if (row.status !== 'PROCESSING') return row;
    // This runs only while holding the actual EX owner FD. An unexpired SQL
    // timestamp alone never licenses taking work from a live dispatcher.
    await this.store.run(
      "UPDATE WorkspaceUpdateOutbox SET status='RETRY',owner_token=NULL,claimed_at=NULL,claim_expires_at=NULL,next_attempt_at=?,last_error_code='DISPATCH_INTERRUPTED' WHERE id=? AND status='PROCESSING' AND owner_token IS ?",
      [this.now().toISOString(), row.id, row.owner_token],
    );
    return this.get(row.id);
  }
  async dispatchOne(id: number) {
    return this.leases.barrier.mutation(async () => {
      let owner: RuntimeLease;
      try {
        owner = await RuntimeLease.acquire(this.paths, positiveId(id));
      } catch (error) {
        if (errorCode(error) === 'RUNTIME_BUSY') return this.get(id);
        throw error;
      }
      try {
        return await withInheritedLease(owner.handle.fd, async () => {
          let row = await this.reclaim(await this.get(id));
          if (
            !['PENDING', 'RETRY'].includes(row.status) ||
            row.next_attempt_at > this.now().toISOString()
          )
            return row;
          const token = randomUUID(),
            now = this.now().toISOString();
          const claimed = await this.store.run(
            "UPDATE WorkspaceUpdateOutbox SET status='PROCESSING',attempt_count=attempt_count+1,owner_token=?,claimed_at=?,claim_expires_at=? WHERE id=? AND status=? AND next_attempt_at<=?",
            [
              token,
              now,
              new Date(this.now().getTime() + this.claimMs).toISOString(),
              id,
              row.status,
              now,
            ],
          );
          if (claimed.changes !== 1) return this.get(id);
          row = await this.get(id);
          const deadline = performance.now() + this.dispatchTimeoutMs;
          try {
            await this.options.fault?.('BEFORE_OUTBOX_DISPATCH', {
              outbox_id: id,
            });
            for (const item of this.plan(row)) {
              if (performance.now() > deadline) fail('OUTBOX_DISPATCH_TIMEOUT');
              let event = await this.event(row, item);
              if (TERMINAL_EVENTS.has(event.status)) continue;
              const current = (
                await this.store.all<{
                  task_id: number;
                  workspace_id: number;
                  task_enabled: number;
                  enabled: number;
                  version: number;
                  lifecycle_state: string;
                  storage_state: string;
                }>(
                  `SELECT tr.task_id,tr.enabled,tr.version,t.workspace_id,t.enabled task_enabled,w.lifecycle_state,w.storage_state
                FROM TaskTriggers tr JOIN Tasks t ON t.id=tr.task_id JOIN Workspaces w ON w.id=t.workspace_id WHERE tr.id=?`,
                  [item.origin_trigger_id],
                )
              )[0];
              const reason = !event.task_id
                ? 'TASK_DELETED'
                : !event.trigger_id || !current
                ? 'TRIGGER_DELETED'
                : current.task_id !== item.task_id ||
                  current.workspace_id !== row.workspace_id
                ? 'TRIGGER_DELETED'
                : !current.enabled
                ? 'TRIGGER_DISABLED'
                : current.version !== item.trigger_version
                ? 'TRIGGER_VERSION_CONFLICT'
                : !current.task_enabled
                ? 'TASK_DISABLED'
                : current.lifecycle_state !== 'READY' ||
                  current.storage_state !== 'PRESENT'
                ? 'WORKSPACE_NOT_READY'
                : null;
              if (reason) {
                await this.settle(event, reason);
                continue;
              }
              await this.store.run(
                "UPDATE TriggerEvents SET status='PROCESSING',owner_token=?,claimed_at=?,claim_expires_at=?,attempt_count=attempt_count+1,updatedAt=? WHERE id=? AND status IN ('RECEIVED','PROCESSING') AND owner_token IS ?",
                [
                  token,
                  now,
                  new Date(this.now().getTime() + this.claimMs).toISOString(),
                  now,
                  event.id,
                  event.owner_token,
                ],
              );
              event = await this.event(row, item);
              if (event.owner_token !== token) fail('SYNC_RECOVERY_REQUIRED');
              const run = await this.execution.submit(item.task_id, {
                triggerType: 'GIT_UPDATE',
                eventId: event.id,
              });
              await this.options.fault?.('AFTER_TASK_RUN_INSERT', {
                outbox_id: id,
                event_id: event.id,
                task_run_id: run.id,
              });
            }
            if (performance.now() > deadline) fail('OUTBOX_DISPATCH_TIMEOUT');
            await this.options.fault?.('BEFORE_OUTBOX_ACK', { outbox_id: id });
            await this.store.transaction(async (tx) => {
              for (const item of this.plan(row))
                if (!TERMINAL_EVENTS.has((await this.event(row, item)).status))
                  fail('SYNC_RECOVERY_REQUIRED');
              const ack = await tx.run(
                "UPDATE WorkspaceUpdateOutbox SET status='DISPATCHED',owner_token=NULL,claimed_at=NULL,claim_expires_at=NULL,dispatched_at=? WHERE id=? AND status='PROCESSING' AND owner_token=?",
                [this.now().toISOString(), id, token],
              );
              if (ack.changes !== 1) fail('SYNC_RECOVERY_REQUIRED');
              await tx.run(
                "UPDATE WorkspaceSyncRuns SET event_status='DISPATCHED' WHERE id=? AND status='SUCCESS'",
                [id],
              );
            });
          } catch (error) {
            const dead = row.attempt_count >= this.maxAttempts;
            const delay = Math.min(
              5000,
              250 * 2 ** Math.min(row.attempt_count - 1, 5),
            );
            await this.store.transaction(async (tx) => {
              const failed = await tx.run(
                "UPDATE WorkspaceUpdateOutbox SET status=?,owner_token=NULL,claimed_at=NULL,claim_expires_at=NULL,next_attempt_at=?,last_error_code=? WHERE id=? AND status='PROCESSING' AND owner_token=?",
                [
                  dead ? 'DEAD' : 'RETRY',
                  new Date(this.now().getTime() + delay).toISOString(),
                  errorCode(error),
                  id,
                  token,
                ],
              );
              if (failed.changes && dead) {
                // A DEAD outbox is settled history, not a live Event owner that
                // permanently prevents backup. Respect the frozen inbox edges.
                await tx.run(
                  "UPDATE TriggerEvents SET status='PROCESSING',owner_token=?,claimed_at=?,claim_expires_at=? WHERE workspace_update_id=? AND status='RECEIVED'",
                  [
                    token,
                    now,
                    new Date(this.now().getTime() + this.claimMs).toISOString(),
                    id,
                  ],
                );
                await tx.run(
                  "UPDATE TriggerEvents SET status='FAILED',error_code='DISPATCH_EXHAUSTED',owner_token=NULL,claimed_at=NULL,claim_expires_at=NULL,updatedAt=? WHERE workspace_update_id=? AND status='PROCESSING'",
                  [this.now().toISOString(), id],
                );
                await tx.run(
                  "UPDATE WorkspaceSyncRuns SET event_status='BLOCKED' WHERE id=? AND status='SUCCESS'",
                  [id],
                );
              }
            });
          }
          return this.get(id);
        });
      } finally {
        await owner.release();
      }
    }, true);
  }
  async tick(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      fail('SYNC_POLICY_INVALID');
    const due = await this.store.all<{ id: number }>(
      "SELECT id FROM WorkspaceUpdateOutbox WHERE status='PROCESSING' OR (status IN ('PENDING','RETRY') AND next_attempt_at<=?) ORDER BY id LIMIT ?",
      [this.now().toISOString(), limit],
    );
    for (const row of due) await this.dispatchOne(row.id);
  }
  async recover(limit = 100) {
    return this.tick(limit);
  }
  async retryDead(id: number): Promise<never> {
    await this.get(id);
    // Frozen SQL does not contain the DEAD -> RETRY edge described in prose.
    // It remains authoritative; no duplicate update/event identity is created.
    return fail('SYNC_RECOVERY_REQUIRED');
  }
  async cancel(id: number) {
    return this.leases.barrier.mutation(async () => {
      const owner = await RuntimeLease.acquire(this.paths, positiveId(id));
      try {
        const row = await this.get(id);
        if (row.status === 'DEAD') fail('SYNC_RECOVERY_REQUIRED');
        if (['CANCELLED', 'DISPATCHED'].includes(row.status)) return row;
        await this.store.transaction(async (tx) => {
          for (const item of this.plan(row))
            await this.settle(await this.event(row, item), 'OUTBOX_CANCELLED');
          await tx.run(
            "UPDATE WorkspaceUpdateOutbox SET status='CANCELLED',owner_token=NULL,claimed_at=NULL,claim_expires_at=NULL,last_error_code='OUTBOX_CANCELLED' WHERE id=? AND status=?",
            [id, row.status],
          );
          await tx.run(
            "UPDATE WorkspaceSyncRuns SET event_status='BLOCKED' WHERE id=? AND status='SUCCESS'",
            [id],
          );
        });
        return this.get(id);
      } finally {
        await owner.release();
      }
    }, true);
  }
}
