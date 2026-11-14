// S5 reruns preserved UI/domain assertions against an explicit compiled release candidate.
const { artifactModule, releaseRoot } = require('./artifact-support.cjs');
const path = require('node:path');
const { assertOwnedInstance } = require('./fixture.cjs');
const { V2Application } = artifactModule('applicationV2/application');
(async () => {
  const root = process.argv[2];
  await assertOwnedInstance(root);
  const app = await V2Application.launch({
    artifactRoot: path.join(
      releaseRoot(),
      'static/build/applicationV2/contracts',
    ),
    dataRoot: path.join(root, 'data'),
    backupRoot: path.join(root, 'backups'),
    initialize: false,
    projectRoot: releaseRoot(),
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
