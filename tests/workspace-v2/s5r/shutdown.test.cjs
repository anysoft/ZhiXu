const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createShutdownFixture,
  until,
  pause,
  assertLeaseBusy,
  assertLeaseReleased,
  assertChildStopped,
  startShutdownWorker,
} = require('./shutdown-support.cjs');
const {
  WorkspaceCronSubmissions,
} = require('../../../back/services/taskExecutionV2/cron');

const gateScript =
  'printf "%s" "$$" > "$1/pid"\nwhile [ ! -f "$1/release" ]; do sleep 0.02; done\nprintf SHUTDOWN_NATURAL_SUCCESS\\n\n';
const endlessScript =
  'trap "" TERM\nprintf "%s" "$$" > "$1/pid"\nwhile :; do sleep 1; done\n';

test('SHUTDOWN_QUEUED_PRESERVED retains original ID, submission key and zero Attempt for an independent process', async (t) => {
  const f = await createShutdownFixture(t);
  const task = await f.task('printf QUEUED_RESUMED\\n\n');
  const run = await f.engine.submit(task.task.id, {
    submissionKey: 'shutdown-queued',
  });
  await f.engine.close();
  const before = await f.engine.get(run.id);
  assert.equal(before.status, 'QUEUED');
  assert.equal(before.submission_key, run.submission_key);
  assert.equal(before.attempt_count, 0);
  assert.equal((await f.engine.attempts(run.id)).length, 0);
  const w = await startShutdownWorker(f, 'resume', run.id);
  const result = await w.exited;
  assert.equal(result.code, 0, result.stderr);
  const reply = JSON.parse(result.stdout);
  assert.notEqual(reply.pid, process.pid);
  assert.equal(reply.run.id, run.id);
  assert.equal(reply.run.submission_key, run.submission_key);
  assert.equal(reply.run.status, 'SUCCESS');
  assert.equal(reply.attempts.length, 1);
  assert.equal((await f.store.all('SELECT id FROM TaskRuns')).length, 1);
  f.record('SHUTDOWN_QUEUED_PRESERVED', {
    run_id: run.id,
    restart_pid: reply.pid,
    queued_attempt_count: 0,
    final_status: reply.run.status,
  });
});

test('SHUTDOWN_RUNNING_GRACEFUL lets an actual child finish naturally before releasing owner and Workspace FDs', async (t) => {
  const f = await createShutdownFixture(t, { shutdownGraceMs: 1000 });
  const task = await f.task(gateScript);
  const run = await f.engine.submit(task.task.id);
  const pid = await f.started(run.id);
  await assertLeaseBusy(f, run.id);
  const release = setTimeout(() => {
    void fs.writeFile(path.join(f.control, 'release'), 'go');
  }, 100);
  try {
    await f.engine.close();
  } finally {
    clearTimeout(release);
  }
  const final = await f.engine.get(run.id);
  assert.equal(final.status, 'SUCCESS');
  assert.equal(final.cancel_requested, 0);
  assert.equal(final.attempt_count, 1);
  assert.equal((await f.engine.attempts(run.id))[0].exit_code, 0);
  assertChildStopped(pid);
  await assertLeaseReleased(f, run.id);
  await f.engine.close();
  f.record('SHUTDOWN_RUNNING_GRACEFUL', {
    run_id: run.id,
    child_pid: pid,
    observed_status: final.status,
    cancel_requested: 0,
    lease_released_after_child_exit: true,
  });
});

test('SHUTDOWN_RUNNING_TIMEOUT coordinates a real TERM-resistant child to INTERRUPTED without user cancellation', async (t) => {
  const f = await createShutdownFixture(t, { shutdownGraceMs: 30 });
  const task = await f.task(endlessScript);
  const run = await f.engine.submit(task.task.id);
  const pid = await f.started(run.id);
  await assertLeaseBusy(f, run.id);
  await Promise.all([f.engine.close(), f.engine.close()]);
  const final = await f.engine.get(run.id),
    result = JSON.parse(final.result);
  assert.equal(final.status, 'INTERRUPTED');
  assert.equal(final.error_code, 'EXECUTION_INTERRUPTED');
  assert.equal(final.cancel_requested, 0);
  assert.equal(result.cancelled, false);
  assert.equal(result.primaryError.phase, 'SHUTDOWN');
  assert.equal(result.cleanupResult, 'SUCCESS');
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal((await f.engine.attempts(run.id))[0].status, 'INTERRUPTED');
  assertChildStopped(pid);
  await assertLeaseReleased(f, run.id);
  f.record('SHUTDOWN_RUNNING_TIMEOUT', {
    run_id: run.id,
    child_pid: pid,
    observed_status: final.status,
    cancel_requested: final.cancel_requested,
    cleanup: result.cleanupResult,
    no_live_child: true,
  });
});

test('USER_CANCEL_RUNNING remains CANCELLED with explicit durable cancel intent', async (t) => {
  const f = await createShutdownFixture(t, { shutdownGraceMs: 1000 });
  const task = await f.task(endlessScript);
  const run = await f.engine.submit(task.task.id);
  const pid = await f.started(run.id);
  await f.engine.cancel(run.id);
  await f.engine.close();
  const final = await f.engine.get(run.id);
  assert.equal(final.status, 'CANCELLED');
  assert.equal(final.cancel_requested, 1);
  assert.equal(JSON.parse(final.result).cancelled, true);
  assertChildStopped(pid);
  await assertLeaseReleased(f, run.id);
  f.record('USER_CANCEL_RUNNING', {
    run_id: run.id,
    observed_status: final.status,
    cancel_requested: 1,
    child_pid: pid,
  });
});

test('CONTROLLER_SIGKILL_RUNNING retains child FD ownership until real cleanup and independent recovery', async (t) => {
  const f = await createShutdownFixture(t);
  const task = await f.task(endlessScript);
  const run = await f.engine.submit(task.task.id);
  const a = await startShutdownWorker(f, 'run', run.id);
  const pid = await until(
    async () =>
      Number(
        await fs.readFile(path.join(f.control, 'pid'), 'utf8').catch(() => '0'),
      ) || false,
  );
  await assertLeaseBusy(f, run.id);
  a.child.kill('SIGKILL');
  const killed = await a.exited;
  assert.equal(killed.signal, 'SIGKILL');
  await assertLeaseBusy(f, run.id);
  const b = await startShutdownWorker(f, 'recover', run.id);
  const recovered = await b.exited;
  assert.equal(recovered.code, 0, recovered.stderr);
  const reply = JSON.parse(recovered.stdout);
  assert.notEqual(b.child.pid, a.child.pid);
  assert.equal(reply.run.id, run.id);
  assert.equal(reply.run.status, 'INTERRUPTED');
  assert.equal(reply.run.cancel_requested, 0);
  assert.equal(reply.attempts.length, 1);
  assertChildStopped(pid);
  await assertLeaseReleased(f, run.id);
  f.record('CONTROLLER_SIGKILL_RUNNING', {
    run_id: run.id,
    controller_pid: a.child.pid,
    recovery_pid: b.child.pid,
    child_pid: pid,
    killed_signal: killed.signal,
    recovery_exit_code: recovered.code,
    observed_status: reply.run.status,
    same_run_id: true,
  });
});

test('RESTART_OCCURRENCE_RECOVERY resumes the same queued Cron event and Run in a fresh controller', async (t) => {
  const f = await createShutdownFixture(t);
  const task = await f.task('printf CRON_SHUTDOWN_RESUMED\\n\n', {}, true);
  let now = new Date();
  const cron = new WorkspaceCronSubmissions(
    f.store,
    f.roots,
    f.leases,
    f.engine,
    { now: () => now },
  );
  const trigger = await cron.create(task.task.id, {
    expression: '* * * * * *',
    timezone: 'UTC',
    misfirePolicy: 'FIRE_ONCE',
  });
  now = new Date(
    (
      await f.store.all(
        'SELECT next_fire_at FROM CronTriggers WHERE trigger_id=?',
        [trigger],
      )
    )[0].next_fire_at,
  );
  await cron.tick();
  const event = (await f.store.all('SELECT * FROM TriggerEvents'))[0];
  const run = await f.engine.get(event.task_run_id);
  assert.equal(run.status, 'QUEUED');
  await f.engine.close();
  const w = await startShutdownWorker(f, 'cron', run.id, now.toISOString());
  const completed = await w.exited;
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).run.status, 'SUCCESS');
  assert.equal((await f.store.all('SELECT id FROM TriggerEvents')).length, 1);
  assert.equal((await f.store.all('SELECT id FROM TaskRuns')).length, 1);
  assert.equal((await f.engine.get(run.id)).event_id, event.id);
  assert.equal((await f.engine.attempts(run.id)).length, 1);
  f.record('RESTART_OCCURRENCE_RECOVERY', {
    trigger_id: trigger,
    event_id: event.id,
    task_run_id: run.id,
    restart_pid: w.child.pid,
    event_key: event.event_key,
    one_event_one_run_one_attempt: true,
  });
});

test('SHUTDOWN_RESOLVING completes safe resolution cleanup without starting an Attempt after the grace deadline', async (t) => {
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await createShutdownFixture(t, {
    shutdownGraceMs: 20,
    fault: async (phase) => {
      if (phase === 'AFTER_LEASE') {
        entered();
        await gate;
      }
    },
  });
  const task = await f.task('printf SHOULD_NOT_START\\n\n');
  const run = await f.engine.submit(task.task.id);
  await f.engine.tick();
  await ready;
  const closing = f.engine.close();
  await pause(80);
  await assertLeaseBusy(f, run.id);
  release();
  await closing;
  const final = await f.engine.get(run.id);
  assert.equal(final.status, 'INTERRUPTED');
  assert.equal(final.cancel_requested, 0);
  assert.equal(final.attempt_count, 0);
  assert.equal((await f.engine.attempts(run.id)).length, 0);
  await assertLeaseReleased(f, run.id);
  f.record('SHUTDOWN_RESOLVING', {
    task_run_id: run.id,
    observed_status: final.status,
    attempt_count: 0,
    owner_held_until_resolution_released: true,
  });
});

test('TASK_TIMEOUT_BEFORE_SHUTDOWN preserves the actual supervisor timeout while its TERM-resistant child is being reaped', async (t) => {
  const f = await createShutdownFixture(t, { shutdownGraceMs: 1200 });
  const task = await f.task(endlessScript, { timeout_seconds: 1 });
  const run = await f.engine.submit(task.task.id);
  const pid = await f.started(run.id);
  await f.engine.close();
  const final = await f.engine.get(run.id),
    result = JSON.parse(final.result);
  assert.equal(final.status, 'TIMEOUT');
  assert.equal(final.error_code, 'TIMEOUT');
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(final.cancel_requested, 0);
  assertChildStopped(pid);
  await assertLeaseReleased(f, run.id);
  f.record('TASK_TIMEOUT_BEFORE_SHUTDOWN', {
    run_id: run.id,
    child_pid: pid,
    observed_status: final.status,
    task_timeout_seconds: 1,
    shutdown_grace_ms: 1200,
  });
});

test('SHUTDOWN_RETRY_BACKOFF preserves the failed Attempt and ends the original Run without a second child', async (t) => {
  const f = await createShutdownFixture(t, { shutdownGraceMs: 20 });
  const task = await f.task('printf RETRY_FIRST_CHILD\\n\nexit 7\n', {
    max_attempts: 3,
    initial_delay_seconds: 5,
  });
  const run = await f.engine.submit(task.task.id);
  await f.engine.tick();
  await until(async () =>
    (await f.engine.events(run.id)).some((e) => e.type === 'RETRY_SCHEDULED'),
  );
  await f.engine.close();
  const final = await f.engine.get(run.id),
    attempts = await f.engine.attempts(run.id);
  assert.equal(final.status, 'INTERRUPTED');
  assert.equal(final.error_code, 'EXECUTION_INTERRUPTED');
  assert.equal(final.cancel_requested, 0);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'FAILED');
  assert.equal(attempts[0].exit_code, 7);
  assert.equal(final.attempt_count, 1);
  await assertLeaseReleased(f, run.id);
  f.record('SHUTDOWN_RETRY_BACKOFF', {
    run_id: run.id,
    observed_status: final.status,
    original_attempt_status: attempts[0].status,
    attempts: 1,
    no_retry_child: true,
  });
});

test('SHUTDOWN_CANNOT_REOPEN_DISPATCH keeps a second queued Run untouched while concurrent close calls drain an owner', async (t) => {
  const f = await createShutdownFixture(t, { shutdownGraceMs: 20 });
  const task = await f.task(endlessScript);
  const first = await f.engine.submit(task.task.id);
  const queued = await f.engine.submit(task.task.id, {
    submissionKey: 'stay-queued',
  });
  const pid = await f.started(first.id);
  const closing = f.engine.close();
  f.engine.start();
  await Promise.all([closing, f.engine.close()]);
  await pause(150);
  const row = await f.engine.get(queued.id);
  assert.equal(row.status, 'QUEUED');
  assert.equal(row.submission_key, 'stay-queued');
  assert.equal(row.attempt_count, 0);
  assert.equal((await f.engine.attempts(queued.id)).length, 0);
  assertChildStopped(pid);
  await assertLeaseReleased(f, first.id);
  f.record('SHUTDOWN_CANNOT_REOPEN_DISPATCH', {
    interrupted_run_id: first.id,
    queued_run_id: queued.id,
    queued_status: row.status,
    queued_attempt_count: 0,
    concurrent_close_finished: true,
  });
});

test('SHUTDOWN_GRACE_CONFIGURATION rejects invalid bounds and an empty close leaves no grace timer behind', async (t) => {
  const f = await createShutdownFixture(t);
  const {
    TaskExecutionService,
  } = require('../../../back/services/taskExecutionV2/execution');
  for (const shutdownGraceMs of [-1, 30001, 0.5, NaN, Infinity, null, '5'])
    assert.throws(
      () =>
        new TaskExecutionService(f.store, f.roots, f.leases, {
          shutdownGraceMs,
        }),
      (e) => e.error_code === 'INVALID_REQUEST',
    );
  for (const shutdownGraceMs of [0, 5000, 30000]) {
    const engine = new TaskExecutionService(f.store, f.roots, f.leases, {
      shutdownGraceMs,
    });
    await engine.close();
    await engine.close();
  }
  f.record('SHUTDOWN_GRACE_CONFIGURATION', {
    valid_ms: [0, 5000, 30000],
    invalid_inputs_rejected: 7,
    queued_rows_created: 0,
  });
});
