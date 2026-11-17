const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('../workspace-v2/fixture.cjs');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const { BackupOperations } = require('../../back/services/backup/operations');
const {
  ScheduledBackupService,
} = require('../../back/services/backup/scheduled');

test('remote queue failure preserves local SUCCESS and next tick retries only upload intent', async (t) => {
  const f = await createFixture(t);
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const operations = f.track(new BackupOperations(backup.paths));
  let failures = 1,
    queued = [],
    ticks = 0,
    closed = false;
  const remote = {
    async enqueueScheduled(id) {
      if (failures-- > 0)
        throw Object.assign(new Error('write failed'), {
          code: 'BACKUP_REMOTE_STATE_WRITE_FAILED',
        });
      queued.push(id);
    },
    async pendingSnapshotIds() {
      return queued;
    },
    async tick() {
      ticks++;
    },
    async close() {
      closed = true;
    },
  };
  const service = f.track(
    new ScheduledBackupService(backup, operations, { remote }),
  );
  await service.saveSettings({ enabled: false });
  const accepted = await service.runNow();
  await operations.wait(accepted.id);
  assert.equal((await operations.get(accepted.id)).status, 'SUCCESS');
  const local = (await service.history()).items[0];
  assert.equal(local.status, 'SUCCESS');
  assert.equal(local.remote_error_code, 'BACKUP_REMOTE_STATE_WRITE_FAILED');
  assert.equal((await backup.list()).length, 1);
  await service.tick();
  assert.deepEqual(queued, [local.snapshot_id]);
  assert.equal((await backup.list()).length, 1, 'no duplicate local snapshot');
  assert.equal((await service.history()).items[0].remote_enqueued, true);
  assert.equal(
    ticks,
    1,
    'remote worker runs even with daily local schedule disabled',
  );
  await service.close();
  assert.equal(closed, true);
});

test('local scheduled retention skips a snapshot still needed by an upload', async (t) => {
  const f = await createFixture(t);
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const operations = f.track(new BackupOperations(backup.paths));
  const pending = new Set();
  const remote = {
    async enqueueScheduled(id) {
      pending.add(id);
    },
    async pendingSnapshotIds() {
      return [...pending];
    },
    async tick() {},
    async close() {},
  };
  const service = f.track(
    new ScheduledBackupService(backup, operations, { remote }),
  );
  await service.saveSettings({ retain_count: 1 });
  for (let n = 0; n < 2; n++) {
    const handle = await service.runNow();
    await operations.wait(handle.id);
    assert.equal((await operations.get(handle.id)).status, 'SUCCESS');
  }
  assert.equal((await backup.list()).length, 2);
  pending.clear();
  const handle = await service.runNow();
  await operations.wait(handle.id);
  assert.equal((await backup.list()).length, 1);
});
