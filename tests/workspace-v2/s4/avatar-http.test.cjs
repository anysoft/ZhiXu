const test = require('node:test'),
  assert = require('node:assert/strict');
const { httpFixture } = require('./http-support.cjs');
test('S4 retained avatar HTTP accepts one bounded PNG multipart and stores only owned private bytes', async (t) => {
  const f = await httpFixture(t, 'S4-AVATAR-HTTP'),
    { token, csrf } = f.session(),
    data = new FormData();
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZtsAAAAASUVORK5CYII=',
    'base64',
  );
  data.append('avatar', new Blob([image], { type: 'image/png' }), 'avatar.png');
  const response = await fetch(f.app.origin + '/api/user/avatar', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + token,
      Origin: f.app.origin,
      'X-CSRF-Token': csrf,
    },
    body: data,
  });
  const payload = await response.json();
  assert.equal(response.status, 200, payload.error_code);
  assert.match(payload.data, /^[0-9a-f-]{36}\.png$/);
  const current = await f.request('GET', '/api/user');
  assert.equal(current.body.data.avatar, payload.data);
  const stat = await require('node:fs/promises').stat(
    require('node:path').join(
      f.app.services.store.dataRoot,
      'upload/avatars',
      payload.data,
    ),
  );
  assert.equal(stat.mode & 0o077, 0);
  assert.equal(stat.size, image.length);
  await f.h.record('S4-AVATAR-HTTP', {
    status: 'PASS',
    http_status: 200,
    bytes: stat.size,
    private_mode: true,
  });
});
