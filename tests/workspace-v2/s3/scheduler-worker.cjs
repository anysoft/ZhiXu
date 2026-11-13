// Independent scheduler controller, opened only inside a proven retained fixture.
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
const { syncServices } = require('./sync-fixture.cjs');

async function schedulerController() {
  const [instanceRoot, workspaceIdText, nowText, mode, runIdText] =
    process.argv.slice(2);
  await assertOwnedInstance(instanceRoot);
  const workspaceId = Number(workspaceIdText);
  const dataRoot = path.join(instanceRoot, 'data');
  const store = await WorkspaceStore.open(
    path.join(dataRoot, 'db/database.sqlite'),
    dataRoot,
  );
  const tracked = [];
  try {
    const repository = (
      await store.all(
        'SELECT repository_id id FROM GitWorkspaces WHERE workspace_id=?',
        [workspaceId],
      )
    )[0];
    if (!repository || !Number.isSafeInteger(workspaceId))
      throw Error('WORKER_WORKSPACE_INVALID');
    const clock = { now: () => new Date(nowText) };
    const fixture = {
      root: instanceRoot,
      dataRoot,
      store,
      repository,
      roots: new WorkspaceRootResolver(dataRoot),
      leases: new WorkspaceLeaseService(
        dataRoot,
        new PlatformBackupBarrier(dataRoot + '.platform-control'),
      ),
      track(value) {
        tracked.push(value);
        return value;
      },
    };
    const services = await syncServices(fixture, {
      clock,
      scheduler: { clock, maxRetries: 0 },
    });
    tracked.push(services.scheduler);
    const go = new Promise((resolve) => process.once('message', resolve));
    process.send({ ready: true, pid: process.pid });
    await go;
    if (mode === 'RESUME') await services.sync.wait(Number(runIdText));
    else {
      await services.scheduler.tick();
      const runs = await store.all(
        'SELECT id FROM WorkspaceSyncRuns WHERE workspace_id=?',
        [workspaceId],
      );
      for (const run of runs) await services.sync.wait(run.id);
    }
    const rows = await store.all(
      'SELECT id,status,error_code,request_key FROM WorkspaceSyncRuns WHERE workspace_id=? ORDER BY id',
      [workspaceId],
    );
    process.send({ done: true, pid: process.pid, rows });
  } finally {
    for (const resource of tracked.reverse()) await resource.close();
    await store.close();
  }
  process.disconnect();
}
schedulerController().catch((error) => {
  const candidate = error.error_code || error.code || error.message;
  process.send?.({
    failure: /^[A-Z0-9_]+$/.test(candidate || '')
      ? candidate
      : 'SCHEDULER_WORKER_FAILED',
  });
  process.exitCode = 1;
  process.disconnect?.();
});
