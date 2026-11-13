const test = require('node:test'),
  assert = require('node:assert/strict'),
  { createHash } = require('node:crypto');
const { createGitFixture } = require('../s3/git-fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');
test('S4 atomic HTTP file receipt retains writer A physical BOM/CRLF hash and revision after real writer B commits before A acknowledgement', async (t) => {
  const f = await createGitFixture(t, {
    caseId: 's4-atomic-file-receipt',
    files: { 'main.sh': '\uFEFFbase\r\n' },
  });
  await f.instance.close();
  const app = await V2Application.launch({
    dataRoot: f.dataRoot,
    backupRoot: f.backupRoot,
    initialize: false,
    projectRoot: f.projectRoot,
    port: 0,
    background: false,
  });
  t.after(() => app.close());
  let token, csrf;
  const request = async (method, url, body) => {
    const response = await fetch(app.origin + '/api' + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(method !== 'GET'
          ? { Origin: app.origin, 'X-CSRF-Token': csrf ?? '' }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  csrf = (await request('GET', '/system')).body.data.csrf_token;
  const password = 'Receipt!' + require('node:crypto').randomUUID();
  f.scenario.registerSecret(password);
  assert.equal(
    (await request('POST', '/user/init', { username: 'owner', password }))
      .status,
    200,
  );
  const login = await request('POST', '/user/login', {
    username: 'owner',
    password,
  });
  token = login.body.data.token;
  csrf = login.body.data.csrf_token;
  f.scenario.registerSecret(token);
  const original = await request(
    'GET',
    `/workspaces/${f.row.id}/files?path=main.sh`,
  );
  assert.equal(original.status, 200);
  let releaseA, signalA;
  const committedA = new Promise((resolve) => {
      signalA = resolve;
    }),
    gateA = new Promise((resolve) => {
      releaseA = resolve;
    });
  const save = app.services.files.save.bind(app.services.files);
  app.services.files.save = async (...args) => {
    const result = await save(...args);
    if (args[2] === 'writer A\n') {
      signalA();
      await gateA;
    }
    return result;
  };
  const responseA = request('PUT', `/workspaces/${f.row.id}/files`, {
    path: 'main.sh',
    content: 'writer A\n',
    expected_hash: original.body.data.hash,
  });
  await committedA;
  const observedA = await request(
    'GET',
    `/workspaces/${f.row.id}/files?path=main.sh`,
  );
  assert.equal(observedA.body.data.content, 'writer A\r\n');
  const responseB = await request('PUT', `/workspaces/${f.row.id}/files`, {
    path: 'main.sh',
    content: 'writer B\n',
    expected_hash: observedA.body.data.hash,
  });
  assert.equal(responseB.status, 200);
  releaseA();
  const acknowledgedA = await responseA;
  assert.equal(acknowledgedA.status, 200);
  const ownHash = createHash('sha256')
    .update('\uFEFFwriter A\r\n')
    .digest('hex');
  assert.equal(acknowledgedA.body.data.entry.hash, ownHash);
  assert.equal(
    acknowledgedA.body.data.content_revision + 1,
    responseB.body.data.content_revision,
  );
  assert.notEqual(
    acknowledgedA.body.data.entry.hash,
    responseB.body.data.entry.hash,
  );
  const stale = await request('PUT', `/workspaces/${f.row.id}/files`, {
    path: 'main.sh',
    content: 'stale A must not overwrite\n',
    expected_hash: acknowledgedA.body.data.entry.hash,
  });
  assert.equal(stale.status, 409);
  const actual = await request(
    'GET',
    `/workspaces/${f.row.id}/files?path=main.sh`,
  );
  assert.equal(actual.body.data.content, 'writer B\r\n');
  assert.equal(actual.body.data.hash, responseB.body.data.entry.hash);
  await f.scenario.record('s4-atomic-http-mutation-receipt', {
    workspace_id: f.row.id,
    own_write_hash: ownHash,
    ack_hash: acknowledgedA.body.data.entry.hash,
    ack_revision: acknowledgedA.body.data.content_revision,
    next_revision: responseB.body.data.content_revision,
    assertions: [
      'actual A core save committed and released lease',
      'actual B HTTP save committed before A response',
      'A response retains A physical BOM/CRLF hash and own revision',
      'next stale A CAS409',
      'B source bytes preserved',
    ],
  });
});
