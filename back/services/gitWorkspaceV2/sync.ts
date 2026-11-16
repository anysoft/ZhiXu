import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import RuntimePathResolver from '../runtimePaths';
import { RuntimeLease } from '../runtimeProcess';
import { withInheritedLease } from '../backup/inheritedLeases';
import { privateJson, readJson, syncDirectory } from '../backup/files';
import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { assertWorkspaceJournalIsolation } from '../workspaceV2/journals';
import { WorkspaceLease, WorkspaceLeaseService } from '../workspaceV2/lease';
import { fail, errorCode, positiveId } from '../workspaceV2/errors';
import type { FaultHook, GitWorkspaceRow } from '../workspaceV2/types';
import { WorkspaceGitAdapter, WorkspaceGitPlan } from './git';
import { GitWorkspaceDiscovery } from './discovery';
import { WorkspaceGitUpdateOutbox } from './outbox';
import { WorkspaceSyncPolicies } from './policy';
import { nextContentRevision, SYNC_TERMINAL } from './types';
import type {
  SyncAdmission,
  SyncJournal,
  SyncRunRow,
  SyncSubmitOptions,
} from './types';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
class SyncOwnerPaths extends RuntimePathResolver {
  async lock(id: number) {
    const directory = await new WorkspaceRootResolver(this.dataRoot).directory(
      '.locks',
      true,
    );
    return path.join(directory, `workspace-sync-${positiveId(id)}.lock`);
  }
}

/** Isolated fresh-v2 SyncRuns are the queue. The local map only owns cancellation handles. */
export class GitWorkspaceSyncService {
  readonly policies: WorkspaceSyncPolicies;
  private active = new Map<
    number,
    { abort: AbortController; done: Promise<void> }
  >();
  private ticking = false;
  private attemptCursor = 0;
  private attemptRoundEnd = 0;
  private closed = false;
  private timer?: NodeJS.Timeout;
  readonly timeoutMs: number;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
    readonly git: WorkspaceGitAdapter,
    readonly discovery: GitWorkspaceDiscovery,
    readonly outbox: WorkspaceGitUpdateOutbox,
    readonly options: {
      fault?: FaultHook;
      timeoutMs?: number;
      maxActive?: number;
      clock?: { now(): Date };
    } = {},
  ) {
    if (
      [
        roots.dataRoot,
        leases.dataRoot,
        git.store.dataRoot,
        discovery.store.dataRoot,
        outbox.store.dataRoot,
      ].some((r) => r !== store.dataRoot)
    )
      fail('WORKSPACE_PATH_INVALID');
    this.timeoutMs = options.timeoutMs ?? 900000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 900000 ||
      !Number.isSafeInteger(options.maxActive ?? 4) ||
      (options.maxActive ?? 4) < 1 ||
      (options.maxActive ?? 4) > 16
    )
      fail('SYNC_POLICY_INVALID');
    this.policies = new WorkspaceSyncPolicies(
      store,
      roots,
      leases,
      options.clock,
    );
  }
  private now() {
    return (this.options.clock?.now() ?? new Date()).toISOString();
  }
  async get(id: number) {
    const row = (
      await this.store.all<SyncRunRow>(
        'SELECT * FROM WorkspaceSyncRuns WHERE id=?',
        [positiveId(id)],
      )
    )[0];
    if (!row) fail('SYNC_RUN_NOT_FOUND', 404);
    return row;
  }
  private async source(id: number) {
    const row = (
      await this.store.all<GitWorkspaceRow>(
        'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
        [id],
      )
    )[0];
    if (!row) fail('WORKSPACE_TYPE_INVALID');
    return row;
  }
  async submit(id: number, options: SyncSubmitOptions = {}) {
    positiveId(id);
    const key = options.requestKey ?? randomUUID(),
      trigger = options.triggerSource ?? 'MANUAL';
    if (
      !/^[A-Za-z0-9:_-]{1,200}$/.test(key) ||
      !['MANUAL', 'CRON', 'INTERVAL'].includes(trigger) ||
      (trigger !== 'MANUAL' && !options.scheduleSlot)
    )
      fail('SYNC_REQUEST_INVALID', 400);
    const requestHash = digest(
      JSON.stringify({
        trigger,
        expectedVersion: options.expectedVersion ?? null,
        expectedPolicyVersion: options.expectedPolicyVersion ?? null,
        slot: options.scheduleSlot ?? null,
        retryOf: options.retryOf ?? null,
        retryAttempt: options.retryAttempt ?? 0,
        admission: options.admission ?? null,
      }),
    );
    return this.leases.barrier.mutation(() =>
      this.store.transaction(async (tx) => {
        const previous = (
          await tx.all<SyncRunRow>(
            'SELECT * FROM WorkspaceSyncRuns WHERE workspace_id=? AND request_key=?',
            [id, key],
          )
        )[0];
        if (previous) {
          if (previous.request_hash !== requestHash)
            fail('IDEMPOTENCY_KEY_CONFLICT');
          return previous;
        }
        const ws = await tx.assertAccessible(id, true),
          git = await this.source(id),
          policy = await this.policies.ensure(tx, id);
        if (
          options.expectedVersion !== undefined &&
          ws.version !== options.expectedVersion
        )
          fail('WORKSPACE_VERSION_CONFLICT');
        if (
          options.expectedPolicyVersion !== undefined &&
          policy.version !== options.expectedPolicyVersion
        )
          fail('SYNC_POLICY_VERSION_CONFLICT');
        if (
          !policy.enabled ||
          (trigger !== 'MANUAL' &&
            (policy.update_mode !== 'SCHEDULED' || git.ref_type !== 'branch'))
        )
          fail('SYNC_POLICY_DISABLED');
        if (
          (
            await tx.all(
              "SELECT id FROM WorkspaceSyncRuns WHERE workspace_id=? AND status IN ('QUEUED','RUNNING','RECOVERY_REQUIRED')",
              [id],
            )
          ).length
        )
          fail('SYNC_ALREADY_RUNNING');
        if (
          ((
            await tx.all(
              "SELECT COUNT(*) n FROM WorkspaceSyncRuns WHERE status='QUEUED'",
            )
          )[0].n as number) >= 1024
        )
          fail('SYNC_QUEUE_FULL');
        const discovery = await this.discovery.policy(id);
        const admission: SyncAdmission = options.admission ?? {
          workspace_id: id,
          workspace_version: ws.version,
          source_generation: ws.source_generation,
          content_revision: ws.content_revision,
          inventory_hash: ws.content_inventory_hash!,
          policy_version: policy.version,
          discovery_policy_version: discovery.version,
          git: {
            repository_id: git.repository_id,
            ref_type: git.ref_type,
            ref_name: git.ref_name,
            resolved_commit: git.resolved_commit,
            applied_commit: git.applied_commit,
            last_verified_commit: git.last_verified_commit,
            baseline_established: git.baseline_established,
          },
          deadline_at: new Date(
            Date.parse(this.now()) + this.timeoutMs,
          ).toISOString(),
          timeout_ms: this.timeoutMs,
          retry_attempt: options.retryAttempt ?? 0,
          retry_of: options.retryOf ?? null,
        };
        if (
          admission.workspace_id !== id ||
          admission.source_generation !== ws.source_generation ||
          admission.policy_version !== policy.version
        )
          fail('SOURCE_SUPERSEDED');
        const result = await tx.run(
          `INSERT INTO WorkspaceSyncRuns(workspace_id,policy_version,source_generation,request_key,request_hash,trigger_source,schedule_slot,initial,source_snapshot,submitted_at,log_identity) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            policy.version,
            ws.source_generation,
            key,
            requestHash,
            trigger,
            options.scheduleSlot ?? null,
            git.baseline_established ? 0 : 1,
            JSON.stringify(admission),
            this.now(),
            randomUUID(),
          ],
        );
        return this.get(result.lastID);
      }),
    );
  }
  private async check(row: SyncRunRow, recovery = false) {
    const a = JSON.parse(row.source_snapshot) as SyncAdmission,
      ws = await this.store.workspace(row.workspace_id),
      g = await this.source(ws.id),
      policy = await this.policies.get(ws.id),
      d = await this.discovery.policy(ws.id);
    if (
      ws.version !== a.workspace_version ||
      ws.source_generation !== a.source_generation ||
      ws.content_revision !== a.content_revision ||
      ws.content_inventory_hash !== a.inventory_hash ||
      g.repository_id !== a.git.repository_id ||
      g.ref_type !== a.git.ref_type ||
      g.ref_name !== a.git.ref_name ||
      g.resolved_commit !== a.git.resolved_commit
    )
      fail('SOURCE_SUPERSEDED');
    if (policy.version !== a.policy_version || !policy.enabled)
      fail('SYNC_POLICY_CHANGED');
    if (d.version !== a.discovery_policy_version)
      fail('DISCOVERY_PREVIEW_STALE');
    if (
      (
        await this.store.all(
          "SELECT id FROM WorkspaceOperations WHERE workspace_id=? AND status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED') LIMIT 1",
          [row.workspace_id],
        )
      ).length
    )
      fail('WORKSPACE_BUSY');
    if (
      (!recovery && ws.lifecycle_state !== 'READY') ||
      (recovery && !['READY', 'RECOVERY_REQUIRED'].includes(ws.lifecycle_state))
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    // A completed physical checkout must still be reconciled after cancellation.
    if (!recovery && (await this.get(row.id)).cancel_requested)
      fail('SYNC_CANCELLED');
    if (!recovery && a.deadline_at <= this.now()) fail('SYNC_TIMEOUT');
    return { a, ws, g, policy };
  }
  private async point(name: string, row: SyncRunRow) {
    await this.options.fault?.(name, {
      sync_run_id: row.id,
      workspace_id: row.workspace_id,
    });
  }
  private async journalPath(id: number) {
    return path.join(
      await this.roots.directory('tmp/workspace-v2/sync', true),
      `sync-${positiveId(id)}.json`,
    );
  }
  private async journal(
    row: SyncRunRow,
    plan: WorkspaceGitPlan,
    token: string,
  ): Promise<SyncJournal> {
    return {
      version: 1,
      run_id: row.id,
      workspace_id: row.workspace_id,
      repository_id: plan.repositoryId,
      owner_token: token,
      source_snapshot_sha256: digest(row.source_snapshot),
      policy_version: row.policy_version,
      source_generation: row.source_generation,
      phase: 'APPLYING',
      before_commit: plan.before,
      target_commit: plan.target,
      actual_commit: null,
      root_identity: {
        dev: plan.proof.rootDevice,
        ino: plan.proof.rootInode,
        owner_token: plan.proof.rootOwnerToken,
      },
      git_identity: {
        admin_key: plan.proof.adminKey,
        admin_device: plan.proof.adminDevice,
        admin_inode: plan.proof.adminInode,
        configuration_sha256: plan.proof.configurationSha256,
      },
      before_inventory_hash: plan.proof.inventoryHash,
      before_index_sha256: plan.proof.indexSha256,
      created_at: this.now(),
    };
  }
  private async removeJournal(id: number) {
    const file = await this.journalPath(id);
    await fs.unlink(file).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await syncDirectory(path.dirname(file));
  }
  private async finish(
    row: SyncRunRow,
    plan: WorkspaceGitPlan,
    lease: WorkspaceLease,
    token: string,
    journal: SyncJournal,
  ) {
    await this.check(row, true);
    const actual = await this.git.inspect(row.workspace_id, lease);
    if (
      actual.head !== plan.target ||
      actual.proof.rootDevice !== journal.root_identity.dev ||
      actual.proof.rootInode !== journal.root_identity.ino ||
      actual.proof.rootOwnerToken !== journal.root_identity.owner_token ||
      actual.proof.adminKey !== journal.git_identity?.admin_key ||
      actual.proof.adminDevice !== journal.git_identity?.admin_device ||
      actual.proof.adminInode !== journal.git_identity?.admin_inode ||
      actual.proof.configurationSha256 !==
        journal.git_identity?.configuration_sha256
    )
      fail('SYNC_RECOVERY_REQUIRED');
    journal.phase = 'APPLIED_PENDING_RECONCILIATION';
    journal.actual_commit = actual.head;
    await privateJson(await this.journalPath(row.id), journal);
    await this.store.run(
      "UPDATE WorkspaceSyncRuns SET phase='BEFORE_DISCOVERY',actual_commit=?,git_update_status=?,discovery_status='RUNNING' WHERE id=? AND owner_token=? AND status='RUNNING'",
      [
        actual.head,
        plan.before === plan.target ? 'UNCHANGED' : 'APPLIED',
        row.id,
        token,
      ],
    );
    await this.point('BEFORE_DISCOVERY', row);
    const current = await this.store.workspace(row.workspace_id);
    const publication = {
      source_generation: current.source_generation,
      content_revision: nextContentRevision(current, actual.inventory.hash),
      inventory_hash: actual.inventory.hash,
      after_commit: actual.head,
    };
    const discovery = await this.discovery.prepareUnderLease(
      row.workspace_id,
      lease,
      {
        syncRunId: row.id,
        publication,
        duringDiscovery: () => this.point('DURING_DISCOVERY', row),
      },
    );
    await this.point('AFTER_DISCOVERY', row);
    if (
      discovery.inventory.hash !== actual.inventory.hash ||
      discovery.commit !== actual.head
    )
      fail('SOURCE_SUPERSEDED');
    if (discovery.diagnostics.some((d) => d.blocking))
      fail('DISCOVERY_RECONCILIATION_FAILED');
    await this.check(row, true);
    await lease.assertHeld();
    await this.point('BEFORE_DB_SUCCESS_COMMIT', row);
    await this.store.transaction(async (tx) => {
      await this.check(row, true);
      const owned = await this.get(row.id);
      if (owned.owner_token !== token || owned.status !== 'RUNNING')
        fail('SYNC_RECOVERY_REQUIRED');
      // READY is private to this SQL transaction until every publication succeeds.
      await tx.run(
        "UPDATE Workspaces SET lifecycle_state='READY',last_error_code=NULL WHERE id=? AND lifecycle_state='RECOVERY_REQUIRED'",
        [row.workspace_id],
      );
      await this.discovery.applyPlanInTransaction(tx, discovery);
      const published = await tx.updateInventory(
        row.workspace_id,
        current.content_revision,
        actual.inventory,
      );
      await tx.run(
        "UPDATE GitWorkspaces SET applied_commit=?,last_verified_commit=?,dirty_state='CLEAN',last_update_at=?,last_error_code=NULL WHERE workspace_id=?",
        [actual.head, actual.head, this.now(), row.workspace_id],
      );
      const source = {
        id: row.id,
        workspaceId: row.workspace_id,
        workspaceVersion: published.version,
        sourceGeneration: published.source_generation,
        contentRevision: published.content_revision,
        initial: !!row.initial,
        beforeCommit: plan.before,
        afterCommit: actual.head,
        inventoryHash: actual.inventory.hash,
      };
      const triggers = await this.outbox.preparePlan(
        tx,
        source,
        row.initial
          ? actual.inventory.entries
              .filter((entry) => entry.kind === 'file')
              .map((entry) => entry.path)
          : plan.changedPaths,
      );
      await tx.run(
        "UPDATE WorkspaceSyncRuns SET status='SUCCESS',phase='COMMITTED',actual_commit=?,after_commit=?,git_update_status=?,discovery_status=?,update_outbox_id=id,event_status='PENDING',content_revision=?,finished_at=?,error_code=NULL WHERE id=? AND owner_token=?",
        [
          actual.head,
          actual.head,
          plan.before === plan.target ? 'UNCHANGED' : 'APPLIED',
          discovery.policy.enabled ? 'SUCCESS' : 'NOT_REQUESTED',
          published.content_revision,
          this.now(),
          row.id,
          token,
        ],
      );
      await this.outbox.commit(tx, source, triggers);
      if (row.initial)
        await tx.run(
          'UPDATE GitWorkspaces SET baseline_established=1,baseline_sync_run_id=? WHERE workspace_id=? AND baseline_established=0',
          [row.id, row.workspace_id],
        );
    });
    await this.point('AFTER_DB_COMMIT', row);
    await this.removeJournal(row.id);
  }
  private async execute(id: number, abort: AbortController) {
    let owner: RuntimeLease | undefined,
      claimed = false,
      intent = false;
    let timer: NodeJS.Timeout | undefined;
    const token = randomUUID();
    try {
      owner = await RuntimeLease.acquire(
        new SyncOwnerPaths(this.store.dataRoot),
        id,
      );
      await withInheritedLease(owner.handle.fd, () =>
        this.leases.barrier.mutation(async () => {
          let row = await this.get(id);
          if (row.status !== 'QUEUED') return;
          // Absolute queue expiry cannot depend on obtaining a busy Repository FD.
          await this.check(row);
          const admitted = JSON.parse(row.source_snapshot) as SyncAdmission;
          const remaining = Math.max(
            1,
            Date.parse(admitted.deadline_at) - Date.parse(this.now()),
          );
          timer = setTimeout(() => abort.abort(), remaining);
          timer.unref();
          // Claim only after the repository FD is acquired; a busy fetch remains QUEUED.
          await this.leases.withRepository(
            admitted.git.repository_id,
            'SYNC_FETCH',
            async (repoLease) => {
              claimed = await this.store.transaction(async (tx) => {
                const r = await this.get(id);
                if (r.status !== 'QUEUED') return false;
                const capacity = (
                  await tx.all<{ n: number }>(
                    "SELECT COUNT(*) n FROM WorkspaceSyncRuns WHERE status='RUNNING'",
                  )
                )[0].n;
                if (capacity >= (this.options.maxActive ?? 4)) return false;
                await this.check(r);
                await tx.run(
                  "UPDATE WorkspaceSyncRuns SET status='RUNNING',owner_token=?,started_at=?,phase='BEFORE_FETCH',git_update_status='FETCHING' WHERE id=? AND status='QUEUED'",
                  [token, this.now(), id],
                );
                return true;
              });
              if (!claimed) return;
              row = await this.get(id);
              await this.point('BEFORE_FETCH', row);
              await this.git.fetch(admitted.git.repository_id, repoLease, {
                workspaceId: row.workspace_id,
                signal: abort.signal,
                timeoutMs: Math.min(remaining, 1800000),
              });
              await this.point('AFTER_FETCH', row);
            },
          );
          if (!claimed) return;
          // No SQL transaction waits on either OS lock. All mutation paths use Repository -> Workspace.
          await this.leases.withRepository(
            admitted.git.repository_id,
            'SYNC_APPLY',
            (repoLease) =>
              this.leases.withWorkspace(
                row.workspace_id,
                'SYNC_APPLY',
                async (wsLease) => {
                  await this.check(row);
                  if (abort.signal.aborted) fail('SYNC_TIMEOUT');
                  await assertWorkspaceJournalIsolation(
                    this.store,
                    this.roots,
                    row.workspace_id,
                  );
                  const plan = await this.git.plan(
                    row.workspace_id,
                    repoLease,
                    wsLease,
                  );
                  await this.store.run(
                    'UPDATE WorkspaceSyncRuns SET before_commit=?,target_commit=?,actual_commit=?,phase=? WHERE id=? AND owner_token=?',
                    [
                      plan.before,
                      plan.target,
                      plan.before,
                      'PLANNED',
                      id,
                      token,
                    ],
                  );
                  if (plan.diagnostic) fail(plan.diagnostic);
                  if (!row.initial && plan.before === plan.target) {
                    await this.store.run(
                      "UPDATE WorkspaceSyncRuns SET status='NO_CHANGE',phase='NO_CHANGE',actual_commit=?,after_commit=?,git_update_status='UNCHANGED',finished_at=? WHERE id=? AND owner_token=?",
                      [plan.before, plan.before, this.now(), id, token],
                    );
                    return;
                  }
                  await this.point('BEFORE_FF_APPLY', row);
                  const journal = await this.journal(row, plan, token);
                  await this.store.transaction(async (tx) => {
                    await this.check(row);
                    await tx.run(
                      "UPDATE Workspaces SET lifecycle_state='RECOVERY_REQUIRED',last_error_code='SYNC_RECOVERY_REQUIRED' WHERE id=? AND lifecycle_state='READY'",
                      [row.workspace_id],
                    );
                    await tx.run(
                      "UPDATE WorkspaceSyncRuns SET phase='BEFORE_APPLY',git_update_status='APPLYING' WHERE id=? AND owner_token=?",
                      [id, token],
                    );
                  });
                  intent = true;
                  await privateJson(await this.journalPath(id), journal);
                  await this.git.apply(plan, repoLease, wsLease, {
                    signal: abort.signal,
                    timeoutMs: Math.max(
                      1,
                      Date.parse(admitted.deadline_at) - Date.parse(this.now()),
                    ),
                    duringCheckout: () => this.point('DURING_CHECKOUT', row),
                    afterHEAD: () =>
                      this.point('AFTER_PHYSICAL_HEAD_CHANGED', row),
                  });
                  if (abort.signal.aborted) fail('SYNC_TIMEOUT');
                  await this.finish(row, plan, wsLease, token, journal);
                },
              ),
          );
        }),
      );
    } catch (error) {
      const code = errorCode(error),
        row = await this.get(id);
      if (SYNC_TERMINAL.has(row.status)) return;
      if (
        !claimed &&
        [
          'RUNTIME_BUSY',
          'WORKSPACE_BUSY',
          'PLATFORM_BACKUP_IN_PROGRESS',
          'BACKUP_BUSY',
        ].includes(code)
      )
        return;
      if (intent || row.git_update_status === 'APPLIED') {
        await this.store.transaction(async (tx) => {
          await tx.run(
            "UPDATE Workspaces SET lifecycle_state='RECOVERY_REQUIRED',last_error_code='SYNC_RECOVERY_REQUIRED' WHERE id=? AND lifecycle_state='READY'",
            [row.workspace_id],
          );
          await tx.run(
            "UPDATE WorkspaceSyncRuns SET status='RECOVERY_REQUIRED',phase='RECONCILIATION_REQUIRED',error_code=? WHERE id=? AND status='RUNNING'",
            [code, id],
          );
        });
      } else {
        const cancelled = row.cancel_requested || code === 'SYNC_CANCELLED',
          expired =
            abort.signal.aborted ||
            code === 'SYNC_TIMEOUT' ||
            code === 'GIT_TIMEOUT';
        const status = cancelled
          ? 'CANCELLED'
          : expired
          ? row.status === 'QUEUED'
            ? 'BLOCKED'
            : 'FAILED'
          : [
              'DIRTY_WORKTREE',
              'STAGED_CHANGES',
              'UNTRACKED_COLLISION',
              'LOCAL_ONLY_COMMITS',
              'DIVERGED_BRANCH',
              'DIVERGED',
              'GIT_CONFLICT',
              'SOURCE_SUPERSEDED',
              'WORKSPACE_BUSY',
              'SYNC_POLICY_CHANGED',
              'DISCOVERY_PREVIEW_STALE',
            ].includes(code)
          ? 'BLOCKED'
          : row.status === 'QUEUED'
          ? 'BLOCKED'
          : 'FAILED';
        await this.store.run(
          "UPDATE WorkspaceSyncRuns SET status=?,phase=?,error_code=?,git_update_status=CASE WHEN git_update_status='NOT_STARTED' THEN git_update_status ELSE 'FAILED' END,finished_at=? WHERE id=? AND status IN ('QUEUED','RUNNING')",
          [
            status,
            status,
            expired ? 'SYNC_TIMEOUT' : cancelled ? 'SYNC_CANCELLED' : code,
            this.now(),
            id,
          ],
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
      await owner?.release();
    }
  }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      for (const [id, entry] of this.active)
        if ((await this.get(id)).cancel_requested) entry.abort.abort();
      await this.recover();
      const rows = await this.store.all<SyncRunRow>(
        "SELECT * FROM WorkspaceSyncRuns WHERE status='QUEUED' ORDER BY id LIMIT 1024",
      );
      // Rotate bounded attempt rounds. A busy Repository consumes an attempt,
      // not every later scheduling turn. New arrivals wait until the current
      // finite round ends, so they cannot starve an older queued resource.
      let candidates = rows.filter(
        (row) => row.id > this.attemptCursor && row.id <= this.attemptRoundEnd,
      );
      if (!candidates.length) {
        this.attemptCursor = 0;
        this.attemptRoundEnd = rows.length ? rows[rows.length - 1].id : 0;
        candidates = rows;
      }
      for (const row of candidates) {
        if (this.active.size >= (this.options.maxActive ?? 4)) break;
        if (this.active.has(row.id)) continue;
        this.attemptCursor = row.id;
        const entry = { abort: new AbortController(), done: Promise.resolve() };
        this.active.set(row.id, entry);
        entry.done = this.execute(row.id, entry.abort).finally(() =>
          this.active.delete(row.id),
        );
      }
    } finally {
      this.ticking = false;
    }
  }
  async wait(id: number, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await this.get(id);
      if (SYNC_TERMINAL.has(row.status) || row.status === 'RECOVERY_REQUIRED') {
        await this.active.get(id)?.done;
        return this.get(id);
      }
      if (Date.now() > deadline) fail('SYNC_WAIT_TIMEOUT');
      await this.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  async cancel(id: number) {
    await this.leases.barrier.mutation(async () => {
      const row = await this.get(id);
      if (row.status === 'RECOVERY_REQUIRED') fail('SYNC_RECOVERY_REQUIRED');
      if (SYNC_TERMINAL.has(row.status)) return;
      await this.store.run(
        "UPDATE WorkspaceSyncRuns SET cancel_requested=1,status=CASE WHEN status='QUEUED' THEN 'CANCELLED' ELSE status END,finished_at=CASE WHEN status='QUEUED' THEN ? ELSE finished_at END,error_code=CASE WHEN status='QUEUED' THEN 'SYNC_CANCELLED' ELSE error_code END WHERE id=?",
        [this.now(), id],
      );
      this.active.get(id)?.abort.abort();
    }, true);
    return this.get(id);
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
    while (this.ticking) await new Promise((r) => setTimeout(r, 5));
    for (const v of this.active.values()) v.abort.abort();
    await Promise.all([...this.active.values()].map((v) => v.done));
  }
  async recover() {
    const rows = await this.store.all<SyncRunRow>(
      "SELECT * FROM WorkspaceSyncRuns WHERE status IN ('RUNNING','RECOVERY_REQUIRED') ORDER BY id LIMIT 1024",
    );
    for (const original of rows) {
      if (this.active.has(original.id)) continue;
      let owner: RuntimeLease | undefined;
      try {
        owner = await RuntimeLease.acquire(
          new SyncOwnerPaths(this.store.dataRoot),
          original.id,
        );
        await withInheritedLease(owner.handle.fd, () =>
          this.leases.barrier.mutation(async () => {
            const row = await this.get(original.id);
            if (
              !['RUNNING', 'RECOVERY_REQUIRED'].includes(row.status) ||
              row.owner_token !== original.owner_token
            )
              return;
            const a = JSON.parse(row.source_snapshot) as SyncAdmission;
            await this.leases.withRepository(
              a.git.repository_id,
              'SYNC_RECOVERY',
              (repo) =>
                this.leases.withWorkspace(
                  row.workspace_id,
                  'SYNC_RECOVERY',
                  async (lease) => {
                    let journal: SyncJournal | null = null;
                    try {
                      journal = (await readJson(
                        await this.journalPath(row.id),
                        65536,
                      )) as SyncJournal;
                    } catch (e) {
                      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                        fail('SYNC_RECOVERY_REQUIRED');
                    }
                    if (!journal) {
                      if (
                        !['BEFORE_FETCH', 'PLANNED', 'BEFORE_APPLY'].includes(
                          row.phase,
                        )
                      )
                        fail('SYNC_RECOVERY_REQUIRED');
                      if (row.phase === 'BEFORE_APPLY') {
                        const proof = await this.git.inspect(
                          row.workspace_id,
                          lease,
                        );
                        if (
                          proof.head !== row.before_commit ||
                          proof.inventory.hash !== a.inventory_hash
                        )
                          fail('SYNC_RECOVERY_REQUIRED');
                        const unchanged = await this.git.plan(
                          row.workspace_id,
                          repo,
                          lease,
                          { targetCommit: row.target_commit! },
                        );
                        if (
                          unchanged.diagnostic ||
                          unchanged.before !== row.before_commit
                        )
                          fail('SYNC_RECOVERY_REQUIRED');
                      }
                      await this.store.transaction(async (tx) => {
                        if (row.status === 'RECOVERY_REQUIRED')
                          await tx.run(
                            "UPDATE WorkspaceSyncRuns SET status='RUNNING',owner_token=? WHERE id=?",
                            [randomUUID(), row.id],
                          );
                        await tx.run(
                          "UPDATE WorkspaceSyncRuns SET status='INTERRUPTED',phase='RECOVERED_UNAPPLIED',git_update_status='FAILED',error_code='SYNC_INTERRUPTED',finished_at=? WHERE id=?",
                          [this.now(), row.id],
                        );
                        if (row.phase === 'BEFORE_APPLY')
                          await tx.run(
                            "UPDATE Workspaces SET lifecycle_state='READY',last_error_code=NULL WHERE id=? AND lifecycle_state='RECOVERY_REQUIRED'",
                            [row.workspace_id],
                          );
                      });
                      return;
                    }
                    if (
                      journal.version !== 1 ||
                      journal.run_id !== row.id ||
                      journal.workspace_id !== row.workspace_id ||
                      journal.repository_id !== a.git.repository_id ||
                      !/^[a-f0-9-]{36}$/.test(journal.owner_token) ||
                      journal.source_snapshot_sha256 !==
                        digest(row.source_snapshot) ||
                      journal.source_generation !== row.source_generation ||
                      journal.policy_version !== row.policy_version ||
                      journal.before_commit !== row.before_commit ||
                      journal.target_commit !== row.target_commit
                    )
                      fail('SYNC_RECOVERY_REQUIRED');
                    const actual = await this.git.inspect(
                      row.workspace_id,
                      lease,
                    );
                    if (
                      actual.proof.rootDevice !== journal.root_identity.dev ||
                      actual.proof.rootInode !== journal.root_identity.ino ||
                      actual.proof.rootOwnerToken !==
                        journal.root_identity.owner_token ||
                      actual.proof.adminKey !==
                        journal.git_identity?.admin_key ||
                      actual.proof.adminDevice !==
                        journal.git_identity?.admin_device ||
                      actual.proof.adminInode !==
                        journal.git_identity?.admin_inode ||
                      actual.proof.configurationSha256 !==
                        journal.git_identity?.configuration_sha256
                    )
                      fail('SYNC_RECOVERY_REQUIRED');
                    if (
                      actual.head === journal.before_commit &&
                      journal.before_commit !== journal.target_commit &&
                      actual.inventory.hash === journal.before_inventory_hash &&
                      actual.indexSha === journal.before_index_sha256
                    ) {
                      await this.store.transaction(async (tx) => {
                        if (row.status === 'RECOVERY_REQUIRED')
                          await tx.run(
                            "UPDATE WorkspaceSyncRuns SET status='RUNNING' WHERE id=?",
                            [row.id],
                          );
                        await tx.run(
                          "UPDATE WorkspaceSyncRuns SET status='INTERRUPTED',phase='RECOVERED_UNAPPLIED',git_update_status='FAILED',error_code='SYNC_INTERRUPTED',finished_at=? WHERE id=?",
                          [this.now(), row.id],
                        );
                        await tx.run(
                          "UPDATE Workspaces SET lifecycle_state='READY',last_error_code=NULL WHERE id=? AND lifecycle_state='RECOVERY_REQUIRED'",
                          [row.workspace_id],
                        );
                      });
                      await this.removeJournal(row.id);
                      return;
                    }
                    if (actual.head !== journal.target_commit)
                      fail('SYNC_RECOVERY_REQUIRED');
                    // Re-plan from the fixed ref and current clean checkout; never reset a partial tree.
                    const plan = await this.git.plan(
                      row.workspace_id,
                      repo,
                      lease,
                      { targetCommit: journal.target_commit },
                    );
                    if (
                      plan.diagnostic ||
                      plan.before !== journal.target_commit ||
                      plan.target !== journal.target_commit
                    )
                      fail('SYNC_RECOVERY_REQUIRED');
                    const token = randomUUID();
                    await this.store.transaction(async (tx) => {
                      if (row.status === 'RUNNING')
                        await tx.run(
                          "UPDATE WorkspaceSyncRuns SET status='RECOVERY_REQUIRED' WHERE id=?",
                          [row.id],
                        );
                      await tx.run(
                        "UPDATE WorkspaceSyncRuns SET status='RUNNING',owner_token=?,phase='RECOVERING' WHERE id=?",
                        [token, row.id],
                      );
                    });
                    journal.owner_token = token;
                    await privateJson(await this.journalPath(row.id), journal);
                    plan.before = journal.before_commit;
                    plan.changedPaths = await this.git.changedPaths(
                      row.workspace_id,
                      journal.before_commit,
                      journal.target_commit,
                      repo,
                      lease,
                    );
                    await this.finish(row, plan, lease, token, journal);
                  },
                ),
            );
          }),
        );
      } catch (error) {
        if (
          [
            'RUNTIME_BUSY',
            'WORKSPACE_BUSY',
            'PLATFORM_BACKUP_IN_PROGRESS',
            'BACKUP_BUSY',
          ].includes(errorCode(error))
        )
          continue;
        await this.store.transaction(async (tx) => {
          const row = await this.get(original.id);
          if (!['RUNNING', 'RECOVERY_REQUIRED'].includes(row.status)) return;
          await tx.run(
            "UPDATE Workspaces SET lifecycle_state='RECOVERY_REQUIRED',last_error_code='SYNC_RECOVERY_REQUIRED' WHERE id=? AND lifecycle_state='READY'",
            [row.workspace_id],
          );
          await tx.run(
            "UPDATE WorkspaceSyncRuns SET status='RECOVERY_REQUIRED',error_code=? WHERE id=? AND status='RUNNING'",
            [errorCode(error), row.id],
          );
        });
      } finally {
        await owner?.release();
      }
    }
    // An acknowledged SQL success may only leave a cleanup journal after controller death.
    const directory = await this.roots.directory('tmp/workspace-v2/sync', true);
    for (const name of await fs.readdir(directory)) {
      const match = /^sync-([1-9][0-9]*)\.json$/.exec(name);
      if (!match) continue;
      const row = await this.get(Number(match[1]));
      if (row.status !== 'SUCCESS' || this.active.has(row.id)) continue;
      let owner: RuntimeLease | undefined;
      try {
        await this.point('BEFORE_SUCCESS_JOURNAL_CLEANUP_OWNER', row);
        owner = await RuntimeLease.acquire(
          new SyncOwnerPaths(this.store.dataRoot),
          row.id,
        );
        await withInheritedLease(owner.handle.fd, () =>
          this.leases.barrier.mutation(async () => {
            let journal: SyncJournal;
            try {
              journal = (await readJson(
                path.join(directory, name),
                65536,
              )) as SyncJournal;
            } catch (error) {
              // Another controller may have finished cleanup after enumeration.
              // The terminal SUCCESS and its FK-backed Outbox are already durable.
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
              throw error;
            }
            const out = (
              await this.store.all(
                'SELECT id FROM WorkspaceUpdateOutbox WHERE id=? AND sync_run_id=? AND after_commit=?',
                [row.id, row.id, row.after_commit],
              )
            )[0];
            if (
              journal.version !== 1 ||
              journal.run_id !== row.id ||
              journal.workspace_id !== row.workspace_id ||
              journal.before_commit !== row.before_commit ||
              journal.target_commit !== row.after_commit ||
              !journal.root_identity ||
              !journal.git_identity ||
              journal.source_snapshot_sha256 !== digest(row.source_snapshot) ||
              !out
            )
              fail('SYNC_RECOVERY_REQUIRED');
            await this.removeJournal(row.id);
          }, true),
        );
      } catch (error) {
        if (
          ![
            'RUNTIME_BUSY',
            'PLATFORM_BACKUP_IN_PROGRESS',
            'BACKUP_BUSY',
          ].includes(errorCode(error))
        )
          throw error;
      } finally {
        await owner?.release();
      }
    }
  }
}
