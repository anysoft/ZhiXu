const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { createS5Fixture, artifactModule, releaseRoot } = require('./artifact-support.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
async function inventory(root) {
  const result = [];
  async function visit(file) {
    const value = await fs.lstat(file, { bigint: true });
    assert.equal(value.isSymbolicLink(), false);
    const row = { path: path.relative(root, file), dev: String(value.dev), ino: String(value.ino), mode: String(value.mode), uid: String(value.uid), gid: String(value.gid), size: String(value.size), mtime_ns: String(value.mtimeNs), ctime_ns: String(value.ctimeNs) };
    if (value.isDirectory()) {
      row.entries = (await fs.readdir(file)).sort(); result.push(row);
      for (const name of row.entries) await visit(path.join(file, name));
    } else { assert.equal(value.isFile(), true); row.sha256 = hash(await fs.readFile(file)); result.push(row); }
  }
  await visit(root);
  return result;
}
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
function launch(instance, direct = false, ports = {}) {
  const root = releaseRoot();
  const child = spawn(process.execPath, [path.join(root, direct ? 'static/build/app.js' : 'scripts/release/entrypoint.cjs')], {
    cwd: root, detached: true,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', NODE_ENV: 'production', DATA_DIR: instance.dataRoot, QL_DATA_DIR: instance.dataRoot, QL_DIR: root, BACKUP_DIR: instance.backupRoot, HOME: path.join(instance.root, 'home-must-not-exist-before-admission'), JWT_SECRET: 's5-owned-v9-entry-dummy', BIND_HOST: '127.0.0.1', BIND_HOST_GRPC: '127.0.0.1', BACK_PORT: String(ports.http || 0), GRPC_PORT: String(ports.grpc || 0), LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', stopped = false;
  const collect = bytes => { output += bytes.toString(); if (output.length > 256 * 1024) output = output.slice(-256 * 1024); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  return { child, exited, output: () => output, async stop() {
    if (stopped) return;
    stopped = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    let timer;
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('S5_V9_SHUTDOWN_DEADLINE')), 10000); })]); }
    finally { clearTimeout(timer); try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  } };
}
async function rejectUnchanged(t, instance, direct) {
  const before = await inventory(instance.root), process = launch(instance, direct);
  t.after(() => process.stop());
  let timeout;
  const exit = await Promise.race([process.exited, new Promise((_, reject) => { timeout = setTimeout(() => { process.stop().catch(() => {}); reject(Error('S5_V9_REJECTION_DEADLINE')); }, 125000); })]).finally(() => clearTimeout(timeout));
  assert.equal(exit.code, 1, process.output()); assert.equal(exit.signal, null);
  assert.match(process.output(), /UNSUPPORTED_DATABASE_SCHEMA/);
  assert.doesNotMatch(process.output(), /worker is ready|worker started|DB loaded/);
  const after = await inventory(instance.root);
  assert.deepEqual(after, before, 'v9 entry must preserve DATA and its HOME/JWT/control/backup parent domain, source, main and sidecars');
  return { entry: direct ? 'compiled-app.js' : 'release-entrypoint.cjs', exit, unchanged_domain_sha256: hash(JSON.stringify(before)), output_sha256: hash(process.output()), paths_compared: before.length };
}

test('S5 actual compiled v9 release entry and direct app reject full genuine v2, unknown and corrupt roots before any parent-domain write', { timeout: 300000 }, async function v9EntryNegativeQualification(t) {
  assert.notEqual(process.getuid?.(), 0, 'actual release entry requires its normal non-root service identity');
  const h = await createS5Fixture(t, { caseId: 'S5-V9-ACTUAL-ENTRY-REJECTION' });
  await fs.access(path.join(releaseRoot(), 'scripts/release/entrypoint.cjs'));
  const { V2Application } = artifactModule('applicationV2/application');
  const { WorkspaceStore } = artifactModule('services/workspaceV2/store');
  const { createV2Services } = artifactModule('applicationV2/container');
  const sqlite3 = require(path.join(releaseRoot(), 'node_modules/sqlite3'));
  const observations = [];
  const instance = await h.createInstance('genuine-full-v2');
  const app = await V2Application.launch({ dataRoot: instance.dataRoot, backupRoot: instance.backupRoot, projectRoot: releaseRoot(), artifactRoot: path.join(releaseRoot(), 'static/build/applicationV2/contracts'), initialize: true, background: false, port: 0 });
  try {
    const s = app.services;
    const workspace = await s.lifecycle.createLocal({ name: 'S5 genuine v2 reverse admission source', requestKey: randomUUID() });
    await s.files.create(workspace.id, 'unique.sh', 's5-owned-v2-only-' + randomUUID() + '\n');
    assert.equal((await s.store.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).length, 58);
    assert.equal((await s.store.all('SELECT schema_version FROM PlatformMetadata'))[0].schema_version, 1);
  } finally { await app.close(); }
  for (const direct of [false, true]) observations.push({ fixture: 'full-v2-clean', ...await rejectUnchanged(t, instance, direct) });
  // Keep an ordinary owned SQLite WAL writer idle. No source SQLite read/open is
  // performed by the v9 guard; even SHM read marks must remain byte-identical.
  const store = await WorkspaceStore.open(path.join(instance.dataRoot, 'db/database.sqlite'), instance.dataRoot);
  try {
    await store.all('PRAGMA journal_mode=WAL'); await store.all('PRAGMA wal_autocheckpoint=0');
    const services = createV2Services(store, instance.backupRoot);
    await services.lifecycle.createLocal({ name: 'S5 WAL-backed v2 row', requestKey: randomUUID() });
    for (const suffix of ['-wal', '-shm']) assert.ok((await fs.stat(path.join(instance.dataRoot, 'db/database.sqlite' + suffix))).size > 0);
    for (const direct of [false, true]) observations.push({ fixture: 'full-v2-wal-shm', ...await rejectUnchanged(t, instance, direct) });
  } finally { await store.close(); }
  for (const kind of ['unknown', 'frozen-v8', 'corrupt']) {
    const other = await h.createInstance(kind);
    await fs.mkdir(path.join(other.dataRoot, 'db'), { recursive: true, mode: 0o700 });
    const database = path.join(other.dataRoot, 'db/database.sqlite');
    if (kind === 'corrupt') await fs.writeFile(database, Buffer.from('s5-owned-non-database-' + randomUUID()), { mode: 0o600 });
    else {
      const connection = await new Promise((resolve, reject) => { const db = new sqlite3.Database(database, error => error ? reject(error) : resolve(db)); });
      try {
        let sql = "CREATE TABLE unique_user_data(value TEXT);INSERT INTO unique_user_data VALUES ('s5-owned-keep');";
        if (kind === 'frozen-v8') {
          const frozen = artifactModule('schema/platformV8').default;
          assert.equal(frozen.metadata.platform_schema_version, 8);
          sql = [...frozen.objects].sort((a, b) => Number(!a.sql.startsWith('CREATE TABLE')) - Number(!b.sql.startsWith('CREATE TABLE'))).map(value => value.sql + ';').join('\n') + "INSERT INTO PlatformMetadata VALUES (8,'" + frozen.metadata.model_signature + "','" + frozen.metadata.schema_signature + "');";
        }
        await new Promise((resolve, reject) => connection.exec(sql, error => error ? reject(error) : resolve()));
      }
      finally { await new Promise((resolve, reject) => connection.close(error => error ? reject(error) : resolve())); }
      await fs.chmod(database, 0o600);
    }
    for (const direct of [false, true]) observations.push({ fixture: kind, ...await rejectUnchanged(t, other, direct) });
  }
  await h.record('S5-V9-ACTUAL-ENTRY-REJECTION', { status: 'PASS', genuine_full_frozen_s0_table_count: 58, actual_compiled_app: true, actual_release_entry: true, mocks: false, original_sqlite_opened_by_guard: false, parent_home_jwt_control_backup_database_source_and_sidecars_unchanged: true, observations });
});

test('S5 actual compiled v9 release entry still serves a fresh v9 database and restarts its exact valid v9 identity', { timeout: 240000 }, async function v9EntryPositiveQualification(t) {
  assert.notEqual(process.getuid?.(), 0);
  const h = await createS5Fixture(t, { caseId: 'S5-V9-ACTUAL-ENTRY-POSITIVE' });
  const instance = await h.createInstance('fresh-v9');
  const results = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const ports = { http: await port(), grpc: await port() }, process = launch(instance, false, ports);
    t.after(() => process.stop());
    const end = Date.now() + 100000; let healthy = false;
    try {
      while (Date.now() < end && process.child.exitCode === null) {
        try {
          const response = await fetch('http://127.0.0.1:' + ports.http + '/api/health', { signal: AbortSignal.timeout(1500) });
          if (response.status === 200 && (await response.json()).data?.status === 'ok') { healthy = true; break; }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(healthy, true, process.output());
      assert.match(process.output(), /DB loaded/);
      results.push({ attempt: attempt + 1, actual_http_health_status: 200, output_sha256: hash(process.output()) });
    } finally { await process.stop(); }
  }
  const sqlite3 = require(path.join(releaseRoot(), 'node_modules/sqlite3'));
  // Validate a private copy after the process is stopped. Never let test evidence
  // collection change read marks on the observed original database.
  const clone = path.join(h.root, 'positive-facts-copy'); await fs.mkdir(clone, { mode: 0o700 });
  for (const name of await fs.readdir(path.join(instance.dataRoot, 'db'))) if (['database.sqlite', 'database.sqlite-wal', 'database.sqlite-shm', 'database.sqlite-journal'].includes(name)) await fs.copyFile(path.join(instance.dataRoot, 'db', name), path.join(clone, name));
  const db = await new Promise((resolve, reject) => { const connection = new sqlite3.Database(path.join(clone, 'database.sqlite'), sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(connection)); });
  let metadata;
  try { metadata = await new Promise((resolve, reject) => db.all('SELECT platform_schema_version FROM PlatformMetadata', (error, rows) => error ? reject(error) : resolve(rows))); }
  finally { await new Promise(resolve => db.close(resolve)); }
  assert.deepEqual(metadata, [{ platform_schema_version: 9 }]);
  await h.record('S5-V9-ACTUAL-ENTRY-POSITIVE', { status: 'PASS', actual_release_entry: true, actual_compiled_app: true, actual_fresh_start_and_v9_restart: true, platform_schema_version: 9, mocks: false, results });
});
