'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { selectReceipts } = require('../../scripts/release/qualification-receipts.cjs');
const env = { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'a'.repeat(40) };
const artifact = (arch, attempt, extra = {}) => ({ id: attempt * 10 + (arch === 'amd64' ? 1 : 2),
  name: `container-gates-${arch}-123-${attempt}-${env.GITHUB_SHA}`, expired: false, ...extra });

test('full, partial and summary-only reruns select both architectures and preserve source attempts', () => {
  for (const [amd, arm] of [[1, 1], [2, 2], [2, 1]]) {
    const selected = selectReceipts([artifact('amd64', amd), artifact('arm64', arm)], env);
    assert.deepEqual(selected.map(x => x.source_attempt), [amd, arm]);
  }
  const selected = selectReceipts([artifact('amd64', 1), artifact('amd64', 2), artifact('arm64', 1)], env);
  assert.equal(selected[0].source_attempt, 2);
});

test('selection rejects missing, expired, ambiguous and foreign evidence without falling back', () => {
  const arm = artifact('arm64', 1);
  for (const name of ['container-gates-amd64-999-2-' + env.GITHUB_SHA,
    'container-gates-amd64-123-2-' + 'b'.repeat(40), artifact('amd64', 3).name]) {
    assert.throws(() => selectReceipts([arm, artifact('amd64', 2, { name })], env), /MISSING_ARCHITECTURE_RECEIPT:amd64/);
  }
  assert.throws(() => selectReceipts([arm, artifact('amd64', 1), artifact('amd64', 2, {expired: true})], env), /EXPIRED/);
  assert.throws(() => selectReceipts([arm, artifact('amd64', 2), artifact('amd64', 2, {id: 99})], env), /AMBIGUOUS/);
});

test('summary validates fixed download paths, mixed attempts and rejects failed or mismatched evidence', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qualification-'));
  const script = path.resolve('scripts/release/qualification-summary.cjs');
  try {
    const receipts = selectReceipts([artifact('amd64', 2), artifact('arm64', 1)], env);
    fs.writeFileSync(path.join(tmp, 'receipts.json'), JSON.stringify(receipts));
    const gate = arch => ({status: 'PASS', commit: env.GITHUB_SHA, architecture: arch,
      image: {status: 'PASS', commit: env.GITHUB_SHA, architecture: arch, sbom: 'PASS', provenance: 'PASS', manifest_digest: 'sha256:test'},
      acceptance: {status: 'PASS', commit: env.GITHUB_SHA, architecture: arch, cleanup: 'PASS'},
      compose: {status: 'PASS', cleanup: 'PASS'}, vulnerability_scan: 'PASS'});
    const write = (arch, value) => fs.writeFileSync(path.join(tmp, arch, 'container-gates.json'), JSON.stringify(value));
    for (const arch of ['amd64', 'arm64']) { fs.mkdirSync(path.join(tmp, arch)); write(arch, gate(arch)); }
    const execute = (needs = {linux: {result: 'success'}, container: {result: 'success'}}) => {
      fs.rmSync(path.join(tmp, 'container-qualification-summary.json'), {force: true});
      return spawnSync(process.execPath, [script], {cwd: tmp, encoding: 'utf8', env: {...process.env, ...env,
        QUALIFICATION_INPUT: tmp, NEEDS: JSON.stringify(needs)}});
    };
    const ok = execute(); assert.equal(ok.status, 0, ok.stderr);
    const summary = JSON.parse(fs.readFileSync(path.join(tmp, 'container-qualification-summary.json')));
    assert.deepEqual(summary.platforms.map(x => x.source_attempt), [2, 1]);
    for (const mutate of [g => g.status = 'FAIL', g => g.acceptance.status = 'FAIL',
      g => g.image.commit = 'b'.repeat(40), g => g.image.architecture = 'arm64',
      g => g.compose.cleanup = 'FAIL', g => g.vulnerability_scan = 'FAIL']) {
      const invalid = gate('amd64'); mutate(invalid); write('amd64', invalid);
      assert.notEqual(execute().status, 0);
      assert.equal(fs.existsSync(path.join(tmp, 'container-qualification-summary.json')), false);
    }
    write('amd64', gate('amd64'));
    assert.notEqual(execute({linux: {result: 'success'}, container: {result: 'failure'}}).status, 0);
    fs.rmSync(path.join(tmp, 'arm64'), {recursive: true});
    assert.notEqual(execute().status, 0);
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
});
