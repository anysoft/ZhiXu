// Targeted production-image verification. No source mounts, ts-node, published ports or live volumes.
// ZHIXU_BACKUP_CLI_IMAGE=<disposable image ID> node diagnostics/v2/backup-cli-container.cjs
// Set ZHIXU_BACKUP_CLI_REMOVE_IMAGE=1 only when that image belongs to this verification.
'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

async function backupCliContainerScenario() {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const crypto = require('node:crypto');
  const { spawn, execFileSync } = require('node:child_process');
  process.env.QL_DIR = '/app';
  process.env.QL_DATA_DIR = '/dev/null';
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  const { V2Application } = require('/app/static/build/applicationV2/application');
  const { WorkspaceLifecycleService } = require('/app/static/build/services/workspaceV2/lifecycle');
  const { WorkspaceFileService } = require('/app/static/build/services/workspaceV2/files');
  const { WorkspaceRootResolver } = require('/app/static/build/services/workspaceV2/roots');
  const { WorkspaceBackupService } = require('/app/static/build/services/workspaceV2/backup');
  const { TaskService } = require('/app/static/build/services/taskExecutionV2/task');
  const dataRoot = '/data/state', backupRoot = '/backup/state';
  const settings = {
    dataRoot, backupRoot, projectRoot: '/app',
    artifactRoot: '/app/static/build/applicationV2/contracts',
    frontendRoot: '/app/static/dist-v2', port: 0, background: false,
  };
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const secrets = [];
  for (const oldEntry of [
    'backupCli.js', 'backupCandidate.js', 'api/backups.js',
    'services/backup/coordinator.js', 'services/backup/restore.js',
    'services/backup/validator.js', 'services/backup/git.js',
    'services/backup/materializations.js',
  ]) {
    await assert.rejects(fs.lstat('/app/static/build/' + oldEntry), {code:'ENOENT'});
  }
  let app;
  async function command(args, input, expectedError) {
    const child = spawn(process.execPath, ['/app/static/build/backupCliV2.js', ...args], {
      env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    } finally { clearTimeout(timer); }
    for (const secret of secrets)
      assert.ok(!(stdout + stderr).includes(secret), 'CLI output contained fixture credentials');
    assert.equal(result.signal, null, 'CLI command deadline');
    const lines = (result.code === 0 ? stdout : stderr).trim().split('\n').filter(Boolean);
    assert.ok(lines.length, 'CLI structured output required');
    let value;
    try { value = JSON.parse(lines.at(-1)); }
    catch { throw Error('CLI_RESULT_NOT_JSON'); }
    if (expectedError) {
      assert.notEqual(result.code, 0, 'CLI unexpectedly accepted rejected operation');
      assert.equal(value.error_code, expectedError);
    } else {
      assert.equal(result.code, 0, value.error_code || 'CLI_COMMAND_FAILED');
      assert.equal(value.code, 200);
    }
    return value.data;
  }
  async function checkRemoteCli(snapshot, portable) {
    const http = require('node:http');
    const { createReadStream } = require('node:fs');
    const { remoteBackupKey } = require('/app/static/build/services/backup/remoteKeys');
    const manifest = JSON.parse(await fs.readFile(path.join(backupRoot, 'snapshots', snapshot, 'manifest.json'), 'utf8'));
    const key = remoteBackupKey(manifest, 'MANUAL');
    const size = (await fs.stat(portable)).size;
    const keySecret = 'image-secret-' + crypto.randomUUID();
    const davPassword = 'image-dav-' + crypto.randomUUID();
    secrets.push(keySecret, davPassword);
    const s3Key = 'external/' + key;
    const davFile = '/dav/' + key;
    const folders = ['/dav/', '/dav/zhixu-v2/', '/dav/zhixu-v2/MANUAL/', '/dav/zhixu-v2/MANUAL/FULL/'];
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://fixture');
      const location = decodeURIComponent(url.pathname);
      const dav = location.startsWith('/dav/');
      const authorized = dav
        ? request.headers.authorization === 'Basic ' + Buffer.from('image-user:' + davPassword).toString('base64')
        : /^AWS4-HMAC-SHA256 Credential=image-access\//.test(request.headers.authorization || '');
      if (!authorized) { response.writeHead(403).end(); return; }
      if (!dav && request.method === 'GET' && url.searchParams.get('list-type') === '2') {
        response.writeHead(200, {'content-type':'application/xml'}).end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Contents><Key>${s3Key}</Key><Size>${size}</Size><LastModified>${manifest.created_at}</LastModified></Contents></ListBucketResult>`);
        return;
      }
      if (dav && request.method === 'PROPFIND' && folders.includes(location)) {
        const child = folders.find((entry) => entry.startsWith(location) && entry !== location && !entry.slice(location.length).replace(/\/$/, '').includes('/'));
        const name = child || davFile;
        const properties = child ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength>`;
        response.writeHead(207, {'content-type':'application/xml'}).end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${name}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
        return;
      }
      if (request.method === 'GET' && (location === '/backup-bucket/' + s3Key || location === davFile)) {
        response.writeHead(200, {'content-length':size});
        createReadStream(portable).on('error', () => response.destroy()).pipe(response);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = 'http://127.0.0.1:' + server.address().port;
      for (const target of [
        {type:'S3',endpoint,region:'us-east-1',bucket:'backup-bucket',prefix:'external',access_key_id:'image-access',secret_access_key:keySecret,path_style:true},
        {type:'WEBDAV',endpoint:endpoint+'/dav/',username:'image-user',password:davPassword},
      ]) {
        const config = '/backup/remote-smoke-' + target.type + '.json';
        const output = '/backup/remote-smoke-' + target.type + '.encrypted';
        await fs.writeFile(config, JSON.stringify(target), {mode:0o600});
        try {
          const listing = await command(['remote','list','--config',config]);
          assert.equal(listing.objects[0].backup_id, snapshot);
          await command(['remote','download',snapshot,'--config',config,'--output',output]);
          assert.equal(digest(await fs.readFile(output)), digest(await fs.readFile(portable)));
        } finally {
          await fs.unlink(config).catch(() => {});
          await fs.unlink(output).catch(() => {});
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  function git(args, cwd) {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Offline CLI fixture',
        GIT_AUTHOR_EMAIL: 'offline@example.invalid', GIT_COMMITTER_NAME: 'Offline CLI fixture',
        GIT_COMMITTER_EMAIL: 'offline@example.invalid',
      },
    }).trim();
  }
  async function checkRestored(expected) {
    app = await V2Application.launch(settings);
    assert.equal((await fetch(app.origin + '/api/system')).status, 200);
    const s = app.services, roots = new WorkspaceRootResolver(dataRoot);
    const workspace = await s.store.workspace(expected.workspace_id);
    const owned = await roots.requireOwned(workspace);
    assert.equal(workspace.name, 'Container offline backup');
    assert.equal(await fs.readFile(path.join(owned.root, 'main.sh'), 'utf8'), 'printf "restored-cli-task\\n"\n');
    const task = (await s.store.all('SELECT name FROM Tasks WHERE id=?', [expected.task_id]))[0];
    assert.equal(task.name, 'Container recovery task');
    assert.equal(digest(await fs.readFile(path.join(dataRoot, 'config-assets', expected.config_key))), expected.config_sha256);
    const binding = (await s.store.all('SELECT revision_id FROM TaskConfigBindings WHERE task_id=?', [expected.task_id]))[0];
    assert.equal(binding.revision_id, expected.revision_id);
    const gitWorkspace = await s.store.workspace(expected.git_workspace_id);
    const gitRoot = (await roots.requireOwned(gitWorkspace)).root;
    assert.equal(git(['rev-parse', 'HEAD'], gitRoot), expected.git_commit);
    assert.equal(await fs.readFile(path.join(gitRoot, 'untracked.py'), 'utf8'), 'print("retained git working file")\n');
    assert.match(git(['status', '--porcelain=v1'], gitRoot), /untracked.py/);
    assert.equal(git(['fsck', '--no-dangling'], gitRoot), '');
    assert.deepEqual(await s.store.all('PRAGMA foreign_key_check'), []);
  }
  try {
    if (process.env.ZHIXU_BACKUP_TEST_PHASE === 'source') {
      app = await V2Application.launch({ ...settings, initialize: true });
      const s = app.services;
      const lifecycle = new WorkspaceLifecycleService(s.store, s.roots, s.leases);
      const files = new WorkspaceFileService(s.store, s.roots, s.leases);
      const workspace = await lifecycle.createLocal({ name: 'Container offline backup', requestKey: crypto.randomUUID() });
      await files.create(workspace.id, 'main.sh', 'printf "restored-cli-task\\n"\n');
      const task = await new TaskService(s.store, s.roots, s.leases).create({
        name: 'Container recovery task',
        source: { type: 'WORKSPACE_ENTRYPOINT', workspace_id: workspace.id,
          relative_entrypoint: 'main.sh', language: 'SHELL', cwd_mode: 'WORKSPACE_ROOT', cwd_relative_path: null },
      });
      const config = 'private-container-config-' + crypto.randomUUID();
      secrets.push(config);
      const now = new Date().toISOString();
      const asset = (await s.store.run('INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES(?,1,?,?)',
        ['Container private configuration', now, now])).lastID;
      const key = `asset-${asset}/revisions/1/content`;
      const revision = (await s.store.run('INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,1,?,?,?,?)',
        [asset, digest(config), Buffer.byteLength(config), key, now])).lastID;
      await s.store.run('UPDATE ConfigAssets SET current_revision_id=? WHERE id=?', [revision, asset]);
      await s.store.run("INSERT INTO TaskConfigBindings(task_id,asset_id,revision_id,target_base,target_path) VALUES(?,?,?,'TASK_CWD','private.conf')",
        [task.task.id, asset, revision]);
      await fs.mkdir(path.join(dataRoot, 'config-assets', path.dirname(key)), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dataRoot, 'config-assets', key), config, { mode: 0o600 });
      const remote = '/scratch/tmp/backup-cli-remote';
      await fs.mkdir(remote, { recursive: true, mode: 0o700 });
      git(['init', '--initial-branch=main'], remote);
      await fs.writeFile(path.join(remote, 'main.py'), 'print("container source")\n');
      git(['add', 'main.py'], remote);
      git(['commit', '-m', 'container backup fixture'], remote);
      const bare = path.join(dataRoot, 'git', 'repository-1.git');
      await fs.mkdir(path.dirname(bare), { recursive: true, mode: 0o700 });
      git(['clone', '--no-hardlinks', '--bare', remote, bare], remote);
      await s.store.run("INSERT INTO Repositories(id,name,provider,remote_url,normalized_url,storage_path,storage_state,default_branch) VALUES(1,'container-fixture','github',?, ?,?,'READY','main')",
        ['https://example.invalid/container-fixture.git', 'https://example.invalid/container-fixture.git', bare]);
      const gitWorkspace = await lifecycle.createGit({ name: 'Container Git source', requestKey: crypto.randomUUID(), repositoryId: 1, refType: 'branch', refName: 'main' });
      await files.create(gitWorkspace.id, 'untracked.py', 'print("retained git working file")\n');
      const expected = {
        workspace_id: workspace.id, task_id: task.task.id, config_key: key,
        config_sha256: digest(config), revision_id: revision,
        git_workspace_id: gitWorkspace.id,
        git_commit: git(['rev-parse', 'HEAD'], (await s.roots.requireOwned(gitWorkspace)).root),
      };
      await app.close(); app = undefined;
      const created = await command(['create']);
      const snapshot = created.id;
      assert.ok((await command(['list'])).some((row) => row.id === snapshot && row.verified));
      await command(['info', snapshot]);
      await command(['verify', snapshot]);
      await checkRestored(expected);
      await command(['restore', '--snapshot', snapshot], undefined, 'RESTORE_BACKEND_ACTIVE');
      await app.close(); app = undefined;
      const corrupt = Buffer.from('NOT A SQLITE DATABASE: isolated CLI disaster fixture\n');
      const database = path.join(dataRoot, 'db/database.sqlite');
      await fs.writeFile(database, corrupt);
      let rejected = false;
      try { app = await V2Application.launch(settings); }
      catch { rejected = true; }
      if (app) { await app.close(); app = undefined; }
      assert.ok(rejected, 'corrupted SQLite must prevent ordinary Web startup');
      assert.ok((await command(['list'])).some((row) => row.id === snapshot && row.verified));
      await command(['verify', snapshot]);
      const restored = await command(['restore', '--snapshot', snapshot]);
      assert.equal(restored.stage, 'COMPLETE');
      assert.ok((await fs.readFile(path.join(restored.old_root, 'db/database.sqlite'))).equals(corrupt), 'damaged original database must remain quarantined');
      assert.equal((await command(['status'])).journal.stage, 'COMPLETE');
      await checkRestored(expected);
      const phrase = 'container-portable-' + crypto.randomUUID();
      secrets.push(phrase);
      const backup = new WorkspaceBackupService(app.services.store, app.services.roots, app.services.leases, backupRoot);
      expected.portable_file = await backup.exportPortable(snapshot, Buffer.from(phrase));
      await fs.writeFile('/backup/container-passphrase', phrase, { mode: 0o600 });
      await fs.writeFile('/backup/container-fixture.json', JSON.stringify(expected), { mode: 0o600 });
      await app.close(); app = undefined;
      await checkRemoteCli(snapshot, expected.portable_file);
      process.stdout.write(JSON.stringify({ phase: 'source', status: 'PASS', runtime: { platform: process.platform, architecture: process.arch, node: process.versions.node }, checks: ['production-cli', 'offline-create-list-info-verify', 'live-owner-refusal', 'corrupt-sqlite-web-refusal', 'snapshot-disaster-restore', 'damaged-root-preserved', 'workspace-git-task-config-restored', 'portable-export', 'packaged-s3-webdav-remote-cli-download'] }) + '\n');
    } else {
      const expected = JSON.parse(await fs.readFile('/backup/container-fixture.json', 'utf8'));
      const phrase = await fs.readFile('/backup/container-passphrase', 'utf8');
      secrets.push(phrase);
      await command(['restore', '--file', expected.portable_file, '--passphrase-stdin'], 'incorrect-' + crypto.randomUUID(), 'BACKUP_AUTHENTICATION_FAILED');
      const target = await fs.readdir(dataRoot).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
      assert.deepEqual(target, [], 'wrong password must not create or overwrite a business database');
      const restored = await command(['restore', '--file', expected.portable_file, '--passphrase-file', '/backup/container-passphrase']);
      assert.equal(restored.stage, 'COMPLETE');
      assert.equal((await command(['status'])).journal.stage, 'COMPLETE');
      await checkRestored(expected);
      await app.close(); app = undefined;
      process.stdout.write(JSON.stringify({ phase: 'portable', status: 'PASS', checks: ['wrong-password-keeps-blank-target', 'portable-restore-to-new-data-volume', 'restored-backend-starts', 'workspace-git-task-config-restored'] }) + '\n');
    }
  } finally { if (app) await app.close(); }
}

async function runBackupCliContainerVerification() {
  const image = process.env.ZHIXU_BACKUP_CLI_IMAGE;
  if (!image || !/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(image))
    throw Error('Set ZHIXU_BACKUP_CLI_IMAGE to the compiled production image ID or tag.');
  const token = randomUUID(), prefix = 'zhixu-backup-cli-' + token;
  const label = 'org.zhixu.backup-cli-test=' + token;
  const ownedVolumes = [], containers = [];
  let failed = false, interrupted = false, active;
  const stop = () => { interrupted = true; active?.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  async function docker(args, input, allowFailure = false) {
    if (interrupted && !allowFailure) throw Error('Container verification interrupted');
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    active = child;
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
    } finally { clearTimeout(timer); active = undefined; }
    if (code !== 0 && !allowFailure) throw Error('Docker verification failed: ' + stderr.trim().slice(-4000));
    return { code, stdout, stderr };
  }
  try {
    await docker(['image', 'inspect', image]);
    for (const role of ['source-data', 'recovered-data', 'backup', 'scratch']) {
      const name = prefix + '-' + role;
      await docker(['volume', 'create', '--label', label, name]);
      ownedVolumes.push(name);
    }
    for (const phase of ['source', 'portable']) {
      const name = prefix + '-' + phase;
      containers.push(name);
      const result = await docker([
        'run', '--rm', '--name', name, '--label', label, '-i', '--read-only',
        '--user', '10001:10001', '--network', 'none', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--pids-limit', '256',
        '--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=64m,mode=1777',
        '--mount', `type=volume,src=${prefix}-${phase === 'source' ? 'source-data' : 'recovered-data'},dst=/data`,
        '--mount', `type=volume,src=${prefix}-backup,dst=/backup`,
        '--mount', `type=volume,src=${prefix}-scratch,dst=/scratch`,
        '--env', 'ZHIXU_BACKUP_TEST_PHASE=' + phase,
        '--entrypoint', 'node', image, '-',
      ], `(${backupCliContainerScenario.toString()})().catch((error) => { process.stderr.write(String(error.stack || error.message)); process.exitCode = 1; });`);
      process.stdout.write(result.stdout);
      assert.match(result.stdout, /"status":"PASS"/);
      if (phase === 'source') {
        const service = prefix + '-entrypoint';
        containers.push(service);
        await docker([
          'run', '--detach', '--name', service, '--label', label, '--read-only',
          '--user', '10001:10001', '--network', 'none', '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges:true', '--pids-limit', '256',
          '--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=64m,mode=1777',
          '--mount', `type=volume,src=${prefix}-source-data,dst=/data`,
          '--mount', `type=volume,src=${prefix}-backup,dst=/backup`,
          '--mount', `type=volume,src=${prefix}-scratch,dst=/scratch`,
          '--env', 'ZHIXU_V2_PUBLIC_ORIGIN=http://127.0.0.1:5600', image,
        ]);
        let ready = false;
        for (let attempt = 0; attempt < 90; attempt++) {
          const health = await docker(['exec', service, 'node', 'scripts/release-v2/healthcheck.cjs'], undefined, true);
          if (health.code === 0) { ready = true; break; }
          const state = await docker(['inspect', '--format', '{{.State.Running}}', service], undefined, true);
          if (state.code !== 0 || state.stdout.trim() !== 'true') break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!ready) {
          const logs = await docker(['logs', '--tail', '80', service], undefined, true);
          throw Error('Formal entrypoint startup rejected: ' + (logs.stderr + logs.stdout).slice(-4000));
        }
        await docker(['stop', '--time', '30', service]);
        await docker(['rm', service]);
        process.stdout.write(JSON.stringify({ phase:'entrypoint', status:'PASS', checks:['formal-entrypoint-starts-v2', 'production-healthcheck-ready', 'normal-signal-stop'] })+'\n');
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const name of containers) {
      const found = await docker(['inspect', '--format', '{{index .Config.Labels "org.zhixu.backup-cli-test"}}', name], undefined, true);
      if (found.code === 0 && found.stdout.trim() === token) {
        const removed = await docker(['rm', '-f', name], undefined, true);
        if (removed.code !== 0) cleanupErrors.push(name);
      }
    }
    for (const name of ownedVolumes) {
      const found = await docker(['volume', 'inspect', '--format', '{{index .Labels "org.zhixu.backup-cli-test"}}', name], undefined, true);
      if (found.code === 0 && found.stdout.trim() === token) {
        const removed = await docker(['volume', 'rm', name], undefined, true);
        if (removed.code !== 0) cleanupErrors.push(name);
      }
    }
    if (process.env.ZHIXU_BACKUP_CLI_REMOVE_IMAGE === '1') {
      const removed = await docker(['image', 'rm', image], undefined, true);
      if (removed.code !== 0) cleanupErrors.push('disposable image');
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.stdout.write(JSON.stringify({ cleanup: cleanupErrors.length ? 'FAILED' : 'PASS', test_status: failed ? 'FAIL' : 'PASS', remaining_owned_resources: cleanupErrors }) + '\n');
    if (cleanupErrors.length && !failed) throw Error('Verification resource cleanup failed');
  }
}

if (require.main === module)
  runBackupCliContainerVerification().catch((error) => {
    process.stderr.write((error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
