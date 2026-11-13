const path = require('node:path');
const { assertOwnedInstance } = require('./fixture.cjs');
const {
  WorkspaceLeaseService,
} = require('../../../back/services/workspaceV2/lease');
const {
  PlatformBackupBarrier,
} = require('../../../back/services/backup/barrier');
(async () => {
  const [root, selected] = process.argv.slice(2),
    repositoryId = Number(selected);
  await assertOwnedInstance(root);
  const dataRoot = path.join(root, 'data');
  const leases = new WorkspaceLeaseService(
    dataRoot,
    new PlatformBackupBarrier(dataRoot + '.platform-control'),
  );
  await leases.withRepository(
    repositoryId,
    'S3_EXTERNAL_REPOSITORY_OWNER',
    async (lease) => {
      await lease.assertHeld();
      process.send({
        held: true,
        pid: process.pid,
        repositoryId,
        realLeaseFdCount: lease.processLeaseFds.length,
      });
      await new Promise((resolve) => {
        const receive = (message) => {
          if (message?.release === true) {
            process.off('message', receive);
            resolve();
          }
        };
        process.on('message', receive);
      });
    },
  );
})().catch((error) => {
  process.send?.({
    failure: /^[A-Z0-9_]+$/.test(error.error_code || error.code || '')
      ? error.error_code || error.code
      : 'EXTERNAL_OWNER_FAILED',
  });
  process.exitCode = 1;
});
