const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const {
  createS5Fixture,
  startArtifactCli,
} = require('../s5/artifact-support.cjs');
const { shellTask, until } = require('../s5/http-support.cjs');

async function productionCli(t, caseId) {
  process.env.ZHIXU_V2_SHUTDOWN_DIAGNOSTICS = '1';
  const h = await createS5Fixture(t, { caseId });
  const root = path.join(h.root, 'data');
  const password = 'S5R!' + randomUUID();
  h.registerSecret(password);
  let cli, token, csrf;
  const lifetimes = [],
    observations = [];
  async function launch(initialize = false) {
    cli = await startArtifactCli(h, root, initialize);
    const events = [],
      started = process.hrtime.bigint();
    const pipesClosed = new Promise((resolve) =>
      cli.child.once('close', resolve),
    );
    const lifetime = {
      pid: cli.child.pid,
      events,
      startup: cli.info,
      cli,
      started,
      pipesClosed,
    };
    lifetimes.push(lifetime);
    let partial = '';
    cli.child.stderr.on('data', (bytes) => {
      partial += bytes.toString();
      for (;;) {
        const offset = partial.indexOf('\n');
        if (offset === -1) break;
        const line = partial.slice(0, offset);
        partial = partial.slice(offset + 1);
        try {
          const event = JSON.parse(line);
          if (['V2_SHUTDOWN', 'V2_PROCESS_EXIT'].includes(event.event))
            events.push(event);
        } catch {}
      }
    });
    return lifetime;
  }
  async function request(method, url, body, key, binary = false) {
    const response = await fetch(cli.origin + '/api' + url, {
      method,
      headers: {
        ...(body === undefined || body instanceof FormData
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { Origin: cli.origin }),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
          ? body
          : JSON.stringify(body),
    });
    const result = binary
      ? { bytes: Buffer.from(await response.arrayBuffer()) }
      : { body: await response.json() };
    observations.push({
      method,
      path: '/api' + url,
      status: response.status,
      error_code: result.body?.error_code,
    });
    return { status: response.status, ...result };
  }
  async function login() {
    const result = await request('POST', '/user/login', {
      username: 'owner',
      password,
    });
    assert.equal(result.status, 200);
    token = result.body.data.token;
    csrf = result.body.data.csrf_token;
    h.registerSecret(token);
    h.registerSecret(csrf);
  }
  function adoptSession(session) {
    token = session.token;
    csrf = session.csrf_token;
    assert.equal(typeof token, 'string');
    assert.equal(typeof csrf, 'string');
    h.registerSecret(token);
    h.registerSecret(csrf);
  }
  async function shutdown() {
    const lifetime = lifetimes.at(-1),
      origin = cli.origin;
    const start = process.hrtime.bigint();
    const result = await cli.stop();
    await lifetime.pipesClosed;
    lifetime.shutdown_duration_ms =
      Number(process.hrtime.bigint() - start) / 1e6;
    lifetime.result = result;
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    for (const phase of [
      'SIGTERM_RECEIVED',
      'ADMISSION_CLOSED',
      'HTTP_HANDLERS_DRAINED',
      'TASK_RUNNER_STOPPED',
      'BACKUP_OPERATIONS_DRAINED',
      'SQLITE_CLOSED',
      'BACKEND_OWNER_RELEASED',
    ])
      assert.ok(
        lifetime.events.some((event) => event.phase === phase),
        phase,
      );
    const closed = lifetime.events.find(
      (event) => event.phase === 'SQLITE_CLOSED',
    );
    assert.equal(closed.connections, 0);
    assert.equal(closed.requests, 0);
    assert.equal(closed.handlers, 0);
    assert.throws(() => process.kill(lifetime.pid, 0), { code: 'ESRCH' });
    const open = await new Promise((resolve) => {
      const socket = net.createConnection(new URL(origin).port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(true);
      });
    });
    assert.equal(
      open,
      false,
      'the stopped process must not retain its listening port',
    );
    return lifetime;
  }
  t.after(async () => {
    for (const lifetime of lifetimes) {
      if (
        lifetime.cli.child.exitCode === null &&
        lifetime.cli.child.signalCode === null
      )
        await lifetime.cli.stop().catch(() => undefined);
    }
    await h.record(caseId + '-LIFETIMES', {
      status: 'OBSERVED',
      lifetimes: lifetimes.map(
        ({ pid, events, startup, shutdown_duration_ms, result }) => ({
          pid,
          events,
          startup,
          shutdown_duration_ms,
          result,
        }),
      ),
      http: observations,
      production_cli: true,
      source_module_substitution: false,
    });
  });
  await launch(true);
  const system = await request('GET', '/system');
  csrf = system.body.data.csrf_token;
  assert.equal(
    (await request('POST', '/user/init', { username: 'owner', password }))
      .status,
    200,
  );
  await login();
  async function task(script, name = caseId) {
    const workspace = await request(
      'POST',
      '/workspaces',
      { type: 'LOCAL', name },
      randomUUID(),
    );
    assert.equal(workspace.status, 202);
    const id = workspace.body.data.workspace.id;
    const provisionId = workspace.body.data.operation.id;
    const provision = await until(
      () => request('GET', `/workspaces/${id}/operations/${provisionId}`),
      (row) => ['SUCCEEDED', 'FAILED', 'RECOVERY_REQUIRED'].includes(row.body.data?.status),
    );
    assert.equal(provision.body.data.status, 'SUCCEEDED');
    await until(
      () => request('GET', `/workspaces/${id}`),
      (row) => row.body.data?.capabilities?.write_files === true,
    );
    const created = await until(
      async () => {
        const row = await request('POST', `/workspaces/${id}/files`, {
          path: 'main.sh',
          content: script,
          must_not_exist: true,
        });
        // Live UI capability probes may temporarily own a conflicting lease.
        // Busy admission has no mutation; every other error fails immediately.
        if (row.status !== 200) {
          assert.equal(row.status, 409);
          assert.equal(row.body.error_code, 'WORKSPACE_BUSY');
        }
        return row;
      },
      (row) => row.status === 200,
      5000,
    );
    assert.equal(created.status, 200);
    const definition = await request('POST', '/tasks', shellTask(id, name));
    assert.equal(definition.status, 200);
    const run = await request(
      'POST',
      `/tasks/${definition.body.data.id}/run`,
      { wait_mode: 'WAIT' },
      randomUUID(),
    );
    assert.equal(run.status, 202);
    return {
      workspace_id: id,
      task_id: definition.body.data.id,
      run_id: run.body.data.id,
    };
  }
  async function running(runId) {
    return until(
      () => request('GET', `/task-runs/${runId}`),
      (row) => row.body.data?.status === 'RUNNING',
    );
  }
  async function terminal(runId) {
    return until(
      () => request('GET', `/task-runs/${runId}`),
      (row) =>
        [
          'SUCCESS',
          'FAILED',
          'CANCELLED',
          'INTERRUPTED',
          'TIMEOUT',
          'SKIPPED',
        ].includes(row.body.data?.status),
    );
  }
  async function operation(id) {
    const result = await until(
      () => request('GET', '/backups/operations/' + id),
      (row) => ['SUCCESS', 'FAILED'].includes(row.body.data?.status),
      90000,
    );
    assert.equal(
      result.body.data.status,
      'SUCCESS',
      result.body.data.error_code,
    );
    return result.body.data;
  }
  return {
    h,
    root,
    password,
    request,
    launch,
    login,
    shutdown,
    task,
    running,
    terminal,
    operation,
    adoptSession,
    get cli() {
      return cli;
    },
    get origin() {
      return cli.origin;
    },
    get session() {
      return { token, csrf };
    },
    lifetimes,
  };
}
module.exports = { productionCli, until };
