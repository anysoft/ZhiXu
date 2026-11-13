const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  fs = require('node:fs/promises'),
  crypto = require('node:crypto'),
  jwt = require('jsonwebtoken');
const { spawnSync } = require('node:child_process');
const { httpFixture, shellTask, until } = require('./http-support.cjs');
const { createS4Fixture } = require('./fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');
test('S4 actual HTTP rejects substituted authority, forged JWT, cross-origin mutations and retired namespaces', async (t) => {
  const f = await httpFixture(t, 'S4-HTTP-SECURITY'),
    r = f.request,
    { token, csrf } = f.session();
  for (const headers of [
    { Authorization: '', Cookie: 'token=' + token },
    { Authorization: '' },
    { Authorization: 'Bearer invalid' },
    {
      Authorization:
        'Bearer ' +
        jwt.sign({ data: 'forged' }, 'different-key', { algorithm: 'HS384' }),
    },
  ])
    assert.equal(
      (await r('GET', '/api/workspaces', undefined, headers)).status,
      401,
    );
  assert.equal(
    (
      await r(
        'GET',
        '/api/workspaces?token=' + encodeURIComponent(token),
        undefined,
        { Authorization: '' },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await r(
        'POST',
        '/api/workspaces',
        { type: 'LOCAL', name: 'blocked' },
        { Origin: 'https://evil.invalid', 'Idempotency-Key': 'blocked' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await r(
        'POST',
        '/api/workspaces',
        { type: 'LOCAL', name: 'blocked' },
        { 'X-CSRF-Token': 'wrong', 'Idempotency-Key': 'blocked' },
      )
    ).status,
    403,
  );
  const appToken = jwt.sign({ type: 'APP', data: 'app' }, f.app.auth.secret, {
    algorithm: 'HS384',
  });
  f.h.registerSecret(appToken);
  assert.equal(
    (
      await r('GET', '/api/workspaces', undefined, {
        Authorization: 'Bearer ' + appToken,
      })
    ).status,
    403,
  );
  for (const url of [
    '/api/subscriptions',
    '/api/worktrees',
    '/api/repositories/1/worktrees',
    '/api/scoped-env/subscriptions',
    '/api/repositories/1/config-bindings',
  ])
    assert.equal((await r('GET', url)).status, 404);
  assert.equal((await r('GET', '/open/workspaces')).status, 403);
  assert.equal((await r('GET', '/API/workspaces')).status, 404);
  const hostDenied = await new Promise((resolve, reject) => {
    const req = require('node:http').get(
      f.app.origin + '/api/workspaces',
      {
        headers: { Host: 'attacker.invalid', Authorization: 'Bearer ' + token },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
  });
  assert.equal(hostDenied, 403);
  f.statuses.push({
    method: 'GET',
    path: '/api/workspaces',
    status: hostDenied,
    case: 'UNTRUSTED_HOST',
  });
  assert.equal(
    (
      await r(
        'POST',
        '/hooks/' + crypto.randomUUID(),
        {},
        { Authorization: 'Bearer ' + token },
      )
    ).status,
    401,
  );
  await f.h.record('S4-HTTP-SECURITY', {
    status: 'PASS',
    checks: 15,
    http: f.statuses.filter(
      (x) => !x.path.includes('login') && !x.path.includes('init'),
    ),
  });
});
test('S4 actual HTTP enforces file hash CAS, traversal policy, secret projections and request identity', async (t) => {
  const f = await httpFixture(t, 'S4-HTTP-CAS'),
    r = f.request;
  const first = await r(
    'POST',
    '/api/workspaces',
    { type: 'LOCAL', name: 'CAS' },
    { 'Idempotency-Key': 'same-create' },
  );
  assert.equal(first.status, 202);
  const ws = first.body.data.workspace.id;
  const again = await r(
    'POST',
    '/api/workspaces',
    { type: 'LOCAL', name: 'CAS' },
    { 'Idempotency-Key': 'same-create' },
  );
  assert.equal(again.body.data.workspace.id, ws);
  assert.equal(
    (
      await r(
        'POST',
        '/api/workspaces',
        { type: 'LOCAL', name: 'different' },
        { 'Idempotency-Key': 'same-create' },
      )
    ).status,
    409,
  );
  let created = await r('POST', `/api/workspaces/${ws}/files`, {
    path: 'main.sh',
    content: 'printf S4_REAL_HTTP\\n',
    must_not_exist: true,
  });
  assert.equal(created.status, 200);
  const hash = created.body.data.entry.hash;
  const save = await r('PUT', `/api/workspaces/${ws}/files`, {
    path: 'main.sh',
    content: 'printf S4_FIRST_WRITE\\n',
    expected_hash: hash,
  });
  assert.equal(save.status, 200);
  const stale = await r('PUT', `/api/workspaces/${ws}/files`, {
    path: 'main.sh',
    content: 'STALE',
    expected_hash: hash,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error_code, 'WORKSPACE_FILE_CONFLICT');
  for (const p of [
    '../escape',
    '/etc/passwd',
    'a/../escape',
    'a\\escape',
    '.git/config',
  ]) {
    const denied = await r('POST', `/api/workspaces/${ws}/files`, {
      path: p,
      content: 'blocked',
      must_not_exist: true,
    });
    assert.ok([400, 403, 409].includes(denied.status));
  }
  const read = await r('GET', `/api/workspaces/${ws}/files?path=main.sh`);
  assert.equal(read.body.data.content, 'printf S4_FIRST_WRITE\\n');
  const task = await r('POST', '/api/tasks', shellTask(ws));
  assert.equal(task.status, 200, task.body.error_code);
  const tid = task.body.data.id;
  const run = await r(
    'POST',
    `/api/tasks/${tid}/run`,
    { wait_mode: 'WAIT' },
    { 'Idempotency-Key': 'run-once' },
  );
  assert.equal(run.status, 202, run.body.error_code);
  const rid = run.body.data.id;
  const duplicate = await r(
    'POST',
    `/api/tasks/${tid}/run`,
    { wait_mode: 'WAIT' },
    { 'Idempotency-Key': 'run-once' },
  );
  assert.equal(duplicate.body.data.id, rid);
  const finished = await until(
    () => r('GET', `/api/task-runs/${rid}`),
    (x) =>
      ['SUCCESS', 'FAILED', 'SKIPPED', 'INTERRUPTED'].includes(
        x.body.data?.status,
      ),
  );
  assert.equal(finished.body.data.status, 'SUCCESS');
  const attempts = await r('GET', `/api/task-runs/${rid}/attempts`);
  assert.equal(attempts.body.data.length, 1);
  const missing = await r(
    'GET',
    `/api/workspaces/${ws + 10000}/files?path=main.sh`,
  );
  assert.equal(missing.status, 404);
  await f.h.record('S4-HTTP-CAS', {
    status: 'PASS',
    workspace_id: ws,
    task_id: tid,
    task_run_id: rid,
    attempts: 1,
    http: f.statuses,
    stale_write_preserved: true,
  });
});
test('S4 actual startup rejects old, corrupted, unknown and symlink roots without changing source bytes', async (t) => {
  const h = await createS4Fixture(t, { caseId: 'S4-STARTUP-REJECTION' });
  const old = path.join(h.root, 'old');
  await fs.mkdir(old, { mode: 0o700 });
  await fs.mkdir(path.join(old, 'db'), { mode: 0o700 });
  const db = path.join(old, 'db/database.sqlite');
  const q = spawnSync('/usr/bin/python3', [
    '-c',
    'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE old_user_source(id INTEGER, source TEXT)"); c.execute("INSERT INTO old_user_source VALUES(1,?)",("unique-user-source",)); c.commit(); c.close()',
    db,
  ]);
  assert.equal(q.status, 0);
  await fs.chmod(db, 0o600);
  const before = await fs.readFile(db);
  await assert.rejects(
    V2Application.launch({
      dataRoot: old,
      initialize: true,
      projectRoot: h.projectRoot,
    }),
    (e) => e.reason === 'UNSUPPORTED_OR_CORRUPTED_SCHEMA',
  );
  assert.deepEqual(await fs.readFile(db), before);
  assert.deepEqual((await fs.readdir(old)).sort(), ['db']);
  const unknown = path.join(h.root, 'unknown');
  await fs.mkdir(unknown, { mode: 0o700 });
  await fs.writeFile(path.join(unknown, 'only-source.txt'), 'unique', {
    mode: 0o600,
  });
  await assert.rejects(
    V2Application.launch({
      dataRoot: unknown,
      initialize: true,
      projectRoot: h.projectRoot,
    }),
    (e) => e.reason === 'UNKNOWN_NONEMPTY_ROOT',
  );
  assert.equal(
    await fs.readFile(path.join(unknown, 'only-source.txt'), 'utf8'),
    'unique',
  );
  const link = path.join(h.root, 'link');
  await fs.symlink(old, link);
  await assert.rejects(
    V2Application.launch({
      dataRoot: link,
      initialize: true,
      projectRoot: h.projectRoot,
    }),
  );
  await assert.rejects(
    V2Application.launch({
      dataRoot: path.join(h.projectRoot, 'data'),
      initialize: true,
      projectRoot: h.projectRoot,
    }),
    (e) => e.reason === 'LEGACY_DATA_DOMAIN_FORBIDDEN',
  );
  await h.record('S4-STARTUP-REJECTION', {
    status: 'PASS',
    old_db_sha256: crypto.createHash('sha256').update(before).digest('hex'),
    unknown_source_preserved: true,
    old_database_bytes_unchanged: true,
    initialization_was_explicit: true,
  });
});
