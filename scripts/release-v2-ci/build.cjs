'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const arch = process.env.TEST_ARCH;
assert.ok(['amd64', 'arm64'].includes(arch));
const read = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const sha = read('git', ['rev-parse', 'HEAD']);
assert.equal(process.env.GITHUB_SHA || sha, sha, 'CHECKOUT_SHA_MISMATCH');
assert.equal(read('git', ['status', '--porcelain']), '', 'CLEAN_BUILD_SOURCE_REQUIRED');
assert.equal(process.arch, arch === 'amd64' ? 'x64' : 'arm64', 'NATIVE_RUNNER_REQUIRED');
const out = process.env.RELEASE_OUTPUT || 'release-output';
fs.mkdirSync(out, { recursive: true });
const tree = read('git', ['rev-parse', 'HEAD^{tree}']);
fs.writeFileSync(out + '/source-state.json', JSON.stringify({ commit: sha, tree, worktree_dirty: false }));
run('docker', ['buildx', 'build', '--file', 'Dockerfile', '--platform', 'linux/' + arch,
  '--build-arg', 'SOURCE_COMMIT=' + sha, '--build-arg', 'SOURCE_TREE=' + tree,
  '--build-arg', 'APP_VERSION=' + require('../../package.json').version,
  '--sbom=true', '--provenance=mode=max', '--metadata-file', out + '/build-metadata.json',
  '--output', 'type=oci,dest=' + out + '/image.tar', '.']);
run('python3', ['scripts/release-v2-ci/oci-audit.py', out + '/image.tar', arch, sha, out]);
const daemon = process.env.DOCKER_HOST || read('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
const image = process.env.TEST_IMAGE;
assert.ok(image, 'TEST_IMAGE_REQUIRED');
run('skopeo', ['copy', '--dest-daemon-host', daemon, '--override-os', 'linux', '--override-arch', arch,
  'oci-archive:' + out + '/image.tar', 'docker-daemon:' + image]);
const config = execFileSync('skopeo', ['inspect', '--daemon-host', daemon, '--config', '--raw', 'docker-daemon:' + image]);
const audit = JSON.parse(fs.readFileSync(out + '/image-audit.json'));
assert.equal('sha256:' + crypto.createHash('sha256').update(config).digest('hex'), audit.config_digest, 'TESTED_BYTES_MISMATCH');
