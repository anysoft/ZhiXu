const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  createFixture,
  seedRepository,
  git,
  insertTaskSource,
} = require('../workspace-v2/fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const {
  WorkspaceRestoreService,
} = require('../../back/services/workspaceV2/restore');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const { OfflineBackupManager } = require('../../back/services/backup/offline');
const {
  WorkspaceGitAdapter,
} = require('../../back/services/gitWorkspaceV2/git');
const {
  WorkspacePreservationService,
} = require('../../back/services/workspaceV2/preservation');
const {
  scanWorkspace,
  hashWorkspaceRecords,
} = require('../../back/services/workspaceV2/inventory');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const projectRoot = path.resolve(__dirname, '../..');

async function createBackupModeFixture(
  t,
  { gitWorkspace = true, changes = true } = {},
) {
  const f = await createFixture(t);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  const local = await lifecycle.createLocal({
    name: 'Mode LOCAL data',
    requestKey: randomUUID(),
  });
  await files.create(
    local.id,
    'local.txt',
    'always preserve complete local workspace\n',
  );
  await files.createDirectory(local.id, 'node_modules');
  await files.create(
    local.id,
    'node_modules/user-local.txt',
    'LOCAL has no Git-derived exclusions\n',
  );
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  if (!gitWorkspace) return { ...f, backup, local, files };
  const repository = await seedRepository(f);
  // A real remote base contains enough incompressible data to prove lightweight
  // snapshots omit both the checked out copy and its complete Git object store.
  const large = randomBytes(2 * 1024 * 1024);
  await fs.writeFile(path.join(repository.source, 'base-large.bin'), large);
  await fs.writeFile(
    path.join(repository.source, '.gitignore'),
    'node_modules/\nuser-state/\n',
  );
  await fs.writeFile(
    path.join(repository.source, 'delete-me.txt'),
    'tracked deletion\n',
  );
  await fs.writeFile(
    path.join(repository.source, 'executable.sh'),
    '#!/bin/sh\necho original\n',
  );
  await fs.chmod(path.join(repository.source, 'executable.sh'), 0o755);
  await fs.writeFile(
    path.join(repository.source, 'binary.bin'),
    Buffer.from([0, 1, 2, 3, 0, 4]),
  );
  git(['add', '--all'], repository.source);
  git(['commit', '-m', 'remote base for backup modes'], repository.source);
  const baseline = git(['rev-parse', 'HEAD'], repository.source);
  const remote = pathToFileURL(repository.source).href;
  await f.store.run(
    'UPDATE Repositories SET remote_url=?,normalized_url=? WHERE id=?',
    [remote, remote, repository.id],
  );
  const initial = await fs.lstat(repository.source);
  let accessCalls = 0;
  const accessResolver = async (row) => {
    accessCalls++;
    assert.equal(fileURLToPath(row.remote_url), repository.source);
    const current = await fs.lstat(repository.source);
    assert.equal(current.dev, initial.dev);
    assert.equal(current.ino, initial.ino);
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    return {
      remote: row.remote_url,
      directory: repository.source,
      secrets: [],
      cleanup: async () => {},
      env: {
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    };
  };
  const adapter = new WorkspaceGitAdapter(f.store, f.roots, { accessResolver });
  await f.leases.withRepository(
    repository.id,
    'BACKUP_MODES_FIXTURE_FETCH',
    (lease) => adapter.fetch(repository.id, lease),
  );
  const workspace = await lifecycle.createGit({
    name: 'Mode Git workspace',
    requestKey: randomUUID(),
    repositoryId: repository.id,
    refType: 'branch',
    refName: 'main',
  });
  const workspaceRoot = f.roots.path(workspace);
  let localCommit = baseline,
    sideCommit;
  if (changes) {
    await fs.writeFile(
      path.join(workspaceRoot, 'local-only.txt'),
      'unpushed code must travel in the bundle\n',
    );
    git(['add', 'local-only.txt'], workspaceRoot);
    git(
      ['commit', '-m', 'unpublished private workspace commit'],
      workspaceRoot,
    );
    localCommit = git(['rev-parse', 'HEAD'], workspaceRoot);
    git(['checkout', '-b', 'local-side', baseline], workspaceRoot);
    await fs.writeFile(
      path.join(workspaceRoot, 'side-only.txt'),
      'unpublished code on another local branch\n',
    );
    git(['add', 'side-only.txt'], workspaceRoot);
    git(['commit', '-m', 'another unpublished local branch'], workspaceRoot);
    sideCommit = git(['rev-parse', 'HEAD'], workspaceRoot);
    git(['tag', 'local-unpublished-tag', sideCommit], workspaceRoot);
    git(['checkout', `ws-${workspace.id}`], workspaceRoot);
    await fs.writeFile(
      path.join(workspaceRoot, 'main.py'),
      'print("staged version")\n',
    );
    git(['add', 'main.py'], workspaceRoot);
    await fs.writeFile(
      path.join(workspaceRoot, 'main.py'),
      'print("final unstaged version")\n',
    );
    await fs.writeFile(
      path.join(workspaceRoot, 'binary.bin'),
      Buffer.from([0, 5, 255, 9, 0, 12, 0, 3]),
    );
    git(['rm', 'delete-me.txt'], workspaceRoot);
    await fs.chmod(path.join(workspaceRoot, 'executable.sh'), 0o644);
    await fs.mkdir(path.join(workspaceRoot, 'untracked'), { mode: 0o700 });
    await fs.writeFile(
      path.join(workspaceRoot, 'untracked/user.py'),
      'print("untracked source")\n',
      { mode: 0o600 },
    );
  }
  await fs.mkdir(path.join(workspaceRoot, 'node_modules'), { mode: 0o700 });
  await fs.writeFile(
    path.join(workspaceRoot, 'node_modules/rebuildable-cache.bin'),
    randomBytes(256 * 1024),
  );
  await fs.mkdir(path.join(workspaceRoot, 'user-state'), { mode: 0o700 });
  await fs.writeFile(
    path.join(workspaceRoot, 'user-state/persistent.json'),
    '{"persist":true}\n',
    { mode: 0o600 },
  );
  const inventory = await scanWorkspace(workspaceRoot, 'GIT');
  await f.leases.withWorkspace(
    workspace.id,
    'BACKUP_MODES_FIXTURE_INVENTORY',
    async () => {
      const current = await f.store.workspace(workspace.id);
      await f.store.updateInventory(
        current.id,
        current.content_revision,
        inventory,
      );
    },
  );
  const taskId = await insertTaskSource(f.store, workspace.id);
  const staged = git(['show', ':main.py'], workspaceRoot);
  const indexTree = git(['write-tree'], workspaceRoot);
  return {
    ...f,
    backup,
    local,
    files,
    repository,
    remote,
    baseline,
    workspace,
    workspaceRoot,
    localCommit,
    sideCommit,
    taskId,
    inventory,
    staged,
    indexTree,
    accessResolver,
    accessCalls: () => accessCalls,
  };
}

async function restoreBackupModeSnapshot(
  f,
  id,
  target = path.join(f.root, 'target-' + randomUUID()),
) {
  const backup = WorkspaceBackupService.forOfflineCatalog(target, f.backupRoot);
  const restore = new WorkspaceRestoreService(backup, {
    lightweightGit: { accessResolver: f.accessResolver },
  });
  const store = f.track(await restore.restoreOffline(id));
  return { target, store, restore, roots: new WorkspaceRootResolver(target) };
}

async function assertBackupModeWorkspace(
  f,
  restored,
  { lightweight = false } = {},
) {
  const local = await restored.store.workspace(f.local.id);
  const localRoot = (await restored.roots.requireOwned(local)).root;
  assert.equal(
    await fs.readFile(path.join(localRoot, 'local.txt'), 'utf8'),
    'always preserve complete local workspace\n',
  );
  assert.equal(
    await fs.readFile(
      path.join(localRoot, 'node_modules/user-local.txt'),
      'utf8',
    ),
    'LOCAL has no Git-derived exclusions\n',
  );
  if (!f.workspace) return;
  const row = await restored.store.workspace(f.workspace.id);
  const root = (await restored.roots.requireOwned(row)).root;
  assert.equal(git(['rev-parse', 'HEAD'], root), f.localCommit);
  assert.equal(git(['rev-parse', 'refs/heads/local-side'], root), f.sideCommit);
  assert.equal(
    git(['rev-parse', 'refs/tags/local-unpublished-tag'], root),
    f.sideCommit,
  );
  assert.equal(
    git(['show', f.sideCommit + ':side-only.txt'], root),
    'unpublished code on another local branch',
  );
  assert.equal(
    git(['show', ':main.py'], root),
    f.staged,
    'staging state survives separately from final working bytes',
  );
  assert.equal(git(['write-tree'], root), f.indexTree);
  assert.equal(
    await fs.readFile(path.join(root, 'main.py'), 'utf8'),
    'print("final unstaged version")\n',
  );
  assert.deepEqual(
    await fs.readFile(path.join(root, 'binary.bin')),
    Buffer.from([0, 5, 255, 9, 0, 12, 0, 3]),
  );
  assert.equal(
    await fs.readFile(path.join(root, 'local-only.txt'), 'utf8'),
    'unpushed code must travel in the bundle\n',
  );
  assert.equal(
    await fs.readFile(path.join(root, 'untracked/user.py'), 'utf8'),
    'print("untracked source")\n',
  );
  assert.equal(
    (await fs.stat(path.join(root, 'executable.sh'))).mode & 0o777,
    0o644,
  );
  await assert.rejects(fs.lstat(path.join(root, 'delete-me.txt')), {
    code: 'ENOENT',
  });
  assert.equal(
    await fs.readFile(path.join(root, 'user-state/persistent.json'), 'utf8'),
    '{"persist":true}\n',
  );
  if (lightweight)
    await assert.rejects(
      fs.lstat(path.join(root, 'node_modules/rebuildable-cache.bin')),
      { code: 'ENOENT' },
    );
  else
    assert.ok(
      (await fs.stat(path.join(root, 'node_modules/rebuildable-cache.bin')))
        .size > 0,
    );
  const actual = await scanWorkspace(root, 'GIT');
  const expectedEntries = f.inventory.entries.filter(
    (entry) =>
      !lightweight ||
      (entry.path !== 'node_modules' &&
        !entry.path.startsWith('node_modules/')),
  );
  assert.equal(actual.hash, hashWorkspaceRecords(expectedEntries));
  assert.equal(row.content_inventory_hash, actual.hash);
  assert.equal(
    (
      await restored.store.all(
        'SELECT workspace_id FROM TaskSources WHERE task_id=?',
        [f.taskId],
      )
    )[0].workspace_id,
    f.workspace.id,
  );
  assert.deepEqual(await restored.store.all('PRAGMA foreign_key_check'), []);
}

async function rewriteManifest(root, change) {
  const file = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  change(manifest);
  const encoded = JSON.stringify(manifest) + '\n';
  await fs.writeFile(file, encoded, { mode: 0o600 });
  await fs.writeFile(
    path.join(root, 'READY'),
    JSON.stringify({ manifest_sha256: digest(encoded) }) + '\n',
    { mode: 0o600 },
  );
}

test('FULL restores local Git objects and user data without the remote; historical v2 manifests remain readable', async (t) => {
  const f = await createBackupModeFixture(t);
  const full = await f.backup.create(600000, 'FULL');
  const historical = await f.backup.create();
  const fullSnapshot = await f.backup.snapshot(full);
  assert.equal(fullSnapshot.manifest.backup_mode, 'FULL');
  assert.equal(fullSnapshot.manifest.format_version, 2);
  const oldRoot = (await f.backup.snapshot(historical)).root;
  await rewriteManifest(oldRoot, (manifest) => {
    delete manifest.backup_mode;
  });
  assert.equal(
    (await f.backup.snapshot(historical)).manifest.backup_mode ?? 'FULL',
    'FULL',
  );
  await fs.rename(f.repository.source, f.repository.source + '-offline');
  await assertBackupModeWorkspace(f, await restoreBackupModeSnapshot(f, full));
  await assertBackupModeWorkspace(
    f,
    await restoreBackupModeSnapshot(f, historical),
  );
});

test('LIGHTWEIGHT stores Git deltas and reconstructs exact unpublished HEAD, staging, binary changes and persistent untracked data', async (t) => {
  const f = await createBackupModeFixture(t);
  const full = await f.backup.create(600000, 'FULL');
  const light = await f.backup.create(600000, 'LIGHTWEIGHT');
  const fullSnapshot = await f.backup.snapshot(full);
  const snapshot = await f.backup.snapshot(light);
  assert.equal(snapshot.manifest.backup_mode, 'LIGHTWEIGHT');
  assert.equal(snapshot.manifest.format_version, 3);
  assert.ok(
    snapshot.manifest.total_bytes < fullSnapshot.manifest.total_bytes / 2,
    'light snapshot omits duplicate committed tree and full object database',
  );
  await assert.rejects(fs.lstat(path.join(snapshot.root, 'data', 'git')), {
    code: 'ENOENT',
  });
  await assert.rejects(
    fs.lstat(
      path.join(snapshot.root, 'data', f.workspace.root_key, 'base-large.bin'),
    ),
    { code: 'ENOENT' },
  );
  assert.equal(
    await fs.readFile(
      path.join(snapshot.root, 'data', f.local.root_key, 'local.txt'),
      'utf8',
    ),
    'always preserve complete local workspace\n',
  );
  // Advance the remote after the snapshot. Restore must use the saved exact SHA,
  // not the new remote branch HEAD, and must import the unpublished local child.
  await fs.writeFile(
    path.join(f.repository.source, 'main.py'),
    'print("new remote HEAD must not replace saved user code")\n',
  );
  git(['add', 'main.py'], f.repository.source);
  git(
    ['commit', '-m', 'remote advanced after lightweight snapshot'],
    f.repository.source,
  );
  const remoteAfter = git(['rev-parse', 'HEAD'], f.repository.source);
  assert.notEqual(remoteAfter, f.localCommit);
  const calls = f.accessCalls();
  await assertBackupModeWorkspace(
    f,
    await restoreBackupModeSnapshot(f, light),
    { lightweight: true },
  );
  assert.ok(
    f.accessCalls() > calls,
    'restore uses the actual Git access chain',
  );
  assert.equal(
    git(['rev-parse', 'HEAD'], f.repository.source),
    remoteAfter,
    'restoring a backup must not update the remote repository',
  );
});

test('LIGHTWEIGHT remote failure remains before publication and preserves the original data root', async (t) => {
  const f = await createBackupModeFixture(t);
  const id = await f.backup.create(600000, 'LIGHTWEIGHT');
  await f.store.close();
  const before = await fs.readFile(f.databasePath);
  const rootIdentity = await fs.lstat(f.dataRoot);
  const originalCode = await fs.readFile(path.join(f.workspaceRoot, 'main.py'));
  await fs.rename(f.repository.source, f.repository.source + '-offline');
  const backup = WorkspaceBackupService.forOfflineCatalog(
    f.dataRoot,
    f.backupRoot,
  );
  const restore = new WorkspaceRestoreService(backup, {
    lightweightGit: { accessResolver: f.accessResolver },
  });
  await assert.rejects(restore.restoreOffline(id), (error) => {
    assert.match(error.error_code || error.code, /LIGHTWEIGHT|REMOTE|GIT/);
    return true;
  });
  assert.deepEqual(await fs.readFile(f.databasePath), before);
  assert.deepEqual(
    await fs.readFile(path.join(f.workspaceRoot, 'main.py')),
    originalCode,
  );
  assert.equal((await fs.lstat(f.dataRoot)).ino, rootIdentity.ino);
  const status = await restore.status();
  assert.ok(
    status &&
      !['OLD_ROOT_MOVED', 'CANDIDATE_PUBLISHED', 'COMPLETE'].includes(
        status.stage,
      ),
  );
  await assert.rejects(fs.lstat(status.old_root), { code: 'ENOENT' });
  // Resume through the same offline manager used by CLI restore --resume.
  // Restoring access must rebuild/validate before publishing this saved journal.
  await fs.rename(f.repository.source + '-offline', f.repository.source);
  const resumed = await new OfflineBackupManager({
    dataRoot: f.dataRoot,
    backupRoot: f.backupRoot,
    projectRoot,
    lightweightGit: { accessResolver: f.accessResolver },
  }).resume();
  assert.equal(resumed.stage, 'COMPLETE');
  assert.equal(resumed.operation_id, status.operation_id);
  assert.equal(resumed.old_root, status.old_root);
  assert.deepEqual(
    await fs.readFile(path.join(resumed.old_root, 'db/database.sqlite')),
    before,
    'resume preserves the original SQLite bytes in quarantine',
  );
  assert.deepEqual(
    await fs.readFile(
      path.join(resumed.old_root, f.workspace.root_key, 'main.py'),
    ),
    originalCode,
    'resume preserves the original working tree bytes in quarantine',
  );
  const restoredStore = f.track(
    await WorkspaceStore.open(f.databasePath, f.dataRoot),
  );
  await assertBackupModeWorkspace(
    f,
    {
      target: f.dataRoot,
      store: restoredStore,
      roots: new WorkspaceRootResolver(f.dataRoot),
    },
    { lightweight: true },
  );
});

test('LIGHTWEIGHT verifies bundle payload hashes before restore and leaves original data untouched when a delta is damaged', async (t) => {
  const f = await createBackupModeFixture(t);
  const id = await f.backup.create(600000, 'LIGHTWEIGHT');
  const snapshot = await f.backup.snapshot(id);
  const bundle = snapshot.manifest.lightweight_git.repositories[0].bundle;
  assert.equal(
    typeof bundle,
    'string',
    'unpublished commits require real bundle bytes',
  );
  await fs.appendFile(
    path.join(snapshot.root, 'data/tmp/backup-lightweight', bundle),
    'damaged bundle bytes',
  );
  await assert.rejects(f.backup.snapshot(id), {
    error_code: 'BACKUP_CHECKSUM_FAILED',
  });
  await f.store.close();
  const originalDatabase = await fs.readFile(f.databasePath);
  const originalCode = await fs.readFile(path.join(f.workspaceRoot, 'main.py'));
  const catalog = WorkspaceBackupService.forOfflineCatalog(
    f.dataRoot,
    f.backupRoot,
  );
  await assert.rejects(
    new WorkspaceRestoreService(catalog, {
      lightweightGit: { accessResolver: f.accessResolver },
    }).restoreOffline(id),
    { error_code: 'BACKUP_CHECKSUM_FAILED' },
  );
  assert.deepEqual(await fs.readFile(f.databasePath), originalDatabase);
  assert.deepEqual(
    await fs.readFile(path.join(f.workspaceRoot, 'main.py')),
    originalCode,
  );
  await assert.rejects(
    fs.lstat(path.join(f.controlRoot, 'workspace-restore-journal.json')),
    { code: 'ENOENT' },
  );
});

test('Portable envelope remains compatible with FULL and LIGHTWEIGHT while LOCAL data stays complete', async (t) => {
  const f = await createBackupModeFixture(t);
  for (const mode of ['FULL', 'LIGHTWEIGHT']) {
    const id = await f.backup.create(600000, mode);
    const phrase = Buffer.from('portable-mode-' + randomUUID());
    const file = await f.backup.exportPortable(id, Buffer.from(phrase));
    assert.equal(
      (await fs.readFile(file)).subarray(0, 8).toString(),
      'PLATBKP1',
    );
    const imported = await f.backup.importPortable(file, Buffer.from(phrase));
    const target = path.join(f.root, 'portable-' + mode);
    const catalog = WorkspaceBackupService.forOfflineCatalog(
      target,
      f.backupRoot,
    );
    const restore = new WorkspaceRestoreService(catalog, {
      lightweightGit: { accessResolver: f.accessResolver },
    });
    const store = f.track(await restore.restoreOffline(imported.id, 'imports'));
    await assertBackupModeWorkspace(
      f,
      { target, store, restore, roots: new WorkspaceRootResolver(target) },
      { lightweight: mode === 'LIGHTWEIGHT' },
    );
    phrase.fill(0);
  }
});

test('LIGHTWEIGHT cannot substitute for durable FULL Workspace preservation while existing held snapshots stay embedded', async (t) => {
  const f = await createBackupModeFixture(t);
  const id = await f.backup.create(600000, 'FULL');
  const preservation = new WorkspacePreservationService(f.backup);
  await preservation.withCatalogLock(async () => {
    const row = await f.store.workspace(f.workspace.id);
    const proof = await preservation.verifyPreservation(id, row);
    await f.store.transaction((tx) => preservation.installHold(proof, tx));
  });
  await assert.rejects(f.backup.delete(id), {
    error_code: 'WORKSPACE_PRESERVATION_REQUIRED',
  });
  const lightweight = await f.backup.create(600000, 'LIGHTWEIGHT');
  const snapshot = await f.backup.snapshot(lightweight);
  assert.ok(
    snapshot.manifest.preserved_snapshots.some((item) => item.backup_id === id),
  );
  await assert.rejects(
    preservation.verifyPreservation(
      lightweight,
      await f.store.workspace(f.workspace.id),
    ),
    (error) => {
      assert.match(error.error_code || error.code, /PRESERVATION|FULL/);
      return true;
    },
  );
  await assert.rejects(f.backup.delete(id), {
    error_code: 'WORKSPACE_PRESERVATION_REQUIRED',
  });
});

test('FULL reports unavailable LFS/submodule data and LIGHTWEIGHT explicitly rejects those external Git requirements', async (t) => {
  for (const kind of ['LFS', 'SUBMODULE']) {
    const f = await createBackupModeFixture(t, { changes: false });
    if (kind === 'LFS') {
      await fs.writeFile(
        path.join(f.workspaceRoot, '.gitattributes'),
        '*.lfs filter=lfs diff=lfs merge=lfs -text\n',
      );
      await fs.writeFile(
        path.join(f.workspaceRoot, 'missing-object.lfs'),
        'version https://git-lfs.github.com/spec/v1\noid sha256:' +
          'a'.repeat(64) +
          '\nsize 12345\n',
      );
      git(['add', '.gitattributes', 'missing-object.lfs'], f.workspaceRoot);
    } else {
      await fs.writeFile(
        path.join(f.workspaceRoot, '.gitmodules'),
        '[submodule "external"]\n\tpath = external\n\turl = https://example.invalid/absent-submodule.git\n',
      );
      git(['add', '.gitmodules'], f.workspaceRoot);
      git(
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${f.baseline},external`,
        ],
        f.workspaceRoot,
      );
    }
    git(['commit', '-m', 'unavailable external Git fixture'], f.workspaceRoot);
    const current = await f.store.workspace(f.workspace.id);
    await f.store.updateInventory(
      current.id,
      current.content_revision,
      await scanWorkspace(f.workspaceRoot, 'GIT'),
    );
    const full = await f.backup.create(600000, 'FULL');
    const manifest = (await f.backup.snapshot(full)).manifest;
    assert.ok(
      manifest.warnings?.some((warning) => warning.includes(kind)),
      'FULL must disclose external data unavailable in its local payload',
    );
    await assert.rejects(f.backup.create(600000, 'LIGHTWEIGHT'), (error) => {
      assert.match(error.error_code || error.code, /LFS|SUBMODULE|EXTERNAL/);
      return true;
    });
  }
});

async function runCompiledCli(
  f,
  args,
  { dataRoot = f.dataRoot, backupRoot = f.backupRoot } = {},
) {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  const child = spawn(
    process.execPath,
    [
      path.join(projectRoot, 'static/build/backupCliV2.js'),
      '--data-root',
      dataRoot,
      '--backup-root',
      backupRoot,
      ...args,
    ],
    { cwd: projectRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, stderr || stdout);
    return JSON.parse(stdout.trim().split('\n').at(-1)).data;
  } finally {
    clearTimeout(timer);
  }
}

test('production v2 CLI creates, recognizes, verifies and restores both modes with the original FULL default', async (t) => {
  const f = await createBackupModeFixture(t, { gitWorkspace: false });
  await f.store.close();
  for (const mode of [undefined, 'full', 'lightweight']) {
    const created = await runCompiledCli(f, [
      'create',
      ...(mode ? ['--mode', mode] : []),
    ]);
    const info = await runCompiledCli(f, ['info', created.id]);
    assert.equal(
      info.manifest.backup_mode ?? 'FULL',
      mode === 'lightweight' ? 'LIGHTWEIGHT' : 'FULL',
    );
    await runCompiledCli(f, ['verify', created.id]);
    const target = path.join(f.root, 'cli-target-' + (mode || 'default'));
    const restored = await runCompiledCli(
      f,
      ['restore', '--snapshot', created.id],
      { dataRoot: target },
    );
    assert.equal(restored.stage, 'COMPLETE');
    const catalog = WorkspaceBackupService.forOfflineCatalog(
      target,
      f.backupRoot,
    );
    const store = f.track(await new WorkspaceRestoreService(catalog).recover());
    await assertBackupModeWorkspace(f, {
      target,
      store,
      roots: new WorkspaceRootResolver(target),
    });
  }
});
