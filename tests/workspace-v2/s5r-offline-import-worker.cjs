const { loadModules } = require('./s5r-offline-fixture.cjs');
async function main() {
  const f = JSON.parse(process.argv[2]),
    { Store } = loadModules(f.dataRoot);
  const store = await Store.open(f.options, f.dataRoot);
  let paused = false;
  await store.importPackage(f.packageRoot, async (stage) => {
    if (stage === 'VERIFIED_SOURCE' && !paused) {
      paused = true;
      process.stdout.write('VERIFIED_SOURCE\n');
      await new Promise((resolve) => process.stdin.once('data', resolve));
    }
  });
  process.stdin.destroy();
  process.stdout.write('IMPORT_COMPLETE\n');
}
main().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
