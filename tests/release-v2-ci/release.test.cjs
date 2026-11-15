'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { gates, summary, assets, requiredSteps } = require('../../scripts/release-v2-ci/receipts.cjs');
const { metadata } = require('../../scripts/release/metadata.cjs');
const { selectReceipts } = require('../../scripts/release/qualification-receipts.cjs');
const sha = 'a'.repeat(40), digest = 'sha256:' + 'b'.repeat(64);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixu-v2-ci-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(arch = 'amd64') {
  return { status: 'PASS', application_mode: 'v2', commit: sha, architecture: arch,
    image: { status: 'PASS', application_mode: 'v2', commit: sha, architecture: arch,
      manifest_digest: digest, config_digest: digest, archive_sha256: 'b'.repeat(64),
      attestation_digests: [digest], sbom: 'PASS', provenance: 'PASS' },
    acceptance: { status: 'PASS', cleanup: 'PASS', application_mode: 'v2', commit: sha,
      architecture: arch, steps: requiredSteps }, security_scan: 'DEFERRED' };
}
test('gate fails closed for incomplete, wrong-source, failed or unclean v2 evidence; stale PASS is removed', t => {
  const root = temporary(t);
  for (const mutate of [g => { g.acceptance.cleanup = 'FAIL'; },
    g => { g.acceptance.status = 'FAIL'; }, g => { g.acceptance.steps = []; },
    g => { g.image.commit = 'c'.repeat(40); }, g => { g.image.application_mode = 'v9'; },
    g => { g.image.attestation_digests = []; }, g => { g.image.provenance = 'FAIL'; }]) {
    const gate = fixture(); mutate(gate);
    write(root + '/image-audit.json', gate.image); write(root + '/v2-smoke.json', gate.acceptance);
    write(root + '/container-gates.json', fixture());
    assert.throws(() => gates(root, sha, 'amd64'));
    assert.equal(fs.existsSync(root + '/container-gates.json'), false);
  }
  const gate = fixture();
  write(root + '/image-audit.json', gate.image); write(root + '/v2-smoke.json', gate.acceptance);
  gates(root, sha, 'amd64');
  assert.equal(JSON.parse(fs.readFileSync(root + '/container-gates.json')).security_scan, 'DEFERRED');
});
test('summary requires success of both native builds and same-run receipts', t => {
  const root = temporary(t), env = { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: sha, NEEDS: '{"container":{"result":"success"}}' };
  const artifacts = ['amd64', 'arm64'].map((arch, i) => ({ id: i + 1, name: `container-gates-${arch}-123-2-${sha}`, expired: false }));
  const receipts = selectReceipts(artifacts, env);
  write(root + '/receipts.json', receipts);
  for (const arch of ['amd64', 'arm64']) { fs.mkdirSync(root + '/' + arch); write(root + '/' + arch + '/container-gates.json', fixture(arch)); }
  assert.equal(summary(root, env).status, 'PASS');
  assert.throws(() => summary(root, { ...env, NEEDS: '{"container":{"result":"failure"}}' }));
  assert.throws(() => summary(root, { ...env, GITHUB_SHA: 'c'.repeat(40) }));
  receipts[1].source_attempt = 3; write(root + '/receipts.json', receipts);
  assert.throws(() => summary(root, env));
});
test('assets describe fresh-only v2, include published smoke and checksum every uploaded asset', t => {
  const root = temporary(t), out = root + '/out', input = root + '/input';
  fs.mkdirSync(out);
  write(out + '/published-manifest.json', { status: 'PASS', version: '2.0.0', sha,
    image: 'anysoft/zhixu', digest, platforms: { amd64: digest, arm64: digest } });
  write(out + '/v2-smoke.json', fixture().acceptance);
  for (const arch of ['amd64', 'arm64']) {
    fs.mkdirSync(input + '/' + arch, { recursive: true });
    write(input + '/' + arch + '/container-gates.json', fixture(arch));
    for (const name of ['sbom', 'provenance', 'image-audit']) write(input + '/' + arch + '/' + name + '.json', {});
  }
  assets(out, input);
  const notes = fs.readFileSync(out + '/release-notes.md', 'utf8');
  assert.match(notes, /Fresh-v2 installation only/); assert.match(notes, /deferred/);
  assert.doesNotMatch(notes, /Schema v9|Use ZhiXu Backup\/Export before upgrades/);
  assert.match(fs.readFileSync(out + '/compose.yaml', 'utf8'), /ZHIXU_V2_DATA_ROOT/);
  assert.match(fs.readFileSync(out + '/container.env.example', 'utf8'), new RegExp('anysoft/zhixu@' + digest));
  const checked = [];
  for (const line of fs.readFileSync(out + '/SHA256SUMS', 'utf8').trim().split('\n')) {
    const [sum, name] = line.split('  '); checked.push(name);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(out + '/' + name)).digest('hex'), sum);
  }
  assert.deepEqual(checked.sort(), fs.readdirSync(out).filter(n => n !== 'SHA256SUMS').sort());
});
test('release identity and receipt selection retain tag, SHA and expiration protections', () => {
  assert.equal(metadata('v2.0.0', '2.0.0', sha).version, '2.0.0');
  assert.throws(() => metadata('v1.0.0', '2.0.0', sha));
  assert.throws(() => selectReceipts([], { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: sha }));
});
test('workflow builds v2 explicitly and publishes tested bytes after qualification', () => {
  const qualification = fs.readFileSync('.github/workflows/container-qualification.yml', 'utf8');
  const release = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  assert.match(qualification, /ubuntu-24\.04-arm/);
  assert.match(qualification, /scripts\/release-v2-ci\/build.cjs/);
  assert.match(qualification, /scripts\/release-v2-ci\/smoke.cjs/);
  assert.doesNotMatch(qualification, /linux-qualification|release\/container-acceptance|trivy/);
  assert.match(release, /needs: \[policy, qualification\]/);
  assert.match(release, /scripts\/release\/publish.cjs/);
  assert.doesNotMatch(release, /release\/container-acceptance|release\/release-assets/);
  assert.match(fs.readFileSync('scripts/release-v2-ci/build.cjs', 'utf8'), /'--file', 'Dockerfile.v2'/);
});
test('container worker authenticates, creates a real-task contract, polls and checks independent restart', async t => {
  let executions = 0, initialized = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    let status = 200, data;
    const url = req.url;
    if (url === '/') { res.end('<html>fresh v2 frontend</html>'); return; }
    if (url === '/api/system') data = { mode: 'v2', schema_identity: 'zhixu.workspace.v2.s0.1', local_write_admission: true, csrf_token: 'csrf' };
    else if (url === '/api/user/init') { assert.equal(initialized, false); initialized = true; data = {}; }
    else if (url === '/api/user/login') data = { token: 'token', csrf_token: 'csrf' };
    else {
      assert.equal(req.headers.authorization, 'Bearer token');
      if (req.method !== 'GET') {
        assert.equal(req.headers.origin, 'http://' + req.headers.host);
        assert.equal(req.headers['x-csrf-token'], 'csrf');
      }
      if (url === '/api/workspaces') { status = 202; data = { workspace: { id: 'ws' } }; }
      else if (url === '/api/workspaces/ws/files') { assert.equal(body.path, 'main.sh'); data = {}; }
      else if (url === '/api/tasks' && req.method === 'POST') { assert.equal(body.runtime.kind, 'SHELL'); data = { id: 'task' }; }
      else if (url === '/api/tasks/task/run') { executions++; status = 202; data = { id: 'run' }; }
      else if (url === '/api/tasks/task') data = { id: 'task' };
      else if (url === '/api/task-runs/run') data = { status: 'SUCCESS' };
      else if (url === '/api/task-runs/run/attempts') data = [{}];
      else if (url === '/api/task-runs/run/log') data = 'V2_RELEASE_REAL_CHILD';
      else if (url === '/api/subscriptions') { status = 404; data = {}; }
      else { status = 500; data = {}; }
    }
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // Run the same node -e path used by docker exec, against an isolated test port.
  const code = fs.readFileSync('scripts/release-v2-ci/smoke-worker.cjs', 'utf8').replaceAll('http://127.0.0.1:5600', 'http://127.0.0.1:' + server.address().port);
  async function worker(ids) {
    const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.stdin.end(JSON.stringify({ password: 'synthetic-test-only', ids }));
    const result = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(result, 0, stderr); return JSON.parse(stdout);
  }
  const ids = await worker();
  await worker(ids);
  assert.equal(executions, 1, 'restart verification must not rerun the task');
});
