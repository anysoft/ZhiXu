const test = require('node:test');
const assert = require('node:assert/strict');
const { httpFixture, until } = require('../workspace-v2/s4/http-support.cjs');

test('authenticated backup API defaults to FULL, accepts LIGHTWEIGHT and projects actual mode and dependencies', async (t) => {
  const f = await httpFixture(t, 'BACKUP-MODE-HTTP', { background: false });
  const local = await f.app.services.lifecycle.createLocal({
    name: 'Mode HTTP local',
    requestKey: 'mode-http-local',
  });
  await f.app.services.files.create(
    local.id,
    'main.sh',
    'echo backed-up-local\n',
  );
  for (const input of [{}, { mode: 'FULL' }, { mode: 'LIGHTWEIGHT' }]) {
    const created = await f.request('POST', '/api/backups', input);
    assert.equal(created.status, 200);
    const operation = await until(
      () => f.request('GET', '/api/backups/operations/' + created.body.data.id),
      (r) => ['SUCCESS', 'FAILED'].includes(r.body.data?.status),
    );
    assert.equal(
      operation.body.data.status,
      'SUCCESS',
      JSON.stringify(operation.body.data),
    );
    const id = operation.body.data.result;
    const detail = await f.request('GET', '/api/backups/' + id);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.backup_mode, input.mode ?? 'FULL');
    assert.equal(detail.body.data.mode, 'FULL_PORTABLE');
    assert.equal(
      detail.body.data.restore_requires_remote,
      false,
      'LOCAL-only snapshots need no Git remote',
    );
    assert.ok(Array.isArray(detail.body.data.validation.warnings));
    assert.equal(detail.body.data.workspaces[0].type, 'LOCAL');
  }
  const list = await f.request('GET', '/api/backups');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 3);
  assert.deepEqual(list.body.data.map((r) => r.backup_mode).sort(), [
    'FULL',
    'FULL',
    'LIGHTWEIGHT',
  ]);
  for (const mode of ['full', 'unknown', null, [], 0]) {
    const invalid = await f.request('POST', '/api/backups', { mode });
    assert.equal(invalid.status, 400);
  }
});
