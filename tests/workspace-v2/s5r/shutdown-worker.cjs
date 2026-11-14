const path = require('node:path');
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
const {
  WorkspaceCronSubmissions,
} = require('../../../back/services/taskExecutionV2/cron');
(async () => {
  const [mode, dataRoot, id, clock] = process.argv.slice(2);
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
  try {
    if (mode === 'cron')
      await new WorkspaceCronSubmissions(store, roots, leases, engine, {
        now: () => new Date(clock),
      }).tick();
    let run;
    if (mode === 'recover') {
      const end = Date.now() + 15000;
      do {
        await engine.recover();
        run = await engine.get(Number(id));
        if (['INTERRUPTED', 'RECOVERY_REQUIRED'].includes(run.status)) break;
        if (Date.now() >= end) throw Error('SHUTDOWN_RECOVERY_TIMEOUT');
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (true);
    } else run = await engine.wait(Number(id), 30000);
    process.stdout.write(
      JSON.stringify({
        pid: process.pid,
        mode,
        run,
        attempts: await engine.attempts(Number(id)),
      }) + '\n',
    );
  } finally {
    await engine.close();
    await store.close();
  }
})().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
