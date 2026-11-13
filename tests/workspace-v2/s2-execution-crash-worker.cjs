const fs = require('node:fs/promises');
const path = require('node:path');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../back/services/workspaceV2/lease');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');
(async () => {
  const [dataRoot, idText, checkpoint] = process.argv.slice(2);
  const store = await WorkspaceStore.open(
    path.join(dataRoot, 'db/database.sqlite'),
    dataRoot,
  );
  const roots = new WorkspaceRootResolver(dataRoot);
  const leases = new WorkspaceLeaseService(
    dataRoot,
    new PlatformBackupBarrier(dataRoot + '.platform-control'),
  );
  const target =
    checkpoint === 'DURING_CONFIG_INJECTION'
      ? 'CONFIG_ORIGINAL_BACKED_UP'
      : checkpoint;
  const engine = new TaskExecutionService(store, roots, leases, {
    fault: async (phase) => {
      if (phase === target) {
        fs.writeFile(
          path.join(path.dirname(dataRoot), 'kill-phase-' + idText),
          phase,
          { mode: 0o600 },
        ).then(() => process.kill(process.pid, 'SIGKILL'));
        await new Promise(() => {});
      }
    },
  });
  const id = Number(idText);
  if (checkpoint === 'RECOVER') {
    const deadline = Date.now() + 15000;
    while (true) {
      await engine.recover();
      const row = await engine.get(id);
      if (row.status === 'INTERRUPTED' || row.status === 'RECOVERY_REQUIRED')
        break;
      if (Date.now() >= deadline) throw Error('CRASH_RECOVERY_DEADLINE');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await engine.close();
    await store.close();
    return;
  }
  const completed = await engine.wait(id, 40000);
  process.stderr.write(
    JSON.stringify({
      unreached_checkpoint: checkpoint,
      run_id: id,
      status: completed.status,
      error_code: completed.error_code,
      result: completed.result,
    }) + '\n',
  );
  await engine.close();
  await store.close();
  process.exitCode = 2;
})().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
