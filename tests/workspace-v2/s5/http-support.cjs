// S5 reruns preserved UI/domain assertions against an explicit compiled release candidate.
const { artifactModule, releaseRoot } = require('./artifact-support.cjs');
const path = require('node:path'),
  { randomUUID } = require('node:crypto');
const { createS5Fixture } = require('./fixture.cjs');
const { V2Application } = artifactModule('applicationV2/application');
async function httpFixture(t, caseId, options = {}) {
  const h = await createS5Fixture(t, { caseId });
  const app = await V2Application.launch({
    dataRoot: path.join(h.root, 'http-data'),
    initialize: true,
    projectRoot: h.projectRoot,
    port: 0,
    ...options,
  });
  t.after(() => app.close());
  let token, csrf;
  const statuses = [];
  t.after(() =>
    h.record(caseId + '-OBSERVATIONS', { status: 'OBSERVED', http: statuses }),
  );
  async function request(method, url, body, overrides = {}) {
    const response = await fetch(app.origin + url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { Origin: app.origin }),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...overrides,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text };
    }
    statuses.push({
      method,
      path: new URL(url, app.origin).pathname,
      status: response.status,
      error_code: payload.error_code,
    });
    return {
      status: response.status,
      body: payload,
      headers: response.headers,
    };
  }
  const system = await request('GET', '/api/system');
  csrf = system.body.data.csrf_token;
  const password = 'S5!' + randomUUID();
  h.registerSecret(password);
  await request('POST', '/api/user/init', { username: 'owner', password });
  const login = await request('POST', '/api/user/login', {
    username: 'owner',
    password,
  });
  token = login.body.data.token;
  csrf = login.body.data.csrf_token;
  h.registerSecret(token);
  h.registerSecret(csrf);
  return {
    h,
    app,
    request,
    password,
    session: () => ({ token, csrf }),
    statuses,
  };
}
function shellTask(workspaceId, name = 'HTTP shell') {
  return {
    name,
    description: 'real application HTTP',
    enabled: true,
    arguments: [],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: workspaceId,
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
      notification: 'NONE',
    },
    env_profile_id: null,
  };
}
async function until(fn, accept, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Object.assign(new Error('HTTP_POLL_DEADLINE'), {
    lastStatus: last?.body?.data?.status,
  });
}
module.exports = { httpFixture, shellTask, until };
