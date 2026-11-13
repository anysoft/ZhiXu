const path = require('node:path');
const { assertOwnedInstance } = require('./fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');
(async () => {
  const root = process.argv[2];
  await assertOwnedInstance(root);
  const app = await V2Application.launch({
    dataRoot: path.join(root, 'data'),
    backupRoot: path.join(root, 'backups'),
    initialize: false,
    projectRoot: path.resolve(__dirname, '../../..'),
    port: 0,
    background: false,
  });
  const facts = async () => ({
    outbox: await app.services.store.all(
      'SELECT id,status,attempt_count FROM NotificationOutbox ORDER BY id',
    ),
    attempts: await app.services.store.all(
      'SELECT attempt,result,error_code FROM NotificationDeliveries ORDER BY attempt',
    ),
  });
  process.send({ ready: true, ...(await facts()) });
  process.on('message', async (message) => {
    try {
      if (message.deliver) {
        await app.notifications.tick();
        process.send({ delivered: true, ...(await facts()) });
      } else if (message.close) {
        await app.close();
        process.exit(0);
      }
    } catch (error) {
      process.send({
        error_code: error.error_code ?? 'NOTIFICATION_WORKER_FAILED',
      });
    }
  });
})().catch((error) => {
  process.send?.({
    error_code: error.error_code ?? 'NOTIFICATION_BOOT_FAILED',
  });
  process.exitCode = 1;
});
