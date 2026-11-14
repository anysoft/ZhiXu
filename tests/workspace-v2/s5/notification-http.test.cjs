// S5 reruns preserved UI/domain assertions against an explicit compiled release candidate.
const { artifactModule, releaseRoot } = require('./artifact-support.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createS5Fixture } = require('./fixture.cjs');
const { V2Application } = artifactModule('applicationV2/application');
const { fork } = require('node:child_process');
const { WorkspaceStore } = artifactModule('services/workspaceV2/store');
async function setup(t) {
  const h = await createS5Fixture(t, {
      caseId: 's5-notifications-http-' + randomUUID(),
    }),
    instance = await h.createInstance('A');
  await instance.close();
  const received = [];
  let failing = false;
  let hold = false;
  const held = [];
  const receiver = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({
      key: req.headers['idempotency-key'],
      body: JSON.parse(body),
    });
    if (hold) {
      held.push(res);
      return;
    }
    res.writeHead(failing ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !failing }));
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => receiver.close(resolve)));
  const url = `http://127.0.0.1:${receiver.address().port}/owned-notification`;
  const app = await V2Application.launch({
    artifactRoot: path.join(
      releaseRoot(),
      'static/build/applicationV2/contracts',
    ),
    dataRoot: instance.dataRoot,
    backupRoot: instance.backupRoot,
    initialize: true,
    projectRoot: instance.projectRoot,
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
          ? {
              Origin: app.origin,
              'X-CSRF-Token': csrf ?? '',
              'Idempotency-Key': randomUUID(),
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  csrf = (await request('GET', '/system')).body.data.csrf_token;
  const password = 'Notif!' + randomUUID();
  h.registerSecret(password);
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
  h.registerSecret(token);
  assert.ok(
    app.notifications,
    'Actual application owns candidate notification domain',
  );
  return {
    h,
    instance,
    app,
    url,
    received,
    request,
    fail(value) {
      failing = value;
    },
    hold(value) {
      hold = value;
      if (!value) for (const response of held.splice(0)) response.destroy();
    },
  };
}
test('S5 notification retained HTTP providers, secrets/CAS and actual loopback delivery retry use durable outbox', async (t) => {
  const f = await setup(t),
    { request } = f;
  const providers = (await request('GET', '/notification-providers')).body.data;
  assert.equal(providers.length, 25);
  for (const mode of ['WEBHOOK', 'lark', 'chronocat', 'wxPusherSpt', 'email'])
    assert.ok(providers.includes(mode));
  const secret = 'Bearer local-notification-' + randomUUID();
  f.h.registerSecret(secret);
  const created = await request('POST', '/notification-channels', {
    name: 'Owned local delivery',
    type: 'WEBHOOK',
    enabled: true,
    is_default: true,
    secret_action: 'REPLACE',
    secret: { url: f.url, authorization: secret },
  });
  assert.equal(created.status, 200);
  const id = created.body.data.id;
  const read = await request('GET', '/notification-channels/' + id);
  assert.equal(read.body.data.secret_configured, true);
  assert.ok(!JSON.stringify(read.body).includes(secret));
  assert.ok(!JSON.stringify(read.body).includes(f.url));
  const saved = await request('PATCH', '/notification-channels/' + id, {
    name: 'Kept credential',
    type: 'WEBHOOK',
    enabled: true,
    is_default: true,
    secret_action: 'KEEP',
    expected_version: read.body.data.version,
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (
      await request('PATCH', '/notification-channels/' + id, {
        name: 'Stale',
        type: 'WEBHOOK',
        secret_action: 'KEEP',
        expected_version: read.body.data.version,
      })
    ).status,
    409,
  );
  f.fail(true);
  const pending = await request(
    'POST',
    `/notification-channels/${id}/test`,
    {},
  );
  assert.equal(pending.status, 200);
  await f.app.notifications.tick();
  let delivery = (
    await request('GET', '/notification-deliveries')
  ).body.data.find((row) => row.id === pending.body.data.id);
  assert.equal(delivery.status, 'RETRY');
  assert.equal(delivery.attempt_count, 1);
  f.fail(false);
  assert.equal(
    (await request('POST', `/notification-deliveries/${delivery.id}/retry`, {}))
      .status,
    200,
  );
  await f.app.notifications.tick();
  delivery = (await request('GET', '/notification-deliveries')).body.data.find(
    (row) => row.id === delivery.id,
  );
  assert.equal(delivery.status, 'SENT');
  assert.equal(delivery.attempt_count, 2);
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].key, f.received[1].key);
  assert.equal(f.received[1].body.event, 'TEST');
  const attempts = (
    await request('GET', `/notification-deliveries/${delivery.id}/attempts`)
  ).body.data;
  assert.deepEqual(
    attempts.map((row) => row.result),
    ['RETRY', 'SENT'],
  );
  const manual = await request('PUT', '/system/notify', {
    title: 'Actual manual notification',
    content: 'Owned local receiver only',
  });
  assert.equal(manual.status, 200);
  assert.equal(f.received.length, 3);
  assert.equal(f.received[2].body.event, 'SYSTEM');
  assert.equal(f.received[2].body.title, 'Actual manual notification');
  const systemRows = await f.app.services.store.all(
    "SELECT status,task_id,task_run_id FROM NotificationOutbox WHERE event_type='SYSTEM'",
  );
  assert.equal(systemRows.length, 1);
  assert.equal(systemRows[0].status, 'SENT');
  assert.equal(systemRows[0].task_run_id, null);
  const current = (await request('GET', '/notification-channels/' + id)).body
    .data;
  assert.equal(
    (
      await request('DELETE', '/notification-channels/' + id, {
        expected_version: current.version,
      })
    ).status,
    200,
  );
  const archived = (await request('GET', '/notification-channels/' + id)).body
    .data;
  assert.equal(archived.archived, true);
  assert.equal(archived.secret_configured, false);
  await f.h.record('s5-notification-http-delivery', {
    channel_id: id,
    delivery_id: delivery.id,
    provider_count: 25,
    assertions: [
      '25 retained provider choices',
      'secrets withheld and KEEP/CAS preserved',
      'actual HTTP503→RETRY→actual HTTP200→SENT',
      'stable Idempotency-Key',
      'durable attempts retained',
      'archive erases protected material',
    ],
  });
});
test('S5 real Shell TaskRun terminal SQL transaction creates exactly one durable notification and actual provider sends it', async (t) => {
  const f = await setup(t),
    { request } = f;
  const channel = (
    await request('POST', '/notification-channels', {
      name: 'TaskRun receiver',
      type: 'WEBHOOK',
      enabled: true,
      is_default: true,
      secret: { url: f.url },
    })
  ).body.data;
  const workspace = (
    await request('POST', '/workspaces', {
      type: 'LOCAL',
      name: 'Notify real source',
    })
  ).body.data.workspace;
  assert.equal(
    (
      await request('POST', `/workspaces/${workspace.id}/files`, {
        path: 'main.sh',
        content: 'printf "ACTUAL_NOTIFICATION_TASK_RUN\\n"\n',
        must_not_exist: true,
      })
    ).status,
    200,
  );
  const created = await request('POST', '/tasks', {
    name: 'Actual notification Shell',
    description: '',
    enabled: true,
    arguments: [],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: workspace.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'ENTRYPOINT_DIR',
      cwd_relative_path: null,
    },
    runtime: {
      kind: 'SHELL',
      python_environment_id: null,
      node_environment_id: null,
    },
    execution: {
      timeout_seconds: 30,
      max_attempts: 1,
      initial_delay_seconds: 0,
      backoff: 'FIXED',
      concurrency: 'QUEUE',
      notification: 'SUCCESS',
    },
    env_profile_id: null,
  });
  assert.equal(created.status, 200);
  const task = created.body.data,
    policy = (await request('GET', `/tasks/${task.id}/notification-policy`))
      .body.data;
  assert.equal(policy.enabled, 1);
  const submitted = await request('POST', `/tasks/${task.id}/run`, {});
  assert.equal(submitted.status, 202);
  const done = await f.app.services.execution.wait(
    submitted.body.data.task_run_id ?? submitted.body.data.id,
  );
  assert.equal(done.status, 'SUCCESS');
  const rows = await f.app.services.store.all(
    'SELECT id,status,task_run_id FROM NotificationOutbox WHERE task_run_id=?',
    [done.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'PENDING');
  await f.app.notifications.tick();
  await f.app.notifications.tick();
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].body.run.id, done.id);
  assert.equal(f.received[0].body.event, 'SUCCESS');
  const terminal = (
    await request('GET', `/notification-deliveries?run_id=${done.id}`)
  ).body.data;
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].status, 'SENT');
  assert.equal(terminal[0].channel_id, channel.id);
  assert.equal(
    (await request('GET', `/tasks/${task.id}/health`)).body.data
      .consecutive_failures,
    0,
  );
  await f.h.record('s5-taskrun-to-real-notification', {
    workspace_id: workspace.id,
    task_id: task.id,
    run_id: done.id,
    delivery_id: rows[0].id,
    assertions: [
      'actual Shell child SUCCESS',
      'frozen terminal SQL trigger created one outbox in terminal transaction',
      'actual loopback provider HTTP',
      'SENT persisted',
      'repeated dispatcher tick no duplicate',
      'health facts retained',
    ],
  });
});

test('S5 actual notification controller SIGKILL during live provider request recovers SENDING under fresh process owner', async (t) => {
  const f = await setup(t),
    { request } = f;
  const channel = (
    await request('POST', '/notification-channels', {
      name: 'Interrupted actual provider',
      type: 'WEBHOOK',
      secret: { url: f.url },
    })
  ).body.data;
  const pending = (
    await request('POST', `/notification-channels/${channel.id}/test`, {})
  ).body.data;
  await f.app.close();
  const workers = [];
  const worker = () => {
    const child = fork(
      path.join(__dirname, 'notification-crash-worker.cjs'),
      [f.instance.root],
      {
        execArgv: [],
        env: process.env,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    workers.push(child);
    return child;
  };
  t.after(() => {
    for (const child of workers)
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  });
  const message = (child, key) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('NOTIFICATION_WORKER_TIMEOUT')),
        90000,
      );
      const onMessage = (data) => {
        if (data[key]) {
          clearTimeout(timer);
          child.off('message', onMessage);
          resolve(data);
        } else if (data.error_code) {
          clearTimeout(timer);
          reject(Error(data.error_code));
        }
      };
      child.on('message', onMessage);
      child.once('error', reject);
    });
  f.hold(true);
  const first = worker();
  await message(first, 'ready');
  first.send({ deliver: true });
  const deadline = Date.now() + 30000;
  while (!f.received.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.received.length, 1);
  const proof = await WorkspaceStore.open(
    path.join(f.instance.dataRoot, 'db/database.sqlite'),
    f.instance.dataRoot,
    { readOnly: true },
  );
  const sending = (
    await proof.all(
      'SELECT status,claim_token,attempt_count FROM NotificationOutbox WHERE id=?',
      [pending.id],
    )
  )[0];
  await proof.close();
  assert.equal(sending.status, 'SENDING');
  assert.match(sending.claim_token, /^[0-9a-f-]{36}$/);
  assert.equal(sending.attempt_count, 1);
  const killed = new Promise((resolve) =>
    first.once('exit', (code, signal) => resolve({ code, signal })),
  );
  first.kill('SIGKILL');
  assert.equal((await killed).signal, 'SIGKILL');
  f.hold(false);
  const second = worker(),
    recovered = await message(second, 'ready');
  assert.equal(recovered.outbox[0].status, 'RETRY');
  assert.equal(recovered.attempts[0].result, 'INTERRUPTED');
  const done = message(second, 'delivered');
  second.send({ deliver: true });
  const delivered = await done;
  assert.equal(delivered.outbox[0].status, 'SENT');
  assert.equal(delivered.outbox[0].attempt_count, 2);
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].key, f.received[1].key);
  const exited = new Promise((resolve) =>
    second.once('exit', (code) => resolve(code)),
  );
  second.send({ close: true });
  assert.equal(await exited, 0);
  await f.h.record('s5-notification-actual-sigkill', {
    delivery_id: pending.id,
    assertions: [
      'actual live provider HTTP request',
      'durable SENDING owner proof',
      'actual controller SIGKILL',
      'independent process startup recovered RETRY/INTERRUPTED',
      'actual second provider HTTP delivered SENT',
      'same Idempotency-Key, no false first SUCCESS',
    ],
  });
});
