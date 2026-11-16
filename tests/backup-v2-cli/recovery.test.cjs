const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const {
  createFixture,
  seedRepository,
  git,
} = require('../workspace-v2/fixture.cjs');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const { V2Application } = require('../../back/applicationV2/application');

const projectRoot = path.resolve(__dirname, '../..');
const cliEntry = path.join(projectRoot, 'static/build/backupCliV2.js');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function processResult(args, input) {
  const env = { ...process.env };
  // The shipped CLI must run from emitted JS, independently of ts-node/preloads.
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) =>
        resolve({ code, signal, stdout, stderr }),
      );
    });
  } finally {
    clearTimeout(timer);
  }
}

async function cli(f, args, options = {}) {
  await fs.access(cliEntry);
  const result = await processResult(
    [
      cliEntry,
      '--data-root',
      options.dataRoot ?? f.dataRoot,
      '--backup-root',
      options.backupRoot ?? f.backupRoot,
      ...args,
    ],
    options.input,
  );
  assert.equal(result.signal, null, result.stdout + result.stderr);
  for (const secret of f.secrets)
    assert.equal(
      (result.stdout + result.stderr).includes(secret),
      false,
      'CLI must not print secrets',
    );
  const output = result.code === 0 ? result.stdout : result.stderr;
  const lines = output.trim().split('\n').filter(Boolean);
  assert.ok(lines.length, 'CLI emits a structured result');
  let body;
  try {
    body = JSON.parse(lines.at(-1));
  } catch {
    assert.fail('CLI result is not JSON: ' + output);
  }
  if (options.failure) {
    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    assert.match(body.error_code, /^[A-Z][A-Z0-9_]+$/);
    assert.equal(typeof body.hint, 'string');
    assert.equal(
      /\bat (?:async )?\w/.test(result.stderr),
      false,
      'ordinary failures do not expose a stack',
    );
  } else {
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(body.code, 200);
  }
  return { ...result, body, data: body.data };
}

async function seed(t, { withGit = false } = {}) {
  const f = await createFixture(t);
  f.secrets = ['private-config-' + randomUUID()];
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  const workspace = await lifecycle.createLocal({
    name: 'CLI recovery workspace',
    requestKey: randomUUID(),
  });
  await files.create(
    workspace.id,
    'main.sh',
    'printf "offline-restored-task\\n"\n',
  );
  const task = await new TaskService(f.store, f.roots, f.leases).create({
    name: 'CLI recovery task',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: workspace.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  const now = new Date().toISOString();
  const asset = (
    await f.store.run(
      'INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES(?,1,?,?)',
      ['CLI private config', now, now],
    )
  ).lastID;
  const key = `asset-${asset}/revisions/1/content`;
  const revision = (
    await f.store.run(
      'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,1,?,?,?,?)',
      [asset, hash(f.secrets[0]), Buffer.byteLength(f.secrets[0]), key, now],
    )
  ).lastID;
  await f.store.run(
    'UPDATE ConfigAssets SET current_revision_id=? WHERE id=?',
    [revision, asset],
  );
  await f.store.run(
    "INSERT INTO TaskConfigBindings(task_id,asset_id,revision_id,target_base,target_path) VALUES(?,?,?,'TASK_CWD','private.conf')",
    [task.task.id, asset, revision],
  );
  const configFile = path.join(f.dataRoot, 'config-assets', key);
  await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(configFile, f.secrets[0], { mode: 0o600 });
  let gitWorkspace, gitCommit;
  if (withGit) {
    const repository = await seedRepository(f);
    gitWorkspace = await lifecycle.createGit({
      name: 'CLI Git source',
      requestKey: randomUUID(),
      repositoryId: repository.id,
      refType: 'branch',
      refName: 'main',
    });
    await files.create(
      gitWorkspace.id,
      'private-untracked.py',
      'print("private working source")\n',
    );
    gitCommit = git(['rev-parse', 'HEAD'], f.roots.path(gitWorkspace));
  }
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  return {
    ...f,
    workspace,
    task,
    key,
    asset,
    revision,
    backup,
    gitWorkspace,
    gitCommit,
  };
}

async function startup(t, f, dataRoot = f.dataRoot, backupRoot = f.backupRoot) {
  const app = await V2Application.launch({
    dataRoot,
    backupRoot,
    projectRoot,
    port: 0,
    background: false,
  });
  f.track(app);
  const system = await fetch(app.origin + '/api/system');
  assert.equal(system.status, 200, 'restored backend is reachable');
  const store = app.services.store;
  const task = (
    await store.all('SELECT * FROM Tasks WHERE id=?', [f.task.task.id])
  )[0];
  assert.equal(task.name, 'CLI recovery task');
  const workspace = await store.workspace(f.workspace.id);
  assert.equal(workspace.name, 'CLI recovery workspace');
  const roots = new WorkspaceRootResolver(dataRoot);
  const owned = await roots.requireOwned(workspace);
  assert.equal(
    await fs.readFile(path.join(owned.root, 'main.sh'), 'utf8'),
    'printf "offline-restored-task\\n"\n',
  );
  assert.equal(
    await fs.readFile(path.join(dataRoot, 'config-assets', f.key), 'utf8'),
    f.secrets[0],
  );
  assert.equal(
    (
      await store.all(
        'SELECT revision_id FROM TaskConfigBindings WHERE task_id=?',
        [f.task.task.id],
      )
    )[0].revision_id,
    f.revision,
  );
  assert.deepEqual(await store.all('PRAGMA foreign_key_check'), []);
  if (f.gitWorkspace) {
    const gitRow = await store.workspace(f.gitWorkspace.id);
    const gitRoot = (await roots.requireOwned(gitRow)).root;
    assert.equal(git(['rev-parse', 'HEAD'], gitRoot), f.gitCommit);
    assert.equal(
      await fs.readFile(path.join(gitRoot, 'private-untracked.py'), 'utf8'),
      'print("private working source")\n',
    );
    assert.match(
      git(['status', '--porcelain=v1'], gitRoot),
      /private-untracked.py/,
    );
    assert.equal(git(['fsck', '--no-dangling'], gitRoot), '');
  }
  return app;
}

async function quarantineDatabase(f, expectedBytes) {
  const base = path.join(f.controlRoot, 'quarantine');
  const entries = await fs.readdir(base);
  assert.equal(
    entries.length,
    1,
    'the original target is preserved as one whole directory',
  );
  assert.deepEqual(
    await fs.readFile(path.join(base, entries[0], 'db/database.sqlite')),
    expectedBytes,
  );
  return path.join(base, entries[0]);
}

test('compiled v2 CLI creates, lists, inspects, verifies and restores a healthy offline snapshot', async (t) => {
  const f = await seed(t);
  await f.store.close();
  const created = await cli(f, ['create']);
  const id = created.data.id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const list = await cli(f, ['list']);
  assert.ok(list.data.some((row) => row.id === id));
  const info = await cli(f, ['info', id]);
  assert.ok(JSON.stringify(info.data).includes(id));
  await cli(f, ['verify', id]);
  const store = await WorkspaceStore.open(f.databasePath, f.dataRoot);
  await new WorkspaceFileService(store, f.roots, f.leases).create(
    f.workspace.id,
    'after-snapshot.sh',
    'printf newer\n',
  );
  await store.close();
  const original = await fs.readFile(f.databasePath);
  await cli(f, ['restore', '--snapshot', id]);
  const status = await cli(f, ['status']);
  assert.ok(JSON.stringify(status.data).includes('COMPLETE'));
  const old = await quarantineDatabase(f, original);
  assert.equal(
    await fs.readFile(
      path.join(old, f.workspace.root_key, 'after-snapshot.sh'),
      'utf8',
    ),
    'printf newer\n',
  );
  await assert.rejects(
    fs.lstat(path.join(f.dataRoot, f.workspace.root_key, 'after-snapshot.sh')),
    { code: 'ENOENT' },
  );
  await startup(t, f);
});

test('SQLite corruption blocks Web startup but compiled CLI restores Workspace, Git, Task and private config from the separate backup root', async (t) => {
  const f = await seed(t, { withGit: true });
  const id = await f.backup.create();
  await f.store.close();
  const corrupt = Buffer.from('deliberately damaged SQLite test database\n');
  await fs.writeFile(f.databasePath, corrupt, { mode: 0o600 });
  await assert.rejects(
    V2Application.launch({
      dataRoot: f.dataRoot,
      backupRoot: f.backupRoot,
      projectRoot,
      port: 0,
      background: false,
    }),
  );
  assert.deepEqual(await fs.readFile(f.databasePath), corrupt);
  assert.ok((await cli(f, ['list'])).data.some((row) => row.id === id));
  await cli(f, ['info', id]);
  await cli(f, ['verify', id]);
  await cli(f, ['restore', '--snapshot', id]);
  await quarantineDatabase(f, corrupt);
  await startup(t, f);
});

test('compiled CLI imports the established encrypted Portable format into a blank data volume and wrong passwords preserve damaged targets', async (t) => {
  const f = await seed(t);
  const id = await f.backup.create();
  const passphrase = 'portable-secret-' + randomUUID();
  const wrong = 'wrong-secret-' + randomUUID();
  f.secrets.push(passphrase, wrong);
  const encrypted = await f.backup.exportPortable(id, Buffer.from(passphrase));
  const encryptedBefore = hash(await fs.readFile(encrypted));
  const passfile = path.join(f.root, 'passphrase');
  const wrongfile = path.join(f.root, 'wrong-passphrase');
  await fs.writeFile(passfile, passphrase + '\n', { mode: 0o600 });
  await fs.writeFile(wrongfile, wrong, { mode: 0o600 });
  await f.store.close();
  const corrupt = Buffer.from(
    'must be preserved after authentication failure\n',
  );
  await fs.writeFile(f.databasePath, corrupt, { mode: 0o600 });
  await cli(
    f,
    ['restore', '--file', encrypted, '--passphrase-file', wrongfile],
    { failure: true },
  );
  assert.deepEqual(await fs.readFile(f.databasePath), corrupt);
  await assert.rejects(fs.lstat(path.join(f.controlRoot, 'quarantine')), {
    code: 'ENOENT',
  });
  const dataRoot = path.join(f.root, 'blank-recovery-data');
  const backupRoot = path.join(f.root, 'independent-import-backups');
  await cli(
    f,
    ['restore', '--file', encrypted, '--passphrase-file', wrongfile],
    { dataRoot, backupRoot, failure: true },
  );
  await assert.rejects(fs.lstat(path.join(dataRoot, 'db/database.sqlite')), {
    code: 'ENOENT',
  });
  await cli(
    f,
    ['restore', '--file', encrypted, '--passphrase-file', passfile],
    { dataRoot, backupRoot },
  );
  assert.equal(hash(await fs.readFile(encrypted)), encryptedBefore);
  await startup(t, f, dataRoot, backupRoot);
});

test('compiled CLI rejects malformed manifests and changed snapshot files before modifying the target', async (t) => {
  const f = await seed(t);
  const id = await f.backup.create();
  const snapshot = await f.backup.snapshot(id);
  await f.store.close();
  const before = hash(await fs.readFile(f.databasePath));
  const manifestPath = path.join(snapshot.root, 'manifest.json');
  const manifest = await fs.readFile(manifestPath);
  await fs.writeFile(manifestPath, '{}\n', { mode: 0o600 });
  await cli(f, ['verify', id], { failure: true });
  await cli(f, ['restore', '--snapshot', id], { failure: true });
  assert.equal(hash(await fs.readFile(f.databasePath)), before);
  await fs.writeFile(manifestPath, manifest, { mode: 0o600 });
  await fs.writeFile(
    path.join(snapshot.root, 'data', f.workspace.root_key, 'main.sh'),
    'tampered snapshot bytes',
    { mode: 0o600 },
  );
  await cli(f, ['verify', id], { failure: true });
  await cli(f, ['restore', '--snapshot', id], { failure: true });
  assert.equal(hash(await fs.readFile(f.databasePath)), before);
  await assert.rejects(
    fs.lstat(path.join(f.controlRoot, 'workspace-restore-journal.json')),
    { code: 'ENOENT' },
  );
});

test('an actual running backend owner prevents compiled CLI restore and offline creation', async (t) => {
  const f = await seed(t);
  const id = await f.backup.create();
  await f.store.close();
  const app = await startup(t, f);
  const before = hash(await fs.readFile(f.databasePath));
  const rejected = await cli(f, ['restore', '--snapshot', id], {
    failure: true,
  });
  assert.equal(rejected.body.error_code, 'RESTORE_BACKEND_ACTIVE');
  const create = await cli(f, ['create'], { failure: true });
  assert.equal(create.body.error_code, 'RESTORE_BACKEND_ACTIVE');
  assert.equal(hash(await fs.readFile(f.databasePath)), before);
  assert.equal((await fetch(app.origin + '/api/system')).status, 200);
});

test('offline restore final-validation failure rolls the old root back and a normal retry preserves the failed candidate', async (t) => {
  const f = await seed(t);
  const id = await f.backup.create();
  await f.store.close();
  const before = await fs.readFile(f.databasePath);
  const {
    OfflineBackupManager,
  } = require('../../static/build/services/backup/offline');
  const manager = new OfflineBackupManager({
    dataRoot: f.dataRoot,
    backupRoot: f.backupRoot,
    fault: async (point) => {
      if (point === 'restore-before-final-validation')
        throw Error('TEST_FINAL_VALIDATION_FAILURE');
    },
  });
  await assert.rejects(manager.restoreSnapshot(id));
  assert.deepEqual(await fs.readFile(f.databasePath), before);
  const status = await cli(f, ['status']);
  assert.ok(JSON.stringify(status.data).includes('ROLLED_BACK'));
  const store = await WorkspaceStore.open(f.databasePath, f.dataRoot);
  try {
    assert.equal(
      (
        await store.all('SELECT name FROM Tasks WHERE id=?', [f.task.task.id])
      )[0].name,
      'CLI recovery task',
    );
  } finally {
    await store.close();
  }
  const failedRoot = status.data.journal.failed_root;
  const failedDatabase = await fs.readFile(
    path.join(failedRoot, 'db/database.sqlite'),
  );
  const retried = await cli(f, ['restore', '--snapshot', id]);
  assert.equal(retried.data.stage, 'COMPLETE');
  assert.deepEqual(
    await fs.readFile(path.join(failedRoot, 'db/database.sqlite')),
    failedDatabase,
    'retry never discards the failed candidate kept for inspection',
  );
  await quarantineDatabase(f, before);
  await startup(t, f);
});

test('compiled recovery resumes the existing journal after SIGKILL following old-root rename, even when that old SQLite is corrupt', async (t) => {
  const f = await seed(t);
  const id = await f.backup.create();
  await f.store.close();
  const corrupt = Buffer.from(
    'corrupt source retained through interrupted offline recovery\n',
  );
  await fs.writeFile(f.databasePath, corrupt, { mode: 0o600 });
  const worker = await processResult([
    path.join(__dirname, 'restore-kill-worker.cjs'),
    f.dataRoot,
    f.backupRoot,
    id,
  ]);
  assert.equal(worker.signal, 'SIGKILL', worker.stdout + worker.stderr);
  assert.match(worker.stdout, /restore-after-old-rename/);
  const status = await cli(f, ['status']);
  assert.ok(JSON.stringify(status.data).includes('PREPARED'));
  await cli(f, ['restore', '--resume']);
  await quarantineDatabase(f, corrupt);
  await startup(t, f);
});
