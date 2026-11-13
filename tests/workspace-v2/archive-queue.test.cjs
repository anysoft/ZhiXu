const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createFixture, insertTaskSource } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');

// Candidate metadata only: no execution resolver, queue dispatcher or Runner.
async function queuedReference(store, taskId, workspaceId) {
  const ws = await store.workspace(workspaceId);
  const task = (
    await store.all('SELECT version FROM Tasks WHERE id=?', [taskId])
  )[0];
  const global = (
    await store.all(
      'SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1',
    )
  )[0];
  const now = new Date().toISOString();
  const deadline = new Date(Date.now() + 60000).toISOString();
  return (
    await store.run(
      `INSERT INTO TaskRuns(task_id,workspace_id,expected_workspace_version,
    expected_global_env_version,expected_task_definition_version,expected_source_generation,
    expected_content_revision,expected_inventory_hash,admission_snapshot,trigger_type,status,
    submitted_at,log_identity,concurrency_policy,queue_deadline_at,next_eligible_at)
    VALUES(?,?,?,?,?,?,?,?,?,'MANUAL','QUEUED',?,?,'ALLOW',?,?)`,
      [
        taskId,
        workspaceId,
        ws.version,
        global.version,
        task.version,
        ws.source_generation,
        ws.content_revision,
        ws.content_inventory_hash,
        JSON.stringify({ workspace_id: workspaceId }),
        now,
        'queued-reference-' + randomUUID(),
        deadline,
        now,
      ],
    )
  ).lastID;
}

test('stable queued candidate metadata survives backup and archive cancels it only after actual owner drain', async (t) => {
  const f = await createFixture(t);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const row = await lifecycle.createLocal({
    name: 'queued reference',
    requestKey: 'queue-create',
  });
  await files.create(row.id, 'main.py', 'print("source preserved")\n');
  const task = await insertTaskSource(f.store, row.id);
  await f.store.run('UPDATE Tasks SET enabled=1,version=version+1 WHERE id=?', [
    task,
  ]);
  const runId = await queuedReference(f.store, task, row.id);
  const before = (
    await f.store.all('SELECT * FROM TaskRuns WHERE id=?', [runId])
  )[0];
  const snapshot = await backup.create();
  const manifest = (await backup.snapshot(snapshot)).manifest;
  assert.equal(
    manifest.workspaces[0].sync_discovery_event_references.queued_runs[0].id,
    runId,
  );
  assert.deepEqual(
    (await f.store.all('SELECT * FROM TaskRuns WHERE id=?', [runId]))[0],
    before,
  );
  let release;
  let entered;
  const admission = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const holder = f.leases.withWorkspace(
    row.id,
    'QUEUE_REFERENCE_OWNER',
    async () => {
      entered();
      await wait;
    },
  );
  t.after(async () => {
    release();
    await holder;
  });
  await admission;
  await assert.rejects(
    lifecycle.archive(row.id, row.version, {
      requestKey: 'queue-timeout',
      drainTimeoutMs: 50,
    }),
    { error_code: 'WORKSPACE_BUSY' },
  );
  assert.equal(
    (await f.store.all('SELECT status FROM TaskRuns WHERE id=?', [runId]))[0]
      .status,
    'QUEUED',
  );
  assert.equal(
    (await f.store.all('SELECT enabled FROM Tasks WHERE id=?', [task]))[0]
      .enabled,
    1,
  );
  release();
  await holder;
  const archived = await lifecycle.archive(row.id, row.version, {
    requestKey: 'queue-archive',
  });
  const after = (
    await f.store.all('SELECT * FROM TaskRuns WHERE id=?', [runId])
  )[0];
  assert.equal(after.status, 'CANCELLED');
  assert.equal(after.error_code, 'WORKSPACE_ARCHIVED');
  assert.equal(after.queue_deadline_at, before.queue_deadline_at);
  assert.equal(after.admission_snapshot, before.admission_snapshot);
  assert.equal(
    (await f.store.all('SELECT enabled FROM Tasks WHERE id=?', [task]))[0]
      .enabled,
    0,
  );
  await lifecycle.unarchive(row.id, archived.version, 'queue-unarchive');
  assert.equal(
    (await f.store.all('SELECT status FROM TaskRuns WHERE id=?', [runId]))[0]
      .status,
    'CANCELLED',
  );
  assert.equal(
    (await f.store.all('SELECT enabled FROM Tasks WHERE id=?', [task]))[0]
      .enabled,
    0,
  );
});
