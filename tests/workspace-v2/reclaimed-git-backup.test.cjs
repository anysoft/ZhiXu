const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createFixture,
  createDatabase,
  seedRepository,
  git,
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
  WorkspaceRestoreService,
} = require('../../back/services/workspaceV2/restore');
const {
  WorkspaceReclaimService,
} = require('../../back/services/workspaceV2/reclaim');
const {
  WorkspacePreservationService,
} = require('../../back/services/workspaceV2/preservation');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');
function logicalTuple(gitRow) {
  return {
    repository_id: gitRow.repository_id,
    ref_type: gitRow.ref_type,
    ref_name: gitRow.ref_name,
    private_branch: gitRow.private_branch,
    resolved_commit: gitRow.resolved_commit,
    applied_commit: gitRow.applied_commit,
    last_verified_commit: gitRow.last_verified_commit,
  };
}
function assertLogical(entry, gitRow, assetSnapshot) {
  assert.equal(entry.workspace_type, 'GIT');
  assert.equal(entry.storage_state, 'RECLAIMED');
  assert.ok(entry.git);
  assert.equal(entry.git.storage_state, 'RECLAIMED');
  for (const [key, value] of Object.entries(logicalTuple(gitRow)))
    assert.equal(entry.git[key], value, key);
  assert.equal(
    entry.git.storage_key,
    `git/repository-${gitRow.repository_id}.git`,
  );
  assert.deepEqual(entry.git.preservation_snapshot_keys, [assetSnapshot]);
  assert.equal(Object.hasOwn(entry.git, 'head'), false);
  assert.equal(Object.hasOwn(entry.git, 'porcelain'), false);
}

test('reclaimed GIT keeps honest logical tuple while portable held assets preserve actual unique local HEAD after A destruction', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  let row = await lifecycle.createGit({
    name: 'reclaimed Git asset',
    requestKey: 'reclaimed-git-create',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  const root = f.roots.path(row);
  // This commit exists only in the owned checkout/bare, never the fixture remote.
  git(
    [
      'commit',
      '--allow-empty',
      '-m',
      'unique local history before reclamation',
    ],
    root,
  );
  const localHead = git(['rev-parse', 'HEAD'], root);
  assert.notEqual(localHead, repo.commit);
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    row.id,
    'untracked-local.py',
    'print("unique untracked held source")\n',
  );
  row = await f.store.workspace(row.id);
  const gitRow = await lifecycle.git.get(row.id);
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const assetSnapshot = await backup.create();
  const assetEntry = (await backup.snapshot(assetSnapshot)).manifest
    .workspaces[0];
  assert.equal(assetEntry.git.head, localHead);
  const reclaim = new WorkspaceReclaimService(
    f.store,
    f.roots,
    f.leases,
    new WorkspacePreservationService(backup),
  );
  const tombstone = await reclaim.remove(row.id, row.version, {
    requestKey: 'reclaimed-git-delete',
    snapshotId: assetSnapshot,
  });
  assert.equal(tombstone.lifecycle_state, 'TOMBSTONED');
  const fullSnapshot = await backup.create();
  const manifest = (await backup.snapshot(fullSnapshot)).manifest;
  assertLogical(manifest.workspaces[0], gitRow, assetSnapshot);
  assert.equal(manifest.preserved_snapshots[0].backup_id, assetSnapshot);
  const encrypted = await backup.exportPortable(
    fullSnapshot,
    Buffer.from('reclaimed Git preservation secret'),
  );
  const portable = path.join(f.root, 'only-reclaimed-git-copy.encrypted');
  await fs.copyFile(encrypted, portable);
  await fs.chmod(portable, 0o600);
  await f.store.close();
  await fs.rm(f.dataRoot, { recursive: true });
  await fs.rm(f.backupRoot, { recursive: true });
  await fs.rm(repo.source, { recursive: true });
  const dataRoot = path.join(f.root, 'restored-reclaimed-git');
  const databasePath = await createDatabase(dataRoot);
  await fs.mkdir(dataRoot + '.platform-control', { mode: 0o700 });
  const store = f.track(await WorkspaceStore.open(databasePath, dataRoot));
  const roots = new WorkspaceRootResolver(dataRoot);
  const leases = new WorkspaceLeaseService(
    dataRoot,
    new PlatformBackupBarrier(dataRoot + '.platform-control'),
  );
  const backupRoot = path.join(f.root, 'fresh-reclaimed-git-catalog');
  const importer = new WorkspaceBackupService(store, roots, leases, backupRoot);
  const imported = await importer.importPortable(
    portable,
    Buffer.from('reclaimed Git preservation secret'),
  );
  assertLogical(
    (await importer.validateRoot(imported.root)).workspaces[0],
    gitRow,
    assetSnapshot,
  );
  const restored = f.track(
    await new WorkspaceRestoreService(importer).restore(imported.id, 'imports'),
  );
  const after = await restored.workspace(row.id);
  assert.equal(after.id, row.id);
  assert.equal(after.lifecycle_state, 'TOMBSTONED');
  assert.equal(after.storage_state, 'RECLAIMED');
  await assert.rejects(fs.lstat(roots.path(after)), { code: 'ENOENT' });
  const restoredGit = (
    await restored.all('SELECT * FROM GitWorkspaces WHERE workspace_id=?', [
      row.id,
    ])
  )[0];
  assert.deepEqual(logicalTuple(restoredGit), logicalTuple(gitRow));
  assert.equal(
    (
      await restored.all('SELECT storage_path FROM Repositories WHERE id=?', [
        repo.id,
      ])
    )[0].storage_path,
    path.join(dataRoot, 'git', `repository-${repo.id}.git`),
  );
  const restoredBackup = new WorkspaceBackupService(
    restored,
    roots,
    leases,
    backupRoot,
  );
  const retained = await restoredBackup.snapshot(assetSnapshot);
  const retainedEntry = retained.manifest.workspaces[0];
  assert.equal(retainedEntry.storage_state, 'PRESENT');
  assert.equal(retainedEntry.git.head, localHead);
  const heldRoot = path.join(retained.root, 'data', row.root_key);
  const heldAdmin = path.join(
    retained.root,
    'data',
    retainedEntry.git.storage_key,
    'worktrees',
    retainedEntry.git.git_admin_key,
  );
  assert.equal(
    git(
      ['--git-dir', heldAdmin, '--work-tree', heldRoot, 'rev-parse', 'HEAD'],
      f.root,
    ),
    localHead,
  );
  assert.equal(
    await fs.readFile(path.join(heldRoot, 'untracked-local.py'), 'utf8'),
    'print("unique untracked held source")\n',
  );
  await assert.rejects(restoredBackup.delete(assetSnapshot), {
    error_code: 'WORKSPACE_PRESERVATION_REQUIRED',
  });
  const afterSnapshot = await restoredBackup.create();
  assertLogical(
    (await restoredBackup.snapshot(afterSnapshot)).manifest.workspaces[0],
    restoredGit,
    assetSnapshot,
  );
});
