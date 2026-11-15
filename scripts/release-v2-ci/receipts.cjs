'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const read = file => JSON.parse(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const requiredSteps = ['fresh-initialize', 'v2-health-and-frontend', 'owner-auth', 'local-workspace',
  'shell-task-run-attempt-log', 'restart-persistence', 'subscription-retired', 'graceful-shutdown'];
function validateGate(gate, sha, arch) {
  assert.equal(gate.status, 'PASS');
  assert.equal(gate.commit, sha);
  assert.equal(gate.architecture, arch);
  assert.equal(gate.application_mode, 'v2');
  for (const item of [gate.image, gate.acceptance]) {
    assert.equal(item.status, 'PASS');
    assert.equal(item.commit, sha);
    assert.equal(item.architecture, arch);
    assert.equal(item.application_mode, 'v2');
  }
  assert.equal(gate.acceptance.cleanup, 'PASS');
  for (const step of requiredSteps) assert.ok(gate.acceptance.steps.includes(step), 'MISSING_SMOKE_STEP:' + step);
  for (const key of ['manifest_digest', 'config_digest']) assert.match(gate.image[key], /^sha256:[a-f0-9]{64}$/);
  assert.match(gate.image.archive_sha256, /^[a-f0-9]{64}$/);
  assert.ok(gate.image.attestation_digests?.length);
  for (const digest of gate.image.attestation_digests) assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(gate.image.sbom, 'PASS');
  assert.equal(gate.image.provenance, 'PASS');
  assert.equal(gate.security_scan, 'DEFERRED');
  return gate;
}
function gates(out, sha, arch) {
  // Always remove a previous success before reading new evidence.
  fs.rmSync(path.join(out, 'container-gates.json'), { force: true });
  const gate = { status: 'PASS', application_mode: 'v2', commit: sha, architecture: arch,
    image: read(path.join(out, 'image-audit.json')), acceptance: read(path.join(out, 'v2-smoke.json')),
    security_scan: 'DEFERRED' };
  validateGate(gate, sha, arch);
  write(path.join(out, 'container-gates.json'), gate);
}
function summary(root, environment) {
  const needs = JSON.parse(environment.NEEDS || '{}');
  assert.deepEqual(Object.keys(needs), ['container']);
  assert.equal(needs.container.result, 'success', 'QUALIFICATION_JOB_FAILED');
  const receipts = read(path.join(root, 'receipts.json'));
  assert.deepEqual(receipts.map(r => r.architecture).sort(), ['amd64', 'arm64']);
  const platforms = receipts.map(receipt => {
    assert.equal(receipt.run_id, environment.GITHUB_RUN_ID);
    assert.equal(receipt.commit, environment.GITHUB_SHA);
    assert.ok(Number.isSafeInteger(receipt.source_attempt) && receipt.source_attempt > 0 &&
      receipt.source_attempt <= Number(environment.GITHUB_RUN_ATTEMPT));
    assert.equal(receipt.artifact_name, `container-gates-${receipt.architecture}-${receipt.run_id}-${receipt.source_attempt}-${receipt.commit}`);
    const gate = validateGate(read(path.join(root, receipt.architecture, 'container-gates.json')), environment.GITHUB_SHA, receipt.architecture);
    return { ...receipt, manifest_digest: gate.image.manifest_digest };
  });
  return { status: 'PASS', application_mode: 'v2', commit: environment.GITHUB_SHA,
    run_id: environment.GITHUB_RUN_ID, run_attempt: environment.GITHUB_RUN_ATTEMPT,
    security_scan: 'DEFERRED', platforms };
}
function assets(out = 'release-output', input = 'release-input') {
  const meta = read(path.join(out, 'published-manifest.json'));
  assert.equal(meta.status, 'PASS');
  assert.deepEqual(Object.keys(meta.platforms).sort(), ['amd64', 'arm64']);
  const names = ['published-manifest.json'];
  for (const arch of ['amd64', 'arm64']) {
    const gate = validateGate(read(path.join(input, arch, 'container-gates.json')), meta.sha, arch);
    assert.equal(gate.image.manifest_digest, meta.platforms[arch]);
    for (const name of ['sbom', 'provenance', 'container-gates', 'image-audit']) {
      const target = arch + '-' + name + '.json';
      fs.copyFileSync(path.join(input, arch, name + '.json'), path.join(out, target));
      names.push(target);
    }
  }
  const smoke = read(path.join(out, 'v2-smoke.json'));
  assert.equal(smoke.status, 'PASS');
  assert.equal(smoke.cleanup, 'PASS');
  assert.equal(smoke.commit, meta.sha);
  assert.equal(smoke.application_mode, 'v2');
  names.push('v2-smoke.json');
  const compose = fs.readFileSync('compose.v2.example.yaml', 'utf8')
    .replace('# Local candidate example; use a new project and dedicated named volumes.', '# Fresh-v2 release; use a new project and dedicated named volumes.')
    .replace('ZHIXU_V2_IMAGE=<locally-built candidate tag or digest>', 'ZHIXU_V2_IMAGE=<published image@sha256:digest>')
    .replaceAll('compose.v2.example.yaml', 'compose.yaml')
    .replace('--pull never', '--pull missing')
    .replace('Set the locally built candidate image or immutable digest', 'Set the published immutable image digest')
    .replace('pull_policy: never', 'pull_policy: missing');
  fs.writeFileSync(path.join(out, 'compose.yaml'), compose);
  fs.writeFileSync(path.join(out, 'container.env.example'),
    `ZHIXU_V2_IMAGE=${meta.image}@${meta.digest}\nZHIXU_V2_PUBLIC_ORIGIN=http://127.0.0.1:5600\n`);
  write(path.join(out, 'release-manifest.json'), { version: meta.version, git_sha: meta.sha,
    application_mode: 'v2', installation: 'FRESH_ONLY', security_scan: 'DEFERRED',
    image: meta.image, manifest_digest: meta.digest, platforms: meta.platforms });
  fs.writeFileSync(path.join(out, 'release-notes.md'), `# ZhiXu ${meta.version}\n\nFresh-v2 installation only. Use new dedicated data, backup and scratch volumes. Existing v9 data volumes cannot be upgraded in place.\n\nSource: ${meta.sha}\nImage: ${meta.image}@${meta.digest}\nPlatforms: linux/amd64, linux/arm64\n\nDownload compose.yaml and container.env.example, rename the latter to .env, then run:\n\n\`\`\`sh\ndocker compose --env-file .env -f compose.yaml pull\ndocker compose --env-file .env -f compose.yaml run --rm --service-ports platform-v2 --initialize\n# After stopping the initialization service:\ndocker compose --env-file .env -f compose.yaml up -d\n\`\`\`\n\nSet ZHIXU_V2_PUBLIC_ORIGIN to the exact browser origin. Default access is localhost port 5600. One active service per data volume. The attached receipts cover OCI identity, SBOM/provenance and fresh-v2 authentication, shell execution and persistence after restart on both architectures. Full CVE clearance and supply-chain review are deferred; this release does not claim either has passed. Historical RC15 results are not the identity of these rebuilt artifacts.\n`);
  names.push('compose.yaml', 'container.env.example', 'release-manifest.json', 'release-notes.md');
  const sums = names.sort().map(name => crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex') + '  ' + name);
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
}
if (require.main === module) {
  const out = process.env.RELEASE_OUTPUT || 'release-output';
  if (process.argv[2] === 'gates') gates(out, process.env.GITHUB_SHA, process.env.TEST_ARCH);
  else if (process.argv[2] === 'summary') write('container-qualification-summary.json', summary(process.env.QUALIFICATION_INPUT || 'qualification-input', process.env));
  else if (process.argv[2] === 'assets') assets(out);
  else throw Error('V2_RELEASE_COMMAND_REQUIRED');
}
module.exports = { validateGate, gates, summary, assets, requiredSteps };
