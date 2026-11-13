const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { createS4Fixture } = require('./fixture.cjs');
const { createV2Services } = require('../../../back/applicationV2/container');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');

async function schemaFacts(store) {
  const objects = await store.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
  const tables = objects.filter((row) => row.type === 'table').map((row) => row.name);
  const rows = {};
  for (const table of tables) {
    assert.match(table, /^[A-Za-z][A-Za-z0-9_]*$/);
    rows[table] = (await store.all('SELECT COUNT(*) n FROM "' + table + '"'))[0].n;
  }
  return { catalog_sha256: createHash('sha256').update(JSON.stringify(objects)).digest('hex'), table_count: tables.length, row_counts: rows };
}

test('S4 unchanged actual v9 schema initializer rejects genuine full S0 v2 identity without database or source mutation', { timeout: 90000 }, async (t) => {
  const h = await createS4Fixture(t, { caseId: 's4-reverse-schema-identity' });
  const instance = await h.createInstance('v2-candidate');
  const s = createV2Services(instance.store, instance.backupRoot);
  const workspace = await s.lifecycle.createLocal({ name: 'Unique v2 source for reverse identity proof', requestKey: randomUUID() });
  await s.files.create(workspace.id, 'unique.sh', 'owned-v2-only-source-' + randomUUID() + '\n');
  const source = path.join(s.roots.path(await s.store.workspace(workspace.id)), 'unique.sh');
  const beforeFacts = await schemaFacts(s.store);
  assert.equal(beforeFacts.table_count, 58);
  const columns = (await s.store.all('PRAGMA table_info(PlatformMetadata)')).map((row) => row.name);
  assert.ok(columns.includes('schema_version'));
  assert.equal(columns.includes('platform_schema_version'), false);
  assert.equal((await s.store.all('SELECT schema_version FROM PlatformMetadata'))[0].schema_version, 1);
  await instance.close();
  const before = {
    database_sha256: await h.hashFile(instance.databasePath),
    source_sha256: await h.hashFile(source),
    data_entries: (await fs.readdir(instance.dataRoot)).sort(),
    db_entries: (await fs.readdir(path.dirname(instance.databasePath))).sort(),
  };
  const child = fork(path.join(__dirname, 'reverse-schema-identity-worker.cjs'), [instance.dataRoot], {
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: { ...process.env, QL_DATA_DIR: instance.dataRoot },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); });
  let message;
  child.on('message', (value) => { message = value; });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (!message?.success) await h.record('S4-REVERSE-SCHEMA-IDENTITY-FAILURE', { status: 'FAILED', exit, error_code: message?.error_code ?? 'WORKER_RESULT_MISSING' });
  assert.equal(exit.code, 0, message?.error_code ?? 'REVERSE_SCHEMA_WORKER_FAILED');
  assert.equal(exit.signal, null);
  assert.equal(message.success, true);
  assert.equal(message.error_code, 'UNSUPPORTED_DATABASE_SCHEMA');
  const after = {
    database_sha256: await h.hashFile(instance.databasePath),
    source_sha256: await h.hashFile(source),
    data_entries: (await fs.readdir(instance.dataRoot)).sort(),
    db_entries: (await fs.readdir(path.dirname(instance.databasePath))).sort(),
  };
  assert.deepEqual(after, before);
  const checked = await WorkspaceStore.open(instance.databasePath, instance.dataRoot, { readOnly: true });
  let afterFacts;
  try { afterFacts = await schemaFacts(checked); } finally { await checked.close(); }
  assert.deepEqual(afterFacts, beforeFacts);
  assert.equal(await h.hashFile(instance.databasePath), before.database_sha256);
  await h.record('S4-REVERSE-SCHEMA-IDENTITY', {
    status: 'PASS', error_code: message.error_code,
    genuine_full_frozen_s0_schema: true, frozen_table_count: 58,
    workspace_id: workspace.id,
    before, after, before_schema: beforeFacts, after_schema: afterFacts,
    actual_v9_initializer: message.actual_initializer,
    actual_v9_data_modules: message.actual_v9_data_modules,
    registered_model_count: message.registered_model_count,
    registered_model_tables: message.registered_model_tables,
    model_mocks: false, module_loader_interception: false,
    v9_full_server_started: false, bootstrap_directories_called: false,
    qualification_boundary: 'Unchanged real v9 operational schema admission gate, not full v9 application boot',
    database_catalog_rows_and_unique_source_bytes_unchanged: true,
  });
});
