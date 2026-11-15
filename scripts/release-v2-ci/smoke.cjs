'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const image = process.env.TEST_IMAGE, arch = process.env.TEST_ARCH, sha = process.env.GITHUB_SHA;
assert.ok(image && ['amd64', 'arm64'].includes(arch));
assert.match(sha || '', /^[a-f0-9]{40}$/);
const out = process.env.RELEASE_OUTPUT || 'release-output';
fs.mkdirSync(out, { recursive: true });
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const identity = JSON.parse(docker('image', 'inspect', image))[0];
assert.equal(identity.Architecture, arch, 'SMOKE_IMAGE_ARCHITECTURE');
assert.equal(identity.Config.Labels['org.opencontainers.image.revision'], sha, 'SMOKE_IMAGE_COMMIT');
assert.equal(identity.Config.Labels['org.opencontainers.image.version'], require('../../package.json').version);
assert.equal(identity.Config.Labels['org.zhixu.application-mode'], 'v2');
const owner = 'zhixu-v2-ci-' + crypto.randomUUID();
const label = 'org.zhixu.ci-owner=' + owner;
const volumes = [], containers = [];
const receipt = { status: 'FAIL', cleanup: 'FAIL', architecture: arch, commit: sha, application_mode: 'v2', steps: [] };
const worker = fs.readFileSync('scripts/release-v2-ci/smoke-worker.cjs', 'utf8');
const password = 'Ci!' + crypto.randomUUID();
let failed = false;
let stage = 'create-volumes';
async function start(initialize) {
  const name = owner + '-' + containers.length;
  containers.push(name);
  docker('run', '-d', '--name', name, '--label', label, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--pids-limit=256', '--memory=4g', '--cpus=2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=64m,mode=1777',
    '-v', volumes[0] + ':/data', '-v', volumes[1] + ':/backup', '-v', volumes[2] + ':/scratch',
    '-e', 'ZHIXU_V2_PUBLIC_ORIGIN=http://127.0.0.1:5600', image, ...(initialize ? ['--initialize'] : []));
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const state = JSON.parse(docker('inspect', name))[0].State;
    assert.equal(state.Running, true, 'V2_CONTAINER_EXITED');
    if (state.Health?.Status === 'healthy') return name;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error('V2_HEALTH_DEADLINE');
}
function request(name, ids) {
  const result = execFileSync('docker', ['exec', '-i', name, 'node', '-e', worker], {
    input: JSON.stringify({ password, ids }), encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(result);
}
function stop(name) {
  docker('stop', '--time', '30', name);
  assert.equal(JSON.parse(docker('inspect', name))[0].State.ExitCode, 0, 'GRACEFUL_SHUTDOWN');
}
(async () => {
  try {
    for (const kind of ['data', 'backup', 'scratch']) {
      const name = owner + '-' + kind;
      volumes.push(name);
      docker('volume', 'create', '--label', label, name);
    }
    stage = 'initialize-and-health';
    const first = await start(true);
    stage = 'fresh-http-task-run';
    const ids = request(first);
    receipt.steps.push('fresh-initialize', 'v2-health-and-frontend', 'owner-auth', 'local-workspace', 'shell-task-run-attempt-log');
    stage = 'first-shutdown';
    stop(first);
    stage = 'restart-and-health';
    const second = await start(false);
    stage = 'persisted-http-state';
    request(second, ids);
    stage = 'second-shutdown';
    stop(second);
    receipt.steps.push('restart-persistence', 'subscription-retired', 'graceful-shutdown');
    receipt.status = 'PASS';
  } catch {
    failed = true;
    receipt.failure_stage = stage;
    process.stderr.write('V2_CONTAINER_SMOKE_FAILED:' + stage + '\n');
  } finally {
    // Only resources carrying this invocation's random owner label are removed.
    let clean = true;
    for (const [kind, names] of [['container', containers], ['volume', volumes]]) {
      for (const name of names) {
        try {
          const item = JSON.parse(docker(kind, 'inspect', name))[0];
          assert.equal((item.Config?.Labels || item.Labels)['org.zhixu.ci-owner'], owner);
          docker(kind, 'rm', ...(kind === 'container' ? ['-f'] : []), name);
        } catch { clean = false; }
      }
    }
    try {
      assert.equal(docker('ps', '-aq', '--filter', 'label=' + label), '');
      assert.equal(docker('volume', 'ls', '-q', '--filter', 'label=' + label), '');
    } catch { clean = false; }
    receipt.cleanup = clean ? 'PASS' : 'FAIL';
    if (!clean) receipt.status = 'FAIL';
    fs.writeFileSync(out + '/v2-smoke.json', JSON.stringify(receipt, null, 2) + '\n');
    process.exitCode = failed || !clean ? 1 : 0;
  }
})();
