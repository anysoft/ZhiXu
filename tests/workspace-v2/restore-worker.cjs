// The parent kills no mocked API: this worker reaches a durable restore rename.
const path = require('node:path');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../back/services/workspaceV2/lease');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const {
  WorkspaceRestoreService,
} = require('../../back/services/workspaceV2/restore');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');
(async () => {
  const [dataRoot, backupRoot, snapshot, checkpoint] = process.argv.slice(2);
  if (snapshot === 'recover') {
    const restored = await WorkspaceRestoreService.recoverAt(
      dataRoot,
      backupRoot,
    );
    await restored.close();
    return;
  }
  const store = await WorkspaceStore.open(
    path.join(dataRoot, 'db/database.sqlite'),
    dataRoot,
  );
  const roots = new WorkspaceRootResolver(dataRoot);
  const leases = new WorkspaceLeaseService(
    dataRoot,
    new PlatformBackupBarrier(dataRoot + '.platform-control'),
  );
  const backup = new WorkspaceBackupService(store, roots, leases, backupRoot);
  await new WorkspaceRestoreService(backup, {
    fault: async (phase) => {
      if (phase === checkpoint) process.kill(process.pid, 'SIGKILL');
    },
  }).restore(snapshot);
  process.exitCode = 2; // The requested checkpoint must actually have been reached.
})().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
