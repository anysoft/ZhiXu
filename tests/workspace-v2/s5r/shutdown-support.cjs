const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createFixture } = require('../fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(10);
  }
  throw Error('SHUTDOWN_TEST_CONDITION_TIMEOUT');
}
async function createShutdownFixture(t, options = {}) {
  const f = await createFixture();
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  const tasks = new TaskService(f.store, f.roots, f.leases);
  const workspace = await lifecycle.createLocal({
    name: 'shutdown',
    requestKey: 'shutdown',
  });
  const control = path.join(f.root, 'control');
  await fs.mkdir(control, { mode: 0o700 });
  const engine = new TaskExecutionService(f.store, f.roots, f.leases, options);
  const workers = [];
  const receipts = [];
  const record = (id, data) => receipts.push({ case_id: id, ...data });
  t.after(async () => {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
    await engine.close();
    const evidence = process.env.ZHIXU_S5R_EVIDENCE_ROOT;
    if (evidence) {
      const out = path.join(evidence, path.basename(f.root));
      await fs.mkdir(out, { mode: 0o700 });
      const rows = {};
      for (const name of [
        'TaskRuns',
        'TaskRunAttempts',
        'TaskRunEvents',
        'TriggerEvents',
      ])
        rows[name] = await f.store.all(`SELECT * FROM ${name}`);
      await fs.writeFile(
        path.join(out, 'receipts.json'),
        JSON.stringify(
          {
            node: process.version,
            architecture: process.arch,
            pid: process.pid,
            receipts,
            rows,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
      await f.store.close();
      await fs.copyFile(f.databasePath, path.join(out, 'database.sqlite'));
    } else await f.store.close();
    await fs.rm(f.root, { recursive: true });
  });
  return {
    ...f,
    workspace,
    control,
    engine,
    workers,
    record,
    async task(script, execution = {}, enabled = false) {
      const name = 'task-' + (await f.store.all('SELECT id FROM Tasks')).length;
      await files.create(workspace.id, name + '.sh', script);
      return tasks.create({
        name,
        enabled,
        arguments: [control],
        source: {
          type: 'WORKSPACE_ENTRYPOINT',
          workspace_id: workspace.id,
          relative_entrypoint: name + '.sh',
          language: 'SHELL',
          cwd_mode: 'WORKSPACE_ROOT',
          cwd_relative_path: null,
        },
        execution: {
          concurrency: 'QUEUE',
          timeout_seconds: null,
          ...execution,
        },
      });
    },
    async started(runId) {
      await engine.tick();
      const pid = await until(async () => {
        const text = await fs
          .readFile(path.join(control, 'pid'), 'utf8')
          .catch(() => '');
        return Number(text) || false;
      });
      assert.equal((await engine.get(runId)).status, 'RUNNING');
      return pid;
    },
  };
}
async function assertLeaseBusy(f, runId) {
  await assert.rejects(
    f.leases.withWorkspace(
      f.workspace.id,
      'SHUTDOWN_BUSY_PROOF',
      async () => {},
    ),
    (e) => e.error_code === 'WORKSPACE_BUSY' || e.code === 'WORKSPACE_BUSY',
  );
  await assert.rejects(
    f.engine.paths.owner(runId),
    (e) => e.error_code === 'RUNTIME_BUSY' || e.code === 'RUNTIME_BUSY',
  );
}
async function assertLeaseReleased(f, runId) {
  await f.leases.withWorkspace(
    f.workspace.id,
    'SHUTDOWN_RELEASE_PROOF',
    async () => {},
  );
  const owner = await f.engine.paths.owner(runId);
  await owner.release();
}
function assertChildStopped(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const live = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(
      ([group, state]) => Number(group) === pid && !state.startsWith('Z'),
    );
  assert.deepEqual(live, []);
}
async function startShutdownWorker(f, mode, runId, clock) {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 'shutdown-worker.cjs'),
      mode,
      f.dataRoot,
      String(runId),
      ...(clock ? [clock] : []),
    ],
    { cwd: f.projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  f.workers.push(child);
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b;
  });
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  return { child, exited };
}
module.exports = {
  createShutdownFixture,
  until,
  pause,
  assertLeaseBusy,
  assertLeaseReleased,
  assertChildStopped,
  startShutdownWorker,
};
