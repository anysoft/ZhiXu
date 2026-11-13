const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFixture } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');

async function createQueueAuditFixture(t, code, execution = {}) {
  const f = await createFixture(t);
  const workspace = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({
    name: 'S2 queue acceptance audit',
    requestKey: 'queue-acceptance-audit',
  });
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  await files.create(workspace.id, 'main.sh', code);
  const gate = path.join(f.root, 'outside-source-gates');
  await fs.mkdir(gate, { mode: 0o700 });
  const tasks = new TaskService(f.store, f.roots, f.leases);
  const task = await tasks.create({
    name: 'real queue acceptance child',
    arguments: [gate],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: workspace.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution: { timeout_seconds: 30, ...execution },
  });
  const engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  return { ...f, workspace, gate, files, tasks, task, engine };
}

async function awaitQueueAuditCondition(f, condition) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await f.engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    'Real candidate queue did not reach the required acceptance boundary: ' +
      JSON.stringify(
        await f.store.all(
          'SELECT id,status,error_code,queue_reason,attempt_count FROM TaskRuns ORDER BY id',
        ),
      ),
  );
}

test('explicit same-Task QUEUE preserves logical FIFO for SKIP and FAIL_FAST before competing for the Workspace lease', async (t) => {
  const f = await createQueueAuditFixture(
    t,
    'printf "%s\\n" "$PLATFORM_TASK_RUN_ID" >> "$1/order"\n' +
      'printf "REAL_QUEUE_CHILD_%s\\n" "$PLATFORM_TASK_RUN_ID"\n' +
      'while [ ! -f "$1/release-$PLATFORM_TASK_RUN_ID" ]; do sleep .02; done\n',
    { concurrency: 'QUEUE' },
  );
  const first = await f.engine.submit(f.task.task.id, {
    submissionKey: 'queue-first',
  });
  await awaitQueueAuditCondition(f, async () =>
    (await f.engine.logs(first.id)).includes('REAL_QUEUE_CHILD_'),
  );
  const second = await f.engine.submit(f.task.task.id, {
    submissionKey: 'queue-second',
    waitMode: 'SKIP',
  });
  const third = await f.engine.submit(f.task.task.id, {
    submissionKey: 'queue-third',
    waitMode: 'FAIL_FAST',
  });
  assert.equal((await f.leases.probeWorkspace(f.workspace.id)).busy, true);
  await awaitQueueAuditCondition(
    f,
    async () =>
      (await f.engine.get(second.id)).queue_reason === 'TASK_CONCURRENCY',
  );
  for (const row of [second, third]) {
    const pending = await f.engine.get(row.id);
    assert.equal(pending.status, 'QUEUED');
    assert.equal(pending.queue_deadline_at, row.queue_deadline_at);
    assert.equal(pending.active_workspace_id, null);
    assert.equal((await f.engine.attempts(row.id)).length, 0);
  }
  assert.equal(
    await fs.readFile(path.join(f.gate, 'order'), 'utf8'),
    first.id + '\n',
  );
  for (const [current, next] of [
    [first, second],
    [second, third],
    [third, null],
  ]) {
    // tick launches claims asynchronously. Drain only later tickets' completed
    // logical-policy checks while this real child remains held at its gate.
    // No delayed claim may race the controlled release; these handles cannot
    // authorize a Run or replace its durable queue/physical lease.
    for (const later of [first, second, third].filter(
      (row) => row.id > current.id,
    ))
      await f.engine.active.get(later.id)?.done;
    assert.equal((await f.engine.get(current.id)).status, 'RUNNING');
    const currentCompletion = f.engine.active.get(current.id)?.done;
    await fs.writeFile(path.join(f.gate, 'release-' + current.id), '', {
      mode: 0o600,
    });
    const terminalDeadline = Date.now() + 10000;
    let completed = await f.engine.get(current.id);
    while (completed.status === 'RUNNING') {
      assert.ok(
        Date.now() < terminalDeadline,
        'released real child must terminate',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = await f.engine.get(current.id);
    }
    assert.equal(completed.status, 'SUCCESS', JSON.stringify(completed));
    await currentCompletion;
    assert.equal((await f.engine.attempts(current.id)).length, 1);
    // Terminal SQL is committed before the controller's finally releases the FD.
    // Do not turn that legitimate release interval into a new SKIP probe race.
    const releaseDeadline = Date.now() + 10000;
    while ((await f.leases.probeWorkspace(f.workspace.id)).busy) {
      assert.ok(
        Date.now() < releaseDeadline,
        'completed Run must release its actual Workspace FD',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (next)
      await awaitQueueAuditCondition(f, async () =>
        (await f.engine.logs(next.id)).includes('REAL_QUEUE_CHILD_'),
      );
  }
  assert.equal(
    await fs.readFile(path.join(f.gate, 'order'), 'utf8'),
    [first.id, second.id, third.id].join('\n') + '\n',
  );
  assert.equal((await f.leases.probeWorkspace(f.workspace.id)).busy, false);
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
});

test('same-Task FORBID takes precedence over both SKIP and FAIL_FAST when its real child owns the Workspace', async (t) => {
  const f = await createQueueAuditFixture(
    t,
    'printf "REAL_FORBID_OWNER\\n"\nwhile [ ! -f "$1/release" ]; do sleep .02; done\n',
    { concurrency: 'FORBID' },
  );
  const first = await f.engine.submit(f.task.task.id);
  await awaitQueueAuditCondition(f, async () =>
    (await f.engine.logs(first.id)).includes('REAL_FORBID_OWNER'),
  );
  assert.equal((await f.leases.probeWorkspace(f.workspace.id)).busy, true);
  for (const waitMode of ['SKIP', 'FAIL_FAST']) {
    const options = { waitMode, submissionKey: 'forbid-' + waitMode };
    const skipped = await f.engine.submit(f.task.task.id, options);
    assert.equal(skipped.status, 'SKIPPED');
    assert.equal(skipped.error_code, 'TASK_CONCURRENCY_FORBID');
    assert.equal(skipped.attempt_count, 0);
    assert.equal((await f.engine.attempts(skipped.id)).length, 0);
    assert.equal(
      (await f.engine.submit(f.task.task.id, options)).id,
      skipped.id,
    );
  }
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 3);
  await fs.writeFile(path.join(f.gate, 'release'), '', { mode: 0o600 });
  assert.equal((await f.engine.wait(first.id)).status, 'SUCCESS');
  assert.equal((await f.engine.attempts(first.id)).length, 1);
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
});

test('cancel intent racing a real durable claim prevents Attempt and child admission before the Workspace lease', async (t) => {
  const code = 'printf "CANCELLED_CLAIM_MUST_NOT_SPAWN\\n"\n';
  const f = await createQueueAuditFixture(t, code, { concurrency: 'ALLOW' });
  let entered, release;
  const reachedClaim = new Promise((resolve) => {
    entered = resolve;
  });
  const continueClaim = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  f.engine.options.fault = async (phase) => {
    if (phase === 'BEFORE_LEASE') {
      entered();
      await continueClaim;
    }
  };
  const queued = await f.engine.submit(f.task.task.id, {
    submissionKey: 'cancel-claimed-ticket',
  });
  await f.engine.tick();
  await reachedClaim;
  const claimed = await f.engine.get(queued.id);
  assert.equal(claimed.status, 'RESOLVING');
  assert.ok(claimed.owner_token);
  assert.equal(claimed.active_workspace_id, null);
  assert.equal((await f.leases.probeWorkspace(f.workspace.id)).busy, false);
  const intent = await f.engine.cancel(queued.id);
  assert.equal(intent.status, 'RESOLVING');
  assert.equal(intent.cancel_requested, 1);
  release();
  const terminal = await f.engine.wait(queued.id);
  assert.equal(terminal.status, 'CANCELLED');
  assert.equal(terminal.cancel_requested, 1);
  assert.equal(terminal.attempt_count, 0);
  assert.equal(terminal.owner_token, null);
  assert.equal(terminal.active_workspace_id, null);
  assert.equal(terminal.source_snapshot, null);
  assert.equal((await f.engine.attempts(queued.id)).length, 0);
  assert.equal(await f.engine.logs(queued.id), '');
  assert.equal(
    (await f.engine.events(queued.id)).filter(
      (event) => event.type === 'CANCEL_REQUESTED',
    ).length,
    1,
  );
  assert.equal(
    (
      await f.engine.submit(f.task.task.id, {
        submissionKey: 'cancel-claimed-ticket',
      })
    ).id,
    queued.id,
  );
  await f.engine.close();
  assert.equal((await f.leases.probeWorkspace(f.workspace.id)).busy, false);
  assert.equal(
    (await f.store.workspace(f.workspace.id)).lifecycle_state,
    'READY',
  );
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 1);
  assert.equal(
    await fs.readFile(path.join(f.roots.path(f.workspace), 'main.sh'), 'utf8'),
    code,
  );
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
});

test('real superseded zero-attempt Run retains audit events and failure health without output, notification, or duplicate submission', async (t) => {
  const f = await createQueueAuditFixture(
    t,
    'printf "REAL_ESTABLISHED_FAILURE\\n"\nexit 9\n',
    { concurrency: 'ALLOW', notification: 'ALWAYS' },
  );
  await f.store.run(
    "INSERT INTO NotificationChannels(name,type,is_default) VALUES('audit local outbox','WEBHOOK',1)",
  );
  await f.store.run(
    'UPDATE TaskNotificationPolicies SET enabled=1,notify_success=1,notify_failure=1,notify_timeout=1,notify_interrupted=1,notify_cancelled=1,notify_recovery=1 WHERE task_id=?',
    [f.task.task.id],
  );
  const failed = await f.engine.wait(
    (
      await f.engine.submit(f.task.task.id)
    ).id,
  );
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.attempt_count, 1);
  const before = (
    await f.store.all('SELECT * FROM TaskHealthStates WHERE task_id=?', [
      f.task.task.id,
    ])
  )[0];
  assert.equal(before.consecutive_failures, 1);
  assert.equal(before.health_state, 'FAILING');
  assert.equal(before.failure_alert_open, 1);
  const outbox = await f.store.all(
    'SELECT * FROM NotificationOutbox WHERE task_id=?',
    [f.task.task.id],
  );
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].event_type, 'FAILED');
  const queued = await f.engine.submit(f.task.task.id, {
    submissionKey: 'audit-superseded',
  });
  await f.store.run(
    "INSERT INTO Envs(name,value,createdAt,updatedAt) VALUES('S2_AUDIT_GLOBAL_CHANGE','safe version mutation',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  );
  const skipped = await f.engine.wait(queued.id);
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(skipped.error_code, 'SOURCE_SUPERSEDED');
  assert.equal(skipped.attempt_count, 0);
  assert.equal(skipped.exit_code, null);
  assert.equal(skipped.signal, null);
  assert.equal(skipped.source_snapshot, null);
  assert.equal((await f.engine.attempts(skipped.id)).length, 0);
  assert.equal(await f.engine.logs(skipped.id), '');
  assert.equal(skipped.log_size, 0);
  const events = await f.engine.events(skipped.id);
  for (const type of [
    'RUN_SUBMITTED',
    'RUN_QUEUED',
    'RUN_SKIPPED',
    'SOURCE_SUPERSEDED',
  ])
    assert.equal(events.filter((event) => event.type === type).length, 1, type);
  assert.equal(
    JSON.parse(
      events.find((event) => event.type === 'SOURCE_SUPERSEDED').metadata,
    ).reason,
    'RESOURCE_CHANGED',
  );
  const after = (
    await f.store.all('SELECT * FROM TaskHealthStates WHERE task_id=?', [
      f.task.task.id,
    ])
  )[0];
  assert.equal(after.last_run_id, skipped.id);
  assert.equal(after.last_terminal_status, 'SKIPPED');
  for (const key of [
    'consecutive_failures',
    'health_state',
    'failure_alert_open',
    'last_failure_at',
    'last_success_at',
  ])
    assert.equal(after[key], before[key], key);
  assert.deepEqual(
    await f.store.all('SELECT * FROM NotificationOutbox WHERE task_id=?', [
      f.task.task.id,
    ]),
    outbox,
  );
  assert.equal(
    (
      await f.engine.submit(f.task.task.id, {
        submissionKey: 'audit-superseded',
      })
    ).id,
    skipped.id,
  );
  await f.engine.tick();
  assert.deepEqual(await f.engine.events(skipped.id), events);
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 2);
  assert.equal((await f.leases.probeWorkspace(f.workspace.id)).busy, false);
  assert.equal(
    await fs.readFile(path.join(f.roots.path(f.workspace), 'main.sh'), 'utf8'),
    'printf "REAL_ESTABLISHED_FAILURE\\n"\nexit 9\n',
  );
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
});
