const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createSyncFixture, syncServices } = require('./sync-fixture.cjs');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');
const {
  WorkspaceBackupService,
} = require('../../../back/services/workspaceV2/backup');

test('S3 terminal SUCCESS journal cleanup tolerates another real controller removing an enumerated journal before owner acquisition', async (t) => {
  const started = performance.now();
  let injectedAfterCommit = false;
  const f = await createSyncFixture(t, {
    caseId: 'S3-SYNC-SUCCESS-CLEANUP-RACE',
    files: { 'one.sh': 'printf "OWNED_SUCCESS_SOURCE\\n"\n' },
    fault: async (point) => {
      if (point === 'AFTER_DB_COMMIT') {
        injectedAfterCommit = true;
        throw Error('qualified post-commit interruption');
      }
    },
  });
  const submitted = await f.sync.submit(f.row.id, {
    requestKey: 'genuine-initial-success',
  });
  const successful = await f.sync.wait(submitted.id);
  await f.sync.close();
  assert.equal(injectedAfterCommit, true);
  assert.equal(successful.status, 'SUCCESS');
  assert.equal(successful.update_outbox_id, successful.id);
  const journalFile = path.join(
    f.dataRoot,
    'tmp/workspace-v2/sync',
    `sync-${successful.id}.json`,
  );
  const originalJournal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  assert.equal(originalJournal.run_id, successful.id);
  assert.equal(originalJournal.workspace_id, f.row.id);
  const facts = async (store) => ({
    sync: await store.all('SELECT * FROM WorkspaceSyncRuns ORDER BY id'),
    outbox: await store.all('SELECT * FROM WorkspaceUpdateOutbox ORDER BY id'),
    workspaces: await store.all('SELECT * FROM Workspaces ORDER BY id'),
    git: await store.all('SELECT * FROM GitWorkspaces ORDER BY workspace_id'),
    tasks: await store.all('SELECT * FROM Tasks ORDER BY id'),
    events: await store.all('SELECT * FROM TriggerEvents ORDER BY id'),
    runs: await store.all('SELECT * FROM TaskRuns ORDER BY id'),
  });
  const before = await facts(f.store);
  assert.equal(before.sync.length, 1);
  assert.equal(before.outbox.length, 1);
  assert.equal(before.tasks.length, 0);
  assert.equal(before.runs.length, 0);
  const storeB = f.track(await WorkspaceStore.open(f.databasePath, f.dataRoot));
  assert.notEqual(storeB, f.store);
  const controllerA = await syncServices(f);
  let entered, release;
  const enumerated = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let pausedCount = 0;
  const controllerB = await syncServices(
    { ...f, store: storeB },
    {
      fault: async (point, metadata) => {
        if (point !== 'BEFORE_SUCCESS_JOURNAL_CLEANUP_OWNER') return;
        assert.equal(metadata.sync_run_id, successful.id);
        assert.equal(
          (await controllerB.sync.get(successful.id)).status,
          'SUCCESS',
        );
        pausedCount++;
        entered();
        await gate;
      },
    },
  );
  const recoveringB = controllerB.sync.recover().then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  await Promise.race([
    enumerated,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error('S3_CLEANUP_ENUMERATION_DEADLINE')),
        15000,
      );
      timer.unref();
    }),
  ]);
  assert.ok((await fs.lstat(journalFile)).isFile());
  // B has enumerated the real success journal but has not acquired its owner FD.
  // A now takes that actual FD and the platform barrier and finishes cleanup.
  await controllerA.sync.recover();
  await assert.rejects(fs.lstat(journalFile), { code: 'ENOENT' });
  assert.deepEqual(await facts(f.store), before);
  release();
  const outcome = await recoveringB;
  assert.equal(
    outcome.ok,
    true,
    outcome.error?.error_code || outcome.error?.code,
  );
  assert.equal(pausedCount, 1);
  assert.deepEqual(await facts(storeB), before);
  await controllerB.sync.recover();
  assert.equal(pausedCount, 1);
  assert.deepEqual(await facts(f.store), before);
  assert.equal(
    await fs.readFile(path.join(f.workspaceRoot, 'one.sh'), 'utf8'),
    'printf "OWNED_SUCCESS_SOURCE\\n"\n',
  );
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const snapshotId = await backup.create();
  const snapshot = await backup.snapshot(snapshotId);
  assert.equal(snapshot.manifest.backup_id, snapshotId);
  assert.deepEqual(await facts(f.store), before);
  await f.scenario.record('S3-SYNC-SUCCESS-CLEANUP-RACE', {
    status: 'PASS',
    duration_ms: performance.now() - started,
    exit_code: 0,
    input:
      'Actual Sync SUCCESS transaction followed by injected AFTER_DB_COMMIT error leaves a genuine durable journal; two independent Store/controller instances race cleanup',
    expected:
      'Second controller tolerates journal disappearance under the acquired owner FD without changing committed SQL facts',
    actual: {
      sync_run_id: successful.id,
      sync_status: successful.status,
      outbox_id: successful.id,
      sync_rows: 1,
      outbox_rows: 1,
      task_rows: 0,
      trigger_events: 0,
      task_runs: 0,
      paused_before_owner_acquisition: pausedCount,
      original_journal_removed_by_controller_A: true,
      controller_B_recovery_completed_without_ENOENT: outcome.ok,
      committed_facts_sha256: createHash('sha256')
        .update(JSON.stringify(before))
        .digest('hex'),
      subsequent_backup_id: snapshotId,
    },
    assertions: [
      'no mocked/fabricated successful Sync row',
      'independent real SQLite connections and controller services',
      'A cleans up while B is paused after enumeration and before actual owner FD',
      'B resumes and handles only the proved missing journal',
      'one immutable SUCCESS and one Outbox unchanged',
      'zero extra Task/Event/Run',
      'actual source bytes unchanged',
      'fresh Backup validates successfully',
    ],
  });
});
