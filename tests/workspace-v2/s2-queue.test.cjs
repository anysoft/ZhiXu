const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { createFixture } = require('./fixture.cjs');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../back/services/workspaceV2/lease');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  WorkspaceEnvironmentService,
} = require('../../back/services/taskExecutionV2/environment');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Real durable QUEUED metadata only. No Runner or SUCCESS is simulated by these
// bounded-volume fixtures; an actual API submission must reject the next row.
async function seedQueuedCopies(f, taskId, count) {
  const first = await f.execution.submit(taskId);
  if (count > 1)
    await f.store.run(
      `WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM copies WHERE n<?)
    INSERT INTO TaskRuns(task_id,workspace_id,expected_workspace_version,expected_global_env_version,
      expected_task_definition_version,expected_source_generation,expected_content_revision,expected_git_commit,
      expected_inventory_hash,admission_snapshot,trigger_type,status,submitted_at,log_identity,concurrency_policy,
      wait_mode,queue_deadline_at,next_eligible_at,submission_key)
    SELECT t.task_id,t.workspace_id,t.expected_workspace_version,t.expected_global_env_version,
      t.expected_task_definition_version,t.expected_source_generation,t.expected_content_revision,t.expected_git_commit,
      t.expected_inventory_hash,t.admission_snapshot,t.trigger_type,'QUEUED',t.submitted_at,
      t.log_identity||'-queue-fixture-'||copies.n,t.concurrency_policy,t.wait_mode,t.queue_deadline_at,
      t.next_eligible_at,t.submission_key||'-queue-fixture-'||copies.n
    FROM TaskRuns t CROSS JOIN copies WHERE t.id=?`,
      [count - 1, first.id],
    );
}
async function setup(t, options = {}) {
  const f = await createFixture(t);
  f.lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  f.files = new WorkspaceFileService(f.store, f.roots, f.leases);
  f.tasks = new TaskService(f.store, f.roots, f.leases);
  f.env = new WorkspaceEnvironmentService(f.store, f.roots, f.leases);
  f.row = await f.lifecycle.createLocal({
    name: 'queue workspace',
    requestKey: 'queue-workspace',
  });
  f.execution = f.track(
    new TaskExecutionService(f.store, f.roots, f.leases, options),
  );
  return f;
}
async function task(f, name, options = {}) {
  const row = options.workspace ?? f.row;
  const filename = name + '.sh';
  await f.files.create(
    row.id,
    filename,
    options.script ?? 'printf "REAL_SHELL_EXECUTION\\n"\n',
  );
  return f.tasks.create({
    name,
    enabled: options.enabled ?? false,
    arguments: options.args ?? [],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: row.id,
      relative_entrypoint: filename,
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution: {
      concurrency: options.concurrency ?? 'ALLOW',
      timeout_seconds: options.timeout ?? null,
    },
  });
}
async function waitUntil(f, condition, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await f.execution.tick();
    if (await condition()) return;
    await pause(20);
  }
  throw Error('REAL_EXECUTION_CONDITION_TIMEOUT');
}
async function completed(f, id, status = 'SUCCESS') {
  const run = await f.execution.wait(id, 30000);
  assert.equal(
    run.status,
    status,
    JSON.stringify({
      status: run.status,
      error: run.error_code,
      result: run.result,
    }),
  );
  return run;
}
async function hold(f, workspaceId = f.row.id) {
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    ready = new Promise((r) => (entered = r));
  const lifetime = f.leases.withWorkspace(
    workspaceId,
    'S2_ACTUAL_OWNER',
    async () => {
      entered();
      await gate;
    },
  );
  await ready;
  return { release, done: lifetime };
}

test('S2 actual Shell durable queue honors same-Task FORBID and idempotent admission without duplicate attempts', async (t) => {
  const f = await setup(t);
  const a = await task(f, 'forbid', { concurrency: 'FORBID' });
  const first = await f.execution.submit(a.task.id, {
    submissionKey: 'same-key',
  });
  const replay = await f.execution.submit(a.task.id, {
    submissionKey: 'same-key',
  });
  assert.equal(replay.id, first.id);
  const second = await f.execution.submit(a.task.id);
  assert.equal(second.status, 'SKIPPED');
  assert.equal(second.error_code, 'TASK_CONCURRENCY_FORBID');
  assert.equal((await f.execution.attempts(second.id)).length, 0);
  await completed(f, first.id);
  assert.equal((await f.execution.attempts(first.id)).length, 1);
  assert.match(await f.execution.logs(first.id), /REAL_SHELL_EXECUTION/);
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 2);
});

test('S2 same Workspace/different Tasks and repeated ALLOW Tasks serialize actual child critical sections in queue order', async (t) => {
  const f = await setup(t);
  const shared = path.join(f.root, 'critical');
  await fs.mkdir(shared, { mode: 0o700 });
  const script =
    'mkdir "$1/owner" || exit 77\nprintf "%s\\n" "$2" >> "$1/order"\nsleep 0.08\nrmdir "$1/owner"\n';
  const a = await task(f, 'first', { script, args: [shared, 'A'] }),
    b = await task(f, 'second', { script, args: [shared, 'B'] });
  const one = await f.execution.submit(a.task.id),
    two = await f.execution.submit(b.task.id),
    three = await f.execution.submit(a.task.id);
  await completed(f, one.id);
  await completed(f, two.id);
  await completed(f, three.id);
  assert.equal(
    await fs.readFile(path.join(shared, 'order'), 'utf8'),
    'A\nB\nA\n',
  );
  for (const id of [one.id, two.id, three.id])
    assert.equal((await f.execution.attempts(id))[0].exit_code, 0);
});

test('S2 different Workspaces run real children concurrently while their materialization journals remain isolated', async (t) => {
  const f = await setup(t);
  const other = await f.lifecycle.createLocal({
    name: 'independent',
    requestKey: 'independent',
  });
  const script =
    'printf "CHILD_STARTED\\n"\nsleep 1\nprintf "CHILD_FINISHED\\n"\n';
  const a = await task(f, 'parallel-a', { script }),
    b = await task(f, 'parallel-b', { workspace: other, script });
  const one = await f.execution.submit(a.task.id),
    two = await f.execution.submit(b.task.id);
  await waitUntil(f, async () => {
    const logs = await Promise.all([
      f.execution.logs(one.id),
      f.execution.logs(two.id),
    ]);
    return logs.every(
      (s) => s.includes('CHILD_STARTED') && !s.includes('CHILD_FINISHED'),
    );
  });
  await completed(f, one.id);
  await completed(f, two.id);
  assert.equal(
    (
      await f.store.all(
        "SELECT COUNT(*) n FROM TaskRuns WHERE status='SUCCESS'",
      )
    )[0].n,
    2,
  );
});

test('S2 WAIT retains the same Run until actual lease release, SKIP accepts one terminal Run and FAIL_FAST consumes no identity', async (t) => {
  const f = await setup(t);
  const a = await task(f, 'busy');
  const blocker = await hold(f);
  t.after(async () => {
    blocker.release();
    await blocker.done;
  });
  const waiting = await f.execution.submit(a.task.id, {
      waitMode: 'WAIT',
      submissionKey: 'wait',
    }),
    skipping = await f.execution.submit(a.task.id, {
      waitMode: 'SKIP',
      submissionKey: 'skip',
    });
  const before = (await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n;
  await assert.rejects(
    f.execution.submit(a.task.id, {
      waitMode: 'FAIL_FAST',
      submissionKey: 'fast',
    }),
    { error_code: 'WORKSPACE_BUSY' },
  );
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
    before,
  );
  await waitUntil(
    f,
    async () => (await f.execution.get(waiting.id)).queue_attempt_count > 0,
  );
  assert.equal((await f.execution.get(waiting.id)).status, 'QUEUED');
  await f.execution.cancel(waiting.id);
  await completed(f, skipping.id, 'SKIPPED');
  assert.equal(
    (await f.execution.get(skipping.id)).error_code,
    'WORKSPACE_BUSY',
  );
  assert.equal((await f.execution.attempts(skipping.id)).length, 0);
  blocker.release();
  await blocker.done;
  const fast = await f.execution.submit(a.task.id, {
    waitMode: 'FAIL_FAST',
    submissionKey: 'fast',
  });
  await completed(f, fast.id);
});

test('S2 FAIL_FAST accepted probe-race becomes one SKIPPED Run when the real Workspace lease is subsequently held', async (t) => {
  const f = await setup(t);
  const a = await task(f, 'probe-race');
  const run = await f.execution.submit(a.task.id, {
    waitMode: 'FAIL_FAST',
    submissionKey: 'probe-race',
  });
  const blocker = await hold(f);
  t.after(async () => {
    blocker.release();
    await blocker.done;
  });
  await completed(f, run.id, 'SKIPPED');
  assert.equal((await f.execution.get(run.id)).error_code, 'WORKSPACE_BUSY');
  assert.equal((await f.execution.attempts(run.id)).length, 0);
  assert.equal(
    (
      await f.execution.submit(a.task.id, {
        waitMode: 'FAIL_FAST',
        submissionKey: 'probe-race',
      })
    ).id,
    run.id,
  );
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 1);
});

test('S2 pending queue caps apply per Task, Workspace and platform without discarding accepted runs', async (t) => {
  const f = await setup(t, {
    limits: { maxPerTask: 2, maxPerWorkspace: 3, maxQueued: 4 },
  });
  const a = await task(f, 'cap-a'),
    b = await task(f, 'cap-b');
  const other = await f.lifecycle.createLocal({
    name: 'global-cap',
    requestKey: 'global-cap',
  });
  const c = await task(f, 'cap-c', { workspace: other });
  for (let i = 0; i < 2; i++) await f.execution.submit(a.task.id);
  await assert.rejects(f.execution.submit(a.task.id), {
    error_code: 'EXECUTION_QUEUE_FULL',
  });
  await f.execution.submit(b.task.id);
  await assert.rejects(f.execution.submit(b.task.id), {
    error_code: 'EXECUTION_QUEUE_FULL',
  });
  await f.execution.submit(c.task.id);
  await assert.rejects(f.execution.submit(c.task.id), {
    error_code: 'EXECUTION_QUEUE_FULL',
  });
  assert.equal(
    (
      await f.store.all("SELECT COUNT(*) n FROM TaskRuns WHERE status='QUEUED'")
    )[0].n,
    4,
  );
  const defaults = new TaskExecutionService(f.store, f.roots, f.leases);
  assert.deepEqual(
    [
      defaults.limits.maxPerTask,
      defaults.limits.maxPerWorkspace,
      defaults.limits.maxQueued,
    ],
    [32, 128, 1024],
  );
  await defaults.close();
  for (const r of await f.store.all('SELECT id FROM TaskRuns'))
    await f.execution.cancel(r.id);
});

test('S2 default 32-per-Task and 128-per-Workspace boundaries reject the next real submission', async (t) => {
  const f = await setup(t);
  const tasks = [];
  for (let n = 0; n < 5; n++) tasks.push(await task(f, 'default-cap-' + n));
  await seedQueuedCopies(f, tasks[0].task.id, 32);
  await assert.rejects(f.execution.submit(tasks[0].task.id), {
    error_code: 'EXECUTION_QUEUE_FULL',
  });
  assert.equal(
    (
      await f.store.all("SELECT COUNT(*) n FROM TaskRuns WHERE status='QUEUED'")
    )[0].n,
    32,
  );
  for (const a of tasks.slice(1, 4)) await seedQueuedCopies(f, a.task.id, 32);
  await assert.rejects(f.execution.submit(tasks[4].task.id), {
    error_code: 'EXECUTION_QUEUE_FULL',
  });
  assert.equal(
    (
      await f.store.all("SELECT COUNT(*) n FROM TaskRuns WHERE status='QUEUED'")
    )[0].n,
    128,
  );
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
});

test('S2 default 1024-global queue boundary rejects a new independent Workspace while preserving all accepted IDs', async (t) => {
  const f = await setup(t);
  const first = await task(f, 'global-0');
  await seedQueuedCopies(f, first.task.id, 32);
  for (let n = 1; n < 32; n++) {
    const row = await f.lifecycle.createLocal({
      name: 'global-volume-' + n,
      requestKey: 'global-volume-' + n,
    });
    const a = await task(f, 'global-' + n, { workspace: row });
    await seedQueuedCopies(f, a.task.id, 32);
  }
  const extra = await f.lifecycle.createLocal({
    name: 'global-next',
    requestKey: 'global-next',
  });
  const a = await task(f, 'global-next', { workspace: extra });
  const before = await f.store.all('SELECT id FROM TaskRuns ORDER BY id');
  assert.equal(before.length, 1024);
  await assert.rejects(f.execution.submit(a.task.id), {
    error_code: 'EXECUTION_QUEUE_FULL',
  });
  assert.deepEqual(
    await f.store.all('SELECT id FROM TaskRuns ORDER BY id'),
    before,
  );
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM TaskRunAttempts'))[0].n,
    0,
  );
});

test('S2 absolute waiting deadline and queued cancellation terminate without Attempt or child', async (t) => {
  const f = await setup(t, { limits: { waitTimeoutMs: 100 } });
  const a = await task(f, 'deadline');
  const owner = await hold(f);
  t.after(async () => {
    owner.release();
    await owner.done;
  });
  const run = await f.execution.submit(a.task.id);
  await completed(f, run.id, 'SKIPPED');
  assert.equal(
    (await f.execution.get(run.id)).error_code,
    'WORKSPACE_WAIT_TIMEOUT',
  );
  assert.equal((await f.execution.attempts(run.id)).length, 0);
  const cancellation = await f.execution.submit(a.task.id);
  await f.execution.cancel(cancellation.id);
  assert.equal((await f.execution.get(cancellation.id)).status, 'CANCELLED');
  assert.equal((await f.execution.attempts(cancellation.id)).length, 0);
  assert.equal((await f.store.workspace(f.row.id)).lifecycle_state, 'READY');
});

test('S2 queued Run survives a real Store restart with same ID, absolute deadline and one eventual real Attempt', async (t) => {
  const f = await setup(t);
  const a = await task(f, 'restart');
  const before = await f.execution.submit(a.task.id, {
    submissionKey: 'restart-key',
  });
  await f.execution.close();
  await f.store.close();
  const store = f.track(await WorkspaceStore.open(f.databasePath, f.dataRoot));
  const roots = new WorkspaceRootResolver(f.dataRoot),
    leases = new WorkspaceLeaseService(
      f.dataRoot,
      new PlatformBackupBarrier(f.controlRoot),
    );
  f.store = store;
  f.execution = f.track(new TaskExecutionService(store, roots, leases));
  const replay = await f.execution.submit(a.task.id, {
    submissionKey: 'restart-key',
  });
  assert.equal(replay.id, before.id);
  assert.equal(replay.queue_deadline_at, before.queue_deadline_at);
  await completed(f, replay.id);
  assert.equal((await f.execution.attempts(replay.id)).length, 1);
  assert.equal((await store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 1);
});

for (const change of ['source', 'global', 'profile', 'task'])
  test(`S2 queued ${change} supersession is SKIPPED with zero Attempt, no injection and no implicit replacement Run`, async (t) => {
    const f = await setup(t);
    let a = await task(f, 'superseded');
    let profile;
    if (change === 'profile') {
      profile = await f.env.createProfile(
        f.row.id,
        (
          await f.store.workspace(f.row.id)
        ).version,
        { name: 'queued-profile' },
      );
      await f.env.selectWorkspaceProfile(
        f.row.id,
        (
          await f.store.workspace(f.row.id)
        ).version,
        profile.id,
      );
    }
    const run = await f.execution.submit(a.task.id, {
      submissionKey: 'old-source',
    });
    if (change === 'source') {
      const prior = await f.files.read(f.row.id, 'superseded.sh');
      await f.files.save(
        f.row.id,
        'superseded.sh',
        'printf "MUST_NOT_EXECUTE\\n"\n',
        prior.hash,
      );
    }
    if (change === 'global')
      await f.env.replaceGlobals(
        (
          await f.store.all('SELECT version FROM GlobalEnvironmentRevision')
        )[0].version,
        [
          {
            name: 'NEW_VALUE',
            operation: 'SET',
            status: 'enabled',
            is_secret: true,
            value: 'must not reach child',
          },
        ],
      );
    if (change === 'profile')
      await f.env.replaceProfileVariables(profile.id, profile.version, [
        {
          name: 'PROFILE_VALUE',
          operation: 'SET',
          status: 'enabled',
          is_secret: false,
          value: 'new',
        },
      ]);
    if (change === 'task')
      await f.tasks.update(a.task.id, a.task.version, {
        arguments: ['changed'],
      });
    const done = await completed(f, run.id, 'SKIPPED');
    assert.equal(done.error_code, 'SOURCE_SUPERSEDED');
    assert.equal((await f.execution.attempts(run.id)).length, 0);
    assert.equal(
      (await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
      1,
    );
    assert.equal(await f.execution.logs(run.id), '');
    assert.equal(
      await fs
        .lstat(path.join(f.roots.path(f.row), 'node_modules'))
        .catch(() => null),
      null,
    );
  });

test('S2 durable Cron event uses WAIT and submission identity atomically links exactly one real Run', async (t) => {
  const f = await setup(t);
  const a = await task(f, 'cron', { enabled: true });
  const now = new Date().toISOString();
  const trigger = (
    await f.store.run(
      "INSERT INTO TaskTriggers(task_id,type,origin,enabled,createdAt,updatedAt) VALUES(?,'CRON','USER',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
      [a.task.id],
    )
  ).lastID;
  await f.store.run(
    "INSERT INTO CronTriggers(trigger_id,expression,timezone,misfire_policy,next_fire_at,createdAt,updatedAt) VALUES(?,'* * * * *','UTC','SKIP',?,?,?)",
    [trigger, now, now, now],
  );
  const event = (
    await f.store.run(
      "INSERT INTO TriggerEvents(trigger_id,origin_trigger_id,task_id,workspace_id,event_key,trigger_type,received_at) VALUES(?,?,?,?,?,'CRON',?)",
      [trigger, trigger, a.task.id, f.row.id, 'slot:' + now, now],
    )
  ).lastID;
  const one = await f.execution.submit(a.task.id, {
    eventId: event,
    triggerType: 'CRON',
    waitMode: 'SKIP',
  });
  assert.equal(one.wait_mode, 'WAIT');
  assert.equal(
    (
      await f.execution.submit(a.task.id, {
        eventId: event,
        triggerType: 'CRON',
      })
    ).id,
    one.id,
  );
  await completed(f, one.id);
  assert.equal(
    (
      await f.store.all(
        'SELECT task_run_id,status FROM TriggerEvents WHERE id=?',
        [event],
      )
    )[0].task_run_id,
    one.id,
  );
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 1);
  assert.equal((await f.execution.attempts(one.id)).length, 1);
});

test('S2 actual execution blocks same-Workspace editing and backup; archive safely waits for the child', async (t) => {
  const f = await setup(t);
  const a = await task(f, 'protected', {
    script: 'printf "ACTIVE_CHILD\\n"\nsleep 0.8\n',
  });
  const run = await f.execution.submit(a.task.id);
  await waitUntil(f, async () =>
    (await f.execution.logs(run.id)).includes('ACTIVE_CHILD'),
  );
  await assert.rejects(
    f.files.create(f.row.id, 'must-not-be-created.sh', 'true'),
    { error_code: 'WORKSPACE_BUSY' },
  );
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  await assert.rejects(backup.create(50));
  const archiving = f.lifecycle.archive(
    f.row.id,
    (await f.store.workspace(f.row.id)).version,
    { requestKey: 'archive-owned-run', drainTimeoutMs: 5000 },
  );
  await completed(f, run.id);
  const archived = await archiving;
  assert.equal(archived.lifecycle_state, 'ARCHIVED');
  assert.equal(
    (await f.store.all('SELECT enabled FROM Tasks WHERE id=?', [a.task.id]))[0]
      .enabled,
    0,
  );
  assert.equal(
    await fs
      .lstat(path.join(f.roots.path(f.row), 'must-not-be-created.sh'))
      .catch(() => null),
    null,
  );
  assert.equal(
    await fs.readFile(path.join(f.roots.path(f.row), 'protected.sh'), 'utf8'),
    'printf "ACTIVE_CHILD\\n"\nsleep 0.8\n',
  );
});
