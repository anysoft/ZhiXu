const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  { spawn } = require('node:child_process');
const { createFixture } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');
test('two independent candidate controller processes claim one durable Run and spawn exactly one real child', async (t) => {
  const f = await createFixture(t);
  const ws = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'multiprocess', requestKey: 'multiprocess' });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    ws.id,
    'main.sh',
    'printf once >> "$1"\nsleep .3\nprintf "ONE_REAL_CHILD\\n"\n',
  );
  const counter = path.join(f.root, 'outside-source-counter');
  const task = await new TaskService(f.store, f.roots, f.leases).create({
    name: 'exactly once',
    arguments: [counter],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: ws.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution: { concurrency: 'ALLOW' },
  });
  const engine = new TaskExecutionService(f.store, f.roots, f.leases);
  const row = await engine.submit(task.task.id, {
    submissionKey: 'two-processes',
  });
  await engine.close();
  const launch = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          path.join(__dirname, 's2-dispatch-worker.cjs'),
          f.dataRoot,
          String(row.id),
        ],
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      });
      let out = '',
        err = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (err += b));
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        try {
          assert.equal(code, 0, err + ' ' + signal);
          resolve(JSON.parse(out.trim()));
        } catch (e) {
          reject(e);
        }
      });
    });
  const results = await Promise.all([launch(), launch()]);
  assert.notEqual(results[0].pid, results[1].pid);
  assert.equal(await fs.readFile(counter, 'utf8'), 'once');
  assert.equal((await engine.get(row.id)).attempt_count, 1);
  assert.equal((await engine.attempts(row.id)).length, 1);
  assert.equal((await engine.get(row.id)).status, 'SUCCESS');
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
});
