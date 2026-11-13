const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { createS4Fixture } = require('./fixture.cjs'),
  { shellTask, until } = require('./http-support.cjs'),
  { startCli } = require('./cli-support.cjs');
test(
  'S4 compiled fresh-v2 CLI independent-process restart preserves identity, queued Run and scheduler occurrence',
  { timeout: 180000 },
  async (t) => {
    const h = await createS4Fixture(t, { caseId: 'S4-CLI-RESTART' }),
      root = path.join(h.root, 'cli-data');
    let cli = await startCli(h, root, true);
    t.after(() => cli?.stop().catch(() => undefined));
    let token, csrf;
    async function request(method, url, body, key) {
      const res = await fetch(cli.origin + '/api' + url, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(method === 'GET' ? {} : { Origin: cli.origin }),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await res.json();
      return { status: res.status, body: payload };
    }
    const system = await request('GET', '/system');
    csrf = system.body.data.csrf_token;
    const password = 'S4!' + crypto.randomUUID();
    h.registerSecret(password);
    assert.equal(
      (await request('PUT', '/user/init', { username: 'owner', password }))
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
    const created = await request(
      'POST',
      '/workspaces',
      { type: 'LOCAL', name: 'Independent CLI' },
      { toString: () => '' },
    );
    assert.equal(created.status, 400);
    const c = await request(
      'POST',
      '/workspaces',
      { type: 'LOCAL', name: 'Independent CLI' },
      'cli-ws',
    );
    assert.equal(c.status, 202);
    const ws = c.body.data.workspace;
    assert.equal(
      (
        await request('POST', `/workspaces/${ws.id}/files`, {
          path: 'main.sh',
          content: 'sleep 1\nprintf S4_CLI_REAL_RUN\\n\n',
          must_not_exist: true,
        })
      ).status,
      200,
    );
    const task = await request('POST', '/tasks', shellTask(ws.id));
    assert.equal(task.status, 200, task.body.error_code);
    const tid = task.body.data.id;
    const first = await request(
      'POST',
      `/tasks/${tid}/run`,
      { wait_mode: 'WAIT' },
      'cli-first',
    );
    assert.equal(first.status, 202);
    const firstRun = await until(
      () => request('GET', `/task-runs/${first.body.data.id}`),
      (r) => ['SUCCESS', 'FAILED'].includes(r.body.data?.status),
    );
    assert.equal(firstRun.body.data.status, 'SUCCESS');
    const pending = await request(
      'POST',
      `/tasks/${tid}/run`,
      { wait_mode: 'WAIT' },
      'cli-pending',
    );
    assert.equal(pending.status, 202);
    assert.ok(
      ['QUEUED', 'RESOLVING', 'RUNNING'].includes(pending.body.data.status),
    );
    const oldPid = cli.child.pid;
    assert.equal((await cli.stop()).code, 0);
    cli = await startCli(h, root, false);
    assert.notEqual(cli.child.pid, oldPid);
    assert.equal(
      (await request('GET', `/workspaces/${ws.id}`)).body.data.id,
      ws.id,
    );
    const pendingDone = await until(
      () => request('GET', `/task-runs/${pending.body.data.id}`),
      (r) =>
        ['SUCCESS', 'INTERRUPTED', 'FAILED', 'SKIPPED'].includes(
          r.body.data?.status,
        ),
    );
    assert.ok(
      ['SUCCESS', 'INTERRUPTED'].includes(pendingDone.body.data.status),
    );
    const second = await request(
      'POST',
      `/tasks/${tid}/run`,
      { wait_mode: 'WAIT' },
      'cli-second',
    );
    assert.equal(second.status, 202);
    const secondDone = await until(
      () => request('GET', `/task-runs/${second.body.data.id}`),
      (r) => ['SUCCESS', 'FAILED', 'SKIPPED'].includes(r.body.data?.status),
    );
    assert.equal(secondDone.body.data.status, 'SUCCESS');
    const trigger = await request('POST', `/tasks/${tid}/triggers`, {
      type: 'CRON',
      enabled: true,
      config: {
        expression: '* * * * * *',
        timezone: 'UTC',
        misfire_policy: 'FIRE_ONCE',
      },
    });
    assert.equal(trigger.status, 200, trigger.body.error_code);
    const triggerId = trigger.body.data.id;
    await cli.stop();
    cli = await startCli(h, root, false);
    const occurrences = await until(
      () => request('GET', `/tasks/${tid}/trigger-events`),
      (r) =>
        Array.isArray(r.body.data) &&
        r.body.data.some((e) => e.trigger_type === 'CRON' && e.task_run_id),
    );
    const occurrence = occurrences.body.data.find(
      (e) => e.trigger_type === 'CRON' && e.task_run_id,
    );
    assert.ok(occurrence.id > 0);
    assert.equal(
      new Set(occurrences.body.data.map((e) => e.event_key)).size,
      occurrences.body.data.length,
    );
    const phases = cli.info.phases;
    for (const [a, b] of [
      ['SCHEMA_IDENTITY_VALIDATED', 'ROOT_OWNERSHIP'],
      ['ROOT_OWNERSHIP', 'WORKSPACE_RECOVERY'],
      ['WORKSPACE_RECOVERY', 'RUNTIME_RECOVERY'],
      ['RUNTIME_RECOVERY', 'TASK_CONFIG_RECOVERY'],
      ['TASK_CONFIG_RECOVERY', 'SYNC_OUTBOX_RECOVERY'],
      ['SYNC_OUTBOX_RECOVERY', 'ADMISSION_READY'],
      ['ADMISSION_READY', 'SCHEDULERS_ENABLED'],
    ])
      assert.ok(phases.indexOf(a) < phases.indexOf(b));
    await h.record('S4-CLI-RESTART', {
      status: 'PASS',
      entry: 'static/build/appV2.js',
      workspace_id: ws.id,
      task_id: tid,
      first_task_run_id: first.body.data.id,
      pending_task_run_id: pending.body.data.id,
      pending_status_after_restart: pendingDone.body.data.status,
      second_task_run_id: second.body.data.id,
      cron_trigger_id: triggerId,
      scheduler_event_id: occurrence.id,
      scheduler_task_run_id: occurrence.task_run_id,
      startup_phases: phases,
      independent_os_processes: true,
      identity_preserved: true,
    });
  },
);
