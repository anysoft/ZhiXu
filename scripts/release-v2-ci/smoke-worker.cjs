'use strict';
// Executed inside the candidate container. Credentials arrive only on stdin.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
async function smoke(input) {
  const origin = 'http://127.0.0.1:5600';
  let token, csrf;
  async function request(method, path, body, status = 200, key) {
    const response = await fetch(origin + path, {
      method, signal: AbortSignal.timeout(10000),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { Origin: origin } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.status, status, method + ' ' + path);
    return response.json();
  }
  const system = (await request('GET', '/api/system')).data;
  assert.equal(system.mode, 'v2');
  assert.equal(system.schema_identity, 'zhixu.workspace.v2.s0.1');
  assert.equal(system.local_write_admission, true);
  csrf = system.csrf_token;
  const frontend = await fetch(origin + '/', { signal: AbortSignal.timeout(10000) });
  assert.equal(frontend.status, 200);
  assert.match(await frontend.text(), /<html/i);
  if (!input.ids) await request('POST', '/api/user/init', { username: 'ci-owner', password: input.password });
  const session = (await request('POST', '/api/user/login', { username: 'ci-owner', password: input.password })).data;
  token = session.token;
  csrf = session.csrf_token;
  assert.ok(token && csrf, 'AUTH_SESSION_REQUIRED');
  let ids = input.ids;
  if (!ids) {
    const created = await request('POST', '/api/workspaces', { type: 'LOCAL', name: 'Release smoke' }, 202, randomUUID());
    const workspace = created.data.workspace.id;
    await request('POST', `/api/workspaces/${workspace}/files`, {
      path: 'main.sh', content: 'printf "V2_RELEASE_REAL_CHILD\\n"\n', must_not_exist: true,
    });
    const task = (await request('POST', '/api/tasks', {
      name: 'Release shell task', description: 'fresh-v2 release smoke', enabled: true, arguments: [],
      source: { type: 'WORKSPACE_ENTRYPOINT', workspace_id: workspace, relative_entrypoint: 'main.sh',
        language: 'SHELL', cwd_mode: 'ENTRYPOINT_DIR', cwd_relative_path: null },
      runtime: { kind: 'SHELL', python_environment_id: null, node_environment_id: null },
      execution: { timeout_seconds: 30, max_attempts: 1, initial_delay_seconds: 0,
        backoff: 'FIXED', concurrency: 'QUEUE', notification: 'NONE' }, env_profile_id: null,
    })).data.id;
    const run = (await request('POST', `/api/tasks/${task}/run`, { wait_mode: 'WAIT' }, 202, randomUUID())).data.id;
    const deadline = Date.now() + 60000;
    let state;
    do {
      state = (await request('GET', `/api/task-runs/${run}`)).data.status;
      if (['SUCCESS', 'FAILED', 'INTERRUPTED', 'SKIPPED'].includes(state)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    assert.equal(state, 'SUCCESS', 'REAL_CHILD_EXECUTION');
    ids = { workspace, task, run };
  }
  assert.equal((await request('GET', `/api/tasks/${ids.task}`)).data.id, ids.task);
  assert.equal((await request('GET', `/api/task-runs/${ids.run}`)).data.status, 'SUCCESS');
  assert.equal((await request('GET', `/api/task-runs/${ids.run}/attempts`)).data.length, 1);
  assert.match(JSON.stringify((await request('GET', `/api/task-runs/${ids.run}/log`)).data), /V2_RELEASE_REAL_CHILD/);
  await request('GET', '/api/subscriptions', undefined, 404);
  return ids;
}
if (require.main === module || !require.main) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => smoke(JSON.parse(input)).then(ids => {
    process.stdout.write(JSON.stringify(ids));
  }).catch(() => { process.stderr.write('V2_SMOKE_HTTP_FAILED\n'); process.exitCode = 1; }));
}
module.exports = { smoke };
