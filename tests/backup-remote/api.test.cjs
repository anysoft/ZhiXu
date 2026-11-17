const test = require('node:test');
const assert = require('node:assert/strict');
const { httpFixture, until } = require('../workspace-v2/s4/http-support.cjs');
const { startS3, startWebdav } = require('./servers.cjs');

for (const [kind, start] of [
  ['S3', startS3],
  ['WEBDAV', startWebdav],
]) {
  test(`${kind} authenticated remote API manages target, uploads encrypted FULL, lists/downloads/deletes without returning secrets`, async (t) => {
    const server = await start();
    t.after(() => server.close());
    const f = await httpFixture(t, 'BACKUP-REMOTE-' + kind, {
      background: false,
    });
    const prefix = '/api/backups/remote';
    assert.equal(
      (
        await f.request('GET', prefix + '/settings', undefined, {
          Authorization: '',
        })
      ).status,
      401,
    );
    const settings = await f.request('GET', prefix + '/settings');
    assert.equal(settings.body.data.enabled, false);
    assert.equal(settings.body.data.retain_count, 14);
    const { id, ...input } = server.target;
    const saved = await f.request('POST', prefix + '/targets', input);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const target = saved.body.data,
      path = prefix + '/targets/' + target.id;
    assert.equal(target.password, undefined);
    assert.equal(target.secret_access_key, undefined);
    assert.equal(target.session_token, undefined);
    assert.equal(
      (await f.request('POST', path + '/test', {})).body.data.status,
      'SUCCESS',
    );
    assert.equal(
      (await f.request('PUT', path, { name: 'Updated ' + kind })).status,
      200,
    );
    const configured = await f.request('PUT', prefix + '/settings', {
      target_id: target.id,
      passphrase: 'saved-independently-from-SQLite',
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.data.passphrase, undefined);
    assert.equal(configured.body.data.has_passphrase, true);
    const local = await f.app.services.lifecycle.createLocal({
      name: 'Remote HTTP Workspace',
      requestKey: 'remote-' + kind,
    });
    await f.app.services.files.create(
      local.id,
      'main.sh',
      'echo restored-through-remote\n',
    );
    const snapshot = await f.app.services.backup.create(1000, 'FULL');
    const admitted = await f.request('POST', prefix + '/uploads', {
      snapshot_id: snapshot,
      target_id: target.id,
    });
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
    const finished = await until(
      () => f.request('GET', prefix + '/uploads'),
      (response) => response.body.data?.[0]?.status === 'SUCCESS',
    );
    const upload = finished.body.data[0];
    assert.equal(upload.mode, 'FULL');
    assert.equal(upload.source, 'MANUAL');
    assert.ok(upload.size > 0);
    const listed = await f.request('GET', path + '/objects');
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].backup_id, snapshot);
    const session = f.session();
    const downloaded = await fetch(
      f.app.origin + path + '/download?key=' + encodeURIComponent(upload.key),
      { headers: { Authorization: 'Bearer ' + session.token } },
    );
    assert.equal(downloaded.status, 200);
    const body = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(body.subarray(0, 8).toString(), 'PLATBKP1');
    assert.equal(body.length, upload.size);
    assert.equal(body.includes(Buffer.from('restored-through-remote')), false);
    assert.equal(
      (
        await f.request('DELETE', path + '/objects', {
          key: 'another-app/data',
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.request('DELETE', path + '/objects', { key: upload.key }))
        .status,
      200,
    );
    assert.equal(
      (await f.request('GET', path + '/objects')).body.data.length,
      0,
    );
    await f.request('PUT', prefix + '/settings', { target_id: null });
    assert.equal((await f.request('DELETE', path)).status, 200);
  });
}
