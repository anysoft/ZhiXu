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
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const {
  WorkspaceRestoreService,
} = require('../../back/services/workspaceV2/restore');
const {
  verifyRepositoryAssets,
  reconcileRepositoryAssets,
} = require('../../back/services/workspaceV2/repositoryAssets');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');
function backup(f) {
  return new WorkspaceBackupService(f.store, f.roots, f.leases, f.backupRoot);
}
async function target(f) {
  const dataRoot = path.join(f.root, 'restored-unused');
  const databasePath = await createDatabase(dataRoot);
  await fs.mkdir(dataRoot + '.platform-control', { mode: 0o700 });
  const store = f.track(await WorkspaceStore.open(databasePath, dataRoot));
  const roots = new WorkspaceRootResolver(dataRoot);
  const leases = new WorkspaceLeaseService(
    dataRoot,
    new PlatformBackupBarrier(dataRoot + '.platform-control'),
  );
  return {
    store,
    roots,
    leases,
    dataRoot,
    databasePath,
    backupRoot: f.backupRoot,
  };
}

test('READY unused Repository with missing bare asset cannot produce a successful backup', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  const service = backup(f);
  assert.equal((await f.store.all('SELECT id FROM Workspaces')).length, 0);
  await fs.rm(repo.bare, { recursive: true });
  await assert.rejects(service.create(), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
  assert.equal((await service.list()).length, 0);
  assert.equal(
    (
      await f.store.all('SELECT storage_path FROM Repositories WHERE id=?', [
        repo.id,
      ])
    )[0].storage_path,
    repo.bare,
  );
});

test('real backup of unused Repository survives destroying A and restores a usable generated bare path in B', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  const service = backup(f);
  const snapshotId = await service.create();
  assert.equal(
    (await service.snapshot(snapshotId)).manifest.workspaces.length,
    0,
  );
  const b = await target(f);
  await f.store.close();
  await fs.rm(f.dataRoot, { recursive: true });
  const restored = f.track(
    await new WorkspaceRestoreService(backup(b)).restore(snapshotId),
  );
  const expected = path.join(b.dataRoot, 'git', `repository-${repo.id}.git`);
  assert.equal(
    (
      await restored.all('SELECT storage_path FROM Repositories WHERE id=?', [
        repo.id,
      ])
    )[0].storage_path,
    expected,
  );
  assert.deepEqual(await verifyRepositoryAssets(restored), [
    { repository_id: repo.id, storage_key: `git/repository-${repo.id}.git` },
  ]);
  const row = await new WorkspaceLifecycleService(
    restored,
    b.roots,
    b.leases,
  ).createGit({
    name: 'restored unused repo',
    requestKey: 'unused-repository-create',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  assert.equal(row.lifecycle_state, 'READY');
  assert.equal(git(['rev-parse', 'HEAD'], b.roots.path(row)), repo.commit);
  assert.equal(
    await fs.readFile(path.join(b.roots.path(row), 'main.py'), 'utf8'),
    'print("s1a-only-source")\n',
  );
});

test('missing required HEAD and external config link fail closed for an unused Repository', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  const head = path.join(repo.bare, 'HEAD');
  const bytes = await fs.readFile(head);
  await fs.unlink(head);
  await assert.rejects(verifyRepositoryAssets(f.store), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
  await fs.writeFile(head, bytes);
  const config = path.join(repo.bare, 'config');
  await fs.rename(config, config + '.original');
  const external = path.join(f.root, 'outside-git-config');
  await fs.writeFile(external, 'must survive', { mode: 0o600 });
  await fs.symlink(external, config);
  await assert.rejects(verifyRepositoryAssets(f.store), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
  assert.equal(await fs.readFile(external, 'utf8'), 'must survive');
});

test('unused Repository corruption is detected by real fsck and stale host paths are never followed', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  await f.store.run('UPDATE Repositories SET storage_path=? WHERE id=?', [
    path.join(f.root, 'unowned-previous-host'),
    repo.id,
  ]);
  await assert.rejects(verifyRepositoryAssets(f.store), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
  assert.equal(
    (await verifyRepositoryAssets(f.store, { relocated: true })).length,
    1,
  );
  await reconcileRepositoryAssets(f.store);
  assert.equal(
    (
      await f.store.all('SELECT storage_path FROM Repositories WHERE id=?', [
        repo.id,
      ])
    )[0].storage_path,
    repo.bare,
  );
  const blob = git(
    ['--git-dir', repo.bare, 'rev-parse', 'HEAD:main.py'],
    f.root,
  );
  const object = path.join(
    repo.bare,
    'objects',
    blob.slice(0, 2),
    blob.slice(2),
  );
  await fs.chmod(object, 0o600);
  await fs.writeFile(object, 'broken actual object');
  await assert.rejects(verifyRepositoryAssets(f.store), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
});
