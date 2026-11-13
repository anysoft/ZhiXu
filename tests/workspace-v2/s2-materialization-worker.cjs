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
  WorkspaceAttemptRunner,
} = require('../../back/services/taskExecutionV2/runner');
(async () => {
  const [dataRoot, planFile, checkpoint] = process.argv.slice(2);
  const store = await WorkspaceStore.open(
    path.join(dataRoot, 'db/database.sqlite'),
    dataRoot,
  );
  const roots = new WorkspaceRootResolver(dataRoot);
  const leases = new WorkspaceLeaseService(
    dataRoot,
    new PlatformBackupBarrier(dataRoot + '.platform-control'),
  );
  const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
  const runner = new WorkspaceAttemptRunner(store, roots, {
    fault: async (phase) => {
      if (phase === checkpoint) {
        process.stdout.write('KILL:' + phase + '\n');
        process.kill(process.pid, 'SIGKILL');
      }
    },
  });
  await leases.withWorkspace(plan.source.workspaceId, 'S2_CRASH', (lease) =>
    runner.run(plan, 1, lease, [], async () => {}),
  );
  await store.close();
  process.exitCode = 2;
})().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
