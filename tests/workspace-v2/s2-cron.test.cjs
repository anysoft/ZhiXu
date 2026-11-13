const test = require('node:test');
const assert = require('node:assert/strict');
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
const {
  WorkspaceCronSubmissions,
} = require('../../back/services/taskExecutionV2/cron');
test('candidate Cron misfire SKIP creates no Run; FIRE_ONCE creates one durable real Runner execution and replay keeps its identity', async (t) => {
  const f = await createFixture(t);
  const ws = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'cron', requestKey: 'cron' });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    ws.id,
    'main.sh',
    'printf "ACTUAL_CRON_RUN\\n"\n',
  );
  const tasks = new TaskService(f.store, f.roots, f.leases),
    engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  const source = {
    type: 'WORKSPACE_ENTRYPOINT',
    workspace_id: ws.id,
    relative_entrypoint: 'main.sh',
    language: 'SHELL',
    cwd_mode: 'WORKSPACE_ROOT',
    cwd_relative_path: null,
  };
  const a = await tasks.create({ name: 'skip', enabled: true, source }),
    b = await tasks.create({ name: 'once', enabled: true, source });
  let time = new Date('2026-01-01T00:00:00.000Z');
  const cron = new WorkspaceCronSubmissions(
    f.store,
    f.roots,
    f.leases,
    engine,
    { now: () => time },
  );
  const skip = await cron.create(a.task.id, {
    expression: '* * * * *',
    timezone: 'UTC',
    misfirePolicy: 'SKIP',
  });
  const once = await cron.create(b.task.id, {
    expression: '* * * * *',
    timezone: 'UTC',
    misfirePolicy: 'FIRE_ONCE',
  });
  time = new Date('2026-01-01T00:05:30.000Z');
  await cron.tick();
  const events = await f.store.all('SELECT * FROM TriggerEvents ORDER BY id');
  assert.equal(events.length, 2);
  const ignored = events.find((e) => e.origin_trigger_id === skip),
    accepted = events.find((e) => e.origin_trigger_id === once);
  assert.equal(ignored.status, 'SKIPPED');
  assert.equal(ignored.error_code, 'CRON_MISFIRE_SKIPPED');
  assert.equal(ignored.task_run_id, null);
  assert.equal(accepted.status, 'SUBMITTED');
  assert.ok(accepted.task_run_id);
  const run = await engine.wait(accepted.task_run_id);
  assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
  assert.equal(run.wait_mode, 'WAIT');
  assert.match(await engine.logs(run.id), /ACTUAL_CRON_RUN/);
  await cron.tick();
  assert.equal((await f.store.all('SELECT id FROM TaskRuns')).length, 1);
  assert.equal(
    (
      await engine.submit(b.task.id, {
        triggerType: 'CRON',
        eventId: accepted.id,
        waitMode: 'SKIP',
      })
    ).id,
    run.id,
  );
  for (const row of await f.store.all('SELECT next_fire_at FROM CronTriggers'))
    assert.ok(new Date(row.next_fire_at) > time);
});
