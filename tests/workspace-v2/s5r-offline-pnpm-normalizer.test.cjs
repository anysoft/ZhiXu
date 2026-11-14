// Real filesystem policy tests with explicitly synthetic source members. These
// are deletion-boundary regressions, never Runtime/Provider qualification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createOfflineFixture,
  writeFixture,
} = require('./s5r-offline-fixture.cjs');
const {
  runtimeTreeDigest,
} = require('../../scripts/release-v2/runtime-tree.cjs');

async function pnpmNormalizationFixture(t) {
  const f = await createOfflineFixture(t);
  Object.assign(f.manifest.artifacts[0], {
    npm_name: 'tsx',
    npm_version: '4.23.15',
  });
  await writeFixture(f);
  const artifacts = await f.open();
  const Paths = f.module('back/services/nodePaths.ts').default;
  const Manager = f.module('back/services/nodePackageManager.ts').default;
  const paths = new Paths(f.dataRoot),
    manager = new Manager(paths);
  const root = await paths.create('build', 1, 1),
    packageRoot = path.join(root, 'node_modules/tsx');
  await fs.mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'tsx', version: '4.23.15' }),
  );
  await fs.writeFile(
    path.join(packageRoot, 'source-member'),
    'synthetic approved source member',
  );
  const baseline = await runtimeTreeDigest(packageRoot);
  const modules = path.join(packageRoot, 'node_modules'),
    bins = path.join(modules, '.bin'),
    shim = path.join(bins, 'esbuild');
  await fs.mkdir(bins, { recursive: true, mode: 0o700 });
  const content =
    '#!/bin/sh\n# synthetic manager wrapper ' +
    'x'.repeat(100) +
    '\n"$basedir/../../../esbuild/bin/esbuild"   "$@"\nexit $?\n';
  await fs.writeFile(shim, content, { mode: 0o700 });
  const build = {
      id: 1,
      environment_id: 1,
      state: 'QUEUED',
      verified_at: null,
      package_json: '',
      lockfile: '',
      metadata: {},
    },
    stages = [];
  const normalize = () =>
    manager.normalizePnpmTsx(
      { stage: async (name) => stages.push(name) },
      { version: '10.34.9' },
      build,
      artifacts,
      { packages: ['test-package'] },
      root,
    );
  return {
    ...f,
    packageRoot,
    modules,
    bins,
    shim,
    content,
    baseline,
    build,
    stages,
    normalize,
  };
}

test('S5R PNPM fresh normalization removes only the known generated entries and restores every source member digest', async (t) => {
  const f = await pnpmNormalizationFixture(t);
  await f.normalize();
  assert.deepEqual(await runtimeTreeDigest(f.packageRoot), f.baseline);
  await assert.rejects(fs.lstat(f.modules), { code: 'ENOENT' });
  assert.deepEqual(f.stages, ['NORMALIZED_PNPM_10_34_9_GENERATED_TSX_SHIM']);
});
test('S5R PNPM normalization refuses unknown additional files without deleting either file', async (t) => {
  const f = await pnpmNormalizationFixture(t),
    extra = path.join(f.bins, 'preserve-user-file');
  await fs.writeFile(extra, 'preserve');
  await assert.rejects(f.normalize(), { error_code: 'NODE_BUILD_INVALID' });
  assert.equal(await fs.readFile(extra, 'utf8'), 'preserve');
  assert.equal(await fs.readFile(f.shim, 'utf8'), f.content);
  assert.deepEqual(f.stages, []);
});
test('S5R PNPM normalization never deletes or repairs an existing READY Build', async (t) => {
  const f = await pnpmNormalizationFixture(t);
  f.build.state = 'READY';
  await assert.rejects(f.normalize(), { error_code: 'NODE_BUILD_INVALID' });
  assert.equal(await fs.readFile(f.shim, 'utf8'), f.content);
  assert.deepEqual(f.stages, []);
});
test('S5R PNPM normalization refuses a symbolic link and preserves its target', async (t) => {
  const f = await pnpmNormalizationFixture(t),
    target = path.join(f.root, 'preserve-target');
  await fs.writeFile(target, 'preserve');
  await fs.unlink(f.shim);
  await fs.symlink(target, f.shim);
  await assert.rejects(f.normalize(), { error_code: 'NODE_BUILD_INVALID' });
  assert.ok((await fs.lstat(f.shim)).isSymbolicLink());
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve');
  assert.deepEqual(f.stages, []);
});
