const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function run(args, env = process.env) {
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}
run([path.join(root, 'scripts/native/verify-sqlite.cjs')]);
run([path.join(root, 'scripts/build-back.cjs')]);
run([path.join(root, 'scripts/native/prepare-git-tools.cjs')]);
const target = path.join(root, 'static/build/applicationV2/contracts');
fs.mkdirSync(target, { recursive: true });
const hashes = {};
for (const name of ['fresh-v2.sql', 'api-contracts.json', 'error-codes.json']) {
  const source = path.join(root, 'docs/architecture/v2/contracts', name);
  fs.copyFileSync(source, path.join(target, name));
  hashes[name] = crypto
    .createHash('sha256')
    .update(fs.readFileSync(source))
    .digest('hex');
}
fs.writeFileSync(
  path.join(target, 'artifact-hashes.json'),
  JSON.stringify(hashes, null, 2) + '\n',
);
run([require.resolve('@umijs/max/bin/max'), 'build'], {
  ...process.env,
  ZHIXU_FRONTEND_MODE: 'v2',
});
