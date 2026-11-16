'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
function manifestFile(environment = process.env) {
  return path.join(environment.QL_MANAGED_DIR || __dirname, 'managed-node/result.json');
}
function catalogEntry(manifest, platform = process.platform, arch = process.arch) {
  assert.equal(manifest.status, 'PASS', 'Official Node preparation required');
  const runtime = manifest.runtime;
  assert.match(runtime.version, /^\d+\.\d+\.\d+$/);
  assert.equal(runtime.metadata.platform, platform, 'Prepared Node platform mismatch');
  assert.equal(runtime.metadata.architecture, arch, 'Prepared Node architecture mismatch');
  return { version: runtime.version, date: '2026-09-01', lts: 'Krypton',
    files: [platform === 'darwin' ? `osx-${arch}-tar` : `${platform}-${arch}`],
    npm: runtime.metadata.npm_version };
}
module.exports = { manifestFile, catalogEntry };
