'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const expected = require('./sqlite-core.json');

async function verifySqliteCore() {
  const sqlite = require('sqlite3');
  const packageFile = require.resolve('sqlite3/package.json');
  const root = path.dirname(packageFile);
  const metadata = JSON.parse(fs.readFileSync(packageFile));
  if (metadata.name !== '@whyour/sqlite3' || metadata.version !== '1.1.2')
    throw Error('SQLITE_FORK_IDENTITY_MISMATCH');
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'zhixu-sqlite-build.json')));
  const binary = createRequire(packageFile)('@mapbox/node-pre-gyp').find(packageFile);
  const binaryHash = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (receipt.source_archive_sha256 !== expected.sourceSha256 ||
      receipt.source_archive_sha3_256 !== expected.sourceSha3_256 ||
      receipt.native_sha256 !== binaryHash || receipt.upstream_prebuilt_used !== false ||
      receipt.napi_target !== expected.napiTarget || receipt.platform !== process.platform ||
      receipt.architecture !== process.arch)
    throw Error('SQLITE_NATIVE_BUILD_RECEIPT_MISMATCH');
  const actual = await new Promise((resolve, reject) => {
    const db = new sqlite.Database(':memory:', (error) => {
      if (error) return reject(error);
      db.get('SELECT sqlite_version() AS version, sqlite_source_id() AS source_id', (error, row) => {
        db.close((closeError) => error || closeError ? reject(error || closeError) : resolve(row));
      });
    });
  });
  if (actual.version !== expected.coreVersion || actual.source_id !== expected.sourceId)
    throw Error('SQLITE_NATIVE_CORE_MISMATCH');
  process.stdout.write(JSON.stringify({
    event: 'SQLITE_VERIFIED_NATIVE_READY', fork: expected.fork,
    sqlite_version: actual.version, sqlite_source_id: actual.source_id,
    native_addon_sha256: binaryHash, node: process.versions.node,
    platform: process.platform, architecture: process.arch,
    napi_target: expected.napiTarget, upstream_prebuilt_used: false,
  }) + '\n');
}
verifySqliteCore().catch((error) => {
  process.stderr.write('SQLite native verification failed: ' +
    (/^[A-Z_]+$/.test(error.message || '') ? error.message : 'SQLITE_VERIFICATION_REJECTED') + '\n');
  process.exitCode = 1;
});
