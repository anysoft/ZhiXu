const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createS4Fixture, git } = require('./fixture.cjs');
const { shellTask } = require('./http-support.cjs');
const RuntimePathResolver =
  require('../../../back/services/runtimePaths').default;
const { RuntimeLease } = require('../../../back/services/runtimeProcess');

async function eventually(read, accept, timeout = 180000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Object.assign(new Error('ENTRY_RECOVERY_PROOF_DEADLINE'), {
    code: 'ENTRY_RECOVERY_PROOF_DEADLINE',
  });
}
async function startWorker(t, h, instance, remoteStat) {
  const child = fork(
    path.join(__dirname, 'application-recovery-worker.cjs'),
    [instance.root, String(remoteStat?.dev ?? 0), String(remoteStat?.ino ?? 0)],
    {
      cwd: h.projectRoot,
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const stdout = createHash('sha256'),
    stderr = createHash('sha256');
  child.stdout.on('data', (chunk) => stdout.update(chunk));
  child.stderr.on('data', (chunk) => stderr.update(chunk));
  const pending = new Map();
  let sequence = 0,
    ready;
  const exited = new Promise((resolve) =>
    child.once('exit', (exit_code, signal) => resolve({ exit_code, signal })),
  );
  child.on('message', (message) => {
    if (message.type === 'READY') ready = message;
    if (message.type === 'FAILED') ready = message;
    if (message.request_id && pending.has(message.request_id)) {
      pending.get(message.request_id)(message);
      pending.delete(message.request_id);
    }
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && child.signalCode === null)
      child.send({ command: 'STOP' });
    const outcome = await exited;
    assert.equal(outcome.exit_code, 0);
    assert.equal(outcome.signal, null);
    await h.record('entry-controller-' + child.pid, {
      status: 'PASS',
      controller_pid: child.pid,
      exit_code: outcome.exit_code,
      signal: outcome.signal,
      stdout_sha256: stdout.digest('hex'),
      stderr_sha256: stderr.digest('hex'),
      actual_production_entry: true,
    });
  }
  t.after(close);
  await eventually(
    async () => ready,
    (value) => !!value,
    180000,
  );
  assert.equal(ready.type, 'READY', ready.error_code);
  return {
    child,
    ready,
    close,
    async facts(workspaceId) {
      const request_id = ++sequence;
      const response = await new Promise((resolve) => {
        pending.set(request_id, resolve);
        child.send({ command: 'FACTS', request_id, workspace_id: workspaceId });
      });
      assert.equal(response.error_code, undefined);
      return response.facts;
    },
  };
}
async function login(h, worker, password, initialize = false) {
  let token, csrf;
  const request = async (method, relative, body, key) => {
    const response = await fetch(worker.ready.origin + '/api' + relative, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { Origin: worker.ready.origin }),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  csrf = (await request('GET', '/system')).body.data.csrf_token;
  if (initialize)
    assert.equal(
      (await request('POST', '/user/init', { username: 'owner', password }))
        .status,
      200,
    );
  const result = await request('POST', '/user/login', {
    username: 'owner',
    password,
  });
  assert.equal(result.status, 200);
  token = result.body.data.token;
  csrf = result.body.data.csrf_token;
  h.registerSecret(token);
  h.registerSecret(csrf);
  return request;
}
class OutboxGatePaths extends RuntimePathResolver {
  async lock(id) {
    return path.join(
      await this.directory('.locks', true),
      'workspace-update-outbox-' + id + '.lock',
    );
  }
}

test(
  'S4 production entry across distinct controllers preserves queued Sync, pending Outbox and scheduler occurrence without duplicate TaskRun',
  { timeout: 600000 },
  async (t) => {
    const h = await createS4Fixture(t, { caseId: 'S4-ENTRY-PENDING-001' }),
      instance = await h.createInstance('A');
    await instance.close();
    const remote = path.join(instance.root, 'controlled-remote');
    await fs.mkdir(remote, { mode: 0o700 });
    git(['init', '-b', 'main'], remote);
    git(['config', 'user.name', 'S4 entry fixture'], remote);
    git(['config', 'user.email', 'fixture@example.invalid'], remote);
    await fs.writeFile(
      path.join(remote, 'main.sh'),
      'printf "ENTRY_INITIAL\\n"\n',
      { mode: 0o600 },
    );
    git(['add', 'main.sh'], remote);
    git(['commit', '-m', 'initial actual source'], remote);
    const remoteStat = await fs.lstat(remote),
      password = 'S4_ENTRY_' + randomUUID();
    h.registerSecret(password);
    const A = await startWorker(t, h, instance, remoteStat),
      rA = await login(h, A, password, true);
    assert.equal(A.ready.ready, true);
    const repo = await rA('POST', '/repositories', {
      name: 'Entry remote',
      remote_url: pathToFileURL(remote).href,
      default_credential_id: null,
    });
    assert.equal(repo.status, 200);
    assert.equal(
      (
        await rA(
          'POST',
          '/repositories/' + repo.body.data.id + '/initialize',
          {},
        )
      ).status,
      200,
    );
    const created = await rA(
      'POST',
      '/workspaces',
      {
        type: 'GIT',
        name: 'Entry Git',
        git: {
          repository_id: repo.body.data.id,
          ref_type: 'branch',
          ref_name: 'main',
        },
      },
      'entry-git-workspace',
    );
    assert.equal(created.status, 202);
    const workspaceId = created.body.data.workspace.id;
    const task = await rA(
      'POST',
      '/tasks',
      shellTask(workspaceId, 'Entry actual GitUpdate'),
    );
    assert.equal(task.status, 200);
    const taskId = task.body.data.id;
    assert.equal(
      (
        await rA('POST', '/tasks/' + taskId + '/triggers', {
          type: 'GIT_UPDATE',
          enabled: true,
          config: {
            mode: 'ANY_CHANGE',
            path_filters: [],
            fire_on_initial: true,
          },
        })
      ).status,
      200,
    );
    let policy = (
      await rA('GET', '/workspaces/' + workspaceId + '/sync-policy')
    ).body.data;
    policy = (
      await rA('PUT', '/workspaces/' + workspaceId + '/sync-policy', {
        expected_version: policy.version,
        enabled: true,
        mode: 'MANUAL',
        schedule: null,
      })
    ).body.data;
    await fs.writeFile(
      path.join(remote, 'main.sh'),
      'printf "ENTRY_RECOVERED_GITUPDATE\\n"\n',
      { mode: 0o600 },
    );
    git(['add', 'main.sh'], remote);
    git(['commit', '-m', 'actual pending source'], remote);
    const targetCommit = git(['rev-parse', 'HEAD'], remote);
    const ws = (await rA('GET', '/workspaces/' + workspaceId)).body.data;
    let releaseWorkspace, workspaceHeld;
    const held = new Promise((resolve) => {
      workspaceHeld = resolve;
    });
    // Sync claims only after acquiring Repository; Workspace ownership comes
    // after fetch. Hold the actual Repository FD to preserve the queued state.
    const gate = instance.leases.withRepository(
      repo.body.data.id,
      'S4_ENTRY_QUEUED_PROOF',
      async () => {
        workspaceHeld();
        await new Promise((resolve) => {
          releaseWorkspace = resolve;
        });
      },
    );
    t.after(async () => {
      releaseWorkspace?.();
      await gate;
    });
    await held;
    const queued = await rA(
      'POST',
      '/workspaces/' + workspaceId + '/sync',
      { expected_version: ws.version, expected_policy_version: policy.version },
      'entry-queued-sync',
    );
    assert.equal(queued.status, 202);
    const syncId = queued.body.data.id;
    assert.equal(
      (await A.facts()).syncs.find((row) => row.id === syncId).status,
      'QUEUED',
    );
    await A.close();
    releaseWorkspace();
    await gate;
    const outboxGate = await RuntimeLease.acquire(
      new OutboxGatePaths(instance.dataRoot),
      1,
    );
    t.after(() => outboxGate.release());
    const B = await startWorker(t, h, instance, remoteStat);
    assert.equal(B.ready.ready, true);
    const beforeStop = await eventually(
      () => B.facts(),
      (facts) =>
        facts.syncs.some(
          (row) => row.id === syncId && row.status === 'SUCCESS',
        ) && facts.outboxes.length === 1,
    );
    assert.equal(beforeStop.outboxes[0].status, 'PENDING');
    assert.equal(beforeStop.runs.length, 0);
    assert.equal(beforeStop.syncs[0].after_commit, targetCommit);
    await B.close();
    await outboxGate.release();
    const C = await startWorker(t, h, instance, remoteStat);
    assert.equal(C.ready.ready, true);
    const recovered = await eventually(
      () => C.facts(workspaceId),
      (facts) =>
        facts.runs.length === 1 &&
        facts.runs[0].status === 'SUCCESS' &&
        facts.workspace_free,
    );
    assert.equal(recovered.outboxes[0].status, 'DISPATCHED');
    assert.equal(recovered.runs[0].attempt_count, 1);
    assert.equal(
      recovered.runs[0].submission_key,
      'event:' + recovered.events[0].id,
    );
    assert.equal(recovered.events[0].task_run_id, recovered.runs[0].id);
    const rC = await login(h, C, password);
    const log = await rC('GET', '/task-runs/' + recovered.runs[0].id + '/log');
    assert.equal(log.status, 200);
    assert.equal(
      log.body.data.text.includes('ENTRY_RECOVERED_GITUPDATE'),
      true,
    );
    policy = (await rC('GET', '/workspaces/' + workspaceId + '/sync-policy'))
      .body.data;
    const anchor = new Date(Date.now() + 2000).toISOString();
    const scheduled = await rC(
      'PUT',
      '/workspaces/' + workspaceId + '/sync-policy',
      {
        expected_version: policy.version,
        enabled: true,
        mode: 'SCHEDULED',
        schedule: {
          type: 'INTERVAL',
          interval_ms: 60000,
          anchor_at: anchor,
          misfire_policy: 'FIRE_ONCE',
        },
      },
    );
    assert.equal(scheduled.status, 200);
    await C.close();
    if (Date.now() <= Date.parse(anchor))
      await new Promise((resolve) =>
        setTimeout(resolve, Date.parse(anchor) - Date.now() + 50),
      );
    const D = await startWorker(t, h, instance, remoteStat);
    assert.equal(D.ready.ready, true);
    const final = await eventually(
      () => D.facts(),
      (facts) =>
        facts.syncs.some(
          (row) =>
            row.trigger_source === 'INTERVAL' && row.status === 'NO_CHANGE',
        ),
    );
    assert.equal(final.runs.length, 1);
    assert.equal(final.events.length, 1);
    assert.equal(final.outboxes.length, 1);
    assert.equal(
      final.syncs.find((row) => row.trigger_source === 'INTERVAL')
        .schedule_slot,
      anchor,
    );
    assert.equal(
      new Set([A.child.pid, B.child.pid, C.child.pid, D.child.pid]).size,
      4,
    );
    await h.record('S4-ENTRY-PENDING-001', {
      status: 'PASS',
      actual_production_entry: true,
      independent_controller_pids: [
        A.child.pid,
        B.child.pid,
        C.child.pid,
        D.child.pid,
      ],
      workspace_id: workspaceId,
      task_id: taskId,
      sync_run_id: syncId,
      target_commit: targetCommit,
      queued_sync_preserved: true,
      pending_outbox_preserved: true,
      final,
      actual_child_log_proved: true,
      one_task_run: true,
      schedule_survives_restart: true,
    });
  },
);

test(
  'S4 production entry retains an unrecognized materialization journal and refuses business admission after restart',
  { timeout: 300000 },
  async (t) => {
    const h = await createS4Fixture(t, { caseId: 'S4-ENTRY-RECOVERY-002' }),
      instance = await h.createInstance('A');
    await instance.close();
    const password = 'S4_RECOVERY_' + randomUUID();
    h.registerSecret(password);
    const A = await startWorker(t, h, instance),
      rA = await login(h, A, password, true);
    const ws = (
      await rA(
        'POST',
        '/workspaces',
        { type: 'LOCAL', name: 'Recovery original' },
        'entry-recovery-local',
      )
    ).body.data.workspace;
    assert.equal(
      (
        await rA('POST', '/workspaces/' + ws.id + '/files', {
          path: 'main.sh',
          content: 'printf "ENTRY_SOURCE_PRESERVED\\n"\n',
          must_not_exist: true,
        })
      ).status,
      200,
    );
    const task = (await rA('POST', '/tasks', shellTask(ws.id))).body.data;
    await A.close();
    const ownerRoot = path.join(
      instance.dataRoot,
      'tmp/execution/workspace-owners',
    );
    await fs.mkdir(ownerRoot, { recursive: true, mode: 0o700 });
    const injected = path.join(ownerRoot, 'workspace-' + ws.id + '.json'),
      bytes = Buffer.from('{"unknown":true}');
    await fs.writeFile(injected, bytes, { mode: 0o600, flag: 'wx' });
    const B = await startWorker(t, h, instance);
    assert.equal(B.ready.ready, false);
    const rB = await login(h, B, password);
    const denied = await rB(
      'POST',
      '/tasks/' + task.id + '/run',
      { wait_mode: 'WAIT' },
      'entry-denied-run',
    );
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error_code, 'WORKSPACE_RECOVERY_REQUIRED');
    assert.deepEqual(await fs.readFile(injected), bytes);
    assert.equal((await B.facts()).runs.length, 0);
    await h.record('S4-ENTRY-RECOVERY-002', {
      status: 'PASS',
      actual_production_entry: true,
      controller_pids: [A.child.pid, B.child.pid],
      workspace_id: ws.id,
      task_id: task.id,
      ready: false,
      unknown_journal_retained: true,
      journal_sha256: createHash('sha256').update(bytes).digest('hex'),
      task_submission_http: 409,
      task_run_count: 0,
      no_automatic_replay: true,
    });
  },
);
