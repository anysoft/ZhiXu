const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSyncFixture } = require('./sync-fixture.cjs');
test('S3-SYNC-001 initial baseline and real FF atomically publish one outbox, unchanged is NO_CHANGE', async (t) => {
  const f = await createSyncFixture(t, {
    caseId: 'S3-SYNC-001',
    files: { 'one.sh': 'echo first\n' },
  });
  const initial = await f.sync.submit(f.row.id, { requestKey: 'initial' });
  const a = await f.sync.wait(initial.id);
  assert.equal(a.status, 'SUCCESS', a.error_code);
  assert.equal(a.initial, 1);
  assert.equal(a.before_commit, a.after_commit);
  assert.equal(a.git_update_status, 'UNCHANGED');
  const ws = await f.store.workspace(f.row.id);
  assert.equal(ws.source_generation, f.row.source_generation);
  const again = await f.sync.submit(f.row.id, { requestKey: 'initial' });
  assert.equal(again.id, a.id);
  const no = await f.sync.wait(
    (
      await f.sync.submit(f.row.id, { requestKey: 'same' })
    ).id,
  );
  assert.equal(no.status, 'NO_CHANGE', no.error_code);
  const target = await f.commit({
    'one.sh': 'echo second\n',
    'two.sh': 'echo added\n',
  });
  const b = await f.sync.wait(
    (
      await f.sync.submit(f.row.id, { requestKey: 'ff' })
    ).id,
  );
  assert.equal(b.status, 'SUCCESS', b.error_code);
  assert.equal(b.after_commit, target);
  assert.equal(b.git_update_status, 'APPLIED');
  assert.equal(
    (await f.store.workspace(f.row.id)).content_revision,
    ws.content_revision + 1,
  );
  assert.equal(
    (await f.store.all('SELECT * FROM WorkspaceUpdateOutbox')).length,
    2,
  );
  assert.equal((await f.store.all('PRAGMA foreign_key_check')).length, 0);
  await f.scenario.record('S3-SYNC-001', {
    workspace_id: f.row.id,
    repository_id: f.repository.id,
    initial_sync_run: a.id,
    ff_sync_run: b.id,
    before_commit: b.before_commit,
    target_commit: target,
    actual_commit: b.actual_commit,
    status: b.status,
    outbox_id: b.update_outbox_id,
  });
});
test('S3-SYNC-002 dirty source remains byte identical and no success or event is invented', async (t) => {
  const f = await createSyncFixture(t, { caseId: 'S3-SYNC-002' });
  await fs.writeFile(
    path.join(f.workspaceRoot, 'main.py'),
    'print("private")\n',
  );
  const before = await fs.readFile(path.join(f.workspaceRoot, 'main.py'));
  const run = await f.sync.wait((await f.sync.submit(f.row.id)).id);
  assert.equal(run.status, 'BLOCKED', run.error_code);
  assert.equal(run.error_code, 'DIRTY_WORKTREE');
  assert.deepEqual(
    await fs.readFile(path.join(f.workspaceRoot, 'main.py')),
    before,
  );
  assert.equal(
    (await f.store.all('SELECT * FROM WorkspaceUpdateOutbox')).length,
    0,
  );
});
test('S3-SYNC-003 duplicate concurrent manual request has one durable run; other request gets active conflict', async (t) => {
  const f = await createSyncFixture(t, { caseId: 'S3-SYNC-003' });
  const [a, b] = await Promise.all([
    f.sync.submit(f.row.id, { requestKey: 'one' }),
    f.sync.submit(f.row.id, { requestKey: 'one' }),
  ]);
  assert.equal(a.id, b.id);
  await assert.rejects(
    f.sync.submit(f.row.id, { requestKey: 'two' }),
    (e) => e.error_code === 'SYNC_ALREADY_RUNNING',
  );
  await f.sync.cancel(a.id);
  assert.equal((await f.sync.get(a.id)).status, 'CANCELLED');
});
