const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../back/services/workspaceV2/lease');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceReclaimService,
} = require('../../back/services/workspaceV2/reclaim');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const {
  WorkspacePreservationService,
} = require('../../back/services/workspaceV2/preservation');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');
(async () => {
  const o = JSON.parse(process.argv[2]);
  const fault = async (phase) => {
    if (phase === o.phase) {
      process.stdout.write('SIGKILL:' + phase + '\n');
      process.kill(process.pid, 'SIGKILL');
    }
  };
  const store = await WorkspaceStore.open(o.databasePath, o.dataRoot);
  const roots = new WorkspaceRootResolver(o.dataRoot, fault);
  const leases = new WorkspaceLeaseService(
    o.dataRoot,
    new PlatformBackupBarrier(o.dataRoot + '.platform-control'),
  );
  const lifecycle = new WorkspaceLifecycleService(store, roots, leases, {
    fault,
  });
  if (o.action === 'create')
    await lifecycle.createLocal({
      name: 'killed create',
      requestKey: o.requestKey,
    });
  else if (o.action === 'create-git')
    await lifecycle.createGit({
      name: 'killed Git create',
      requestKey: o.requestKey,
      repositoryId: o.repositoryId,
      refType: 'branch',
      refName: 'main',
    });
  else if (o.action === 'archive')
    await lifecycle.archive(o.workspaceId, o.version, {
      requestKey: o.requestKey,
    });
  else if (o.action === 'reclaim') {
    const backup = new WorkspaceBackupService(
      store,
      roots,
      leases,
      o.backupRoot,
    );
    const reclaim = new WorkspaceReclaimService(
      store,
      roots,
      leases,
      new WorkspacePreservationService(backup),
      { fault },
    );
    await reclaim.remove(o.workspaceId, o.version, {
      requestKey: o.requestKey,
      snapshotId: o.snapshotId,
    });
  } else throw Error('WORKER_ACTION_INVALID');
  await store.close();
  process.exit(2);
})().catch((e) => {
  console.error(e.error_code || 'WORKER_FAILED');
  process.exit(1);
});
