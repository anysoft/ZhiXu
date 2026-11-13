const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutboxFixture } = require('./outbox-fixture.cjs');
const {
  WorkspaceEnvironmentService,
} = require('../../../back/services/taskExecutionV2/environment');

async function successful(f, sync, key) {
  const run = await sync.wait(
    (
      await sync.submit(f.row.id, { requestKey: key })
    ).id,
  );
  assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
  return run;
}
async function taskRuns(f) {
  return f.store.all('SELECT * FROM TaskRuns ORDER BY id');
}
async function execute(f, run) {
  const terminal = await f.execution.wait(run.id);
  assert.equal(terminal.status, 'SUCCESS', JSON.stringify(terminal));
  assert.equal((await f.execution.attempts(run.id)).length, 1);
  assert.equal((await f.execution.logs(run.id)).includes(f.secret), false);
  return terminal;
}

test('S3 actual initial baseline fires only explicitly opted-in trigger once; NO_CHANGE and late triggers never replay it', async (t) => {
  const f = await createOutboxFixture(t, { caseId: 's3-outbox-initial' });
  const ordinary = await f.createTrigger(),
    initial = await f.createTrigger({ fireOnInitial: true });
  const sync = await f.buildSync(),
    first = await successful(f, sync, 'initial');
  assert.equal(first.initial, 1);
  assert.equal(first.before_commit, first.after_commit);
  assert.equal(first.git_update_status, 'UNCHANGED');
  assert.equal((await f.outbox.dispatchOne(first.id)).status, 'DISPATCHED');
  const runs = await taskRuns(f);
  assert.equal(runs.length, 1);
  await execute(f, runs[0]);
  const events = await f.store.all('SELECT * FROM TriggerEvents ORDER BY id');
  assert.equal(
    events.find((event) => event.origin_trigger_id === ordinary.id).error_code,
    'GIT_INITIAL_SYNC_SKIPPED',
  );
  assert.equal(
    events.find((event) => event.origin_trigger_id === initial.id).task_run_id,
    runs[0].id,
  );
  await f.outbox.dispatchOne(first.id);
  await f.outbox.recover();
  const next = await sync.wait(
    (
      await sync.submit(f.row.id, { requestKey: 'no-change' })
    ).id,
  );
  assert.equal(next.status, 'NO_CHANGE');
  const late = await f.createTrigger({ fireOnInitial: true });
  await f.outbox.dispatchOne(first.id);
  assert.equal((await taskRuns(f)).length, 1);
  assert.equal(
    (await f.store.all('SELECT id FROM WorkspaceUpdateOutbox')).length,
    1,
  );
  assert.equal(
    (
      await f.store.all(
        'SELECT id FROM TriggerEvents WHERE origin_trigger_id=?',
        [late.id],
      )
    ).length,
    0,
  );
  assert.deepEqual(await f.effectsLines(), [String(runs[0].id)]);
  await f.scenario.record('outbox-initial', {
    status: 'PASS',
    input:
      'actual first logical unchanged Sync plus repeated fetch/dispatch and late Trigger',
    expected: 'one initial effect only for opt-in',
    actual: {
      sync_run_id: first.id,
      outbox_id: first.id,
      task_run_id: runs[0].id,
      actual_effect_count: 1,
      second_sync: next.status,
    },
    assertions: [
      'initial baseline established once',
      'default initial disabled',
      'NO_CHANGE has no outbox',
      'new Trigger does not replay initial',
      'secret redacted',
    ],
  });
});

test('S3 real FF updates freeze source/path filter results and submit idempotently into the S2 Runner queue', async (t) => {
  const f = await createOutboxFixture(t, { caseId: 's3-outbox-filters' });
  const any = await f.createTrigger(),
    source = await f.createTrigger({ mode: 'SOURCE_CHANGE' }),
    pathFilter = await f.createTrigger({
      mode: 'PATH_FILTER',
      pathFilters: ['lib/**/*.txt'],
    });
  const sync = await f.buildSync();
  await successful(f, sync, 'initial');
  await f.commit({ 'unrelated.txt': 'actual unrelated remote update' });
  const update = await successful(f, sync, 'unrelated');
  assert.notEqual(update.before_commit, update.after_commit);
  await f.outbox.dispatchOne(update.id);
  const events = await f.store.all(
    'SELECT * FROM TriggerEvents WHERE workspace_update_id=? ORDER BY id',
    [update.id],
  );
  assert.equal(
    events.find((event) => event.origin_trigger_id === source.id).error_code,
    'GIT_SOURCE_UNCHANGED',
  );
  assert.equal(
    events.find((event) => event.origin_trigger_id === pathFilter.id)
      .error_code,
    'GIT_PATH_UNMATCHED',
  );
  const runs = await taskRuns(f);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger_id, any.id);
  assert.equal(runs[0].expected_git_commit, update.after_commit);
  await execute(f, runs[0]);
  await f.outbox.dispatchOne(update.id);
  assert.equal((await taskRuns(f)).length, 1);
  assert.deepEqual(await f.effectsLines(), [String(runs[0].id)]);
  assert.equal(
    JSON.stringify(await f.outbox.get(update.id)).includes(f.secret),
    false,
  );
  await f.scenario.record('outbox-filters', {
    status: 'PASS',
    expected:
      'real FF plus explicit filter outcomes and exactly one durable submission',
    actual: {
      sync_run_id: update.id,
      before: update.before_commit,
      after: update.after_commit,
      event_count: events.length,
      run_count: runs.length,
    },
    assertions: [
      'real Git commit changed',
      'source/path skips durable',
      'actual Shell child SUCCESS',
      'repeat dispatch keeps same Run',
    ],
  });
});

test('S3 old committed event after a later real FF remains bound to the complete old source snapshot and skips with zero Attempt', async (t) => {
  const f = await createOutboxFixture(t, { caseId: 's3-outbox-superseded' });
  await f.createTrigger({ fireOnInitial: true });
  const sync = await f.buildSync(),
    old = await successful(f, sync, 'A');
  const frozen = JSON.parse((await f.outbox.get(old.id)).trigger_plan)[0]
    .admission;
  await f.commit({ 'main.sh': f.program('B') });
  const current = await successful(f, sync, 'B');
  await f.outbox.dispatchOne(old.id);
  const skipped = (await taskRuns(f))[0];
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(skipped.error_code, 'SOURCE_SUPERSEDED');
  assert.deepEqual(JSON.parse(skipped.admission_snapshot), frozen);
  assert.equal(skipped.expected_git_commit, old.after_commit);
  assert.notEqual(skipped.expected_git_commit, current.after_commit);
  assert.equal((await f.execution.attempts(skipped.id)).length, 0);
  assert.deepEqual(await f.effectsLines(), []);
  assert.equal(
    JSON.parse(
      (await f.execution.events(skipped.id)).find(
        (event) => event.type === 'SOURCE_SUPERSEDED',
      ).metadata,
    ).reason,
    'SOURCE_CHANGED',
  );
  await f.outbox.dispatchOne(current.id);
  const fresh = (await taskRuns(f))[1];
  await execute(f, fresh);
  assert.match(await f.execution.logs(fresh.id), /S3_TASK_B/);
  assert.deepEqual(await f.effectsLines(), [String(fresh.id)]);
  await f.scenario.record('outbox-source-pin', {
    status: 'PASS',
    expected: 'A event never executes B source',
    actual: {
      old_update: old.id,
      current_update: current.id,
      old_run: skipped.id,
      old_status: skipped.status,
      old_attempt_count: 0,
      current_run: fresh.id,
    },
    assertions: [
      'entire old AdmissionSnapshot preserved',
      'old commit not mixed with current revision/hash/resources',
      'zero old child',
      'new B event executes actual B source once',
    ],
  });
});

test('S3 resource changes supersede the full frozen event snapshot and forged metadata cannot replace its immutable plan', async (t) => {
  const f = await createOutboxFixture(t, { caseId: 's3-outbox-resource-pin' });
  await f.createTrigger({ fireOnInitial: true });
  const sync = await f.buildSync(),
    update = await successful(f, sync, 'initial');
  const event = (
    await f.store.all(
      'SELECT * FROM TriggerEvents WHERE workspace_update_id=?',
      [update.id],
    )
  )[0];
  const before = event.metadata,
    malformed = JSON.parse(before);
  malformed.frozen_admission.expected_workspace_version++;
  await f.store.run('UPDATE TriggerEvents SET metadata=? WHERE id=?', [
    JSON.stringify(malformed),
    event.id,
  ]);
  await assert.rejects(
    f.execution.submit(f.task.task.id, {
      triggerType: 'GIT_UPDATE',
      eventId: event.id,
    }),
    { error_code: 'TRIGGER_EVENT_INVALID' },
  );
  assert.equal((await taskRuns(f)).length, 0);
  await f.store.run('UPDATE TriggerEvents SET metadata=? WHERE id=?', [
    before,
    event.id,
  ]);
  const global = (
    await f.store.all(
      'SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1',
    )
  )[0];
  await new WorkspaceEnvironmentService(
    f.store,
    f.roots,
    f.leases,
  ).replaceGlobals(global.version, [
    {
      name: 'UPDATED_GLOBAL',
      value: 'new harmless value',
      operation: 'SET',
      status: 'enabled',
      is_secret: false,
    },
  ]);
  await f.outbox.dispatchOne(update.id);
  const skipped = (await taskRuns(f))[0];
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(skipped.error_code, 'SOURCE_SUPERSEDED');
  assert.deepEqual(
    JSON.parse(skipped.admission_snapshot),
    JSON.parse(before).frozen_admission,
  );
  assert.equal((await f.execution.attempts(skipped.id)).length, 0);
  assert.equal(
    JSON.parse(
      (await f.execution.events(skipped.id)).find(
        (entry) => entry.type === 'SOURCE_SUPERSEDED',
      ).metadata,
    ).reason,
    'RESOURCE_CHANGED',
  );
  assert.deepEqual(await f.effectsLines(), []);
  await f.scenario.record('outbox-resource-pin', {
    status: 'PASS',
    expected:
      'immutable plan authenticates full source/resources, current resource change cannot be absorbed',
    actual: {
      skipped_run_id: skipped.id,
      attempt_count: 0,
      reason: 'RESOURCE_CHANGED',
    },
    assertions: [
      'forged metadata rejected before Run insertion',
      'old complete snapshot retained',
      'no child/side effect',
    ],
  });
});

for (const removed of ['trigger', 'task'])
  test(
    'S3 deleted ' +
      removed +
      ' settles its precommitted normalized event without fabricating a nullable origin or new Run',
    async (t) => {
      const f = await createOutboxFixture(t, {
        caseId: 's3-outbox-deleted-' + removed,
      });
      const trigger = await f.createTrigger({ fireOnInitial: true });
      const sync = await f.buildSync(),
        update = await successful(f, sync, 'initial');
      const original = (await f.store.all('SELECT * FROM TriggerEvents'))[0];
      if (removed === 'trigger')
        await f.triggers.remove(trigger.id, trigger.version);
      else
        await f.tasks.remove(
          f.task.task.id,
          (
            await f.tasks.get(f.task.task.id)
          ).task.version,
        );
      assert.equal(
        (await f.outbox.dispatchOne(update.id)).status,
        'DISPATCHED',
      );
      const event = (await f.store.all('SELECT * FROM TriggerEvents'))[0];
      assert.equal(event.id, original.id);
      assert.equal(event.origin_trigger_id, trigger.id);
      assert.equal(event.trigger_id, null);
      assert.equal(
        event.error_code,
        removed === 'task' ? 'TASK_DELETED' : 'TRIGGER_DELETED',
      );
      assert.equal(event.status, 'SKIPPED');
      assert.equal((await taskRuns(f)).length, 0);
      await f.scenario.record('outbox-delete-' + removed, {
        status: 'PASS',
        expected: 'same durable event records deleted target decision',
        actual: {
          event_id: event.id,
          origin_trigger_id: event.origin_trigger_id,
          error_code: event.error_code,
          task_runs: 0,
        },
        assertions: [
          'event created only while valid trigger existed',
          'FK deletion retains original identity',
          'no deleted target recreation',
          'zero Run',
        ],
      });
    },
  );

test('S3 dispatcher retries with durable backoff, bounds failures, clears dead ownership and obeys frozen DEAD guard', async (t) => {
  let now = new Date(),
    secret;
  const f = await createOutboxFixture(t, {
    caseId: 's3-outbox-retry',
    outbox: {
      maxAttempts: 2,
      clock: { now: () => now },
      fault: async (point) => {
        if (point === 'BEFORE_OUTBOX_DISPATCH') throw Error(secret);
      },
    },
  });
  secret = f.secret;
  await f.createTrigger({ fireOnInitial: true });
  const sync = await f.buildSync(),
    update = await successful(f, sync, 'initial');
  let row = await f.outbox.dispatchOne(update.id);
  assert.equal(row.status, 'RETRY');
  assert.equal(row.attempt_count, 1);
  assert.equal(row.last_error_code, 'WORKSPACE_OPERATION_FAILED');
  assert.ok(new Date(row.next_attempt_at) > now);
  await f.outbox.tick();
  assert.equal((await f.outbox.get(update.id)).attempt_count, 1);
  now = new Date(new Date(row.next_attempt_at).getTime() + 1);
  row = await f.outbox.dispatchOne(update.id);
  assert.equal(row.status, 'DEAD');
  assert.equal(row.owner_token, null);
  assert.equal(row.attempt_count, 2);
  assert.equal(JSON.stringify(row).includes(secret), false);
  assert.equal((await sync.get(update.id)).status, 'SUCCESS');
  assert.equal((await sync.get(update.id)).event_status, 'BLOCKED');
  assert.equal(
    (await f.store.all('SELECT * FROM TriggerEvents'))[0].status,
    'FAILED',
  );
  await assert.rejects(f.outbox.retryDead(update.id), {
    error_code: 'SYNC_RECOVERY_REQUIRED',
  });
  await assert.rejects(f.outbox.cancel(update.id), {
    error_code: 'SYNC_RECOVERY_REQUIRED',
  });
  await assert.rejects(
    f.store.run("UPDATE WorkspaceUpdateOutbox SET status='RETRY' WHERE id=?", [
      update.id,
    ]),
    { error_code: 'SYNC_RECOVERY_REQUIRED' },
  );
  assert.equal((await taskRuns(f)).length, 0);
  await f.scenario.record('outbox-retry', {
    status: 'PASS',
    expected:
      'transient retry/backoff and terminal exhaustion without frozen-state bypass',
    actual: {
      outbox_status: row.status,
      attempt_count: 2,
      sync_status: 'SUCCESS',
      event_status: 'BLOCKED',
      task_runs: 0,
    },
    contract_discrepancy:
      'Frozen SQL rejects DEAD->RETRY/CANCELLED despite prose; explicit operations return guard error and never create duplicate identity',
    assertions: [
      'raw exception secret not persisted',
      'no tight retry loop',
      'no PROCESSING event survives DEAD',
      'no fake Sync rollback',
      'no duplicate TaskRun',
    ],
  });
});

test('S3 dispatch deadline expires before submission without pretending a child executed', async (t) => {
  const f = await createOutboxFixture(t, {
    caseId: 's3-outbox-timeout',
    outbox: {
      maxAttempts: 1,
      dispatchTimeoutMs: 1,
      fault: async (point) => {
        if (point === 'BEFORE_OUTBOX_DISPATCH')
          await new Promise((resolve) => setTimeout(resolve, 20));
      },
    },
  });
  await f.createTrigger({ fireOnInitial: true });
  const sync = await f.buildSync(),
    update = await successful(f, sync, 'initial');
  const row = await f.outbox.dispatchOne(update.id);
  assert.equal(row.status, 'DEAD');
  assert.equal(row.last_error_code, 'OUTBOX_DISPATCH_TIMEOUT');
  assert.equal((await taskRuns(f)).length, 0);
  await f.scenario.record('outbox-timeout', {
    status: 'PASS',
    input: 'bounded dispatch deadline with real awaited checkpoint delay',
    expected: 'no submission after deadline',
    actual: {
      status: row.status,
      error_code: row.last_error_code,
      task_runs: 0,
    },
    assertions: [
      'finite timeout',
      'no child',
      'no false dispatch acknowledgement',
    ],
  });
});

test('S3 empty successful update plan settles durably with zero Events, Runs and children', async (t) => {
  const f = await createOutboxFixture(t, { caseId: 's3-outbox-empty' });
  const sync = await f.buildSync(),
    update = await successful(f, sync, 'initial');
  assert.deepEqual(
    JSON.parse((await f.outbox.get(update.id)).trigger_plan),
    [],
  );
  assert.equal((await f.outbox.dispatchOne(update.id)).status, 'DISPATCHED');
  assert.equal((await sync.get(update.id)).event_status, 'DISPATCHED');
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM TriggerEvents'))[0].n,
    0,
  );
  assert.equal((await taskRuns(f)).length, 0);
  assert.deepEqual(await f.effectsLines(), []);
  await f.scenario.record('outbox-empty', {
    status: 'PASS',
    expected: 'zero targets is settled without claiming script execution',
    actual: { status: 'DISPATCHED', events: 0, task_runs: 0, child_effects: 0 },
    assertions: [
      'real Sync baseline fact preserved',
      'no fabricated Event',
      'no fabricated TaskRun SUCCESS',
      'idempotent zero-target acknowledgement',
    ],
  });
});

module.exports = { successful };
