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

async function setup(t, code, execution = {}) {
  const f = await createFixture(t);
  const ws = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'engine', requestKey: 'engine-root' });
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  await files.create(ws.id, 'main.sh', code);
  const tasks = new TaskService(f.store, f.roots, f.leases);
  const task = await tasks.create({
    name: 'real shell',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: ws.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution,
  });
  const engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  return { ...f, ws, files, tasks, task, engine };
}
test('real candidate TaskRun uses Workspace source, real Runner, durable attempt and redacted log', async (t) => {
  const f = await setup(
    t,
    'printf "candidate-stdout\\n"; printf "candidate-stderr\\n" >&2\n',
  );
  const submitted = await f.engine.submit(f.task.task.id, {
    submissionKey: 'engine-first',
  });
  assert.equal(submitted.status, 'QUEUED');
  const run = await f.engine.wait(submitted.id);
  assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
  assert.equal(run.attempt_count, 1);
  assert.equal(run.active_workspace_id, null);
  assert.match(await f.engine.logs(run.id), /candidate-stdout/);
  assert.match(await f.engine.logs(run.id), /candidate-stderr/);
  const source = JSON.parse(run.source_snapshot);
  assert.equal(source.workspace_id, f.ws.id);
  assert.equal(source.workspace_type, 'LOCAL');
  assert.equal(source.git, null);
  assert.equal('worktree_id' in source, false);
  assert.equal('repository_id' in source, false);
  assert.equal((await f.engine.attempts(run.id))[0].status, 'SUCCESS');
  assert.equal(
    (await f.engine.submit(f.task.task.id, { submissionKey: 'engine-first' }))
      .id,
    run.id,
  );
  assert.equal((await f.store.all('PRAGMA foreign_key_check')).length, 0);
});
test('real retries retain one TaskRun and source identity while recording each actual attempt', async (t) => {
  const f = await setup(
    t,
    'if [ "$PLATFORM_TASK_ATTEMPT" = 1 ]; then exit 7; fi\nprintf "second-actual-attempt\\n"\n',
    { max_attempts: 2, initial_delay_seconds: 0, concurrency: 'ALLOW' },
  );
  const queued = await f.engine.submit(f.task.task.id);
  const run = await f.engine.wait(queued.id);
  assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
  assert.equal(run.attempt_count, 2);
  assert.deepEqual(
    (await f.engine.attempts(run.id)).map((a) => a.status),
    ['FAILED', 'SUCCESS'],
  );
  assert.equal((await f.store.all('SELECT id FROM TaskRuns')).length, 1);
  assert.match(await f.engine.logs(run.id), /second-actual-attempt/);
  const after = await f.store.workspace(f.ws.id);
  assert.equal(
    after.content_revision,
    JSON.parse(run.source_snapshot).content_revision,
  );
});

test('a failed child cannot rewrite its entrypoint and run replacement bytes as the next retry', async (t) => {
  const f = await setup(
    t,
    'printf \'printf "REPLACEMENT_MUST_NOT_RUN\\\\n"\\n\' > main.sh\nexit 3\n',
    { max_attempts: 2, initial_delay_seconds: 0, concurrency: 'ALLOW' },
  );
  const row = await f.engine.submit(f.task.task.id);
  const run = await f.engine.wait(row.id);
  assert.equal(run.status, 'FAILED');
  assert.equal(run.error_code, 'SOURCE_SUPERSEDED');
  assert.equal(run.attempt_count, 1);
  assert.equal((await f.engine.attempts(run.id)).length, 1);
  assert.doesNotMatch(await f.engine.logs(run.id), /REPLACEMENT_MUST_NOT_RUN/);
});

test('TaskSource custom CWD and its ancestors cannot be renamed or removed through platform files', async (t) => {
  const f = await setup(t, 'printf "cwd reference\\n"\n');
  await f.files.createDirectory(f.ws.id, 'working');
  await f.files.createDirectory(f.ws.id, 'working/custom');
  const task = await f.tasks.get(f.task.task.id);
  await f.tasks.update(task.task.id, task.task.version, {
    source: {
      ...task.source,
      cwd_mode: 'CUSTOM_RELATIVE',
      cwd_relative_path: 'working/custom',
    },
  });
  for (const relative of ['working', 'working/custom']) {
    await assert.rejects(
      f.files.rename(f.ws.id, relative, 'moved', '0'.repeat(64)),
      { error_code: 'WORKSPACE_FILE_REFERENCED' },
    );
    await assert.rejects(f.files.remove(f.ws.id, relative, '0'.repeat(64)), {
      error_code: 'WORKSPACE_FILE_REFERENCED',
    });
  }
  assert.equal((await f.tasks.readiness(task.task.id)).status, 'READY');
});

test('ordinary failure before Workspace acquisition cannot manufacture a live Workspace reference', async (t) => {
  const f = await setup(t, 'printf "must not spawn\\n"\n');
  const engine = f.track(
    new TaskExecutionService(f.store, f.roots, f.leases, {
      fault: async (phase) => {
        if (phase === 'BEFORE_LEASE') throw Error('injected before lease');
      },
    }),
  );
  const queued = await engine.submit(f.task.task.id);
  const run = await engine.wait(queued.id);
  assert.equal(run.status, 'FAILED');
  assert.equal(run.attempt_count, 0);
  assert.equal(run.active_workspace_id, null);
  assert.equal((await f.store.workspace(f.ws.id)).lifecycle_state, 'READY');
});

test('superseded audit distinguishes Global resource, Task definition and source changes with no child attempts', async (t) => {
  const f = await setup(t, 'printf "MUST_NOT_EXECUTE\\n"\n');
  const resource = await f.engine.submit(f.task.task.id);
  await f.store.run(
    "INSERT INTO Envs(name,value,createdAt,updatedAt) VALUES('RESOURCE_CHANGE','fixture',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  );
  let run = await f.engine.wait(resource.id);
  assert.equal(run.status, 'SKIPPED');
  const reason = async (id) =>
    JSON.parse(
      (await f.engine.events(id)).find((e) => e.type === 'SOURCE_SUPERSEDED')
        .metadata,
    ).reason;
  assert.equal(await reason(run.id), 'RESOURCE_CHANGED');
  assert.equal(run.attempt_count, 0);
  const definition = await f.engine.submit(f.task.task.id);
  const current = await f.tasks.get(f.task.task.id);
  await f.tasks.update(current.task.id, current.task.version, {
    name: 'changed definition',
  });
  run = await f.engine.wait(definition.id);
  assert.equal(run.status, 'SKIPPED');
  assert.equal(await reason(run.id), 'TASK_CHANGED');
  const source = await f.engine.submit(f.task.task.id);
  const previous = await f.files.read(f.ws.id, 'main.sh');
  await f.files.save(
    f.ws.id,
    'main.sh',
    'printf "NEW_SOURCE_MUST_NOT_EXECUTE\\n"\n',
    previous.hash,
  );
  run = await f.engine.wait(source.id);
  assert.equal(run.status, 'SKIPPED');
  assert.equal(await reason(run.id), 'SOURCE_CHANGED');
  assert.equal((await f.engine.attempts(run.id)).length, 0);
});
