'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const needs = JSON.parse(process.env.NEEDS || '{}');
assert.deepEqual(Object.keys(needs).sort(), ['container', 'linux']);
assert.ok(Object.values(needs).every(job => job.result === 'success'), 'QUALIFICATION_JOB_FAILED');
const root = process.env.QUALIFICATION_INPUT || 'qualification-input';
const receipts = JSON.parse(fs.readFileSync(path.join(root, 'receipts.json')));
assert.deepEqual(receipts.map(receipt => receipt.architecture).sort(), ['amd64', 'arm64']);
const gates = [];
for (const arch of ['amd64', 'arm64']) {
  const receipt = receipts.find(item => item.architecture === arch);
  assert.equal(receipt.run_id, process.env.GITHUB_RUN_ID);
  assert.equal(receipt.commit, process.env.GITHUB_SHA);
  assert.ok(Number.isSafeInteger(receipt.source_attempt) && receipt.source_attempt > 0 &&
    receipt.source_attempt <= Number(process.env.GITHUB_RUN_ATTEMPT));
  assert.equal(receipt.artifact_name, `container-gates-${arch}-${receipt.run_id}-${receipt.source_attempt}-${receipt.commit}`);
  const gate = JSON.parse(fs.readFileSync(path.join(root, arch, 'container-gates.json')));
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.commit, process.env.GITHUB_SHA);
  assert.equal(gate.architecture, arch);
  for (const evidence of [gate.image, gate.acceptance]) {
    assert.equal(evidence.status, 'PASS');
    assert.equal(evidence.commit, process.env.GITHUB_SHA);
    assert.equal(evidence.architecture, arch);
  }
  assert.equal(gate.compose.status, 'PASS');
  assert.equal(gate.acceptance.cleanup, 'PASS');
  assert.equal(gate.compose.cleanup, 'PASS');
  assert.equal(gate.vulnerability_scan, 'PASS');
  assert.equal(gate.image.sbom, 'PASS');
  assert.equal(gate.image.provenance, 'PASS');
  gates.push({...receipt, manifest_digest: gate.image.manifest_digest});
}
fs.writeFileSync('container-qualification-summary.json', JSON.stringify({status:'PASS', commit:process.env.GITHUB_SHA, run_id:process.env.GITHUB_RUN_ID, run_attempt:process.env.GITHUB_RUN_ATTEMPT, platforms:gates}, null, 2) + '\n');
