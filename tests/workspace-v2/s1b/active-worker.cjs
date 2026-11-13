const fs = require('node:fs/promises');
const path = require('node:path');
const { assertOwnedInstance } = require('./fixture.cjs');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../../back/services/workspaceV2/lease');
const {
  PlatformBackupBarrier,
} = require('../../../back/services/backup/barrier');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');

(async () => {
  const [mode, instanceRoot, runText, readyFile] = process.argv.slice(2);
  await assertOwnedInstance(instanceRoot);
  const dataRoot = path.join(instanceRoot, 'data');
  const store = await WorkspaceStore.open(
    path.join(dataRoot, 'db/database.sqlite'),
    dataRoot,
  );
  const roots = new WorkspaceRootResolver(dataRoot);
  const leases = new WorkspaceLeaseService(
    dataRoot,
    new PlatformBackupBarrier(dataRoot + '.platform-control'),
  );
  const id = Number(runText);
  const engine = new TaskExecutionService(store, roots, leases, {
    fault: async (phase) => {
      if (mode === 'RUN' && phase === 'DURING_RUNNER') {
        await fs.writeFile(
          readyFile,
          JSON.stringify({ pid: process.pid, run_id: id, phase }),
          { mode: 0o600 },
        );
        await new Promise(() => {});
      }
    },
  });
  try {
    if (mode === 'RECOVER') {
      const deadline = Date.now() + 30000;
      while (true) {
        await engine.recover();
        const run = await engine.get(id);
        if (['INTERRUPTED', 'RECOVERY_REQUIRED'].includes(run.status)) {
          process.stdout.write(
            JSON.stringify({
              pid: process.pid,
              run_id: id,
              status: run.status,
              attempt_count: run.attempt_count,
            }) + '\n',
          );
          break;
        }
        if (Date.now() >= deadline) throw Error('S1B_RECOVERY_DEADLINE');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } else {
      const run = await engine.wait(id, 45000);
      throw Error('S1B_EXPECTED_ACTIVE_CHECKPOINT_NOT_REACHED_' + run.status);
    }
  } finally {
    await engine.close();
    await store.close();
  }
})().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      code:
        error.error_code || error.code || error.message || 'S1B_WORKER_FAILED',
    }) + '\n',
  );
  process.exitCode = 1;
});
