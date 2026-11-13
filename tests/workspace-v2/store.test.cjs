const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const { createDatabase } = require('./fixture.cjs');

async function isolated(t) {
  const directory = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), 's1a-store-'),
  );
  const root = path.join(directory, 'data');
  const db = await createDatabase(root);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, root, db };
}

test('S1.A explicit Store validates the full frozen schema and serializes transactions', async (t) => {
  const f = await isolated(t);
  const store = await WorkspaceStore.open(f.db, f.root);
  t.after(() => store.close());
  assert.equal(
    (
      await store.all(
        "SELECT COUNT(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
    )[0].n,
    58,
  );
  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO Workspaces(name,type) VALUES('rollback','LOCAL')",
      );
      throw Error('planned transaction failure');
    }),
  );
  assert.equal((await store.all('SELECT COUNT(*) n FROM Workspaces'))[0].n, 0);
  await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      store.transaction(async (tx) => {
        await tx.run("INSERT INTO Workspaces(name,type) VALUES(?,'LOCAL')", [
          'w' + n,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }),
    ),
  );
  assert.equal((await store.all('SELECT COUNT(*) n FROM Workspaces'))[0].n, 8);
  assert.equal((await store.all('PRAGMA foreign_key_check')).length, 0);
});

test('S1.A Store refuses unknown/v9 or corrupted schemas without changing their bytes', async (t) => {
  const f = await isolated(t);
  execFileSync('python3', [
    '-I',
    '-S',
    '-c',
    'import sqlite3,sys\nd=sqlite3.connect(sys.argv[1]);d.execute("DROP VIEW ReadyWorkspaceResources");d.commit();d.close()',
    f.db,
  ]);
  const before = await fs.readFile(f.db);
  await assert.rejects(WorkspaceStore.open(f.db, f.root), {
    error_code: 'DATABASE_SCHEMA_CORRUPTED',
  });
  assert.deepEqual(await fs.readFile(f.db), before);
  const other = path.join(f.directory, 'legacy');
  await fs.mkdir(path.join(other, 'db'), { recursive: true, mode: 0o700 });
  const legacy = path.join(other, 'db/database.sqlite');
  execFileSync('python3', [
    '-I',
    '-S',
    '-c',
    'import sqlite3,sys\nd=sqlite3.connect(sys.argv[1]);d.execute("CREATE TABLE PlatformMetadata(platform_schema_version INTEGER)");d.execute("INSERT INTO PlatformMetadata VALUES(9)");d.commit();d.close()',
    legacy,
  ]);
  await fs.chmod(legacy, 0o600);
  const old = await fs.readFile(legacy);
  await assert.rejects(WorkspaceStore.open(legacy, other), {
    error_code: 'UNSUPPORTED_DATABASE_SCHEMA',
  });
  assert.deepEqual(await fs.readFile(legacy), old);
});

test('S1.A Store does not create missing data and rejects symlinked database parents', async (t) => {
  const f = await isolated(t);
  const absent = path.join(f.directory, 'missing');
  await assert.rejects(
    WorkspaceStore.open(path.join(absent, 'db/database.sqlite'), absent),
    (error) =>
      error.error_code === 'UNSUPPORTED_DATABASE_SCHEMA' &&
      !error.message.includes(f.directory),
  );
  await assert.rejects(fs.lstat(absent), { code: 'ENOENT' });
  const original = await fs.readFile(f.db);
  await fs.rename(path.join(f.root, 'db'), path.join(f.root, 'owned-db'));
  await fs.symlink('owned-db', path.join(f.root, 'db'));
  await assert.rejects(WorkspaceStore.open(f.db, f.root), {
    error_code: 'WORKSPACE_PATH_FORBIDDEN',
  });
  assert.deepEqual(
    await fs.readFile(path.join(f.root, 'owned-db/database.sqlite')),
    original,
  );
});

test('detached async work after a transaction cannot enter a later transaction and be lost with its rollback', async (t) => {
  const f = await isolated(t);
  const store = await WorkspaceStore.open(f.db, f.root);
  t.after(() => store.close());
  let detached;
  await store.transaction(async () => {
    detached = new Promise((resolve, reject) => {
      setTimeout(
        () =>
          store
            .run("INSERT INTO Workspaces(name,type) VALUES('detached','LOCAL')")
            .then(resolve, reject),
        25,
      );
    });
  });
  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO Workspaces(name,type) VALUES('rolled-back','LOCAL')",
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      throw Error('planned rollback');
    }),
    /planned rollback/,
  );
  await detached;
  assert.deepEqual(await store.all('SELECT name FROM Workspaces ORDER BY id'), [
    { name: 'detached' },
  ]);
});
