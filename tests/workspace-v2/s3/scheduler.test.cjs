const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createSyncFixture } = require('./sync-fixture.cjs');

function schedulerClock() {
  let value = Date.now();
  return {
    now: () => new Date(value),
    set: (date) => {
      value = Date.parse(date);
    },
    advance: (ms) => {
      value += ms;
    },
  };
}
async function scheduledFixture(t, id, overrides = {}) {
  const clock = schedulerClock();
  const { scheduler, ...other } = overrides;
  const f = await createSyncFixture(t, {
    caseId: id,
    clock,
    ...other,
    scheduler: { clock, maxRetries: 0, ...scheduler },
  });
  f.track(f.scheduler);
  return Object.assign(f, { clock });
}
async function scheduleInterval(f, misfire = 'FIRE_ONCE', ms = 60000) {
  const previous = await f.policies.get(f.row.id);
  return f.policies.save(f.row.id, {
    expected_version: previous.version,
    enabled: true,
    mode: 'SCHEDULED',
    schedule: {
      type: 'INTERVAL',
      interval_ms: ms,
      anchor_at: f.clock.now().toISOString(),
      misfire_policy: misfire,
    },
  });
}
async function allRuns(f) {
  return f.store.all('SELECT * FROM WorkspaceSyncRuns ORDER BY id');
}
async function pollScheduler(predicate, code = 'SCHEDULER_CONDITION_TIMEOUT') {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error(code);
}
function schedulerGate() {
  let release, entered;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  return {
    release,
    ready,
    fault: async (point) => {
      if (point === 'BEFORE_FETCH') {
        entered();
        await hold;
      }
    },
  };
}
async function controllerWorker(t, f, mode = 'TICK', runId = 0) {
  const worker = fork(
    path.join(__dirname, 'scheduler-worker.cjs'),
    [
      f.root,
      String(f.row.id),
      f.clock.now().toISOString(),
      mode,
      String(runId),
    ],
    {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  worker.stderr.resume();
  const messages = [];
  worker.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve) =>
    worker.once('exit', (code, signal) => resolve({ code, signal })),
  );
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await exited;
    }
  });
  await pollScheduler(
    () => messages.find((message) => message.ready || message.failure),
    'SCHEDULER_WORKER_NOT_READY',
  );
  assert.equal(
    messages.some((message) => message.failure),
    false,
  );
  return { worker, messages, exited, go: () => worker.send({ go: true }) };
}

test('S3-SCHEDULE-001 Manual, UTC Interval and timezone Cron produce real Git SyncRuns; disable cancels pending policy', async (t) => {
  const f = await scheduledFixture(t, 'S3-SCHEDULE-001');
  await f.scheduler.tick();
  assert.equal((await allRuns(f)).length, 0);
  const manual = await f.sync.wait(
    (
      await f.sync.submit(f.row.id, { requestKey: 'manual-baseline' })
    ).id,
  );
  assert.equal(manual.status, 'SUCCESS', manual.error_code);
  let policy = await scheduleInterval(f);
  const intervalDue = policy.next_due_at;
  assert.equal(new Date(intervalDue).toISOString(), intervalDue);
  const target = await f.commit({ 'main.py': 'print("interval")\n' });
  f.clock.set(intervalDue);
  await f.scheduler.tick();
  const interval = await f.sync.wait((await allRuns(f)).at(-1).id);
  assert.equal(interval.status, 'SUCCESS', interval.error_code);
  assert.equal(interval.trigger_source, 'INTERVAL');
  assert.equal(interval.schedule_slot, intervalDue);
  assert.equal(interval.after_commit, target);
  assert.equal(
    interval.request_key,
    `schedule:${f.row.id}:${policy.version}:${Date.parse(intervalDue)}`,
  );
  policy = await f.policies.save(f.row.id, {
    expected_version: policy.version,
    enabled: true,
    mode: 'SCHEDULED',
    schedule: {
      type: 'CRON',
      expression: '* * * * *',
      timezone: 'Asia/Singapore',
      misfire_policy: 'FIRE_ONCE',
    },
  });
  const cronDue = policy.next_due_at;
  assert.equal(new Date(cronDue).toISOString(), cronDue);
  const cronTarget = await f.commit({ 'main.py': 'print("cron")\n' });
  f.clock.set(cronDue);
  await f.scheduler.tick();
  const cron = await f.sync.wait((await allRuns(f)).at(-1).id);
  assert.equal(cron.status, 'SUCCESS', cron.error_code);
  assert.equal(cron.trigger_source, 'CRON');
  assert.equal(cron.schedule_slot, cronDue);
  assert.equal(cron.after_commit, cronTarget);
  const pending = await f.sync.submit(f.row.id, {
    requestKey: 'old-policy-pending',
  });
  policy = await f.policies.save(f.row.id, {
    expected_version: policy.version,
    enabled: false,
    mode: 'SCHEDULED',
    schedule: {
      type: 'CRON',
      expression: '* * * * *',
      timezone: 'Asia/Singapore',
      misfire_policy: 'FIRE_ONCE',
    },
  });
  assert.equal((await f.sync.get(pending.id)).status, 'CANCELLED');
  assert.equal(
    (await f.sync.get(pending.id)).error_code,
    'SYNC_POLICY_CHANGED',
  );
  assert.equal(policy.next_due_at, null);
  f.clock.advance(600000);
  await f.scheduler.tick();
  assert.equal((await allRuns(f)).length, 4);
  assert.equal(
    (await f.store.all('SELECT id FROM WorkspaceUpdateOutbox')).length,
    3,
  );
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspaceRoot), cronTarget);
  await f.scenario.record('S3-SCHEDULE-001', {
    sync_run_ids: [manual.id, interval.id, cron.id, pending.id],
    terminal_statuses: ['SUCCESS', 'SUCCESS', 'SUCCESS', 'CANCELLED'],
    interval_slot: intervalDue,
    cron_slot: cronDue,
    timezone: 'Asia/Singapore',
    disable_preserved_history: true,
  });
});

for (const misfire of ['SKIP', 'FIRE_ONCE'])
  test(`S3-SCHEDULE-MISFIRE-${misfire} consumes many missed slots once with durable reason`, async (t) => {
    const f = await scheduledFixture(t, 'S3-SCHEDULE-MISFIRE-' + misfire);
    const policy = await scheduleInterval(f, misfire);
    const target = await f.commit({ 'main.py': `print("${misfire}")\n` });
    f.clock.set(policy.next_due_at);
    f.clock.advance(5 * 60000);
    await f.scheduler.tick();
    let rows = await allRuns(f);
    assert.equal(rows.length, 1);
    const row = await f.sync.wait(rows[0].id);
    assert.equal(row.schedule_slot, policy.next_due_at);
    assert.equal(row.trigger_source, 'INTERVAL');
    if (misfire === 'SKIP') {
      assert.equal(row.status, 'BLOCKED');
      assert.equal(row.phase, 'MISFIRE_SKIPPED');
      assert.equal(row.error_code, 'SYNC_MISFIRE_SKIPPED');
      assert.equal(row.git_update_status, 'NOT_STARTED');
      assert.equal(row.owner_token, null);
      assert.equal(row.started_at, null);
      assert.equal(row.update_outbox_id, null);
      assert.notEqual(f.git(['rev-parse', 'HEAD'], f.workspaceRoot), target);
    } else {
      assert.equal(row.status, 'SUCCESS', row.error_code);
      assert.equal(row.after_commit, target);
    }
    const cursor = await f.policies.get(f.row.id);
    assert.equal(cursor.last_claimed_slot, policy.next_due_at);
    assert.ok(Date.parse(cursor.next_due_at) > f.clock.now().getTime());
    await f.scheduler.tick();
    rows = await allRuns(f);
    assert.equal(rows.length, 1);
    assert.equal(
      (await f.store.all('SELECT id FROM WorkspaceUpdateOutbox')).length,
      misfire === 'SKIP' ? 0 : 1,
    );
    await f.scenario.record('S3-SCHEDULE-MISFIRE-' + misfire, {
      sync_run_id: row.id,
      status: row.status,
      phase: row.phase,
      error_code: row.error_code,
      missed_slots: 5,
      durable_cursor: cursor.last_claimed_slot,
      next_due_at: cursor.next_due_at,
      no_catchup_backlog: true,
    });
  });

test('S3-SCHEDULE-004 a due occurrence during an actual claimed Sync is durably skipped without altering the owner', async (t) => {
  const gate = schedulerGate();
  t.after(() => gate.release());
  const f = await scheduledFixture(t, 'S3-SCHEDULE-004', { fault: gate.fault });
  const policy = await scheduleInterval(f);
  const original = await f.sync.submit(f.row.id, {
    requestKey: 'active-real-sync',
  });
  await f.sync.tick();
  await gate.ready;
  const owned = await f.sync.get(original.id);
  assert.equal(owned.status, 'RUNNING');
  assert.ok(owned.owner_token);
  f.clock.set(policy.next_due_at);
  await f.scheduler.tick();
  const skipped = (await allRuns(f)).at(-1);
  assert.notEqual(skipped.id, original.id);
  assert.equal(skipped.status, 'BLOCKED');
  assert.equal(skipped.phase, 'OCCURRENCE_SKIPPED');
  assert.equal(skipped.error_code, 'SYNC_ALREADY_RUNNING');
  assert.equal(skipped.owner_token, null);
  assert.equal(skipped.git_update_status, 'NOT_STARTED');
  assert.equal(skipped.update_outbox_id, null);
  assert.equal((await f.sync.get(original.id)).owner_token, owned.owner_token);
  gate.release();
  assert.equal((await f.sync.wait(original.id)).status, 'SUCCESS');
  assert.equal(
    (await f.store.all('SELECT id FROM WorkspaceUpdateOutbox')).length,
    1,
  );
  await f.scenario.record('S3-SCHEDULE-004', {
    active_run_id: original.id,
    skipped_run_id: skipped.id,
    error_code: skipped.error_code,
    active_owner_preserved: true,
    one_outbox: true,
  });
});

test('S3-SCHEDULE-005 real failed Fetch retries as a new Run with a fixed retry deadline and no duplicate on later tick', async (t) => {
  const f = await scheduledFixture(t, 'S3-SCHEDULE-005', {
    scheduler: { maxRetries: 3, retryBaseMs: 50 },
  });
  const policy = await scheduleInterval(f);
  const target = await f.commit({ 'main.py': 'print("retry-real-fetch")\n' });
  const gitDir = path.join(f.repository.source, '.git'),
    offline = path.join(f.repository.source, '.git-owned-offline');
  await fs.rename(gitDir, offline);
  t.after(async () => {
    if (await fs.lstat(offline).catch(() => null))
      await fs.rename(offline, gitDir);
  });
  f.clock.set(policy.next_due_at);
  await f.scheduler.tick();
  const original = await f.sync.wait((await allRuns(f))[0].id);
  assert.equal(original.status, 'FAILED');
  assert.equal(original.error_code, 'FETCH_FAILED');
  assert.equal(original.update_outbox_id, null);
  await fs.rename(offline, gitDir);
  const failedFacts = JSON.stringify(original);
  f.clock.advance(60);
  await f.scheduler.tick();
  const rows = await allRuns(f);
  assert.equal(rows.length, 2);
  const retry = await f.sync.wait(rows[1].id);
  assert.equal(retry.status, 'SUCCESS', retry.error_code);
  assert.equal(retry.after_commit, target);
  assert.equal(retry.request_key, `retry:${original.id}:1`);
  const snapshot = JSON.parse(retry.source_snapshot);
  assert.equal(snapshot.retry_of, original.id);
  assert.equal(snapshot.retry_attempt, 1);
  assert.equal(
    Date.parse(snapshot.deadline_at),
    Date.parse(original.finished_at) + 50 + snapshot.timeout_ms,
  );
  assert.equal(JSON.stringify(await f.sync.get(original.id)), failedFacts);
  f.clock.advance(100);
  await f.scheduler.tick();
  assert.equal((await allRuns(f)).length, 2);
  assert.equal(
    (await f.sync.get(retry.id)).source_snapshot,
    retry.source_snapshot,
  );
  await f.scenario.record('S3-SCHEDULE-005', {
    failed_run_id: original.id,
    retry_run_id: retry.id,
    failed_error: original.error_code,
    retry_status: retry.status,
    retry_deadline_at: snapshot.deadline_at,
    immutable_failed_history: true,
    fixed_deadline_no_duplicate: true,
  });
});

test('S3-SCHEDULE-006 queued and claimed cancellation plus absolute queued timeout preserve no-apply facts', async (t) => {
  const gate = schedulerGate();
  t.after(() => gate.release());
  const f = await scheduledFixture(t, 'S3-SCHEDULE-006', {
    fault: gate.fault,
    timeoutMs: 10000,
  });
  const before = f.git(['rev-parse', 'HEAD'], f.workspaceRoot);
  const pending = await f.sync.submit(f.row.id, {
    requestKey: 'cancel-queued',
  });
  await f.sync.cancel(pending.id);
  assert.equal((await f.sync.get(pending.id)).status, 'CANCELLED');
  const claimed = await f.sync.submit(f.row.id, {
    requestKey: 'cancel-claimed',
  });
  await f.sync.tick();
  await gate.ready;
  assert.equal((await f.sync.get(claimed.id)).status, 'RUNNING');
  await f.sync.cancel(claimed.id);
  gate.release();
  const cancelled = await f.sync.wait(claimed.id);
  assert.equal(cancelled.status, 'CANCELLED', cancelled.error_code);
  assert.equal(cancelled.cancel_requested, 1);
  const expired = await f.sync.submit(f.row.id, {
    requestKey: 'timeout-queued',
  });
  const admitted = expired.source_snapshot;
  f.clock.advance(10001);
  const timedOut = await f.sync.wait(expired.id);
  assert.equal(timedOut.status, 'BLOCKED');
  assert.equal(timedOut.error_code, 'SYNC_TIMEOUT');
  assert.equal(timedOut.started_at, null);
  assert.equal(timedOut.source_snapshot, admitted);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspaceRoot), before);
  assert.equal(
    (await f.store.all('SELECT id FROM WorkspaceUpdateOutbox')).length,
    0,
  );
  await f.scenario.record('S3-SCHEDULE-006', {
    cancelled_run_ids: [pending.id, claimed.id],
    expired_run_id: expired.id,
    timeout_status: timedOut.status,
    timeout_error: timedOut.error_code,
    no_apply_or_outbox: true,
  });
});

test('S3-SCHEDULE-007 two independent controllers confirm one scheduled occurrence and one actual effect', async (t) => {
  const f = await scheduledFixture(t, 'S3-SCHEDULE-007');
  const policy = await scheduleInterval(f);
  const target = await f.commit({ 'main.py': 'print("two-controllers")\n' });
  f.clock.set(policy.next_due_at);
  const workers = await Promise.all([
    controllerWorker(t, f),
    controllerWorker(t, f),
  ]);
  assert.notEqual(workers[0].worker.pid, workers[1].worker.pid);
  for (const worker of workers) worker.go();
  const exits = await Promise.all(workers.map((worker) => worker.exited));
  for (const exit of exits) {
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
  }
  for (const worker of workers)
    assert.equal(
      worker.messages.some((message) => message.failure),
      false,
    );
  const rows = await allRuns(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'SUCCESS', rows[0].error_code);
  assert.equal(
    rows[0].request_key,
    `schedule:${f.row.id}:${policy.version}:${Date.parse(policy.next_due_at)}`,
  );
  assert.equal(rows[0].after_commit, target);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspaceRoot), target);
  assert.equal(
    (await f.store.all('SELECT id FROM WorkspaceUpdateOutbox')).length,
    1,
  );
  await f.scenario.record('S3-SCHEDULE-007', {
    controller_pids: workers.map((worker) => worker.worker.pid),
    sync_run_id: rows[0].id,
    occurrence_slot: policy.next_due_at,
    status: rows[0].status,
    target_commit: target,
    actual_commit: rows[0].actual_commit,
    exactly_one_effect: true,
  });
});

test('S3-SCHEDULE-008 queued admission survives controller close and an independent process resumes the same Run', async (t) => {
  const f = await scheduledFixture(t, 'S3-SCHEDULE-008');
  const target = await f.commit({ 'main.py': 'print("controller-restart")\n' });
  const pending = await f.sync.submit(f.row.id, {
    requestKey: 'durable-before-controller-close',
  });
  const admission = pending.source_snapshot;
  await f.sync.close();
  assert.equal((await f.sync.get(pending.id)).status, 'QUEUED');
  const worker = await controllerWorker(t, f, 'RESUME', pending.id);
  worker.go();
  assert.equal((await worker.exited).code, 0);
  assert.equal(
    worker.messages.some((message) => message.failure),
    false,
  );
  const finished = await f.sync.get(pending.id);
  assert.equal(finished.status, 'SUCCESS', finished.error_code);
  assert.equal(finished.after_commit, target);
  assert.equal(finished.source_snapshot, admission);
  assert.equal((await allRuns(f)).length, 1);
  assert.equal(
    (await f.store.all('SELECT id FROM WorkspaceUpdateOutbox')).length,
    1,
  );
  await f.scenario.record('S3-SCHEDULE-008', {
    previous_controller: process.pid,
    resumed_controller: worker.worker.pid,
    sync_run_id: pending.id,
    status: finished.status,
    admission_unchanged: true,
    exactly_one_outbox: true,
  });
});
