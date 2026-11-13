const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSyncFixture } = require('./sync-fixture.cjs');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
async function baseline(f) {
  const run = await f.sync.wait(
    (
      await f.sync.submit(f.row.id, { requestKey: 'initial' })
    ).id,
  );
  assert.equal(run.status, 'SUCCESS', run.error_code);
  await f.discovery.savePolicy(f.row.id, {
    expected_version: (await f.discovery.policy(f.row.id)).version,
    enabled: true,
    includes: ['**/*.sh'],
    excludes: [],
    languages: ['SHELL'],
  });
  return f.store.workspace(f.row.id);
}
test('S3-FAIL-001 actual invalid discovered Cron after physical FF retains fence, old DB tuple and no success event', async (t) => {
  const f = await createSyncFixture(t, { caseId: 'S3-FAIL-001' }),
    old = await baseline(f);
  const target = await f.commit({
    'invalid.sh': '# cron: invalid cron\nprintf invalid\n',
  });
  const run = await f.sync.wait(
    (
      await f.sync.submit(f.row.id, { requestKey: 'invalid-discovery' })
    ).id,
  );
  assert.equal(run.status, 'RECOVERY_REQUIRED', run.error_code);
  assert.equal(run.error_code, 'DISCOVERY_RECONCILIATION_FAILED');
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspaceRoot), target);
  const current = await f.store.workspace(f.row.id);
  assert.equal(current.lifecycle_state, 'RECOVERY_REQUIRED');
  assert.equal(current.content_revision, old.content_revision);
  assert.equal(current.content_inventory_hash, old.content_inventory_hash);
  assert.equal(
    (
      await f.store.all(
        'SELECT id FROM WorkspaceUpdateOutbox WHERE sync_run_id=?',
        [run.id],
      )
    ).length,
    0,
  );
  assert.equal((await f.store.all('SELECT id FROM Tasks')).length, 0);
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  await assert.rejects(
    files.create(f.row.id, 'user.txt', 'cannot bypass'),
    (e) => e.error_code === 'WORKSPACE_RECOVERY_REQUIRED',
  );
  const bytes = await fs.readFile(path.join(f.workspaceRoot, 'invalid.sh'));
  await f.sync.recover();
  assert.equal((await f.sync.get(run.id)).status, 'RECOVERY_REQUIRED');
  assert.deepEqual(
    await fs.readFile(path.join(f.workspaceRoot, 'invalid.sh')),
    bytes,
  );
  await f.scenario.record('S3-FAIL-001', {
    sync_run_id: run.id,
    status: run.status,
    physical_commit: target,
    old_content_revision: old.content_revision,
    outbox_count: 0,
    task_count: 0,
    no_reset: true,
  });
});
test('S3-FAIL-002 actual SQLite outbox abort rolls back Discovery/Workspace/SUCCESS together, then formal recovery commits once', async (t) => {
  const f = await createSyncFixture(t, { caseId: 'S3-FAIL-002' }),
    old = await baseline(f);
  const target = await f.commit({
    'discovered.sh': '# name: Transactional discovery\nprintf new\n',
  });
  // Fault lives only in this private candidate DB. The frozen DDL file is untouched.
  await f.store.exec(
    "CREATE TRIGGER s3_outbox_abort BEFORE INSERT ON WorkspaceUpdateOutbox BEGIN SELECT RAISE(ABORT,'S3_TEST_COMMIT_FAILURE'); END",
  );
  const run = await f.sync.wait(
    (
      await f.sync.submit(f.row.id, { requestKey: 'sql-abort' })
    ).id,
  );
  assert.equal(run.status, 'RECOVERY_REQUIRED', run.error_code);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspaceRoot), target);
  const blocked = await f.store.workspace(f.row.id);
  assert.equal(blocked.lifecycle_state, 'RECOVERY_REQUIRED');
  assert.equal(blocked.content_revision, old.content_revision);
  assert.equal(blocked.content_inventory_hash, old.content_inventory_hash);
  assert.equal((await f.store.all('SELECT id FROM Tasks')).length, 0);
  assert.equal(
    (
      await f.store.all(
        'SELECT id FROM WorkspaceUpdateOutbox WHERE sync_run_id=?',
        [run.id],
      )
    ).length,
    0,
  );
  await f.store.exec('DROP TRIGGER s3_outbox_abort');
  await f.store.verifySchema();
  await f.sync.recover();
  const recovered = await f.sync.get(run.id);
  assert.equal(recovered.status, 'SUCCESS', recovered.error_code);
  assert.equal(recovered.after_commit, target);
  assert.equal((await f.store.all('SELECT id FROM Tasks')).length, 1);
  assert.equal(
    (
      await f.store.all(
        'SELECT id FROM WorkspaceUpdateOutbox WHERE sync_run_id=?',
        [run.id],
      )
    ).length,
    1,
  );
  assert.equal(
    (await f.store.workspace(f.row.id)).content_revision,
    old.content_revision + 1,
  );
  await f.sync.recover();
  assert.equal((await f.store.all('SELECT id FROM Tasks')).length, 1);
  assert.equal((await f.store.all('PRAGMA foreign_key_check')).length, 0);
  await f.scenario.record('S3-FAIL-002', {
    sync_run_id: run.id,
    status: recovered.status,
    before_commit: run.before_commit,
    target_commit: target,
    actual_commit: recovered.actual_commit,
    rollback_task_count: 0,
    final_task_count: 1,
    outbox_count: 1,
    revision_increment: 1,
    frozen_schema_verified: true,
  });
});
