const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncFixture, syncServices } = require('./sync-fixture.cjs');
const { seedRepository } = require('../fixture.cjs');
const { createLocalGitAccess } = require('./git-fixture.cjs');
const { pathToFileURL } = require('node:url');

test('cancel after real HEAD advance fences first then formally reconciles actual applied target', async (t) => {
  let f,
    cancelAfterHead = false;
  f = await createSyncFixture(t, {
    caseId: 'S3-CANCEL-AFTER-HEAD',
    fault: async (phase, details) => {
      if (cancelAfterHead && phase === 'AFTER_PHYSICAL_HEAD_CHANGED')
        await f.sync.cancel(details.sync_run_id);
    },
  });
  const baseline = await f.sync.wait((await f.sync.submit(f.row.id)).id);
  assert.equal(baseline.status, 'SUCCESS', baseline.error_code);
  const target = await f.commit({
    'main.py': 'print("actually applied before cancellation")\n',
  });
  cancelAfterHead = true;
  const cancelled = await f.sync.wait((await f.sync.submit(f.row.id)).id);
  assert.equal(cancelled.status, 'RECOVERY_REQUIRED');
  assert.equal(cancelled.cancel_requested, 1);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspaceRoot), target);
  assert.equal(cancelled.after_commit, null);
  assert.equal(
    (await f.store.workspace(f.row.id)).lifecycle_state,
    'RECOVERY_REQUIRED',
  );
  await f.sync.recover();
  const completed = await f.sync.get(cancelled.id);
  assert.equal(completed.status, 'SUCCESS', completed.error_code);
  assert.equal(completed.after_commit, target);
  assert.equal(completed.git_update_status, 'APPLIED');
  assert.equal((await f.store.workspace(f.row.id)).lifecycle_state, 'READY');
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM WorkspaceUpdateOutbox'))[0].n,
    2,
  );
  await f.scenario.record('S3-CANCEL-AFTER-HEAD', {
    sync_run_id: completed.id,
    before_commit: baseline.after_commit,
    after_commit: target,
    initial_state: cancelled.status,
    recovered_state: completed.status,
    cancel_requested: completed.cancel_requested,
    outboxes: 2,
  });
});

test('Task queued before Sync stays queued under real apply fence then skips changed source with zero Attempt', async (t) => {
  let reached, release;
  const entered = new Promise((resolve) => {
      reached = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  let hold = false;
  const f = await createSyncFixture(t, {
    caseId: 'S3-QUEUED-TASK-FENCE',
    files: { 'main.sh': 'echo old-source-must-not-run\n' },
    fault: async (phase) => {
      if (hold && phase === 'AFTER_PHYSICAL_HEAD_CHANGED') {
        reached();
        await gate;
      }
    },
  });
  t.after(() => release());
  const baseline = await f.sync.wait((await f.sync.submit(f.row.id)).id);
  assert.equal(baseline.status, 'SUCCESS', baseline.error_code);
  const task = await f.tasks.create({
    name: 'queued original source',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: f.row.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  const queued = await f.engine.submit(task.task.id);
  const target = await f.commit({
    'main.sh': 'echo new-source-must-not-be-absorbed\n',
  });
  hold = true;
  const run = await f.sync.submit(f.row.id);
  await f.sync.tick();
  await entered;
  assert.equal(
    (await f.store.workspace(f.row.id)).lifecycle_state,
    'RECOVERY_REQUIRED',
  );
  await f.engine.tick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const parked = await f.engine.get(queued.id);
  assert.equal(parked.status, 'QUEUED');
  assert.equal(parked.attempt_count, 0);
  assert.equal((await f.engine.attempts(queued.id)).length, 0);
  release();
  const applied = await f.sync.wait(run.id);
  assert.equal(applied.status, 'SUCCESS', applied.error_code);
  assert.equal(applied.after_commit, target);
  const skipped = await f.engine.wait(queued.id);
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(skipped.result_code, 'SKIPPED');
  assert.equal(skipped.error_code, 'SOURCE_SUPERSEDED');
  assert.equal(skipped.attempt_count, 0);
  assert.equal((await f.engine.attempts(queued.id)).length, 0);
  assert.equal((await f.engine.logs(queued.id)).includes('must-not-'), false);
  await f.scenario.record('S3-QUEUED-TASK-FENCE', {
    sync_run_id: applied.id,
    task_run_id: skipped.id,
    queued_under_fence: true,
    final_status: skipped.status,
    result_code: skipped.result_code,
    error_code: skipped.error_code,
    attempts: 0,
    before_commit: baseline.after_commit,
    after_commit: target,
  });
});

test('Sync global active claim cap holds across distinct controllers/repositories sharing one DB', async (t) => {
  let entered, release;
  const reached = new Promise((resolve) => {
      entered = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const f = await createSyncFixture(t, {
    caseId: 'S3-GLOBAL-SYNC-CAP',
    maxActive: 1,
    fault: async (phase) => {
      if (phase === 'DURING_FETCH') {
        entered();
        await gate;
      }
    },
  });
  t.after(() => release());
  const secondRepo = await seedRepository(f.instance, 2),
    remote = pathToFileURL(secondRepo.source).href;
  await f.store.run(
    'UPDATE Repositories SET remote_url=?,normalized_url=? WHERE id=?',
    [remote, remote, 2],
  );
  const secondAccess = await createLocalGitAccess(f.instance, secondRepo),
    firstAccess = f.accessResolver;
  const composite = async (row) =>
    row.id === 1 ? firstAccess(row) : secondAccess(row);
  const second = await syncServices(
    { ...f, accessResolver: composite },
    { maxActive: 1 },
  );
  await f.leases.withRepository(2, 'CAP_INITIAL_FETCH', (lease) =>
    second.gitAdapter.fetch(2, lease),
  );
  const row = await f.lifecycle.createGit({
    name: 'independent cap repository',
    requestKey: require('node:crypto').randomUUID(),
    repositoryId: 2,
    refType: 'branch',
    refName: 'main',
  });
  await second.policies.save(row.id, {
    expected_version: 1,
    enabled: true,
    mode: 'MANUAL',
    schedule: null,
  });
  const firstRun = await f.sync.submit(f.row.id);
  await f.sync.tick();
  await reached;
  const secondRun = await second.sync.submit(row.id);
  await second.sync.tick();
  const claimDeadline = Date.now() + 30000;
  // Wait for the second real owner/repository-FD claim attempt to finish. A
  // fixed sleep could observe QUEUED before that controller had reached SQL.
  while (second.sync.active.has(secondRun.id)) {
    if (Date.now() > claimDeadline) throw Error('SECOND_CLAIM_DID_NOT_FINISH');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    (
      await f.store.all(
        "SELECT COUNT(*) n FROM WorkspaceSyncRuns WHERE status='RUNNING'",
      )
    )[0].n,
    1,
  );
  assert.equal((await second.sync.get(secondRun.id)).status, 'QUEUED');
  assert.equal((await second.sync.get(secondRun.id)).owner_token, null);
  release();
  assert.equal((await f.sync.wait(firstRun.id)).status, 'SUCCESS');
  assert.equal((await second.sync.wait(secondRun.id)).status, 'SUCCESS');
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM WorkspaceUpdateOutbox'))[0].n,
    2,
  );
  await f.scenario.record('S3-GLOBAL-SYNC-CAP', {
    controllers: 2,
    repository_ids: [1, 2],
    global_cap: 1,
    max_observed_running: 1,
    second_waited_queued: true,
    sync_run_ids: [firstRun.id, secondRun.id],
  });
});
