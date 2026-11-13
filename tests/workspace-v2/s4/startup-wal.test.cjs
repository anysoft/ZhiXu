const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { spawnSync } = require('node:child_process');
const { createS4Fixture } = require('./fixture.cjs'),
  { V2Application } = require('../../../back/applicationV2/application');
test('S4 rejected legacy WAL database preserves main and pending WAL bytes', async (t) => {
  const h = await createS4Fixture(t, { caseId: 'S4-LEGACY-WAL' }),
    root = path.join(h.root, 'legacy'),
    db = path.join(root, 'db/database.sqlite');
  await fs.mkdir(path.dirname(db), { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const made = spawnSync('/usr/bin/python3', [
    '-c',
    'import sqlite3,os,sys; os.umask(0o077); c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.execute("CREATE TABLE legacy_source(id INTEGER,source TEXT)"); c.execute("INSERT INTO legacy_source VALUES(1,?)",("owned-unique-source",)); c.commit(); os._exit(0)',
    db,
  ]);
  assert.equal(made.status, 0);
  const digest = async (file) => {
    const bytes = await fs
      .readFile(file)
      .catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    return bytes === null
      ? null
      : crypto.createHash('sha256').update(bytes).digest('hex');
  };
  const before = {
    main: await digest(db),
    wal: await digest(db + '-wal'),
    shm: await digest(db + '-shm'),
  };
  assert.ok(before.wal);
  await assert.rejects(
    V2Application.launch({
      dataRoot: root,
      initialize: true,
      projectRoot: h.projectRoot,
    }),
    (e) => e.reason === 'UNSUPPORTED_OR_CORRUPTED_SCHEMA',
  );
  const after = {
    main: await digest(db),
    wal: await digest(db + '-wal'),
    shm: await digest(db + '-shm'),
  };
  await h.record('S4-LEGACY-WAL', {
    status: JSON.stringify(before) === JSON.stringify(after) ? 'PASS' : 'FAIL',
    before_sha256: before,
    after_sha256: after,
  });
  assert.deepEqual(after, before);
});
