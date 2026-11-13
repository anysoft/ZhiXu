// Isolated S2 qualification. Provision one actual managed domain, then serialize
// test files against it. No v9 startup, default data root or Host fallback.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const projectRoot = path.resolve(__dirname, '../..');
const runner = path.join(__dirname, 'run.cjs');
let receipt = process.env.ZHIXU_S2_MANAGED_RECEIPT;
if (!receipt) {
  const owned = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 's2-runtime-proof-'),
  );
  fs.chmodSync(owned, 0o700);
  receipt = path.join(owned, 'receipt.json');
  const provision = spawnSync(
    process.execPath,
    [runner, 's2-runtime-provision.cjs'],
    {
      cwd: projectRoot,
      env: { ...process.env, ZHIXU_S2_MANAGED_RECEIPT: receipt },
      stdio: 'inherit',
    },
  );
  if (provision.error) throw provision.error;
  if (provision.status !== 0) process.exit(provision.status ?? 1);
}
process.stdout.write('S2 managed qualification receipt: ' + receipt + '\n');
const requested = process.argv.slice(2);
const files = requested.length
  ? requested
  : fs
      .readdirSync(__dirname)
      .filter((name) => name.startsWith('s2-') && name.endsWith('.test.cjs'))
      .sort();
const result = spawnSync(process.execPath, [runner, ...files], {
  cwd: projectRoot,
  env: { ...process.env, ZHIXU_S2_MANAGED_RECEIPT: receipt },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
