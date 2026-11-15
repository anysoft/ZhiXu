'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

test('SQLite publication preserves strict build umask and service-readable output', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 's5r-sqlite-publish-')));
  const identity = await fs.lstat(root);
  const listeners = new Map(['SIGINT', 'SIGTERM'].map((name) => [name, process.listeners(name)]));
  t.after(async () => {
    for (const [name, previous] of listeners)
      for (const listener of process.listeners(name))
        if (!previous.includes(listener)) process.removeListener(name, listener);
    const current = await fs.lstat(root);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await fs.rm(root, { recursive: true });
  });
  const patch = await fs.readFile(path.resolve(__dirname, '../../../patches/@whyour__sqlite3@1.1.2.patch'), 'utf8');
  const marker = 'diff --git a/deps/install-secure.cjs b/deps/install-secure.cjs';
  const start = patch.indexOf(marker), next = patch.indexOf('\ndiff --git ', start + marker.length);
  assert.ok(start >= 0);
  const source = patch.slice(start, next < 0 ? undefined : next).split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1)).join('\n');
  const entry = source.lastIndexOf('\nmain().catch(');
  assert.ok(entry >= 0);
  const filename = path.join(root, 'deps/install-secure.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  // Exact published helper, with only CLI auto-start disabled. All filesystem,
  // umask, ownership, modes, exclusive creation and rename calls are real.
  loaded._compile(source.slice(0, entry) + '\nmodule.exports = {targetDirectory, publishReceipt};\n', filename);
  const { targetDirectory, publishReceipt } = loaded.exports;
  const previousUmask = process.umask(0o077);
  try {
    await t.test('new and pre-existing caller-owned addon directories are traversable', async () => {
      const relative = path.join('lib', 'binding', 'napi-v6-fixture', 'node_sqlite3.node');
      const target = await targetDirectory(relative);
      for (const dir of [path.dirname(target), path.dirname(path.dirname(target)), path.join(root, 'lib')])
        assert.equal((await fs.lstat(dir)).mode & 0o777, 0o755);
      await fs.chmod(path.dirname(target), 0o700);
      await targetDirectory(relative);
      assert.equal((await fs.lstat(path.dirname(target))).mode & 0o777, 0o755);
      assert.equal(process.umask(), 0o077);
    });
    await t.test('symlink addon paths are rejected before changing target permissions', async () => {
      const target = path.join(root, 'outside');
      await fs.mkdir(target, { mode: 0o700 });
      await fs.symlink(target, path.join(root, 'lib', 'binding', 'napi-v6-alias'));
      await assert.rejects(targetDirectory(path.join('lib', 'binding', 'napi-v6-alias', 'node_sqlite3.node')), { code: 'SQLITE_NATIVE_PATH_REJECTED' });
      assert.equal((await fs.lstat(target)).mode & 0o777, 0o700);
    });
    await t.test('receipt is physically readable after atomic publish under umask 077', async () => {
      const receipt = path.join(root, 'zhixu-sqlite-build.json');
      await publishReceipt(receipt, { fixture: true }, 'owned-fixture');
      assert.equal((await fs.lstat(receipt)).mode & 0o777, 0o644);
      assert.deepEqual(JSON.parse(await fs.readFile(receipt, 'utf8')), { fixture: true });
      await assert.rejects(fs.lstat(receipt + '.owned-fixture.tmp'), { code: 'ENOENT' });
      assert.equal(process.umask(), 0o077);
    });
    await t.test('private exclusive lock and temporary directories retain private modes', async () => {
      const lock = path.join(root, 'fixture.lock');
      const handle = await fs.open(lock, 'wx', 0o600);
      await handle.close();
      assert.equal((await fs.lstat(lock)).mode & 0o777, 0o600);
      const temp = await fs.mkdtemp(path.join(root, 'private-'));
      assert.equal((await fs.lstat(temp)).mode & 0o777, 0o700);
    });
    await t.test('a physical foreign-owned addon directory is refused', async () => {
      if (process.getuid() === 0) {
        const foreign = path.join(root, 'lib', 'binding', 'napi-v6-foreign');
        await fs.mkdir(foreign, { mode: 0o700 });
        await fs.chown(foreign, 10001, 10001);
        try { await assert.rejects(targetDirectory(path.join('lib', 'binding', 'napi-v6-foreign', 'node_sqlite3.node')), { code: 'SQLITE_NATIVE_PATH_REJECTED' }); }
        finally { await fs.chown(foreign, 0, 0); }
      } else {
        // Use a separate exact helper instance whose ROOT is a read-only system
        // directory. Ownership is checked before chmod; no system write occurs.
        const system = await fs.realpath('/usr');
        const foreignFilename = path.join(system, 'deps/install-secure.cjs');
        const foreign = new Module(foreignFilename, module);
        foreign.filename = foreignFilename;
        foreign._compile(source.slice(0, entry) + '\nmodule.exports = targetDirectory;\n', foreignFilename);
        try { await assert.rejects(foreign.exports(path.join('lib', 'binding', 'napi-v6-foreign', 'node_sqlite3.node')), { code: 'SQLITE_NATIVE_PATH_REJECTED' }); }
        finally {
          for (const [name, previous] of listeners)
            for (const listener of process.listeners(name))
              if (!previous.includes(listener)) process.removeListener(name, listener);
        }
      }
    });
  } finally { process.umask(previousUmask); }
});
