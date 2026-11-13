const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createS4Fixture } = require('./fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');
async function fixture(t) {
  const h = await createS4Fixture(t, {
      caseId: 's4-backup-http-' + randomUUID(),
    }),
    instance = await h.createInstance('A');
  await instance.close();
  let restarts = 0;
  const app = await V2Application.launch({
    dataRoot: instance.dataRoot,
    backupRoot: instance.backupRoot,
    initialize: true,
    projectRoot: instance.projectRoot,
    port: 0,
    background: false,
    onRestartRequested: () => {
      restarts++;
    },
  });
  t.after(() => app.close());
  const password = 'S4HTTP!' + randomUUID();
  h.registerSecret(password);
  const session = { token: null, csrf: null };
  const request = async (method, url, body, options = {}) => {
    const response = await fetch(
      (options.origin ?? app.origin) + '/api' + url,
      {
        method,
        headers: {
          ...(body !== undefined && !(body instanceof FormData)
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(method !== 'GET' ? { Origin: options.origin ?? app.origin } : {}),
          ...(options.auth === false
            ? {}
            : session.token
            ? { Authorization: 'Bearer ' + session.token }
            : {}),
          ...(options.csrf === false
            ? {}
            : session.csrf
            ? { 'X-CSRF-Token': session.csrf }
            : {}),
          ...(options.key ? { 'Idempotency-Key': options.key } : {}),
        },
        body:
          body === undefined
            ? undefined
            : body instanceof FormData
            ? body
            : JSON.stringify(body),
      },
    );
    if (options.binary)
      return {
        status: response.status,
        bytes: Buffer.from(await response.arrayBuffer()),
        headers: response.headers,
      };
    return { status: response.status, body: await response.json() };
  };
  const system = await request('GET', '/system');
  session.csrf = system.body.data.csrf_token;
  assert.equal(
    (await request('POST', '/user/init', { username: 'owner', password }))
      .status,
    200,
  );
  const login = await request('POST', '/user/login', {
    username: 'owner',
    password,
  });
  assert.equal(login.status, 200);
  Object.assign(session, {
    token: login.body.data.token,
    csrf: login.body.data.csrf_token,
  });
  h.registerSecret(session.token);
  const wait = async (operation) => {
    if (typeof operation !== 'string')
      assert.ok(
        operation.status >= 200 && operation.status < 300,
        operation.body?.error_code ?? 'BACKUP_HTTP_ADMISSION_FAILED',
      );
    const id =
        typeof operation === 'string' ? operation : operation.body.data.id,
      deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const response = await request('GET', '/backups/operations/' + id);
      assert.equal(response.status, 200);
      if (['SUCCESS', 'FAILED'].includes(response.body.data.status))
        return response.body.data;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error('BACKUP_HTTP_OPERATION_TIMEOUT');
  };
  const local = async (content = 'actual original unique source\n') => {
    const response = await request(
      'POST',
      '/workspaces',
      { type: 'LOCAL', name: 'HTTP backup source' },
      { key: randomUUID() },
    );
    assert.equal(response.status, 202);
    const id = response.body.data.workspace.id;
    assert.equal(
      (
        await request('POST', `/workspaces/${id}/files`, {
          path: 'unique.sh',
          content,
          must_not_exist: true,
        })
      ).status,
      200,
    );
    return id;
  };
  return {
    h,
    instance,
    app,
    request,
    wait,
    local,
    password,
    session,
    get restarts() {
      return restarts;
    },
  };
}
test('S4 authenticated HTTP snapshot/export/download/import/validation, quotas, preservation and numeric file-search query are actual', async (t) => {
  const f = await fixture(t),
    { request, wait } = f,
    id = await f.local();
  assert.equal(
    (await request('GET', `/workspaces/${id}/search?query=unique&limit=100`))
      .status,
    200,
  );
  assert.equal(
    (await request('GET', '/system/git-identity')).body.data.version,
    1,
  );
  assert.equal(
    (await request('GET', '/backups', undefined, { auth: false })).status,
    401,
  );
  assert.equal(
    (await request('POST', '/backups', {}, { csrf: false })).status,
    403,
  );
  const snapshot = await wait(await request('POST', '/backups', {}));
  assert.equal(snapshot.status, 'SUCCESS');
  assert.match(snapshot.result, /^[0-9a-f-]{36}$/);
  const detail = await request('GET', '/backups/' + snapshot.result);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.workspaces[0].workspace_id, id);
  const preview = await request(
    'GET',
    `/restores/${snapshot.result}/preview?source=snapshots`,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.restart_required, true);
  const validated = await wait(
    await request('POST', `/backups/${snapshot.result}/validate`, {}),
  );
  assert.equal(validated.status, 'SUCCESS');
  const phrase = 'S4 portable phrase ' + randomUUID();
  f.h.registerSecret(phrase);
  const exported = await wait(
    await request('POST', `/backups/${snapshot.result}/export`, {
      passphrase: phrase,
    }),
  );
  assert.equal(exported.status, 'SUCCESS');
  assert.equal(
    (
      await request(
        'GET',
        `/backups/exports/${exported.result}/download`,
        undefined,
        { auth: false, binary: true },
      )
    ).status,
    401,
  );
  const download = await request(
    'GET',
    `/backups/exports/${exported.result}/download`,
    undefined,
    { binary: true },
  );
  assert.equal(download.status, 200);
  assert.ok(download.bytes.length > 80);
  const upload = (pass) => {
    const form = new FormData();
    form.set('passphrase', pass);
    form.set(
      'file',
      new Blob([download.bytes]),
      '../../client-host-path.platform-backup',
    );
    return form;
  };
  const imported = await wait(
    await request('POST', '/restores/import', upload(phrase)),
  );
  assert.equal(imported.status, 'SUCCESS');
  assert.equal(imported.result.snapshot_id, snapshot.result);
  const importValidation = await wait(
    await request('POST', `/restores/${imported.result.id}/validate`, {}),
  );
  assert.equal(importValidation.status, 'SUCCESS');
  assert.ok(importValidation.result > 0);
  assert.equal(
    (
      await request(
        'GET',
        `/restores/${imported.result.id}/preview?source=imports`,
      )
    ).status,
    200,
  );
  const wrong = await wait(
    await request('POST', '/restores/import', upload('wrong private phrase')),
  );
  assert.equal(wrong.status, 'FAILED');
  const quota = await request('GET', '/backups/usage');
  assert.equal(quota.status, 200);
  assert.ok(quota.body.data.live_storage_bytes > 0);
  assert.ok(quota.body.data.retained_bytes > 0);
  assert.ok(quota.body.data.free_bytes > 0);
  const current = (await request('GET', '/workspaces/' + id)).body.data;
  const archived = await request(
    'POST',
    `/workspaces/${id}/archive`,
    { expected_version: current.version },
    { key: randomUUID() },
  );
  assert.equal(archived.status, 202);
  const deleted = await request(
    'DELETE',
    '/workspaces/' + id,
    {
      expected_version: archived.body.data.workspace.version,
      confirm_reclaim: true,
      preservation_backup_id: snapshot.result,
    },
    { key: randomUUID() },
  );
  assert.equal(deleted.status, 202);
  const holds = await request(
    'GET',
    `/backups/${snapshot.result}/preservation`,
  );
  assert.equal(holds.body.data.holds.length, 1);
  assert.equal(
    (await request('DELETE', '/backups/' + snapshot.result, {})).status,
    409,
  );
  const states = JSON.stringify([
    detail.body,
    preview.body,
    exported,
    imported,
    wrong,
    quota.body,
    holds.body,
  ]);
  assert.ok(!states.includes(phrase));
  assert.ok(!states.includes(f.instance.dataRoot));
  await f.h.record('s4-backup-http-portable-preservation', {
    workspace_id: id,
    snapshot_id: snapshot.result,
    assertions: [
      'Panel/CSRF enforced',
      'actual encrypted authenticated download',
      'actual multipart import validation',
      'wrong passphrase fails',
      'actual hold blocks snapshot delete',
      'actual quota usage',
      'numeric search query100 accepted',
      'safe metadata no hostpaths/passphrase',
    ],
  });
});
test('S4 confirmed HTTP restore stages under live backend FD and an independent fresh application process restores actual source', async (t) => {
  const f = await fixture(t),
    { request, wait } = f,
    id = await f.local('RESTORED UNIQUE SOURCE\n');
  const beforeRoot = await fs.lstat(f.instance.dataRoot),
    snapshot = await wait(await request('POST', '/backups', {}));
  assert.equal(snapshot.status, 'SUCCESS');
  const read = await request('GET', `/workspaces/${id}/files?path=unique.sh`);
  assert.equal(
    (
      await request('PUT', `/workspaces/${id}/files`, {
        path: 'unique.sh',
        content: 'later source before restart\n',
        expected_hash: read.body.data.hash,
      })
    ).status,
    200,
  );
  const rejected = await request('POST', `/restores/${snapshot.result}/stage`, {
    source: 'snapshots',
    confirmation: 'NO',
  });
  assert.equal(rejected.status, 400);
  assert.equal(await f.app.services.restore.status(), null);
  const accepted = await request('POST', `/restores/${snapshot.result}/stage`, {
    source: 'snapshots',
    confirmation: 'RESTORE',
  });
  assert.equal(accepted.status, 202);
  let restartTimer;
  try {
    await Promise.race([
      f.app.restartRequested,
      new Promise((_, reject) => {
        restartTimer = setTimeout(
          () => reject(Error('RESTORE_RESTART_NOT_REQUESTED')),
          90000,
        );
      }),
    ]);
  } finally {
    clearTimeout(restartTimer);
  }
  assert.equal(f.restarts, 1);
  const operation = await wait(accepted);
  assert.equal(operation.status, 'SUCCESS');
  assert.equal(operation.result.stage, 'PENDING');
  const stillLive = await fs.lstat(f.instance.dataRoot);
  assert.equal(stillLive.ino, beforeRoot.ino);
  assert.equal(
    await fs.readFile(
      path.join(f.instance.dataRoot, `workspaces/local/ws-${id}/unique.sh`),
      'utf8',
    ),
    'later source before restart\n',
  );
  await f.app.close();
  const child = fork(
    path.join(__dirname, 'backup-restart-worker.cjs'),
    [f.instance.root],
    {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    if (output.length < 1024) output += chunk.toString();
  });
  child.stderr.on('data', () => {});
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error('FRESH_RESTORE_BOOT_TIMEOUT')),
      90000,
    );
    child.once('error', reject);
    child.once('exit', () => reject(Error('FRESH_RESTORE_BOOT_FAILED')));
    child.on('message', (message) => {
      if (message.ready) {
        clearTimeout(timer);
        resolve(message);
      } else if (message.error_code) {
        clearTimeout(timer);
        reject(
          Object.assign(Error(message.error_code), {
            code: message.error_code,
          }),
        );
      }
    });
  });
  assert.equal(ready.restore_stage, 'COMPLETE');
  assert.notEqual((await fs.lstat(f.instance.dataRoot)).ino, beforeRoot.ino);
  const login = await request(
    'POST',
    '/user/login',
    { username: 'owner', password: f.password },
    { origin: ready.origin },
  );
  assert.equal(login.status, 200);
  f.session.token = login.body.data.token;
  f.session.csrf = login.body.data.csrf_token;
  f.h.registerSecret(f.session.token);
  const restored = await request(
    'GET',
    `/workspaces/${id}/files?path=unique.sh`,
    undefined,
    { origin: ready.origin },
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.content, 'RESTORED UNIQUE SOURCE\n');
  assert.equal(
    (
      await request('GET', '/restore/status', undefined, {
        origin: ready.origin,
      })
    ).body.data.stage,
    'COMPLETE',
  );
  const exited = new Promise((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  child.send({ close: true });
  assert.equal(await exited, 0);
  await f.h.record('s4-backup-http-independent-restore', {
    workspace_id: id,
    snapshot_id: snapshot.result,
    assertions: [
      'confirmation required',
      'live backend keeps original root before restart',
      'real pending journal and SUCCESS staging operation',
      'independent application process root replacement',
      'restored source readable through actual HTTP',
      'restored Panel credentials retained',
    ],
  });
});
test('S4 retained stage cancellation verifies pending owner and reopens admission without swapping source', async (t) => {
  const f = await fixture(t),
    id = await f.local(),
    snapshot = await f.wait(await f.request('POST', '/backups', {}));
  const before = await fs.lstat(f.instance.dataRoot),
    journal = await f.app.services.restore.stage(snapshot.result, 'snapshots');
  assert.equal(journal.stage, 'PENDING');
  assert.equal(
    (await f.app.services.leases.barrier.state()).phase,
    'RESTORE_PENDING',
  );
  const cancelled = await f.request(
    'DELETE',
    `/restores/${journal.operation_id}/stage`,
    {},
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.cancelled, true);
  assert.equal((await f.app.services.restore.status()).stage, 'CANCELLED');
  assert.equal(await f.app.services.leases.barrier.state(), null);
  assert.equal((await fs.lstat(f.instance.dataRoot)).ino, before.ino);
  assert.equal(
    (
      await f.request('POST', `/workspaces/${id}/files`, {
        path: 'after-cancel.txt',
        content: 'admission reopened',
        must_not_exist: true,
      })
    ).status,
    200,
  );
  await f.h.record('s4-restore-http-cancel', {
    workspace_id: id,
    assertions: [
      'real pending journal under backend FD',
      'authenticated cancel clears matching barrier',
      'original root unchanged',
      'new mutation admitted',
    ],
  });
});
