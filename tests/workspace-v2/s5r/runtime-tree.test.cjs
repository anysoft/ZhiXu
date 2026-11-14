const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  runtimeTreeDigest,
} = require('../../../scripts/release-v2/runtime-tree.cjs');

async function tree(t) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), 's5r-tree-'),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('RUNTIME_TREE stable across creation order and modes, detects nested dependency mutation', async (t) => {
  const a = await tree(t),
    b = await tree(t);
  for (const [root, order] of [
    [a, ['a', 'b']],
    [b, ['b', 'a']],
  ]) {
    await fs.mkdir(path.join(root, 'nested'));
    for (const name of order)
      await fs.writeFile(path.join(root, 'nested', name), name);
    await fs.symlink('nested/a', path.join(root, 'cli'));
  }
  const before = await runtimeTreeDigest(a);
  assert.deepEqual(before, await runtimeTreeDigest(b));
  assert.equal(before.bytes, 2);
  await fs.chmod(path.join(b, 'nested/b'), 0o700);
  assert.deepEqual(before, await runtimeTreeDigest(b));
  await fs.writeFile(path.join(b, 'nested/b'), 'patched transitive dependency');
  assert.notEqual(before.sha256, (await runtimeTreeDigest(b)).sha256);
});
test('RUNTIME_TREE rejects hard links and special files', async (t) => {
  const root = await tree(t);
  await fs.writeFile(path.join(root, 'a'), 'one');
  await fs.link(path.join(root, 'a'), path.join(root, 'b'));
  await assert.rejects(runtimeTreeDigest(root), /RUNTIME_TREE_INVALID/);
  await fs.unlink(path.join(root, 'b'));
  execFileSync('/usr/bin/mkfifo', [path.join(root, 'fifo')]);
  await assert.rejects(runtimeTreeDigest(root), /RUNTIME_TREE_INVALID/);
});
test('RUNTIME_TREE rejects external, absolute, dangling and cyclic links', async (t) => {
  for (const target of ['../outside', '/bin/sh', 'missing', 'loop']) {
    const root = await tree(t);
    await fs.symlink(target, path.join(root, 'loop'));
    await assert.rejects(runtimeTreeDigest(root));
  }
});
test('RUNTIME_TREE rejects directory alias cycles without traversing them', async (t) => {
  const root = await tree(t);
  await fs.mkdir(path.join(root, 'package'));
  await fs.symlink('.', path.join(root, 'package/self'));
  await assert.rejects(runtimeTreeDigest(root), /RUNTIME_TREE_INVALID/);
});
test('RUNTIME_TREE rejects symlink roots and accepts safe internal package CLI links', async (t) => {
  const root = await tree(t);
  await fs.mkdir(path.join(root, 'package'));
  await fs.writeFile(path.join(root, 'package/cli.js'), 'CLI');
  await fs.mkdir(path.join(root, '.bin'));
  await fs.symlink('../package/cli.js', path.join(root, '.bin/command'));
  const digest = await runtimeTreeDigest(root);
  assert.equal(digest.entry_count, 4);
  assert.equal(digest.bytes, 3);
  await fs.symlink('package', path.join(root, 'alias'));
  await assert.rejects(
    runtimeTreeDigest(path.join(root, 'alias')),
    /RUNTIME_TREE_INVALID/,
  );
});
test('RUNTIME_TREE rejects lossy UTF8 name ambiguity and invalid raw link targets', async (t) => {
  const root = await tree(t);
  const rawName = Buffer.concat([Buffer.from(root + '/'), Buffer.from([0xff])]);
  let created = false;
  try {
    await fs.writeFile(rawName, 'hidden physical file');
    created = true;
  } catch (error) {
    assert.equal(
      error.code,
      'EILSEQ',
      'Only a kernel UTF8-name rejection is an alternative to decoder rejection',
    );
    t.diagnostic(
      'Kernel rejected invalid UTF8 filename before creation; no raw-name collision can be constructed on this filesystem.',
    );
  }
  if (created) {
    await fs.writeFile(
      path.join(root, '\uFFFD'),
      'literal replacement-character name',
    );
    assert.equal((await fs.readdir(root, { encoding: 'buffer' })).length, 2);
    await assert.rejects(runtimeTreeDigest(root), /RUNTIME_TREE_INVALID/);
    await fs.unlink(rawName);
  }
  await fs.symlink(Buffer.from([0xff]), path.join(root, 'raw-link'));
  await assert.rejects(runtimeTreeDigest(root), /RUNTIME_TREE_INVALID/);
});
