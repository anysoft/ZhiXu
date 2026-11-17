const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
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
const {
  WorkspaceRestoreService,
} = require('../../back/services/workspaceV2/restore');
const {
  WorkspacePreservationService,
} = require('../../back/services/workspaceV2/preservation');
const { BackupOperations } = require('../../back/services/backup/operations');
const {
  ScheduledBackupService,
} = require('../../back/services/backup/scheduled');
const {
  WorkspaceFoundationError,
} = require('../../back/services/workspaceV2/errors');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');

const digest = (value) => createHash('sha256').update(value).digest('hex');

async function scheduledBackupFixture(t, options = {}) {
  const f = await createFixture(t);
  const workspace = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({
    name: 'Scheduled local data',
    requestKey: randomUUID(),
  });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    workspace.id,
    'main.sh',
    'printf "scheduled-local-data\\n"\n',
  );
  let time = new Date(options.now ?? '2030-01-01T18:59:00.000Z');
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
    options.backupOptions,
  );
  const operations = f.track(new BackupOperations(backup.paths));
  const clock = () => new Date(time);
  const settings = { now: clock, waitTimeoutMs: 25, ...options.serviceOptions };
  const service = f.track(
    new ScheduledBackupService(backup, operations, settings),
  );
  const current = async () => (await service.history()).items;
  const complete = async (handle) => {
    assert.equal(typeof handle.id, 'string');
    const end = Date.now() + 20000;
    for (;;) {
      const operation = await operations.get(handle.id);
      if (['SUCCESS', 'FAILED'].includes(operation.status)) {
        await operations.wait(handle.id);
        return operations.get(handle.id);
      }
      if (Date.now() >= end) throw Error('SCHEDULED_TEST_OPERATION_DEADLINE');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const automatic = async () => {
    const operation = await complete(await service.runNow());
    assert.equal(operation.status, 'SUCCESS', JSON.stringify(operation));
    return (
      (await current()).find((entry) => entry.id === operation.id) ??
      (await current())[0]
    );
  };
  return {
    ...f,
    workspace,
    backup,
    operations,
    service,
    clock,
    settings,
    current,
    complete,
    automatic,
    setTime(value) {
      time = new Date(value);
    },
    advance(milliseconds) {
      time = new Date(time.getTime() + milliseconds);
    },
  };
}

test('daily schedule uses explicit timezone, defaults to 03:00 and creates one LIGHTWEIGHT cycle', async (t) => {
  const f = await scheduledBackupFixture(t);
  const defaults = await f.service.getSettings();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.time, '03:00');
  assert.equal(defaults.timezone, 'Asia/Shanghai');
  assert.equal(defaults.retain_count, 3);
  assert.equal(defaults.mode, 'LIGHTWEIGHT');
  assert.equal(defaults.next_run_at, '2030-01-01T19:00:00.000Z');
  await f.service.tick();
  assert.equal((await f.backup.list()).length, 0);
  f.setTime('2030-01-01T19:00:00.000Z');
  await f.service.tick();
  const snapshots = await f.backup.list();
  assert.equal(snapshots.length, 1);
  const snapshot = await f.backup.snapshot(snapshots[0].id);
  assert.equal(snapshot.manifest.backup_mode, 'LIGHTWEIGHT');
  assert.equal(snapshot.manifest.source, 'SCHEDULED');
  assert.equal(snapshot.manifest.scheduled.attempt, 1);
  assert.equal(snapshot.manifest.workspaces[0].workspace_type, 'LOCAL');
  assert.equal(
    await fs.readFile(
      path.join(snapshot.root, 'data', f.workspace.root_key, 'main.sh'),
      'utf8',
    ),
    'printf "scheduled-local-data\\n"\n',
  );
  await f.service.tick();
  assert.equal((await f.backup.list()).length, 1);
  assert.equal(
    (await f.service.getSettings()).next_run_at,
    '2030-01-02T19:00:00.000Z',
  );
  const history = await f.current();
  assert.equal(history[0].status, 'SUCCESS');
  assert.equal(history[0].source, 'SCHEDULED');
  assert.equal(history[0].mode, 'LIGHTWEIGHT');
  assert.equal(history[0].size, snapshot.manifest.total_bytes);
  assert.ok(history[0].duration_ms >= 0);
});

test('platform timezone, settings edits and disable survive a new service instance', async (t) => {
  const f = await scheduledBackupFixture(t);
  await f.store.run(
    "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('systemConfig',?,?,?)",
    [
      JSON.stringify({ timezone: 'America/New_York' }),
      f.clock().toISOString(),
      f.clock().toISOString(),
    ],
  );
  assert.equal((await f.service.getSettings()).timezone, 'America/New_York');
  const changed = await f.service.saveSettings({
    enabled: false,
    time: '08:15',
    timezone: 'Europe/Berlin',
    retain_count: 5,
  });
  assert.equal(changed.enabled, false);
  assert.equal(changed.next_run_at, null);
  f.advance(10 * 86400000);
  await f.service.tick();
  assert.equal((await f.backup.list()).length, 0);
  await f.service.close();
  const restarted = f.track(
    new ScheduledBackupService(
      f.backup,
      f.track(new BackupOperations(f.backup.paths)),
      f.settings,
    ),
  );
  const persisted = await restarted.getSettings();
  assert.equal(persisted.time, '08:15');
  assert.equal(persisted.timezone, 'Europe/Berlin');
  assert.equal(persisted.retain_count, 5);
  const enabled = await restarted.saveSettings({ enabled: true });
  assert.ok(Date.parse(enabled.next_run_at) > f.clock().getTime());
  for (const invalid of [
    { time: '25:00' },
    { time: '3:00' },
    { timezone: 'not-a-zone' },
    { retain_count: 0 },
    { enabled: 'yes' },
    { mode: 'FULL' },
  ])
    await assert.rejects(restarted.saveSettings(invalid));
});

test('restart catches up at most one missed day and the DST repeated hour cannot duplicate a local cycle', async (t) => {
  const f = await scheduledBackupFixture(t);
  await f.service.getSettings();
  await f.service.close();
  f.setTime('2030-01-10T20:00:00.000Z');
  const restarted = f.track(
    new ScheduledBackupService(
      f.backup,
      f.track(new BackupOperations(f.backup.paths)),
      f.settings,
    ),
  );
  await restarted.tick();
  assert.equal((await f.backup.list()).length, 1);
  await restarted.tick();
  assert.equal((await f.backup.list()).length, 1);
  assert.ok(
    Date.parse((await restarted.getSettings()).next_run_at) >
      f.clock().getTime(),
  );

  const fold = await scheduledBackupFixture(t, {
    now: '2030-11-03T05:29:00.000Z',
  });
  await fold.service.saveSettings({
    time: '01:30',
    timezone: 'America/New_York',
  });
  fold.setTime('2030-11-03T05:30:00.000Z');
  await fold.service.tick();
  assert.equal((await fold.backup.list()).length, 1);
  fold.setTime('2030-11-03T06:30:00.000Z');
  await fold.service.tick();
  assert.equal((await fold.backup.list()).length, 1);
});

test('failed automatic cycles retry twice at fifteen-minute intervals without pruning valid snapshots', async (t) => {
  let failing = false;
  const f = await scheduledBackupFixture(t, {
    backupOptions: {
      fault: async (point) => {
        if (failing && point === 'backup-before-copy')
          throw new WorkspaceFoundationError('DISK_BUDGET_EXCEEDED', 413);
      },
    },
  });
  const manual = await f.backup.create(600000, 'FULL');
  await f.service.getSettings();
  failing = true;
  f.setTime('2030-01-01T19:00:00.000Z');
  await f.service.tick();
  let history = await f.current();
  assert.equal(history[0].status, 'FAILED');
  assert.equal(history[0].error_code, 'DISK_BUDGET_EXCEEDED');
  assert.equal(
    (await f.service.getSettings()).retry_at,
    '2030-01-01T19:15:00.000Z',
  );
  f.setTime('2030-01-01T19:14:59.000Z');
  await f.service.tick();
  assert.equal((await f.current()).length, 1);
  f.setTime('2030-01-01T19:15:00.000Z');
  await f.service.tick();
  assert.equal(
    (await f.service.getSettings()).retry_at,
    '2030-01-01T19:30:00.000Z',
  );
  f.setTime('2030-01-01T19:30:00.000Z');
  await f.service.tick();
  assert.equal((await f.service.getSettings()).retry_at, null);
  f.setTime('2030-01-01T22:00:00.000Z');
  await f.service.tick();
  history = await f.current();
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((entry) => entry.attempt).sort(), [1, 2, 3]);
  assert.ok(
    history.every(
      (entry) => entry.mode === 'LIGHTWEIGHT' && entry.source === 'SCHEDULED',
    ),
  );
  assert.deepEqual(
    (await f.backup.list()).map((entry) => entry.id),
    [manual],
  );
  assert.equal((await f.backup.snapshot(manual)).manifest.backup_mode, 'FULL');
});

test('only successful scheduled snapshots are pruned; manual modes, legacy provenance and held snapshots survive', async (t) => {
  const f = await scheduledBackupFixture(t);
  await f.service.saveSettings({ retain_count: 3 });
  const manualFull = await f.backup.create(600000, 'FULL');
  const manualLight = await f.backup.create(600000, 'LIGHTWEIGHT');
  const unknown = await f.backup.create(600000, 'FULL');
  const legacy = await f.backup.snapshot(unknown);
  delete legacy.manifest.source;
  delete legacy.manifest.scheduled;
  await fs.writeFile(
    path.join(legacy.root, 'manifest.json'),
    JSON.stringify(legacy.manifest) + '\n',
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(legacy.root, 'READY'),
    JSON.stringify({
      manifest_sha256: digest(JSON.stringify(legacy.manifest) + '\n'),
    }) + '\n',
    { mode: 0o600 },
  );
  const verify = f.backup.snapshot.bind(f.backup);
  const manualIds = new Set([manualFull, manualLight, unknown]);
  let manualVerificationReads = 0;
  f.backup.snapshot = async (id) => {
    if (manualIds.has(id)) manualVerificationReads++;
    return verify(id);
  };
  const automaticIds = [];
  for (let index = 0; index < 4; index++) {
    const result = await f.automatic();
    assert.equal(result.status, 'SUCCESS');
    automaticIds.push(result.snapshot_id);
    f.advance(1000);
  }
  f.backup.snapshot = verify;
  assert.equal(
    manualVerificationReads,
    0,
    'automatic catalog passes do not fully rescan unrelated manual payloads',
  );
  const ids = (await f.backup.list()).map((entry) => entry.id);
  assert.ok(!ids.includes(automaticIds[0]));
  for (const id of [...automaticIds.slice(1), manualFull, manualLight, unknown])
    assert.ok(ids.includes(id), 'expected protected snapshot ' + id);
  assert.equal(ids.length, 6);
  assert.equal((await f.backup.snapshot(manualFull)).manifest.source, 'MANUAL');
  assert.equal(
    (await f.backup.snapshot(manualLight)).manifest.source,
    'MANUAL',
  );
  assert.equal((await f.backup.snapshot(unknown)).manifest.source, undefined);

  const heldId = automaticIds[1];
  const preservation = new WorkspacePreservationService(f.backup);
  const row = await f.store.workspace(f.workspace.id);
  await preservation.installHold(
    await preservation.verifyPreservation(heldId, row),
  );
  await f.automatic();
  assert.ok((await f.backup.list()).some((entry) => entry.id === heldId));
  const last = (await f.current())[0];
  assert.equal(last.status, 'SUCCESS');
});

test('active backup ownership rejects automatic overlap while preserving the admitted operation', async (t) => {
  let release, began;
  const admitted = new Promise((resolve) => {
    began = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await scheduledBackupFixture(t);
  const manual = await f.operations.start('MANUAL_TEST_OPERATION', async () => {
    began();
    await gate;
    return { kept: true };
  });
  await admitted;
  try {
    await assert.rejects(f.service.runNow());
    assert.equal((await f.operations.get(manual.id)).status, 'RUNNING');
    assert.equal((await f.backup.list()).length, 0);
  } finally {
    release();
  }
  assert.equal((await f.complete(manual)).status, 'SUCCESS');
  assert.equal((await f.backup.list()).length, 0);
});

test('a busy real Task is allowed to complete while automatic backup waits only its bounded interval', async (t) => {
  const f = await scheduledBackupFixture(t);
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    f.workspace.id,
    'busy.sh',
    'sleep 2\nprintf "task-completed-without-backup-interruption\\n"\n',
  );
  const task = await new TaskService(f.store, f.roots, f.leases).create({
    name: 'Backup busy task',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: f.workspace.id,
      relative_entrypoint: 'busy.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  const engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  const submitted = await engine.submit(task.task.id);
  await engine.tick();
  const end = Date.now() + 5000;
  while ((await engine.get(submitted.id)).status !== 'RUNNING') {
    if (Date.now() >= end) throw Error('SCHEDULED_BUSY_TASK_START_DEADLINE');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const operation = await f.complete(await f.service.runNow());
  assert.equal(operation.status, 'FAILED');
  const history = (await f.current())[0];
  assert.equal(history.error_code, 'BACKUP_BUSY');
  assert.equal((await engine.get(submitted.id)).cancel_requested, 0);
  const run = await engine.wait(submitted.id, 10000);
  assert.equal(run.status, 'SUCCESS');
  assert.match(
    await engine.logs(submitted.id),
    /task-completed-without-backup-interruption/,
  );
  assert.equal((await f.backup.list()).length, 0);
});

test('retention deletion failure remains a warning on a valid successful new backup', async (t) => {
  const f = await scheduledBackupFixture(t);
  await f.service.saveSettings({ retain_count: 1 });
  const first = await f.automatic();
  const remove = f.backup.delete.bind(f.backup);
  f.backup.delete = async (id) => {
    if (id === first.snapshot_id)
      throw Object.assign(new Error('BACKUP_PERMISSION_INVALID'), {
        code: 'BACKUP_PERMISSION_INVALID',
      });
    return remove(id);
  };
  const next = await f.automatic();
  assert.equal(next.status, 'SUCCESS');
  assert.ok(next.retention_errors?.length > 0);
  const ids = (await f.backup.list()).map((entry) => entry.id);
  assert.ok(ids.includes(first.snapshot_id));
  assert.ok(ids.includes(next.snapshot_id));
  assert.equal(
    (await f.backup.snapshot(next.snapshot_id)).manifest.source,
    'SCHEDULED',
  );
});

test('post-create verification failure records its actual error and never authorizes retention', async (t) => {
  const f = await scheduledBackupFixture(t);
  await f.service.saveSettings({ retain_count: 1 });
  const old = await f.automatic();
  const oldSnapshot = await f.backup.snapshot(old.snapshot_id);
  const oldDatabaseHash = digest(
    await fs.readFile(path.join(oldSnapshot.root, 'data/db/database.sqlite')),
  );
  const verify = f.backup.snapshot.bind(f.backup);
  const remove = f.backup.delete.bind(f.backup);
  const removed = [];
  let rejectedId;
  f.backup.snapshot = async (id) => {
    if (id !== old.snapshot_id && !rejectedId) {
      rejectedId = id;
      throw new WorkspaceFoundationError('BACKUP_CHECKSUM_FAILED');
    }
    return verify(id);
  };
  f.backup.delete = async (id, options) => {
    removed.push(id);
    return remove(id, options);
  };
  const operation = await f.complete(await f.service.runNow());
  assert.equal(operation.status, 'FAILED');
  const entry = (await f.current()).find((value) => value.id === operation.id);
  assert.equal(entry.status, 'FAILED');
  assert.equal(entry.error_code, 'BACKUP_CHECKSUM_FAILED');
  assert.equal(entry.mode, 'LIGHTWEIGHT');
  assert.equal(entry.source, 'SCHEDULED');
  assert.ok(
    rejectedId,
    'the new snapshot must reach the explicit post-create verification boundary',
  );
  assert.deepEqual(removed, []);
  f.backup.snapshot = verify;
  const ids = (await f.backup.list()).map((value) => value.id);
  assert.ok(ids.includes(old.snapshot_id));
  assert.ok(
    ids.includes(rejectedId),
    'failed verification does not silently erase the published evidence',
  );
  assert.equal(
    digest(
      await fs.readFile(
        path.join(
          (
            await verify(old.snapshot_id)
          ).root,
          'data/db/database.sqlite',
        ),
      ),
    ),
    oldDatabaseHash,
  );
});

test('a completed Restore Journal reference remains protected from scheduled retention', async (t) => {
  const f = await scheduledBackupFixture(t);
  await f.service.saveSettings({ retain_count: 1 });
  const original = await f.automatic();
  await f.service.close();
  await f.operations.close();
  const restored = f.track(
    await new WorkspaceRestoreService(f.backup).restore(original.snapshot_id),
  );
  const backup = new WorkspaceBackupService(
    restored,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const operations = f.track(new BackupOperations(backup.paths));
  const service = f.track(
    new ScheduledBackupService(backup, operations, f.settings),
  );
  const handle = await service.runNow();
  const end = Date.now() + 20000;
  for (;;) {
    const operation = await operations.get(handle.id);
    if (['SUCCESS', 'FAILED'].includes(operation.status)) {
      assert.equal(operation.status, 'SUCCESS', JSON.stringify(operation));
      await operations.wait(handle.id);
      break;
    }
    if (Date.now() >= end) throw Error('SCHEDULED_RESTORE_REFERENCE_DEADLINE');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    (await backup.list()).some((entry) => entry.id === original.snapshot_id),
  );
  await assert.rejects(
    backup.delete(original.snapshot_id, { scheduledOnly: true }),
  );
  assert.equal(
    (await backup.snapshot(original.snapshot_id)).manifest.source,
    'SCHEDULED',
  );
});

test('execution history keeps only the most recent hundred terminal results', async (t) => {
  const f = await scheduledBackupFixture(t);
  let attempts = 0;
  f.backup.create = async (_timeout, mode) => {
    assert.equal(mode, 'FULL');
    attempts++;
    throw Object.assign(new Error('BACKUP_SOURCE_INCOMPLETE'), {
      error_code: 'BACKUP_SOURCE_INCOMPLETE',
    });
  };
  for (let index = 0; index < 103; index++) {
    const operation = await f.complete(await f.service.runManual('FULL'));
    assert.equal(operation.status, 'FAILED');
    f.advance(1000);
  }
  const history = await f.current();
  assert.equal(attempts, 103);
  assert.equal(history.length, 100);
  assert.ok(
    history.every(
      (entry) =>
        entry.status === 'FAILED' &&
        entry.source === 'MANUAL' &&
        entry.mode === 'FULL',
    ),
  );
  assert.ok(
    history.every((entry) => entry.error_code === 'BACKUP_SOURCE_INCOMPLETE'),
  );
  const operationFiles = await fs.readdir(
    await f.backup.paths.bucket('operations'),
  );
  assert.ok(
    operationFiles.filter((name) => /^[0-9a-f-]{36}$/.test(name)).length <= 100,
    'owned terminal backup operation journals are bounded too',
  );
  assert.equal((await f.backup.list()).length, 0);
});

test('a published snapshot is reconciled after checkpoint failure and an old SQLite settings value cannot duplicate its cycle', async (t) => {
  let failCheckpoint = true;
  const f = await scheduledBackupFixture(t, {
    serviceOptions: {
      fault: async (point) => {
        if (point === 'after-snapshot-published' && failCheckpoint) {
          failCheckpoint = false;
          throw Object.assign(new Error('BACKUP_CHECKPOINT_TEST_FAILURE'), {
            error_code: 'BACKUP_CHECKPOINT_TEST_FAILURE',
          });
        }
      },
    },
  });
  await f.service.saveSettings({
    enabled: true,
    time: '03:00',
    timezone: 'Asia/Shanghai',
    retain_count: 3,
  });
  const saved = await f.store.all(
    "SELECT id,info FROM Auths WHERE type='scheduledBackup'",
  );
  assert.equal(saved.length, 1);
  f.setTime('2030-01-01T19:00:00.000Z');
  await f.service.tick();
  const snapshots = await f.backup.list();
  assert.equal(snapshots.length, 1);
  const id = snapshots[0].id;
  const manifest = (await f.backup.snapshot(id)).manifest;
  assert.equal(manifest.source, 'SCHEDULED');
  await f.service.close();
  f.setTime('2030-01-01T19:15:00.000Z');
  await f.store.run('UPDATE Auths SET info=? WHERE id=?', [
    saved[0].info,
    saved[0].id,
  ]);
  const restarted = f.track(
    new ScheduledBackupService(
      f.backup,
      f.track(new BackupOperations(f.backup.paths)),
      f.settings,
    ),
  );
  await restarted.tick();
  await restarted.tick();
  assert.deepEqual(
    (await f.backup.list()).map((entry) => entry.id),
    [id],
  );
  const history = (await restarted.history()).items;
  assert.ok(
    history.some(
      (entry) => entry.snapshot_id === id && entry.status === 'SUCCESS',
    ),
  );
  assert.ok(
    Date.parse((await restarted.getSettings()).next_run_at) >
      f.clock().getTime(),
  );
});
