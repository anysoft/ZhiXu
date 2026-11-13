const path = require('node:path');
const { assertOwnedInstance } = require('./fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');
(async () => {
  const instanceRoot = process.argv[2];
  await assertOwnedInstance(instanceRoot);
  const app = await V2Application.launch({
    dataRoot: path.join(instanceRoot, 'data'),
    backupRoot: path.join(instanceRoot, 'backups'),
    initialize: false,
    projectRoot: path.resolve(__dirname, '../../..'),
    port: 0,
    background: false,
  });
  const journal = await app.services.restore.status();
  process.send({
    ready: true,
    origin: app.origin,
    restore_stage: journal?.stage,
    phases: app.phases,
  });
  process.on('message', async (message) => {
    if (message?.close) {
      await app.close();
      process.exit(0);
    }
  });
})().catch((error) => {
  process.send?.({
    error_code: /^[A-Z][A-Z0-9_]+$/.test(error.error_code ?? error.code ?? '')
      ? error.error_code ?? error.code
      : 'BACKUP_RESTART_WORKER_FAILED',
  });
  process.exitCode = 1;
});
