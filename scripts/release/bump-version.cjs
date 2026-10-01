'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const yaml = require('js-yaml');
const {metadata} = require('./metadata.cjs');
const files = ['package.json', 'version.yaml', 'compose.yaml', 'docs/deploy/container.env.example',
  'deploy/kubernetes/base/zhixu.yaml', 'deploy/kubernetes/overlays/example/kustomization.yaml',
  'README.md', 'README-en.md', 'deploy/kubernetes/README.md', 'docs/deploy/docker.md'];
const root = path.resolve(__dirname, '../..');

function readSources(directory) {
  return Object.fromEntries(files.map(file => {
    const full = path.join(directory, file), stat = fs.lstatSync(full);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `UNSAFE_VERSION_FILE:${file}`);
    return [file, fs.readFileSync(full, 'utf8')];
  }));
}
function validateSources(sources, version) {
  metadata('v' + version, version, '0'.repeat(40));
  assert.equal(JSON.parse(sources['package.json']).version, version);
  assert.equal(yaml.load(sources['version.yaml']).version, version, 'VERSION_YAML_MISMATCH');
  assert.ok(yaml.load(sources['compose.yaml']).services.platform.image.endsWith('${PLATFORM_VERSION:-' + version + '}'), 'COMPOSE_VERSION_MISMATCH');
  assert.equal(sources['docs/deploy/container.env.example'].match(/^PLATFORM_VERSION=(.+)$/m)?.[1], version, 'ENV_VERSION_MISMATCH');
  const workload = yaml.loadAll(sources['deploy/kubernetes/base/zhixu.yaml']).find(doc => doc?.kind === 'StatefulSet');
  assert.equal(workload.spec.template.spec.containers.find(c => c.name === 'zhixu').image, 'anysoft/zhixu:' + version);
  const overlay = yaml.load(sources['deploy/kubernetes/overlays/example/kustomization.yaml']);
  assert.equal(overlay.images.find(i => i.name === 'anysoft/zhixu').newTag, version);
  for (const file of files.slice(6)) assert.ok(sources[file].includes(version), `DOC_VERSION_MISMATCH:${file}`);
}
function planVersion(directory, version) {
  const before = readSources(directory), current = JSON.parse(before['package.json']).version;
  validateSources(before, current);
  metadata('v' + version, version, '0'.repeat(40));
  const after = {...before};
  if (current !== version) {
    // Only these current-version surfaces; never scan dependency locks or historical evidence.
    const pattern = new RegExp(current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9A-Za-z.+-])', 'g');
    for (const file of files) {
      if (file === 'package.json') {
        after[file] = before[file].replace(/("version"\s*:\s*")[^"]+("(?:\s*,)?)/, (_, a, b) => a + version + b);
      } else if (file === 'version.yaml') {
        // Preserve historical changelog text; only the current top-level version changes.
        after[file] = before[file].replace(/^version:.*$/m, 'version: ' + version);
      } else after[file] = before[file].replace(pattern, version);
    }
  }
  validateSources(after, version);
  return {current, version, before, after, changed: files.filter(file => before[file] !== after[file])};
}
async function atomicWrite(file, text, mode) {
  const temporary = path.join(path.dirname(file), '.version-' + randomUUID());
  let handle;
  try {
    handle = await fsp.open(temporary, 'wx', mode);
    await handle.writeFile(text);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close(); handle = null;
    await fsp.rename(temporary, file);
  } finally {
    await handle?.close();
    await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function main(args) {
  if (!args.length || args.includes('--help')) {
    console.log('Usage: ./bump-version.sh VERSION [--dry-run]\n       ./bump-version.sh --check\nAccepts 1.2.3 or v1.2.3, including -rc.1. Does not commit, push or tag.\nRequires Node.js, Git and installed project dependencies (pnpm install --frozen-lockfile).');
    return;
  }
  const check = args.length === 1 && args[0] === '--check';
  const dry = args.includes('--dry-run');
  const positional = args.filter(arg => arg !== '--dry-run');
  assert.ok(check || (positional.length === 1 && args.length === (dry ? 2 : 1)), 'INVALID_ARGUMENTS');
  const version = check ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version : positional[0].replace(/^v/, '');
  metadata('v' + version, version, '0'.repeat(40));
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {cwd: root, encoding: 'utf8'}).trim();
  assert.equal(fs.realpathSync(gitRoot), fs.realpathSync(root), 'REPOSITORY_ROOT_MISMATCH');
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {cwd: root, encoding: 'utf8'}).trim();
  // mkdir is an exclusive cross-platform lock (macOS has no standard flock CLI).
  const lock = path.join(gitDir, 'zhixu-version.lock');
  try { await fsp.mkdir(lock, {mode: 0o700}); }
  catch (error) { if (error.code === 'EEXIST') throw Error(`VERSION_UPDATE_LOCKED:${lock}; if a process was killed, inspect backups before removing the stale lock`); throw error; }
  let interrupted = false, backup;
  const signal = () => { interrupted = true; };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  const committed = [], modes = {};
  let plan;
  try {
    plan = planVersion(root, version);
    console.log(`${plan.current} -> ${version}${dry ? ' (dry run)' : ''}`);
    if (check || !plan.changed.length) { console.log('Version files are consistent; unchanged.'); return; }
    for (const file of plan.changed) console.log(file);
    if (dry) return;
    const backups = path.join(gitDir, 'zhixu-version-backups');
    await fsp.mkdir(backups, {recursive: true, mode: 0o700});
    backup = await fsp.mkdtemp(path.join(backups, 'update-'));
    for (const file of plan.changed) {
      modes[file] = fs.statSync(path.join(root, file)).mode & 0o777;
      await fsp.mkdir(path.dirname(path.join(backup, file)), {recursive: true, mode: 0o700});
      await fsp.writeFile(path.join(backup, file), plan.before[file], {mode: 0o600});
    }
    await fsp.writeFile(path.join(backup, 'transaction.json'), JSON.stringify({from: plan.current, to: version, files: plan.changed, modes}, null, 2), {mode: 0o600});
    for (const file of plan.changed) {
      if (interrupted) throw Error('VERSION_UPDATE_INTERRUPTED');
      assert.equal((await fsp.lstat(path.join(root, file))).isSymbolicLink(), false);
      assert.equal(await fsp.readFile(path.join(root, file), 'utf8'), plan.before[file], `CONCURRENT_EDIT:${file}`);
      committed.push(file); // Register rollback before mutation.
      await atomicWrite(path.join(root, file), plan.after[file], modes[file]);
    }
    if (interrupted) throw Error('VERSION_UPDATE_INTERRUPTED');
    validateSources(readSources(root), version);
    console.log(`Updated. Backup: ${backup}\nNext: review diff, commit and push develop; wait for that SHA's CI, then tag v${version}.`);
  } catch (error) {
    for (const file of committed.reverse()) {
      const live = await fsp.readFile(path.join(root, file), 'utf8');
      if (live === plan.after[file]) await atomicWrite(path.join(root, file), plan.before[file], modes[file]);
      else if (live !== plan.before[file]) throw Error(`ROLLBACK_CONCURRENT_EDIT:${file}; backups: ${backup}`, {cause: error});
    }
    if (backup) console.error(`Rolled back this invocation. Backup: ${backup}`);
    throw error;
  } finally {
    process.off('SIGINT', signal); process.off('SIGTERM', signal);
    await fsp.rmdir(lock);
  }
}
module.exports = {files, readSources, validateSources, planVersion};
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
