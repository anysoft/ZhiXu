const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  createFixture,
  createDatabase,
  seedRepository,
  git,
  insertTaskSource,
} = require('./fixture.cjs');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../back/services/workspaceV2/lease');
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
  WorkspacePreservationService,
} = require('../../back/services/workspaceV2/preservation');
const {
  WorkspaceRestoreService,
} = require('../../back/services/workspaceV2/restore');
const {
  WorkspaceReclaimService,
} = require('../../back/services/workspaceV2/reclaim');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');
const { scanWorkspace } = require('../../back/services/workspaceV2/inventory');

function services(f, options) {
  return {
    lifecycle: new WorkspaceLifecycleService(f.store, f.roots, f.leases),
    files: new WorkspaceFileService(f.store, f.roots, f.leases),
    backup: new WorkspaceBackupService(
      f.store,
      f.roots,
      f.leases,
      f.backupRoot,
      options,
    ),
  };
}
async function local(f, withReference = true) {
  const s = services(f);
  const row = await s.lifecycle.createLocal({
    name: 'local source',
    requestKey: 'backup-local',
  });
  await s.files.create(row.id, 'main.py', 'print("preserved local bytes")\n');
  await s.files.createDirectory(row.id, 'nested');
  await s.files.create(row.id, 'nested/second.py', 'print("second")\n');
  if (withReference) await insertTaskSource(f.store, row.id);
  return { ...s, row: await f.store.workspace(row.id) };
}
async function target(f, name = 'restored-data') {
  const dataRoot = path.join(f.root, name);
  const databasePath = await createDatabase(dataRoot);
  const store = f.track(await WorkspaceStore.open(databasePath, dataRoot));
  await fs.mkdir(dataRoot + '.platform-control', { mode: 0o700 });
  const roots = new WorkspaceRootResolver(dataRoot);
  const barrier = new PlatformBackupBarrier(dataRoot + '.platform-control');
  const leases = new WorkspaceLeaseService(dataRoot, barrier);
  return {
    store,
    roots,
    leases,
    dataRoot,
    databasePath,
    backupRoot: f.backupRoot,
  };
}

test('real LOCAL source backup, destroy root A, restore root B preserves DB/file identity and rotates physical owner', async (t) => {
  const f = await createFixture(t);
  const { row, backup } = await local(f);
  const id = await backup.create();
  const snapshot = await backup.snapshot(id);
  assert.equal(
    snapshot.manifest.workspaces[0].source_references[0].availability,
    'PRESENT',
  );
  const b = await target(f);
  await f.store.close();
  await fs.rm(f.dataRoot, { recursive: true });
  const restored = f.track(
    await new WorkspaceRestoreService(services(b).backup).restore(id),
  );
  const after = await restored.workspace(row.id);
  assert.equal(after.id, row.id);
  assert.equal(after.content_revision, row.content_revision);
  assert.equal(after.content_inventory_hash, row.content_inventory_hash);
  assert.equal(after.root_owner_token, row.root_owner_token);
  assert.notEqual(after.root_inode, row.root_inode);
  const owner = await new WorkspaceRootResolver(b.dataRoot).requireOwned(after);
  assert.equal(
    await fs.readFile(path.join(owner.root, 'main.py'), 'utf8'),
    'print("preserved local bytes")\n',
  );
  assert.equal(
    (await scanWorkspace(owner.root, 'LOCAL')).hash,
    row.content_inventory_hash,
  );
  assert.equal(
    (await restored.all('SELECT relative_entrypoint FROM TaskSources'))[0]
      .relative_entrypoint,
    'main.py',
  );
  assert.equal((await restored.all('PRAGMA foreign_key_check')).length, 0);
});

test('verified READY preservation installs real hold, rejects forged and stale proof, prevents GC', async (t) => {
  const f = await createFixture(t);
  const { row, backup, files } = await local(f);
  const id = await backup.create();
  const preservation = new WorkspacePreservationService(backup);
  await preservation.withCatalogLock(async () => {
    const proof = await preservation.verifyPreservation(id, row);
    await assert.rejects(
      preservation.installHold({ ...proof, manifest_hash: '0'.repeat(64) }),
      { error_code: 'WORKSPACE_PRESERVATION_REQUIRED' },
    );
    await f.store.transaction((tx) => preservation.installHold(proof, tx));
  });
  await assert.rejects(backup.delete(id), {
    error_code: 'WORKSPACE_PRESERVATION_REQUIRED',
  });
  assert.equal((await preservation.usage()).active_holds, 1);
  await files.create(row.id, 'later.py', 'new bytes');
  await assert.rejects(
    preservation.verifyPreservation(id, await f.store.workspace(row.id)),
    { error_code: 'WORKSPACE_PRESERVATION_REQUIRED' },
  );
});

test('actual catalog FD serializes verified preservation hold installation against concurrent snapshot deletion', async (t) => {
  const f = await createFixture(t);
  const { row, backup } = await local(f);
  const id = await backup.create();
  const preservation = new WorkspacePreservationService(backup);
  let release, verified;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    verified = resolve;
  });
  const hold = preservation.withCatalogLock(async () => {
    const proof = await preservation.verifyPreservation(id, row);
    verified();
    await gate;
    return f.store.transaction((tx) => preservation.installHold(proof, tx));
  });
  await ready;
  try {
    await assert.rejects(backup.delete(id), { error_code: 'BACKUP_BUSY' });
    assert.equal((await backup.snapshot(id)).manifest.backup_id, id);
  } finally {
    release();
  }
  await hold;
  assert.equal(
    (
      await f.store.all(
        'SELECT snapshot_key FROM WorkspacePreservationHolds WHERE released_at IS NULL',
      )
    )[0].snapshot_key,
    id,
  );
  await assert.rejects(backup.delete(id), {
    error_code: 'WORKSPACE_PRESERVATION_REQUIRED',
  });
  assert.equal((await backup.snapshot(id)).manifest.backup_id, id);
});

test('portable encrypted archive authenticates before extraction and validates full imported domain', async (t) => {
  const f = await createFixture(t);
  const { backup } = await local(f);
  const id = await backup.create();
  const exportKey = Buffer.from('correct portable secret');
  const encrypted = await backup.exportPortable(id, exportKey);
  assert.ok(exportKey.every((byte) => byte === 0));
  const wrongKey = Buffer.from('wrong portable secret');
  await assert.rejects(backup.importPortable(encrypted, wrongKey));
  assert.ok(wrongKey.every((byte) => byte === 0));
  assert.deepEqual(await fs.readdir(path.join(f.backupRoot, 'imports')), []);
  const imported = await backup.importPortable(
    encrypted,
    Buffer.from('correct portable secret'),
  );
  assert.equal(imported.snapshot_id, id);
  assert.equal(
    (await backup.validateRoot(imported.root)).workspaces[0].workspace_type,
    'LOCAL',
  );
  assert.deepEqual(await fs.readdir(path.dirname(imported.root)), [
    '.owner.json',
    'snapshot',
  ]);
});

test('config revision key, size and checksum require actual private content; secret bytes survive encrypted portable restore', async (t) => {
  const f = await createFixture(t);
  const { row, backup } = await local(f);
  const secret = 'S1A_PRIVATE_CONFIG_DO_NOT_EXPOSE_a7235e';
  const checksum = createHash('sha256').update(secret).digest('hex');
  const now = new Date().toISOString();
  const asset = (
    await f.store.run(
      'INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES(?,1,?,?)',
      ['private source config', now, now],
    )
  ).lastID;
  const key = `asset-${asset}/revisions/1/content`;
  const revision = (
    await f.store.run(
      'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,1,?,?,?,?)',
      [asset, checksum, Buffer.byteLength(secret), key, now],
    )
  ).lastID;
  await f.store.run(
    'UPDATE ConfigAssets SET current_revision_id=? WHERE id=?',
    [revision, asset],
  );
  await f.store.run(
    "INSERT INTO WorkspaceConfigBindings(workspace_id,asset_id,revision_id,target_base,target_path) VALUES(?,?,?,'WORKSPACE_ROOT','config/private.txt')",
    [row.id, asset, revision],
  );
  const task = (await f.store.all('SELECT id FROM Tasks'))[0].id;
  await f.store.run(
    "INSERT INTO TaskConfigBindings(task_id,asset_id,revision_id,target_base,target_path) VALUES(?,?,?,'TASK_CWD','task-private.txt')",
    [task, asset, revision],
  );
  const profile = (
    await f.store.run(
      "INSERT INTO EnvironmentProfiles(workspace_id,name) VALUES(?,'private profile')",
      [row.id],
    )
  ).lastID;
  await f.store.run(
    "INSERT INTO WorkspaceProfileVariables(profile_id,name,value,operation,is_secret) VALUES(?,'PRIVATE_SET',?,'SET',1)",
    [profile, secret],
  );
  await f.store.run(
    "INSERT INTO WorkspaceProfileVariables(profile_id,name,value,operation) VALUES(?,'PRIVATE_UNSET',NULL,'UNSET')",
    [profile],
  );
  await f.store.run(
    "INSERT INTO TaskEnvVariables(task_id,name,value,operation,is_secret,createdAt,updatedAt) VALUES(?,'TASK_PRIVATE',?,'SET',1,?,?)",
    [task, secret, now, now],
  );
  await assert.rejects(backup.create(), {
    error_code: 'BACKUP_CONFIG_INTEGRITY_FAILED',
  });
  const file = path.join(f.dataRoot, 'config-assets', key);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, 'corrupt bytes', { mode: 0o600 });
  await assert.rejects(backup.create(), {
    error_code: 'BACKUP_CONFIG_INTEGRITY_FAILED',
  });
  await fs.writeFile(file, secret, { mode: 0o600 });
  const id = await backup.create();
  const manifest = (await backup.snapshot(id)).manifest;
  assert.equal(JSON.stringify(manifest).includes(secret), false);
  assert.equal(
    manifest.workspaces[0].environment_config_references.config_bindings[0]
      .revision_id,
    revision,
  );
  const encrypted = await backup.exportPortable(
    id,
    Buffer.from('private config portable key'),
  );
  assert.equal(
    (await fs.readFile(encrypted)).includes(Buffer.from(secret)),
    false,
  );
  const imported = await backup.importPortable(
    encrypted,
    Buffer.from('private config portable key'),
  );
  const b = await target(f);
  const restored = f.track(
    await new WorkspaceRestoreService(services(b).backup).restore(
      imported.id,
      'imports',
    ),
  );
  assert.equal(
    await fs.readFile(path.join(b.dataRoot, 'config-assets', key), 'utf8'),
    secret,
  );
  assert.equal(
    (
      await restored.all(
        'SELECT value FROM WorkspaceProfileVariables WHERE name=?',
        ['PRIVATE_SET'],
      )
    )[0].value,
    secret,
  );
});

test('portable export/import enforce aggregate retained capacity before allocation and preserve existing assets', async (t) => {
  const f = await createFixture(t);
  const { backup } = await local(f);
  const id = await backup.create();
  const snapshot = await backup.snapshot(id);
  const before = await fs.readFile(path.join(snapshot.root, 'manifest.json'));
  const encrypted = await backup.exportPortable(
    id,
    Buffer.from('quota portable key'),
  );
  const encryptedBefore = await fs.readFile(encrypted);
  const limited = services(f, { limits: { backupRetainedBytes: 1 } }).backup;
  const exportKey = Buffer.from('quota portable key');
  await assert.rejects(limited.exportPortable(id, exportKey), {
    error_code: 'BACKUP_QUOTA_EXCEEDED',
  });
  assert.ok(exportKey.every((byte) => byte === 0));
  const importKey = Buffer.from('quota portable key');
  await assert.rejects(limited.importPortable(encrypted, importKey), {
    error_code: 'BACKUP_QUOTA_EXCEEDED',
  });
  assert.ok(importKey.every((byte) => byte === 0));
  assert.deepEqual(await fs.readdir(path.join(f.backupRoot, 'imports')), []);
  assert.deepEqual(
    await fs.readFile(path.join(snapshot.root, 'manifest.json')),
    before,
  );
  assert.deepEqual(await fs.readFile(encrypted), encryptedBefore);
});

test('missing source, forged ownership, active journal and finite backup budget fail closed', async (t) => {
  const f = await createFixture(t);
  const { row, backup } = await local(f);
  const file = path.join(f.roots.path(row), 'main.py');
  const bytes = await fs.readFile(file);
  const mode = (await fs.stat(file)).mode & 0o777;
  await fs.unlink(file);
  await assert.rejects(backup.create());
  await fs.writeFile(file, bytes, { mode });
  const tiny = services(f, { limits: { backupSnapshotBytes: 1 } }).backup;
  await assert.rejects(tiny.create(), { error_code: 'BACKUP_QUOTA_EXCEEDED' });
  await fs.mkdir(path.join(f.dataRoot, 'tmp/workspace-v2'), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    path.join(f.dataRoot, 'tmp/workspace-v2', 'unknown-operation.json'),
    '{}',
    { mode: 0o600 },
  );
  await assert.rejects(backup.create(), /BACKUP_RECOVERY_REQUIRED/);
  await fs.unlink(
    path.join(f.dataRoot, 'tmp/workspace-v2', 'unknown-operation.json'),
  );
  const marker = path.join(f.roots.path(row), '.platform-workspace-owner.json');
  const original = await fs.readFile(marker);
  const forged = JSON.parse(original);
  forged.owner_token = 'forged';
  await fs.writeFile(marker, JSON.stringify(forged), { mode: 0o600 });
  await assert.rejects(backup.create());
  await fs.writeFile(marker, original, { mode: 0o600 });
  const id = await backup.create();
  const { root } = await backup.snapshot(id);
  await fs.unlink(path.join(root, 'data', row.root_key, 'main.py'));
  await assert.rejects(backup.snapshot(id));
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('real GIT dirty/untracked/private branch and worktree administration survive source destruction and cross-root repair', async (t) => {
  const f = await createFixture(t);
  const repository = await seedRepository(f);
  const { lifecycle, files, backup } = services(f);
  const row = await lifecycle.createGit({
    name: 'git source',
    requestKey: 'backup-git',
    repositoryId: repository.id,
    refType: 'branch',
    refName: 'main',
  });
  const sourceRoot = f.roots.path(row);
  await files.create(row.id, 'local-commit.py', 'print("only local commit")\n');
  git(['add', '--', 'local-commit.py'], sourceRoot);
  git(['commit', '-m', 'unique workspace local commit'], sourceRoot);
  const localCommit = git(['rev-parse', 'HEAD'], sourceRoot);
  assert.notEqual(localCommit, repository.commit);
  await files.create(row.id, 'untracked.py', 'print("untracked")\n');
  const read = await files.read(row.id, 'main.py');
  await files.save(
    row.id,
    'main.py',
    'print("dirty tracked bytes")\n',
    read.hash,
  );
  const before = await f.store.workspace(row.id);
  const id = await backup.create();
  const proof = (await backup.snapshot(id)).manifest.workspaces[0].git;
  assert.equal(proof.head, localCommit);
  assert.equal(proof.dirty, true);
  assert.match(proof.porcelain, /untracked.py/);
  const b = await target(f);
  await f.store.close();
  await fs.rm(f.dataRoot, { recursive: true });
  const restored = f.track(
    await new WorkspaceRestoreService(services(b).backup).restore(id),
  );
  const after = await restored.workspace(row.id);
  assert.equal(after.content_inventory_hash, before.content_inventory_hash);
  const root = new WorkspaceRootResolver(b.dataRoot).path(after);
  assert.equal(
    await fs.readFile(path.join(root, 'untracked.py'), 'utf8'),
    'print("untracked")\n',
  );
  assert.equal(git(['rev-parse', 'HEAD'], root), proof.head);
  assert.equal(
    git(['show', 'HEAD:local-commit.py'], root),
    'print("only local commit")',
  );
  assert.equal(
    git(['symbolic-ref', 'HEAD'], root),
    'refs/heads/' + proof.private_branch,
  );
  assert.match(
    git(['status', '--porcelain=v1', '--untracked-files=all'], root),
    /untracked.py/,
  );
  assert.equal(
    (await restored.all('SELECT storage_path FROM Repositories'))[0]
      .storage_path,
    path.join(b.dataRoot, 'git/repository-1.git'),
  );
});

test('reclaimed source travels in authenticated portable preservation dependencies after all original roots are destroyed', async (t) => {
  const f = await createFixture(t);
  const { row, backup } = await local(f, false);
  const assetSnapshot = await backup.create();
  const preservation = new WorkspacePreservationService(backup);
  const reclaim = new WorkspaceReclaimService(
    f.store,
    f.roots,
    f.leases,
    preservation,
  );
  const operation = await reclaim.requestDelete(row.id, row.version, {
    requestKey: 'portable-reclaim',
    snapshotId: assetSnapshot,
  });
  const tombstone = await reclaim.reclaim(operation.id);
  assert.equal(tombstone.storage_state, 'RECLAIMED');
  const fullSnapshot = await backup.create();
  assert.equal(
    (await backup.snapshot(fullSnapshot)).manifest.preserved_snapshots[0]
      .backup_id,
    assetSnapshot,
  );
  const encrypted = await backup.exportPortable(
    fullSnapshot,
    Buffer.from('retained asset secret'),
  );
  const portable = path.join(f.root, 'only-portable-copy.encrypted');
  await fs.copyFile(encrypted, portable);
  await fs.chmod(portable, 0o600);
  await f.store.close();
  await fs.rm(f.dataRoot, { recursive: true });
  await fs.rm(f.backupRoot, { recursive: true });
  const b = await target(f);
  b.backupRoot = path.join(f.root, 'fresh-backup-domain');
  const importedBackup = services(b).backup;
  const imported = await importedBackup.importPortable(
    portable,
    Buffer.from('retained asset secret'),
  );
  const restored = f.track(
    await new WorkspaceRestoreService(importedBackup).restore(
      imported.id,
      'imports',
    ),
  );
  const after = await restored.workspace(row.id);
  assert.equal(after.storage_state, 'RECLAIMED');
  assert.equal(after.lifecycle_state, 'TOMBSTONED');
  assert.equal(
    await fs.lstat(path.join(b.dataRoot, row.root_key)).catch(() => null),
    null,
  );
  const restoredBackup = new WorkspaceBackupService(
    restored,
    new WorkspaceRootResolver(b.dataRoot),
    b.leases,
    b.backupRoot,
  );
  const retained = await restoredBackup.snapshot(assetSnapshot);
  assert.equal(
    await fs.readFile(
      path.join(retained.root, 'data', row.root_key, 'main.py'),
      'utf8',
    ),
    'print("preserved local bytes")\n',
  );
  assert.equal(
    (
      await restored.all('SELECT snapshot_key FROM WorkspacePreservationHolds')
    )[0].snapshot_key,
    assetSnapshot,
  );
  await assert.rejects(restoredBackup.delete(assetSnapshot), {
    error_code: 'WORKSPACE_PRESERVATION_REQUIRED',
  });
});

test('snapshot waits for actual admitted file mutation to drain and blocks new producers', async (t) => {
  const f = await createFixture(t);
  const { row, backup } = await local(f);
  let release, prepared;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    prepared = resolve;
  });
  const files = new WorkspaceFileService(f.store, f.roots, f.leases, {
    fault: async (phase) => {
      if (phase === 'FILE_PREPARED') {
        prepared();
        await gate;
      }
    },
  });
  const mutation = files.create(row.id, 'drained.py', 'print("drained")\n');
  await ready;
  const snapshot = backup.create(10000);
  for (let tries = 0; tries < 100; tries++) {
    if ((await backup.barrier.state())?.phase === 'QUIESCING') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await backup.barrier.state()).phase, 'QUIESCING');
  await assert.rejects(
    services(f).files.create(row.id, 'new-producer.py', 'denied'),
    { error_code: 'PLATFORM_BACKUP_IN_PROGRESS' },
  );
  release();
  await mutation;
  const id = await snapshot;
  assert.ok(
    (await backup.snapshot(id)).manifest.workspaces[0].content_inventory.some(
      (entry) => entry.path === 'drained.py',
    ),
  );
});

test('tampered manifest, malformed catalog receipt, disk budget and ENOSPC preserve source and do not publish READY', async (t) => {
  const f = await createFixture(t);
  const { row, backup } = await local(f);
  const id = await backup.create();
  const { root } = await backup.snapshot(id);
  const manifestFile = path.join(root, 'manifest.json');
  const manifestBytes = await fs.readFile(manifestFile);
  const changed = JSON.parse(manifestBytes);
  changed.workspaces[0].source_generation += 1;
  await fs.writeFile(manifestFile, JSON.stringify(changed) + '\n', {
    mode: 0o600,
  });
  await assert.rejects(backup.snapshot(id), {
    error_code: 'BACKUP_SOURCE_INCOMPLETE',
  });
  await fs.writeFile(manifestFile, manifestBytes, { mode: 0o600 });
  const directory = path.join(f.backupRoot, 'preservation-holds', id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, row.id + '.json'), '{}', {
    mode: 0o600,
  });
  await assert.rejects(backup.delete(id), {
    error_code: 'BACKUP_RECOVERY_REQUIRED',
  });
  const statfs = fs.statfs;
  try {
    fs.statfs = async () => ({ bavail: 0, bsize: 4096 });
    await assert.rejects(backup.create(), {
      error_code: 'DISK_BUDGET_EXCEEDED',
    });
  } finally {
    fs.statfs = statfs;
  }
  const failed = services(f, {
    fault: async (phase) => {
      if (phase === 'backup-after-copy')
        throw Object.assign(Error('injected full disk'), { code: 'ENOSPC' });
    },
  }).backup;
  await assert.rejects(failed.create(), { error_code: 'DISK_BUDGET_EXCEEDED' });
  assert.equal(
    (await fs.readdir(path.join(f.backupRoot, 'snapshots'))).length,
    1,
  );
  for (const stage of await fs.readdir(path.join(f.backupRoot, '.staging'))) {
    assert.equal(
      await fs
        .lstat(path.join(f.backupRoot, '.staging', stage, 'READY'))
        .catch(() => null),
      null,
    );
  }
  assert.equal(
    await fs.readFile(path.join(f.roots.path(row), 'main.py'), 'utf8'),
    'print("preserved local bytes")\n',
  );
});

test('unknown target directory is retained and final-validation failure rolls back to original B bytes', async (t) => {
  const f = await createFixture(t);
  const { backup } = await local(f);
  const id = await backup.create();
  const b = await target(f);
  assert.throws(
    () => new WorkspaceBackupService(f.store, b.roots, b.leases, f.backupRoot),
    { error_code: 'WORKSPACE_PATH_INVALID' },
  );
  await assert.rejects(
    WorkspaceBackupService.forRestoreRecovery(
      f.store,
      b.roots,
      b.leases,
      f.backupRoot,
    ),
    { error_code: 'WORKSPACE_RECOVERY_REQUIRED' },
  );
  const destination = services(b);
  const bRow = await destination.lifecycle.createLocal({
    name: 'original B',
    requestKey: 'original-B',
  });
  await destination.files.create(
    bRow.id,
    'original.py',
    'print("original B")\n',
  );
  const unknown = path.join(b.dataRoot, 'unknown-user-directory');
  await fs.mkdir(unknown, { mode: 0o700 });
  await fs.writeFile(path.join(unknown, 'retain-me'), 'user-owned', {
    mode: 0o600,
  });
  await assert.rejects(
    new WorkspaceRestoreService(destination.backup).restore(id),
    { error_code: 'WORKSPACE_RECOVERY_REQUIRED' },
  );
  assert.equal(
    await fs.readFile(path.join(unknown, 'retain-me'), 'utf8'),
    'user-owned',
  );
  await fs.rm(unknown, { recursive: true });
  const restore = new WorkspaceRestoreService(destination.backup, {
    fault: async (phase) => {
      if (phase === 'restore-before-final-validation')
        throw Error('injected validation failure');
    },
  });
  await assert.rejects(restore.restore(id));
  assert.equal((await restore.status()).stage, 'ROLLED_BACK');
  assert.equal(
    await fs.readFile(
      path.join(b.dataRoot, bRow.root_key, 'original.py'),
      'utf8',
    ),
    'print("original B")\n',
  );
  assert.ok(
    (await fs.readdir(path.join(b.dataRoot + '.platform-control', 'failed')))
      .length > 0,
  );
  assert.equal(
    (await destination.backup.barrier.state()).phase,
    'RESTORE_PENDING',
  );
});

for (const checkpoint of [
  'restore-after-old-rename',
  'restore-after-candidate-publish',
]) {
  test(
    'SIGKILL at ' + checkpoint + ' recovers durable cross-root rename journal',
    async (t) => {
      const f = await createFixture(t);
      const { row, backup } = await local(f);
      const id = await backup.create();
      const b = await target(f);
      await f.store.close();
      await fs.rm(f.dataRoot, { recursive: true });
      await b.store.close();
      const worker = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          path.join(__dirname, 'restore-worker.cjs'),
          b.dataRoot,
          f.backupRoot,
          id,
          checkpoint,
        ],
        {
          cwd: f.projectRoot,
          env: process.env,
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      worker.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      t.after(() => {
        if (worker.exitCode === null && worker.signalCode === null)
          worker.kill('SIGKILL');
      });
      const exit = await new Promise((resolve, reject) => {
        worker.on('error', reject);
        worker.on('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(exit.signal, 'SIGKILL', stderr);
      const restore = new WorkspaceRestoreService(services(b).backup);
      const pending = await restore.status();
      assert.ok(['PREPARED', 'OLD_ROOT_MOVED'].includes(pending.stage));
      const recovery = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          path.join(__dirname, 'restore-worker.cjs'),
          b.dataRoot,
          f.backupRoot,
          'recover',
        ],
        {
          cwd: f.projectRoot,
          env: process.env,
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let recoveryError = '';
      recovery.stderr.on('data', (chunk) => {
        recoveryError += chunk;
      });
      const recovered = await new Promise((resolve, reject) => {
        recovery.on('error', reject);
        recovery.on('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(recovered.code, 0, recoveryError);
      const restored = f.track(
        await WorkspaceStore.open(b.databasePath, b.dataRoot),
      );
      const after = await restored.workspace(row.id);
      await new WorkspaceRootResolver(b.dataRoot).requireOwned(after);
      assert.equal(after.content_inventory_hash, row.content_inventory_hash);
      assert.equal(
        await fs.readFile(
          path.join(b.dataRoot, row.root_key, 'main.py'),
          'utf8',
        ),
        'print("preserved local bytes")\n',
      );
      assert.equal((await restore.status()).stage, 'COMPLETE');
      assert.equal(await restore.backup.barrier.state(), null);
    },
  );
}
