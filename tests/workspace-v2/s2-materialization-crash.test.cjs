const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceAttemptRunner,
} = require('../../back/services/taskExecutionV2/runner');
const { materializationFixture } = require('./s2-materialization-fixture.cjs');

for (const checkpoint of [
  'NODE_JOURNAL_DURABLE',
  'NODE_INSTALLED',
  'CONFIG_JOURNAL_DURABLE',
  'CONFIG_ORIGINAL_BACKED_UP',
  'CONFIG_STAGED_DURABLE',
  'CONFIG_INSTALLED',
  'DURING_RUNNER',
  'DURING_CLEANUP',
  'CONFIG_ORIGINAL_RESTORED',
  'AFTER_CHILD_EXIT',
]) {
  test(
    'real SIGKILL at ' +
      checkpoint +
      ' restores original config and owned Workspace Node binding',
    async (t) => {
      const f = await materializationFixture(t, {
        node: true,
        script: 'printf "REAL_MAIN_STARTED\\n"; sleep 0.2',
      });
      const plan = path.join(f.root, 'private-plan.json');
      await fs.writeFile(plan, JSON.stringify(f.context), { mode: 0o600 });
      await f.store.close();
      const child = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          path.join(__dirname, 's2-materialization-worker.cjs'),
          f.dataRoot,
          plan,
          checkpoint,
        ],
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (b) => {
        output += b;
      });
      child.stderr.on('data', (b) => {
        output += b;
      });
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      });
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(result.signal, 'SIGKILL', output);
      assert.match(output, new RegExp('KILL:' + checkpoint));
      f.store = f.track(await WorkspaceStore.open(f.databasePath, f.dataRoot));
      const runner = new WorkspaceAttemptRunner(f.store, f.roots);
      const deadline = Date.now() + 10000;
      while (true) {
        try {
          await f.leases.withWorkspace(
            f.row.id,
            'S2_RECOVER',
            async (lease) => {
              await runner.recover(f.row.id, lease);
              await runner.cleanupRun(f.context.identity.taskRunId);
            },
          );
          break;
        } catch (error) {
          if (error.error_code !== 'WORKSPACE_BUSY' || Date.now() >= deadline)
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.equal(
        await fs.readFile(
          path.join(f.context.workspace.workspaceRoot, 'config.txt'),
          'utf8',
        ),
        'original private user config\n',
      );
      await assert.rejects(
        fs.lstat(path.join(f.context.workspace.workspaceRoot, 'node_modules')),
        { code: 'ENOENT' },
      );
      assert.deepEqual(
        await fs.readdir(path.join(f.dataRoot, 'tmp/config-materialization')),
        [],
      );
      assert.deepEqual(
        await fs.readdir(path.join(f.dataRoot, 'tmp/execution/node-bindings')),
        [],
      );
    },
  );
}
