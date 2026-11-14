'use strict';
// Only the parent-owned clone reaches this isolated process. Never invoke the
// loader default: model registration is needed; bootstrap, sync and migration are not.
const path = require('node:path');
const sqlite3 = require('sqlite3');

(async () => {
  let database, sequelize;
  try {
    const root = process.argv[2];
    if (!root || process.env.QL_DATA_DIR !== root || process.cwd() !== root) throw Error('CLONE_REQUIRED');
    database = await new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(path.join(root, 'db/database.sqlite'), sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(connection));
    });
    const all = sql => new Promise((resolve, reject) => database.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
    const check = await all('PRAGMA quick_check');
    if (check.length !== 1 || check[0].quick_check !== 'ok' || (await all('PRAGMA foreign_key_check')).length) throw Error('INVALID');
    const objects = await all("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
    if (objects.length) {
      if (!objects.some(object => object.name === 'PlatformMetadata')) throw Error('INVALID');
      const metadata = await all('SELECT * FROM PlatformMetadata');
      if (metadata.length !== 1 || metadata[0].platform_schema_version !== 9 || Object.keys(metadata[0]).sort().join(',') !== 'model_signature,platform_schema_version,schema_signature') throw Error('INVALID');
      require('../loaders/db');
      sequelize = require('../data').sequelize;
      const { modelSignature, schemaSignature } = require('./operationalSchema');
      if (metadata[0].model_signature !== modelSignature(Object.values(sequelize.models)) || metadata[0].schema_signature !== schemaSignature(objects)) throw Error('INVALID');
    }
    process.stdout.write('V9_IDENTITY_ACCEPTED\n');
  } catch {
    process.exitCode = 1;
  } finally {
    if (database) await new Promise(resolve => database.close(() => resolve()));
    if (sequelize) await sequelize.close();
  }
})();
