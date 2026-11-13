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
  const [dataRoot, idText, operation] = process.argv.slice(2);
  const store = await WorkspaceStore.open(
    path.join(dataRoot, 'db/database.sqlite'),
    dataRoot,
  );
  const roots = new WorkspaceRootResolver(dataRoot);
  const leases = new WorkspaceLeaseService(
    dataRoot,
    new PlatformBackupBarrier(dataRoot + '.platform-control'),
  );
  const engine = new TaskExecutionService(store, roots, leases);
  const id = Number(idText);
  if (operation === 'RECOVER') {
    const deadline = Date.now() + 15000;
    while (true) {
      await engine.recover();
      const run = await engine.get(id);
      if (run.status === 'INTERRUPTED' || run.status === 'RECOVERY_REQUIRED')
        break;
      if (Date.now() >= deadline) throw Error('HOOK_RECOVERY_DEADLINE');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } else {
    await engine.wait(id, 45000);
    throw Error('HOOK_CONTROLLER_WAS_NOT_KILLED');
  }
  await engine.close();
  await store.close();
})().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
