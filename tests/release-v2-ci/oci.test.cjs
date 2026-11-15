'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sha = 'a'.repeat(40);
function archiveFixture(t, change = () => {}, corruptLayer = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixu-v2-oci-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(root + '/layout/blobs/sha256', { recursive: true });
  function blob(value, mediaType = 'application/vnd.oci.image.manifest.v1+json') {
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    fs.writeFileSync(root + '/layout/blobs/sha256/' + hash, raw);
    return { mediaType, digest: 'sha256:' + hash, size: raw.length };
  }
  const cfg = { architecture: 'amd64', os: 'linux', config: { User: '10001:10001',
    Entrypoint: ['/usr/bin/tini', '--', 'node', 'scripts/release-v2/entrypoint.cjs'],
    Healthcheck: { Test: ['CMD', 'node', 'scripts/release-v2/healthcheck.cjs'] },
    Labels: { 'org.opencontainers.image.revision': sha,
      'org.opencontainers.image.version': require('../../package.json').version,
      'org.zhixu.source-tree': sha, 'org.zhixu.application-mode': 'v2' } } };
  change(cfg);
  const layer = blob(Buffer.from('synthetic-layer-bytes'));
  const image = blob({ schemaVersion: 2, config: blob(cfg), layers: [layer] });
  image.platform = { os: 'linux', architecture: 'amd64' };
  const attestation = blob({ schemaVersion: 2, config: blob({}), layers: [
    blob({ predicateType: 'https://spdx.dev/Document', predicate: {} }),
    blob({ predicateType: 'https://slsa.dev/provenance/v1', predicate: {} }),
  ] });
  attestation.platform = { os: 'unknown', architecture: 'unknown' };
  attestation.annotations = { 'vnd.docker.reference.digest': image.digest };
  fs.writeFileSync(root + '/layout/index.json', JSON.stringify({ schemaVersion: 2, manifests: [image, attestation] }));
  fs.writeFileSync(root + '/layout/oci-layout', '{"imageLayoutVersion":"1.0.0"}');
  if (corruptLayer) fs.writeFileSync(root + '/layout/blobs/sha256/' + layer.digest.slice(7), 'synthetic-layer-xxxxx');
  const tar = spawnSync('tar', ['-cf', root + '/image.tar', '-C', root + '/layout', '.']);
  assert.equal(tar.status, 0, String(tar.stderr));
  return root;
}
function audit(root) {
  return spawnSync('python3', ['scripts/release-v2-ci/oci-audit.py', root + '/image.tar', 'amd64', sha, root + '/out'], { encoding: 'utf8' });
}
test('OCI validation emits compatible digest/attestation receipts for v2 only', t => {
  const root = archiveFixture(t), result = audit(root);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(fs.readFileSync(root + '/out/image-audit.json'));
  assert.equal(receipt.status, 'PASS'); assert.equal(receipt.application_mode, 'v2');
  assert.equal(receipt.security_scan, 'DEFERRED'); assert.equal(receipt.attestation_digests.length, 1);
  assert.match(receipt.archive_sha256, /^[a-f0-9]{64}$/);
});
test('OCI validation rejects wrong architecture, old entrypoint, wrong source/version and tampered layer bytes', t => {
  for (const change of [c => { c.architecture = 'arm64'; },
    c => { c.config.Entrypoint = ['node', 'static/build/app.js']; },
    c => { c.config.Labels['org.opencontainers.image.revision'] = 'c'.repeat(40); },
    c => { c.config.Labels['org.opencontainers.image.version'] = '1.0.0'; },
    c => { c.config.Labels['org.zhixu.application-mode'] = 'v9'; }]) {
    assert.notEqual(audit(archiveFixture(t, change)).status, 0);
  }
  const corrupted = archiveFixture(t, undefined, true);
  assert.notEqual(audit(corrupted).status, 0);
  assert.equal(fs.existsSync(corrupted + '/out/image-audit.json'), false);
});
