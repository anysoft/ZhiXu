const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { artifactModule, createS5Fixture } = require('./artifact-support.cjs');

test('S5 explicit public authority works on a wildcard listener and rejects spoofed origins before changing unknown data', async function publicOriginQualification(t) {
  const h = await createS5Fixture(t, { caseId: 'S5-PUBLIC-ORIGIN' });
  const { normalizeV2PublicOrigin } = artifactModule(
    'applicationV2/publicOrigin',
  );
  const { V2Application } = artifactModule('applicationV2/application');
  assert.equal(normalizeV2PublicOrigin(undefined), undefined);
  assert.equal(
    normalizeV2PublicOrigin('https://panel.example.test/'),
    'https://panel.example.test',
  );
  const rejected = [
    null,
    1,
    '',
    'ftp://panel.test',
    'http://0.0.0.0:5600',
    'http://[::]:5600',
    'https://user:pass@panel.test',
    'https://panel.test/path',
    'https://panel.test?q=1',
    'https://panel.test#fragment',
    ' https://panel.test',
    'https://panel.test:443',
    'https://panel.test/../',
  ];
  for (const publicOrigin of rejected) {
    const root = path.join(h.root, 'invalid-data');
    await assert.rejects(
      V2Application.launch({
        dataRoot: root,
        initialize: true,
        projectRoot: h.projectRoot,
        artifactRoot: path.join(
          h.projectRoot,
          'static/build/applicationV2/contracts',
        ),
        publicOrigin,
      }),
      /STARTUP_PUBLIC_ORIGIN_INVALID/,
    );
    await assert.rejects(fs.stat(root), { code: 'ENOENT' });
    await assert.rejects(fs.stat(root + '.platform-control'), {
      code: 'ENOENT',
    });
    await assert.rejects(fs.stat(root + '-backups'), { code: 'ENOENT' });
  }
  await assert.rejects(
    V2Application.launch({
      dataRoot: path.join(h.root, 'missing-authority'),
      projectRoot: h.projectRoot,
      artifactRoot: path.join(
        h.projectRoot,
        'static/build/applicationV2/contracts',
      ),
      initialize: true,
      host: '0.0.0.0',
    }),
    /STARTUP_PUBLIC_ORIGIN_REQUIRED/,
  );
  const publicOrigin = 'https://panel.example.test:9443';
  const app = await V2Application.launch({
    dataRoot: path.join(h.root, 'actual-data'),
    projectRoot: h.projectRoot,
    artifactRoot: path.join(
      h.projectRoot,
      'static/build/applicationV2/contracts',
    ),
    initialize: true,
    background: false,
    port: 0,
    host: '0.0.0.0',
    publicOrigin,
  });
  t.after(() => app.close());
  const statuses = [];
  const request = (method, route, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const content = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: app.server.address().port,
          method,
          path: '/api' + route,
          headers: {
            Host: 'panel.example.test:9443',
            ...(content === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(content),
                }),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            try {
              statuses.push(res.statusCode);
              resolve({
                status: res.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(Error('S5_HTTP_DEADLINE')));
      req.end(content);
    });
  assert.equal(app.origin, publicOrigin);
  const system = await request('GET', '/system');
  assert.equal(system.status, 200);
  assert.equal(system.body.data.ready, true);
  assert.equal(
    (
      await request('GET', '/system', undefined, {
        Host: 'attacker.example.test',
      })
    ).status,
    403,
  );
  const password = 'S5!' + randomUUID();
  h.registerSecret(password);
  assert.equal(
    (
      await request(
        'POST',
        '/user/init',
        { username: 'owner', password },
        {
          Origin: 'https://attacker.example.test',
          'X-CSRF-Token': system.body.data.csrf_token,
        },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        'POST',
        '/user/init',
        { username: 'owner', password },
        { Origin: publicOrigin, 'X-CSRF-Token': system.body.data.csrf_token },
      )
    ).status,
    200,
  );
  const login = await request(
    'POST',
    '/user/login',
    { username: 'owner', password },
    { Origin: publicOrigin },
  );
  assert.equal(login.status, 200);
  h.registerSecret(login.body.data.token);
  assert.equal(
    (
      await request('GET', '/workspaces', undefined, {
        Authorization: 'Bearer ' + login.body.data.token,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('GET', '/system', undefined, {
        Host: 'attacker.example.test',
        'X-Forwarded-Host': 'panel.example.test:9443',
        'X-Forwarded-Proto': 'https',
      })
    ).status,
    403,
  );
  await h.record('S5-PUBLIC-ORIGIN', {
    status: 'PASS',
    http_statuses: statuses,
    invalid_configurations_rejected: rejected.length,
    unknown_data_unchanged: true,
    wildcard_listener: true,
    configured_authority_enforced: true,
  });
});
