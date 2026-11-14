const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const {
  runtimeTreeDigest,
} = require('../../../scripts/release-v2/runtime-tree.cjs');

test('RUNTIME_TREE_LOADER compiled module uses its own release helper and fails closed when absent', async (t) => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), 's5r-loader-'),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.resolve(__dirname, '../../..');
  const services = path.join(root, 'static/build/services'),
    scripts = path.join(root, 'scripts/release-v2');
  await fs.mkdir(services, { recursive: true, mode: 0o700 });
  await fs.mkdir(scripts, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(root, 'tree'), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@anysoft/zhixu' }),
  );
  const compiled = ts.transpileModule(
    await fs.readFile(
      path.join(project, 'back/services/runtimeTreeWitness.ts'),
      'utf8',
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const module = path.join(services, 'runtimeTreeWitness.js');
  await fs.writeFile(module, compiled);
  const helper = path.join(scripts, 'runtime-tree.cjs');
  await fs.copyFile(
    path.join(project, 'scripts/release-v2/runtime-tree.cjs'),
    helper,
  );
  const code =
    'require(process.argv[1]).runtimeTreeDigest(process.argv[2]).then(x=>console.log(JSON.stringify(x)))';
  const run = () =>
    spawnSync(process.execPath, ['-e', code, module, path.join(root, 'tree')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
        HOME: root,
        QL_DIR: '/irrelevant-untrusted-app-path',
      },
    });
  const good = run();
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(
    JSON.parse(good.stdout),
    await runtimeTreeDigest(path.join(root, 'tree')),
  );
  await fs.unlink(helper);
  const missing = run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /MODULE_NOT_FOUND/);
});
