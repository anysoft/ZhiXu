const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createS5Fixture, artifactModule, releaseRoot } = require('./artifact-support.cjs');
const { WorkspaceStore } = artifactModule('services/workspaceV2/store');
const sqlite3 = require(path.join(releaseRoot(), 'node_modules/sqlite3'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('S5 unknown database catalog is rejected before any metadata object or integrity expression is queried', async (t) => {
  const h = await createS5Fixture(t, { caseId: 'S5-SCHEMA-CATALOG-ADMISSION' });
  const observations = [];
  for (const kind of ['ordinary-view', 'noncanonical-table']) {
    const instance = await h.createInstance(kind);
    await fs.mkdir(path.join(instance.dataRoot, 'db'), { recursive: true, mode: 0o700 });
    const file = path.join(instance.dataRoot, 'db/database.sqlite');
    const db = await new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(file, error => error ? reject(error) : resolve(connection));
    });
    // Benign unknown-schema fixtures: no exploit expression, large input or user data.
    const sql = kind === 'ordinary-view'
      ? "CREATE VIEW PlatformMetadata AS SELECT 'owned-unknown-schema' AS schema_identity"
      : 'CREATE TABLE PlatformMetadata(schema_identity TEXT)';
    try {
      await new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
    } finally {
      await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
    await fs.chmod(file, 0o600);
    const before = await fs.readFile(file), beforeStat = await fs.stat(file, { bigint: true });
    const queries = [], original = WorkspaceStore.prototype.all;
    // Observe genuine SQLite calls without changing their arguments or results.
    WorkspaceStore.prototype.all = function (statement, ...args) {
      if (this.databasePath === file) queries.push(statement);
      return Reflect.apply(original, this, [statement, ...args]);
    };
    try {
      await assert.rejects(WorkspaceStore.open(file, instance.dataRoot, { readOnly: true }), error =>
        ['UNSUPPORTED_DATABASE_SCHEMA', 'DATABASE_SCHEMA_CORRUPTED'].includes(error.error_code));
    } finally {
      WorkspaceStore.prototype.all = original;
    }
    assert.equal(queries.length, 1);
    assert.match(queries[0], /FROM sqlite_schema/);
    assert.equal(queries.some(statement => /FROM PlatformMetadata|PRAGMA integrity_check|PRAGMA foreign_key_check/.test(statement)), false);
    assert.deepEqual(await fs.readFile(file), before);
    const afterStat = await fs.stat(file, { bigint: true });
    for (const field of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(afterStat[field], beforeStat[field]);
    assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['database.sqlite']);
    observations.push({ fixture: kind, actual_driver: true, catalog_query_count: 1, metadata_or_integrity_query_count: 0, database_sha256: hash(before), original_bytes_and_identity_unchanged: true });
  }
  await h.record('S5-SCHEMA-CATALOG-ADMISSION', { status: 'PASS', evidence_levels: ['UNIT', 'INTEGRATION'], query_observer_preserves_actual_driver_calls: true, observations });
});
