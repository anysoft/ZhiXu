// Invoked through the isolated test runner environment, never the default app root.
const fs = require('node:fs/promises');
const { createFixture } = require('./fixture.cjs');
const {
  provisionManagedRuntime,
  writePreparedReceipt,
} = require('./s2-runtime-fixture.cjs');
(async () => {
  const f = await createFixture();
  process.stdout.write('S2_MANAGED_ROOT=' + f.root + '\n');
  const managed = await provisionManagedRuntime(f);
  const receipt = await writePreparedReceipt(
    f,
    managed,
    process.env.ZHIXU_S2_MANAGED_RECEIPT ||
      '/tmp/zhixu-s2-managed-runtime-receipt.json',
  );
  process.stdout.write(
    JSON.stringify({
      status: 'PASS',
      python: receipt.python.runtimeVersion,
      node: receipt.node.runtimeVersion,
      root: f.root,
    }) + '\n',
  );
  await managed.close();
  await f.store.close();
})().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
