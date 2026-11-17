const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { httpFixture, until } = require('../workspace-v2/s4/http-support.cjs');
const { OfflineBackupManager } = require('../../back/services/backup/offline');

test('authenticated automatic-backup API persists policy, creates LIGHTWEIGHT, records manual history and exposes legacy-safe provenance', async (t) => {
  const f = await httpFixture(t, 'BACKUP-SCHEDULE-HTTP', { background: false });
  const denied = await f.request('GET', '/api/backups/schedule', undefined, {
    Authorization: '',
  });
  assert.equal(denied.status, 401);
  const local = await f.app.services.lifecycle.createLocal({
    name: 'Automatic HTTP local',
    requestKey: 'scheduled-http-local',
  });
  await f.app.services.files.create(
    local.id,
    'main.sh',
    'echo automatic-http-source\n',
  );
  const initial = await f.request('GET', '/api/backups/schedule');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.data.enabled, true);
  assert.equal(initial.body.data.time, '03:00');
  assert.equal(initial.body.data.mode, 'LIGHTWEIGHT');
  assert.equal(initial.body.data.retain_count, 3);
  const changed = await f.request('PUT', '/api/backups/schedule', {
    enabled: false,
    time: '05:45',
    timezone: 'America/New_York',
    retain_count: 2,
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.next_run_at, null);
  assert.equal(
    (await f.request('GET', '/api/backups/schedule')).body.data.timezone,
    'America/New_York',
  );
  for (const invalid of [
    { time: '25:70' },
    { timezone: 'invalid-zone' },
    { retain_count: 0 },
    { mode: 'FULL' },
  ]) {
    const response = await f.request('PUT', '/api/backups/schedule', invalid);
    assert.equal(response.status, 400, JSON.stringify(response.body));
  }
  const automatic = await f.request('POST', '/api/backups/schedule/run', {});
  assert.equal(automatic.status, 200);
  const automaticDone = await until(
    () => f.request('GET', '/api/backups/operations/' + automatic.body.data.id),
    (result) => ['SUCCESS', 'FAILED'].includes(result.body.data?.status),
  );
  assert.equal(
    automaticDone.body.data.status,
    'SUCCESS',
    JSON.stringify(automaticDone.body),
  );
  const manual = await f.request('POST', '/api/backups', { mode: 'FULL' });
  assert.equal(manual.status, 200);
  const manualDone = await until(
    () => f.request('GET', '/api/backups/operations/' + manual.body.data.id),
    (result) => ['SUCCESS', 'FAILED'].includes(result.body.data?.status),
  );
  assert.equal(
    manualDone.body.data.status,
    'SUCCESS',
    JSON.stringify(manualDone.body),
  );
  const snapshots = await f.request('GET', '/api/backups');
  assert.equal(snapshots.status, 200);
  assert.equal(snapshots.body.data.length, 2);
  const scheduled = snapshots.body.data.find(
    (entry) => entry.source === 'SCHEDULED',
  );
  const user = snapshots.body.data.find((entry) => entry.source === 'MANUAL');
  assert.equal(scheduled.backup_mode, 'LIGHTWEIGHT');
  assert.equal(user.backup_mode, 'FULL');
  const history = await f.request('GET', '/api/backups/history');
  assert.equal(history.status, 200);
  assert.equal(history.body.data.items.length, 2);
  assert.ok(
    history.body.data.items.every(
      (entry) =>
        entry.status === 'SUCCESS' && entry.size > 0 && entry.duration_ms >= 0,
    ),
  );
  assert.deepEqual(
    history.body.data.items.map((entry) => entry.source).sort(),
    ['MANUAL', 'SCHEDULED'],
  );
  assert.equal(
    (await f.request('POST', '/api/backups/schedule/run', { mode: 'FULL' }))
      .status,
    400,
  );
});

test('application startup activates the scheduler without opening its settings page and shutdown permits offline CLI backup', async (t) => {
  const f = await httpFixture(t, 'BACKUP-SCHEDULE-LIFECYCLE', {
    background: true,
  });
  const file = path.join(
    f.app.services.backup.paths.root,
    'scheduled-backup-state.json',
  );
  const end = Date.now() + 5000;
  let state;
  while (!state) {
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= end) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(Date.parse(state.next_run_at) > Date.now());
  assert.equal(
    state.history.length,
    0,
    'fresh startup does not fabricate missed historical cycles',
  );
  assert.equal((await f.app.services.backup.list()).length, 0);
  const dataRoot = f.app.services.store.dataRoot;
  const backupRoot = f.app.services.backup.paths.root;
  await f.app.close();
  const offline = new OfflineBackupManager({
    dataRoot,
    backupRoot,
    projectRoot: f.h.projectRoot,
  });
  const created = await offline.create();
  assert.equal(typeof created.id, 'string');
  const verified = await offline.info(created.id);
  assert.equal(verified.backup_mode, 'FULL');
  assert.equal(verified.source, 'MANUAL');
});
