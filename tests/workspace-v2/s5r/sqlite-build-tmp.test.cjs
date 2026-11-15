const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

test('S5R source-only SQLite staging validates the physical build-only override', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 's5r-sqlite-build-tmp-')));
  const initial = await fs.lstat(root);
  const beforeSignals = new Map(['SIGINT', 'SIGTERM'].map((name) => [name, process.listeners(name)]));
  t.after(async () => {
    for (const [name, previous] of beforeSignals)
      for (const listener of process.listeners(name))
        if (!previous.includes(listener)) process.removeListener(name, listener);
    const current = await fs.lstat(root);
    assert.equal(current.dev, initial.dev);
    assert.equal(current.ino, initial.ino);
    await fs.rm(root, { recursive: true });
  });
  const patch = await fs.readFile(path.resolve(__dirname, '../../../patches/@whyour__sqlite3@1.1.2.patch'), 'utf8');
  const marker = 'diff --git a/deps/install-secure.cjs b/deps/install-secure.cjs';
  const start = patch.indexOf(marker);
  assert.ok(start >= 0);
  const next = patch.indexOf('\ndiff --git ', start + marker.length);
  const source = patch.slice(start, next < 0 ? undefined : next).split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1)).join('\n');
  const entry = source.lastIndexOf('\nmain().catch(');
  assert.ok(entry >= 0);
  // Load the exact shipped helper with only its CLI auto-start disabled. The
  // filesystem, ownership, permissions and process UID are the real OS values.
  const filename = path.join(root, 'deps/install-secure.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source.slice(0, entry) + '\nmodule.exports = buildTemporaryRoot;\n', filename);
  const select = loaded.exports;
  const owned = path.join(root, 'owned');
  await fs.mkdir(owned, { mode: 0o700 });
  const rejected = (value) => assert.rejects(select(value), { code: 'SQLITE_BUILD_TEMP_PATH_REJECTED' });
  await t.test('explicit protected root takes priority over pnpm lifecycle TMPDIR', async () => {
    const lifecycle = path.join(root, 'patch_hash=fixture');
    await fs.mkdir(lifecycle, { mode: 0o700 });
    const previous = { TMPDIR: process.env.TMPDIR, override: process.env.ZHIXU_SQLITE_BUILD_TMPDIR };
    try {
      process.env.TMPDIR = lifecycle;
      process.env.ZHIXU_SQLITE_BUILD_TMPDIR = owned;
      assert.equal(await select(), owned);
      delete process.env.ZHIXU_SQLITE_BUILD_TMPDIR;
      await rejected(undefined);
    } finally {
      for (const [key, value] of [['TMPDIR', previous.TMPDIR], ['ZHIXU_SQLITE_BUILD_TMPDIR', previous.override]])
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await t.test('relative and noncanonical spellings are rejected', async () => {
    await rejected('relative');
    await rejected(owned + '/');
    await rejected(path.join(root, 'unused') + '/../owned');
  });
  await t.test('symlink aliases and regular files are rejected', async () => {
    const alias = path.join(root, 'alias'), file = path.join(root, 'file');
    await fs.symlink(owned, alias);
    await fs.writeFile(file, 'owned fixture', { mode: 0o600 });
    await rejected(alias);
    await rejected(file);
  });
  await t.test('group and other writable directories are rejected', async () => {
    for (const mode of [0o770, 0o707]) {
      const dir = path.join(root, 'mode-' + mode);
      await fs.mkdir(dir);
      await fs.chmod(dir, mode);
      await rejected(dir);
    }
  });
  await t.test('the actual directory owner must match the invoking UID', async () => {
    if (process.getuid() === 0) {
      const foreign = path.join(root, 'foreign');
      await fs.mkdir(foreign, { mode: 0o700 });
      await fs.chown(foreign, 10001, 10001);
      try { await rejected(foreign); }
      finally { await fs.chown(foreign, 0, 0); }
    } else {
      const system = await fs.realpath('/usr');
      assert.notEqual((await fs.lstat(system)).uid, process.getuid());
      await rejected(system); // read-only stat checks; no writes to this path
    }
  });
  await t.test('gyp equals and CR/LF guards remain enforced', async () => {
    for (const name of ['has=equals', 'has\rreturn', 'has\nnewline']) {
      const dir = path.join(root, name);
      await fs.mkdir(dir, { mode: 0o700 });
      await rejected(dir);
    }
  });
});
