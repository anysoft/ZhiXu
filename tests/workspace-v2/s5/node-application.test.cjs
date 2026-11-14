const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createS5Fixture, startArtifactCli } = require('./artifact-support.cjs');
const { shellTask, until } = require('./http-support.cjs');
test(
  'S5 compiled production CLI actually initializes, authenticates, executes and independently restarts on the selected application Node',
  { timeout: 180000 },
  async (t) => {
    const fixture = await createS5Fixture(t, { caseId: 'S5-COMPILED-CLI' });
    const root = path.join(fixture.root, 'cli-data');
    let cli = await startArtifactCli(fixture, root, true);
    const coldStartupDuration = cli.startup_duration_ms;
    let token, csrf;
    const http = [],
      controllerPids = [cli.child.pid];
    t.after(async () => {
      if (cli) await cli.stop();
    });
    async function request(method, url, body, key, authority = true) {
      const started = process.hrtime.bigint();
      const response = await fetch(cli.origin + '/api' + url, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(method === 'GET' ? {} : { Origin: cli.origin }),
          ...(authority && token ? { Authorization: 'Bearer ' + token } : {}),
          ...(authority && csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json();
      http.push({
        method,
        path: '/api' + url,
        status: response.status,
        error_code: payload.error_code,
        elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6,
      });
      return { status: response.status, body: payload };
    }
    const system = await request('GET', '/system');
    assert.equal(system.body.data.mode, 'v2');
    assert.equal(system.body.data.schema_identity, 'zhixu.workspace.v2.s0.1');
    assert.equal(system.body.data.local_write_admission, true);
    assert.equal(
      (await request('GET', '/workspaces', undefined, undefined, false)).status,
      401,
    );
    csrf = system.body.data.csrf_token;
    const password = 'S5!' + randomUUID();
    fixture.registerSecret(password);
    assert.equal(
      (
        await request('POST', '/user/init', {
          username: 's5-cli-owner',
          password,
        })
      ).status,
      200,
    );
    async function login() {
      const session = await request('POST', '/user/login', {
        username: 's5-cli-owner',
        password,
      });
      assert.equal(session.status, 200);
      token = session.body.data.token;
      csrf = session.body.data.csrf_token;
      fixture.registerSecret(token);
      fixture.registerSecret(csrf);
    }
    await login();
    const created = await request(
      'POST',
      '/workspaces',
      { type: 'LOCAL', name: 'S5 compiled production entry' },
      's5-cli-local',
    );
    assert.equal(created.status, 202);
    const workspaceId = created.body.data.workspace.id;
    assert.equal(
      (
        await request('POST', `/workspaces/${workspaceId}/files`, {
          path: 'main.sh',
          content: 'printf S5_COMPILED_REAL_CHILD\\n\n',
          must_not_exist: true,
        })
      ).status,
      200,
    );
    const task = await request(
      'POST',
      '/tasks',
      shellTask(workspaceId, 'S5 compiled CLI task'),
    );
    assert.equal(task.status, 200);
    const taskId = task.body.data.id;
    const submitted = await request(
      'POST',
      `/tasks/${taskId}/run`,
      { wait_mode: 'WAIT' },
      's5-cli-first',
    );
    assert.equal(submitted.status, 202);
    const runId = submitted.body.data.id;
    const run = await until(
      () => request('GET', `/task-runs/${runId}`),
      (row) =>
        ['SUCCESS', 'FAILED', 'INTERRUPTED', 'SKIPPED'].includes(
          row.body.data?.status,
        ),
    );
    assert.equal(run.body.data.status, 'SUCCESS');
    assert.equal(
      (await request('GET', `/task-runs/${runId}/attempts`)).body.data.length,
      1,
    );
    const logs = await request('GET', `/task-runs/${runId}/log`);
    assert.equal(logs.status, 200);
    assert.match(JSON.stringify(logs.body.data), /S5_COMPILED_REAL_CHILD/);
    const stopped = await cli.stop();
    cli = null;
    assert.equal(stopped.code, 0);
    cli = await startArtifactCli(fixture, root, false);
    controllerPids.push(cli.child.pid);
    assert.notEqual(controllerPids[0], controllerPids[1]);
    await login();
    assert.equal(
      (await request('GET', `/tasks/${taskId}`)).body.data.id,
      taskId,
    );
    assert.equal(
      (await request('GET', `/task-runs/${runId}`)).body.data.status,
      'SUCCESS',
    );
    assert.equal(
      (await request('GET', `/task-runs/${runId}/attempts`)).body.data.length,
      1,
    );
    assert.equal((await request('GET', '/subscriptions')).status, 404);
    await fixture.record('S5-COMPILED-CLI', {
      status: 'PASS',
      actual_production_entry: true,
      actual_application_restart: true,
      application_node: process.version,
      cold_startup_duration_ms: coldStartupDuration,
      restart_startup_duration_ms: cli.startup_duration_ms,
      startup_measurement_scope:
        'monotonic clock immediately before spawn through receipt of actual V2_HTTP_READY line',
      http_elapsed_scope:
        'monotonic request start through response JSON parsing',
      controller_pids: controllerPids,
      workspace_id: workspaceId,
      task_id: taskId,
      task_run_id: runId,
      attempt_count: 1,
      http,
    });
  },
);
