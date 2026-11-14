'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'bin/git-tools');
if (!fs.existsSync(output)) {
  const tools = path.join(root, 'release-tools/native-git');
  const sources = path.join(tools, 'sources');
  const work = path.join(tools, 'work');
  for (const directory of [path.dirname(output), tools, sources, work])
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const result = spawnSync('bash', [
    path.join(__dirname, 'build-git-tools.sh'), '--output', output,
    '--source-cache', sources, '--work-parent', work, '--jobs', '2',
  ], { cwd: root, stdio: 'inherit', timeout: 3600000 });
  if (result.error || result.status !== 0) {
    process.stderr.write('Verified native Git tool build failed\n');
    process.exit(result.status || 1);
  }
}
// The compiled verifier checks every executable SHA and actual platform/architecture.
const { verifiedGitSshTools } = require(path.join(root, 'static/build/shared/nativeGitTools.js'));
verifiedGitSshTools().then((tools) => {
  const result = spawnSync(tools.ssh, ['-V'], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0 ||
      !/OpenSSH_10\.6p2.*OpenSSL 3\.5\.9/.test(result.stderr || ''))
    throw Error('NATIVE_GIT_TOOL_ACTUAL_VERSION_MISMATCH');
  const git = spawnSync(tools.git, ['--version'], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GIT_EXEC_PATH: tools.execPath, PATH: tools.binPath + ':/usr/bin:/bin' } });
  if (git.error || git.status !== 0 || git.stdout.trim() !== 'git version 2.50.2')
    throw Error('NATIVE_GIT_ACTUAL_VERSION_MISMATCH');
  process.stdout.write(JSON.stringify({ git_version: git.stdout.trim(), event: 'VERIFIED_GIT_TOOLS_READY',
    platform: process.platform, architecture: process.arch,
    version: result.stderr.trim() }) + '\n');
}).catch(() => { process.stderr.write('Verified native Git tool identity rejected\n'); process.exitCode = 1; });
