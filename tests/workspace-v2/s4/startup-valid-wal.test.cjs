const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { createS4Fixture, assertOwnedInstance } = require('./fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');
const { openV2Store } = require('../../../back/applicationV2/bootstrap');
const { DEFAULT_LIMITS } = require('../../../back/services/workspaceV2/limits');
const { createV2Services } = require('../../../back/applicationV2/container');
const { privateJson } = require('../../../back/services/backup/files');
const { readWorkspaceRestoreJournal } = require('../../../back/services/workspaceV2/restore');

async function digests(database) {
  const result = {};
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const bytes = await fs.readFile(database + suffix).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    result[suffix || 'main'] = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
  }
  return result;
}

test('S4 actual startup accepts full frozen S0 schema and committed source present only in genuine WAL', { timeout: 180000 }, async (t) => {
  const h = await createS4Fixture(t, { caseId: 's4-valid-s0-wal-startup' });
  const root = path.join(h.root, 'valid-wal-data');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(path.join(root, 'db'), { mode: 0o700 });
  const database = path.join(root, 'db/database.sqlite');
  const unique = 'committed-in-real-s0-wal-' + randomUUID();
  const made = spawnSync('/usr/bin/python3', ['-c',
    'import sqlite3,os,sys,json; os.umask(0o077); c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA wal_autocheckpoint=0"); c.executescript(open(sys.argv[2]).read()); c.execute("INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES(?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",("startupWALqualification",json.dumps({"unique_source":sys.argv[3]}))); c.commit(); os._exit(0)',
    database, h.schemaPath, unique,
  ]);
  assert.equal(made.status, 0, 'GENUINE_S0_WAL_FIXTURE_FAILED');
  const before = await digests(database);
  assert.ok(before['-wal']);
  assert.ok(before['-shm']);
  assert.equal((await fs.stat(database)).size, 4096);
  assert.ok((await fs.stat(database + '-wal')).size > (await fs.stat(database)).size);
  const app = await V2Application.launch({ dataRoot: root, projectRoot: h.projectRoot, port: 0, background: false });
  t.after(() => app.close());
  assert.equal(app.ready, true);
  assert.equal(app.localWrites, true);
  const rows = await app.services.store.all('SELECT info FROM Auths WHERE type=?', ['startupWALqualification']);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].info).unique_source, unique);
  assert.equal((await app.services.store.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).length, 58);
  assert.equal((await app.services.store.all('PRAGMA foreign_key_check')).length, 0);
  await h.record('S4-VALID-S0-WAL-STARTUP', {
    status: 'PASS', actual_application_startup: true,
    complete_frozen_schema_in_wal: true, frozen_table_count: 58,
    main_before_bytes: 4096, before_sha256: before,
    committed_wal_source_sha256: createHash('sha256').update(unique).digest('hex'),
    wal_only_source_recovered_exactly: true,
    ready: app.ready, local_write_admission: app.localWrites,
    original_sqlite_rw_only_after_full_clone_schema_qualification: true,
  });
});

for (const kind of ['symlink', 'hardlink']) {
  test(`S4 startup rejects an SQLite ${kind} sidecar without following or changing owned source`, async (t) => {
    const h = await createS4Fixture(t, { caseId: 's4-unsafe-sqlite-' + kind });
    const instance = await h.createInstance('candidate');
    await instance.close();
    const source = path.join(h.root, 'unique-sidecar-source');
    await fs.writeFile(source, 'unique protected sidecar bytes ' + randomUUID(), { mode: 0o600 });
    const sidecar = instance.databasePath + (kind === 'symlink' ? '-wal' : '-shm');
    if (kind === 'symlink') await fs.symlink(source, sidecar);
    else await fs.link(source, sidecar);
    const beforeDatabase = await h.hashFile(instance.databasePath);
    const beforeSource = createHash('sha256').update(await fs.readFile(source)).digest('hex');
    const before = await fs.lstat(sidecar);
    await assert.rejects(V2Application.launch({ dataRoot: instance.dataRoot, backupRoot: instance.backupRoot, projectRoot: h.projectRoot, port: 0 }),
      (error) => error.error_code === 'STARTUP_REJECTED' && error.reason === 'SCHEMA_PREFLIGHT_SOURCE_INVALID');
    assert.equal(await h.hashFile(instance.databasePath), beforeDatabase);
    assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'), beforeSource);
    const after = await fs.lstat(sidecar);
    assert.equal(after.ino, before.ino);
    assert.equal(after.nlink, before.nlink);
    if (kind === 'symlink') assert.equal(await fs.readlink(sidecar), source);
    await assert.rejects(fs.lstat(instance.backupRoot), { code: 'ENOENT' });
    await h.record('S4-UNSAFE-SQLITE-' + kind.toUpperCase(), {
      status: 'PASS', error_code: 'STARTUP_REJECTED', reason: 'SCHEMA_PREFLIGHT_SOURCE_INVALID',
      database_sha256: beforeDatabase, protected_source_sha256: beforeSource,
      sidecar_inode_and_link_count_unchanged: true,
      original_database_and_target_bytes_unchanged: true, backup_root_not_created: true,
    });
  });
}

test('S4 final pre-open generation check rejects a real WAL writer after clone validation without mutating its files', async (t) => {
  const h = await createS4Fixture(t, { caseId: 's4-preflight-live-wal-writer' });
  const instance = await h.createInstance('candidate');
  await instance.close();
  let writerBytes;
  await assert.rejects(openV2Store({ dataRoot: instance.dataRoot, projectRoot: h.projectRoot }, async () => {
    const writer = spawnSync('/usr/bin/python3', ['-c',
      'import sqlite3,os,sys,json; os.umask(0o077); c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.execute("INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES(?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",("actualConcurrentWALWriter",json.dumps({"owned":True}))); c.commit(); os._exit(0)',
      instance.databasePath,
    ]);
    assert.equal(writer.status, 0, 'ACTUAL_CONCURRENT_WAL_WRITER_FAILED');
    writerBytes = await digests(instance.databasePath);
    assert.ok(writerBytes['-wal']);
  }), (error) => error.error_code === 'STARTUP_REJECTED' && error.reason === 'SCHEMA_PREFLIGHT_SOURCE_CHANGED');
  assert.deepEqual(await digests(instance.databasePath), writerBytes);
  await h.record('S4-PREFLIGHT-LIVE-WAL-WRITER', {
    status: 'PASS', actual_sqlite_writer_committed_after_clone_validation: true,
    reason: 'SCHEMA_PREFLIGHT_SOURCE_CHANGED', writer_sha256: writerBytes,
    all_committed_writer_database_wal_shm_bytes_unchanged_after_rejection: true,
  });
});

test('S4 startup rejects a physical sparse database exceeding clone temporary budget before copying it', async (t) => {
  const h = await createS4Fixture(t, { caseId: 's4-preflight-physical-budget' });
  const instance = await h.createInstance('candidate');
  await instance.close();
  await fs.truncate(instance.databasePath, DEFAULT_LIMITS.temporaryMaxBytes);
  const before = await fs.stat(instance.databasePath, { bigint: true });
  const descriptor = await fs.open(instance.databasePath, 'r');
  const header = Buffer.alloc(100);
  try { await descriptor.read(header, 0, header.length, 0); } finally { await descriptor.close(); }
  await assert.rejects(V2Application.launch({ dataRoot: instance.dataRoot, backupRoot: instance.backupRoot, projectRoot: h.projectRoot, port: 0 }),
    (error) => error.error_code === 'STARTUP_REJECTED' && error.reason === 'SCHEMA_PREFLIGHT_CAPACITY_EXCEEDED');
  const after = await fs.stat(instance.databasePath, { bigint: true });
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
  assert.deepEqual(await fs.readdir(path.dirname(instance.databasePath)), ['database.sqlite']);
  await assert.rejects(fs.lstat(instance.backupRoot), { code: 'ENOENT' });
  await h.record('S4-PREFLIGHT-PHYSICAL-BUDGET', {
    status: 'PASS', reason: 'SCHEMA_PREFLIGHT_CAPACITY_EXCEEDED',
    fixture: 'physical sparse file; no allocated disk-fill or ENOSPC claim',
    declared_database_bytes: String(before.size),
    maximum_temporary_bytes: DEFAULT_LIMITS.temporaryMaxBytes,
    before_header_sha256: createHash('sha256').update(header).digest('hex'),
    source_inode_size_mtime_ctime_unchanged: true, source_directory_unchanged: true,
    backup_root_not_created: true,
  });
});

test('S4 startup validates known recovery-directory SQLite schema without checkpointing an unknown quarantined WAL', { timeout: 180000 }, async (t) => {
  const h = await createS4Fixture(t, { caseId: 's4-recovery-unknown-quarantined-wal' });
  const instance = await h.createInstance('candidate');
  const services = createV2Services(instance.store, instance.backupRoot);
  const workspace = await services.lifecycle.createLocal({ name: 'Genuine recovery ownership', requestKey: randomUUID() });
  await services.files.create(workspace.id, 'unique.sh', 'genuine retained source ' + randomUUID());
  const snapshot = await services.backup.create();
  const restored = await services.restore.restore(snapshot);
  await restored.close();
  await instance.close();
  const journal = await readWorkspaceRestoreJournal(services.backup.paths);
  assert.equal(journal.stage, 'COMPLETE');
  await assertOwnedInstance(instance.root);
  const savedDatabaseDirectory = path.join(instance.root, 'preserved-original-quarantine-db');
  await fs.rename(path.join(journal.old_root, 'db'), savedDatabaseDirectory);
  await fs.mkdir(path.join(journal.old_root, 'db'), { mode: 0o700 });
  const unknownDatabase = path.join(journal.old_root, 'db/database.sqlite');
  const made = spawnSync('/usr/bin/python3', ['-c',
    'import sqlite3,os,sys; os.umask(0o077); c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.execute("CREATE TABLE legacy_source(source TEXT)"); c.execute("INSERT INTO legacy_source VALUES(?)",("owned-quarantined-unique-source",)); c.commit(); os._exit(0)',
    unknownDatabase,
  ]);
  assert.equal(made.status, 0);
  const marker = path.join(instance.controlRoot, 'barrier.json');
  await privateJson(marker, { version: 1, id: journal.operation_id, phase: 'RESTORE_PENDING' });
  const before = await digests(unknownDatabase);
  assert.ok(before['-wal']); assert.ok(before['-shm']);
  const preservedFiles = [instance.databasePath, path.join(savedDatabaseDirectory, 'database.sqlite'), path.join(instance.controlRoot, 'workspace-restore-journal.json'), marker];
  const preservedHashes = await Promise.all(preservedFiles.map((file) => h.hashFile(file)));
  await assert.rejects(V2Application.launch({ dataRoot: instance.dataRoot, backupRoot: instance.backupRoot, projectRoot: h.projectRoot, port: 0 }),
    (error) => error.error_code === 'STARTUP_REJECTED' && error.reason === 'UNSUPPORTED_OR_CORRUPTED_SCHEMA');
  assert.deepEqual(await digests(unknownDatabase), before);
  assert.deepEqual(await Promise.all(preservedFiles.map((file) => h.hashFile(file))), preservedHashes);
  const originalQuarantine = await fs.lstat(journal.old_root);
  assert.equal(originalQuarantine.dev, journal.old_identity.dev);
  assert.equal(originalQuarantine.ino, journal.old_identity.ino);
  await h.record('S4-RECOVERY-UNKNOWN-QUARANTINED-WAL', {
    status: 'PASS', genuine_complete_restore_journal: true,
    matching_quarantine_directory_identity_is_insufficient_to_open_unknown_sqlite: true,
    reason: 'UNSUPPORTED_OR_CORRUPTED_SCHEMA',
    unknown_quarantined_database_wal_shm_sha256: before,
    unknown_database_wal_shm_bytes_unchanged: true,
    published_database_preserved: true, original_quarantine_database_preserved_by_rename: true,
    pending_barrier_and_complete_journal_preserved: true,
    preserved_file_sha256: preservedHashes,
  });
});
