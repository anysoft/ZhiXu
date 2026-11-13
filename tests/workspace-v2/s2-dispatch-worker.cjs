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
  const [root, id] = process.argv.slice(2);
  const store = await WorkspaceStore.open(
    path.join(root, 'db/database.sqlite'),
    root,
  );
  const roots = new WorkspaceRootResolver(root),
    leases = new WorkspaceLeaseService(
      root,
      new PlatformBackupBarrier(root + '.platform-control'),
    );
  const engine = new TaskExecutionService(store, roots, leases);
  try {
    const result = await engine.wait(Number(id), 30000);
    if (result.status !== 'SUCCESS')
      throw Error(result.error_code || result.status);
    process.stdout.write(
      JSON.stringify({
        id: result.id,
        status: result.status,
        attempts: result.attempt_count,
        pid: process.pid,
      }) + '\n',
    );
  } finally {
    await engine.close();
    await store.close();
  }
})().catch((error) => {
  process.stderr.write(String(error.error_code || error.message));
  process.exitCode = 1;
});
