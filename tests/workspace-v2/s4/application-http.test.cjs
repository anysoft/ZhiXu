const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createS4Fixture } = require('./fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');
test('S4 real fresh application boots frozen schema and validates Panel sessions before Workspace HTTP', async (t) => {
  const h = await createS4Fixture(t, { caseId: 'S4-HTTP-BOOT' });
  let app;
  try {
    app = await V2Application.launch({
      dataRoot: path.join(h.root, 'application-data'),
      initialize: true,
      projectRoot: h.projectRoot,
      frontendRoot: path.join(h.projectRoot, 'static/dist-v2'),
      port: 0,
    });
  } catch (e) {
    await h.record('S4-HTTP-BOOT-FAILURE', {
      status: 'FAILED',
      missing_routes: e.missingRoutes,
      error_code: e.error_code ?? e.code ?? e.name,
      frames: String(e.stack).split('\n').slice(1, 12),
    });
    throw e;
  }
  t.after(() => app.close());
  assert.equal(app.ready, true);
  assert.equal(app.localWrites, true);
  const request = async (method, url, body, token, csrf, key) => {
    const response = await fetch(app.origin + '/api' + url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { Origin: app.origin } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const system = await request('GET', '/system');
  assert.equal(system.body.data.mode, 'v2');
  assert.equal(system.body.data.initialized, false);
  assert.equal(system.body.data.local_write_admission, true);
  assert.equal((await request('GET', '/workspaces')).status, 401);
  const password = 'S4_OWNED_' + require('node:crypto').randomUUID();
  h.registerSecret(password);
  const initialized = await request(
    'POST',
    '/user/init',
    { username: 'owner', password },
    null,
    system.body.data.csrf_token,
  );
  assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
  const login = await request('POST', '/user/login', {
    username: 'owner',
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const { token, csrf_token } = login.body.data;
  h.registerSecret(token);
  const list = await request('GET', '/workspaces', null, token);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 0);
  assert.equal(
    (
      await request(
        'POST',
        '/workspaces',
        { type: 'LOCAL', name: 'Missing CSRF' },
        token,
      )
    ).status,
    403,
  );
  const created = await request(
    'POST',
    '/workspaces',
    { type: 'LOCAL', name: 'Actual HTTP LOCAL' },
    token,
    csrf_token,
    'http-local',
  );
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.data.workspace.type, 'LOCAL');
  const id = created.body.data.workspace.id;
  assert.ok(id > 0);
  assert.equal(
    (await app.services.store.all('SELECT id FROM Repositories')).length,
    0,
  );
  assert.equal(
    (await request('GET', '/subscriptions', null, token)).status,
    404,
  );
  assert.equal(app.coverage().length, 129);
  assert.ok(app.coverage().every((r) => r.status === 'IMPLEMENTED'));
  await h.record('S4-HTTP-BOOT', {
    status: 'PASS',
    workspace_id: id,
    route_count: 129,
    api_route_catalog: app.publicRouteCatalog(),
    http_statuses: [401, 403, 202, 404],
    schema_identity: system.body.data.schema_identity,
    current_build_local_admission: true,
    subscription_routes_exposed: false,
  });
});
