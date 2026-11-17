const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createFixture } = require('../workspace-v2/fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const { BackupOperations } = require('../../back/services/backup/operations');
const { RemoteBackupService } = require('../../back/services/backup/remote');
const {
  parseRemoteBackupKey,
} = require('../../back/services/backup/remoteKeys');
const { ProxyManagement } = require('../../back/services/proxyManagement');

async function fixture(t) {
  const f = await createFixture(t);
  const workspace = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'Remote backup local', requestKey: randomUUID() });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    workspace.id,
    'main.sh',
    'echo remote-backup-secret-body\n',
  );
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const operations = f.track(new BackupOperations(backup.paths));
  const objects = new Map(),
    deletes = [],
    uploads = [];
  let time = new Date('2030-01-01T19:00:00.000Z');
  const control = { fail: false, mismatch: false, block: null };
  const storageFactory = () => ({
    async testConnection() {
      if (control.fail) throw new Error('secret-address:secret-password');
    },
    async upload(key, file, onProgress) {
      uploads.push(key);
      if (control.fail) throw new Error('secret-address:secret-password');
      if (control.block) await control.block;
      const body = await fs.readFile(file);
      assert.equal(body.subarray(0, 8).toString(), 'PLATBKP1');
      assert.equal(
        body.includes(Buffer.from('remote-backup-secret-body')),
        false,
      );
      objects.set(key, body);
      onProgress?.(body.length);
      return { key, size: body.length, last_modified: time.toISOString() };
    },
    async stat(key) {
      return objects.has(key)
        ? {
            key,
            size: objects.get(key).length + (control.mismatch ? 1 : 0),
            last_modified: time.toISOString(),
          }
        : null;
    },
    async list() {
      return [...objects].map(([key, body]) => ({
        key,
        size: body.length,
        last_modified: time.toISOString(),
      }));
    },
    async download(key, file) {
      await fs.writeFile(file, objects.get(key), { flag: 'wx', mode: 0o600 });
      return {
        key,
        size: objects.get(key).length,
        last_modified: time.toISOString(),
      };
    },
    async delete(key) {
      deletes.push(key);
      objects.delete(key);
    },
    close() {},
  });
  const options = {
    now: () => new Date(time),
    retryDelayMs: 100,
    storageFactory,
  };
  const remote = f.track(new RemoteBackupService(backup, operations, options));
  const target = await remote.saveTarget({
    name: 'Test remote',
    type: 'WEBDAV',
    endpoint: 'http://127.0.0.1:9999/dav',
    directory: 'backups',
    username: 'user',
    password: 'remote-password',
  });
  await remote.saveSettings({
    passphrase: 'independently-saved-recovery-key',
    target_id: target.id,
  });
  async function done(service = remote) {
    await service.tick();
    for (let attempt = 0; attempt < 500; attempt++) {
      const records = await service.uploads();
      if (
        records.every(
          (entry) => !['WAITING', 'UPLOADING'].includes(entry.status),
        )
      ) {
        for (const entry of records)
          if (entry.operation_id) await operations.wait(entry.operation_id);
        return service.uploads();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error('REMOTE_TEST_TIMEOUT');
  }
  const scheduledSnapshot = () =>
    backup.create(1000, 'LIGHTWEIGHT', {
      source: 'SCHEDULED',
      scheduled: {
        cycle_key: randomUUID(),
        scheduled_at: time.toISOString(),
        attempt: 1,
      },
    });
  return {
    ...f,
    scheduledSnapshot,
    workspace,
    backup,
    operations,
    remote,
    target,
    objects,
    deletes,
    uploads,
    control,
    options,
    done,
    advance(ms = 1000) {
      time = new Date(time.getTime() + ms);
    },
  };
}

test('remote target and settings CRUD masks credentials, preserves omitted secrets, protects selected target', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.remote.getSettings(), {
    enabled: false,
    target_id: f.target.id,
    retain_count: 14,
    has_passphrase: true,
  });
  assert.equal(f.target.has_password, true);
  assert.equal(
    JSON.stringify(await f.remote.listTargets()).includes('remote-password'),
    false,
  );
  await f.remote.saveTarget({ name: 'Renamed remote' }, f.target.id);
  const stored = JSON.parse(
    (await f.store.all("SELECT info FROM Auths WHERE type='remoteBackup'"))[0]
      .info,
  );
  assert.equal(stored.targets[0].password, 'remote-password');
  assert.equal(
    JSON.stringify(await f.remote.getSettings()).includes(
      'independently-saved',
    ),
    false,
  );
  await assert.rejects(
    f.remote.deleteTarget(f.target.id),
    /BACKUP_REMOTE_TARGET_IN_USE/,
  );
  await assert.rejects(
    f.remote.saveSettings({ retain_count: 0 }),
    /BACKUP_REMOTE_CONFIGURATION_INVALID/,
  );
  await assert.rejects(
    f.remote.saveTarget({
      name: 'bad',
      type: 'WEBDAV',
      endpoint: 'http://user:password@localhost',
    }),
    /BACKUP_REMOTE_CONFIGURATION_INVALID/,
  );
  await f.remote.saveSettings({ target_id: null });
  await f.remote.deleteTarget(f.target.id);
  assert.equal((await f.remote.listTargets()).length, 0);
});

test('manual FULL and LIGHTWEIGHT upload use encrypted Portable, stable keys, confirmed size and downloads', async (t) => {
  const f = await fixture(t);
  for (const mode of ['FULL', 'LIGHTWEIGHT']) {
    const snapshot = await f.backup.create(1000, mode);
    const upload = await f.remote.enqueue(snapshot, f.target.id);
    const duplicate = await f.remote.enqueue(snapshot, f.target.id);
    assert.equal(duplicate.id, upload.id);
    const result = (await f.done()).find((entry) => entry.id === upload.id);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.source, 'MANUAL');
    assert.equal(result.mode, mode);
    await assert.rejects(
      f.remote.retry(result.id),
      /BACKUP_REMOTE_UPLOAD_NOT_RETRYABLE/,
    );
    assert.equal(result.size, f.objects.get(upload.key).length);
    assert.equal(parseRemoteBackupKey(upload.key).backup_id, snapshot);
    const downloaded = await f.remote.download(f.target.id, upload.key);
    assert.deepEqual(await fs.readFile(downloaded), f.objects.get(upload.key));
    await fs.unlink(downloaded);
    assert.deepEqual(await fs.readdir(path.join(f.backupRoot, 'exports')), []);
  }
  assert.equal((await f.remote.listObjects(f.target.id)).length, 2);
  assert.equal((await f.backup.list()).length, 2);
  await assert.rejects(
    f.remote.deleteObject(f.target.id, 'unrelated-object'),
    /BACKUP_REMOTE_OBJECT_INVALID/,
  );
});

test('upload failure leaves local snapshot successful; retries and restart reuse snapshot and key', async (t) => {
  const f = await fixture(t);
  await f.remote.saveSettings({ enabled: true });
  const snapshot = await f.scheduledSnapshot();
  const queued = await f.remote.enqueueScheduled(snapshot);
  f.control.fail = true;
  let result = (await f.done())[0];
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error_code, 'BACKUP_REMOTE_REQUEST_FAILED');
  assert.equal(result.attempt, 1);
  assert.ok(result.retry_at);
  assert.equal((await f.backup.list()).length, 1);
  assert.equal(f.deletes.length, 0);
  f.control.fail = false;
  f.advance(101);
  const restarted = f.track(
    new RemoteBackupService(f.backup, f.operations, f.options),
  );
  result = (await f.done(restarted))[0];
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.id, queued.id);
  assert.equal(result.attempt, 2);
  assert.equal(new Set(f.uploads).size, 1);
  assert.equal((await f.backup.list()).length, 1);
  assert.equal(
    JSON.stringify(await restarted.uploads()).includes('secret-password'),
    false,
  );
});

test('remote automatic retention keeps newest 14 while both manual modes and unknown objects survive', async (t) => {
  const f = await fixture(t);
  await f.remote.saveSettings({ enabled: true, retain_count: 14 });
  const manualKeys = [];
  for (const mode of ['FULL', 'LIGHTWEIGHT']) {
    const snapshot = await f.backup.create(1000, mode);
    manualKeys.push((await f.remote.enqueue(snapshot, f.target.id)).key);
    await f.done();
  }
  f.objects.set('unrelated-application/keep.txt', Buffer.from('keep'));
  for (let index = 0; index < 16; index++) {
    const snapshot = await f.scheduledSnapshot();
    await f.remote.enqueueScheduled(snapshot);
    await f.done();
    f.advance();
  }
  const objects = await f.remote.listObjects(f.target.id);
  assert.equal(
    objects.filter((entry) => entry.source === 'SCHEDULED').length,
    14,
  );
  assert.equal(f.deletes.length, 2);
  assert.ok(manualKeys.every((key) => f.objects.has(key)));
  assert.ok(f.objects.has('unrelated-application/keep.txt'));
  assert.ok(
    f.deletes.every((key) => parseRemoteBackupKey(key)?.source === 'SCHEDULED'),
  );
  await fs.unlink(f.remote.stateFile);
  const afterLoss = await f.scheduledSnapshot();
  await f.remote.enqueueScheduled(afterLoss);
  await f.done();
  assert.equal(
    (await f.remote.listObjects(f.target.id)).filter(
      (entry) => entry.source === 'SCHEDULED',
    ).length,
    14,
  );
  assert.ok(manualKeys.every((key) => f.objects.has(key)));
  assert.ok(f.objects.has('unrelated-application/keep.txt'));
});

test('size confirmation failure does not trigger retention; failed uploads stop after two retries', async (t) => {
  const f = await fixture(t);
  await f.remote.saveSettings({ enabled: true, retain_count: 1 });
  const old = await f.scheduledSnapshot();
  await f.remote.enqueueScheduled(old);
  await f.done();
  const snapshot = await f.scheduledSnapshot();
  await f.remote.enqueueScheduled(snapshot);
  f.control.mismatch = true;
  let result = (await f.done())[0];
  assert.equal(result.error_code, 'BACKUP_REMOTE_CONFIRMATION_FAILED');
  for (let index = 0; index < 2; index++) {
    f.advance(101);
    result = (await f.done())[0];
  }
  assert.equal(result.attempt, 3);
  assert.equal(result.retry_at, null);
  assert.equal(f.deletes.length, 0);
  assert.deepEqual(await f.remote.pendingSnapshotIds(), []);
  await f.remote.retry(result.id);
  f.control.mismatch = false;
  result = (await f.done())[0];
  assert.equal(result.status, 'SUCCESS');
  assert.equal(f.deletes.length, 1);
});

test('existing backup operation delays upload admission and active target cannot be edited/deleted', async (t) => {
  const f = await fixture(t);
  const snapshot = await f.backup.create(1000, 'FULL');
  const queued = await f.remote.enqueue(snapshot, f.target.id);
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const operation = await f.operations.start('TEST_OWNER', () => barrier);
  await f.remote.tick();
  assert.equal((await f.remote.uploads())[0].status, 'WAITING');
  release();
  await f.operations.wait(operation.id);
  let releaseUpload;
  f.control.block = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  await f.remote.tick();
  for (let i = 0; i < 100 && !f.uploads.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(
    f.remote.saveTarget({ name: 'Cannot edit active' }, f.target.id),
    /BACKUP_REMOTE_TARGET_BUSY/,
  );
  await assert.rejects(
    f.remote.deleteTarget(f.target.id),
    /BACKUP_REMOTE_TARGET_BUSY/,
  );
  releaseUpload();
  const result = (await f.done()).find((entry) => entry.id === queued.id);
  assert.equal(result.status, 'SUCCESS');
});

test('restart discovers interrupted upload, resumes same object and bounds interrupted final attempt', async (t) => {
  const f = await fixture(t);
  const snapshot = await f.backup.create(1000, 'FULL');
  const queued = await f.remote.enqueue(snapshot, f.target.id);
  let state = JSON.parse(await fs.readFile(f.remote.stateFile, 'utf8'));
  state.uploads[0].status = 'UPLOADING';
  state.uploads[0].attempt = 1;
  await fs.writeFile(f.remote.stateFile, JSON.stringify(state));
  const restarted = f.track(
    new RemoteBackupService(f.backup, f.operations, f.options),
  );
  let result = (await f.done(restarted))[0];
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.attempt, 2);
  assert.equal(result.key, queued.key);
  assert.equal((await f.backup.list()).length, 1);
  state = JSON.parse(await fs.readFile(f.remote.stateFile, 'utf8'));
  state.uploads[0].status = 'UPLOADING';
  state.uploads[0].attempt = 3;
  await fs.writeFile(f.remote.stateFile, JSON.stringify(state));
  await restarted.tick();
  result = (await restarted.uploads())[0];
  assert.equal(result.status, 'FAILED');
  assert.equal(result.attempt, 3);
  assert.equal(result.error_code, 'BACKUP_REMOTE_UPLOAD_INTERRUPTED');
  assert.equal(result.retry_at, null);
});

test('remote metadata preserves manual-upload classification of an automatic snapshot and rejects forged automatic source', async (t) => {
  const f = await fixture(t);
  const snapshot = await f.scheduledSnapshot();
  const uploaded = await f.remote.enqueue(snapshot, f.target.id, 'MANUAL');
  assert.equal(parseRemoteBackupKey(uploaded.key).source, 'MANUAL');
  await f.done();
  const manual = await f.backup.create(1000, 'LIGHTWEIGHT');
  await assert.rejects(
    f.remote.enqueue(manual, f.target.id, 'SCHEDULED'),
    /BACKUP_REMOTE_SOURCE_INVALID/,
  );
});

test('proxy profiles referenced by remote targets report usage and cannot be deleted until unselected', async (t) => {
  const f = await fixture(t);
  const proxies = new ProxyManagement(f.store, f.backup.barrier);
  const profile = await proxies.save({
    name: 'Backup proxy',
    protocol: 'HTTP',
    host: '127.0.0.1',
    port: 8080,
    status: 'enabled',
  });
  await f.remote.saveTarget(
    { proxy: { mode: 'PROFILE', profile_id: profile.id } },
    f.target.id,
  );
  const referenced = (await proxies.list()).find(
    (entry) => entry.id === profile.id,
  );
  assert.ok(
    referenced.used_by.some((reference) => reference.scope === 'remote_backup'),
  );
  await assert.rejects(proxies.remove(profile.id), /PROXY_PROFILE_IN_USE/);
  await f.remote.saveTarget({ proxy: { mode: 'DIRECT' } }, f.target.id);
  await proxies.remove(profile.id);
  assert.equal((await proxies.list()).length, 0);
});
