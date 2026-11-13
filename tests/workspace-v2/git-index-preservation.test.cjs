const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFixture, seedRepository, git } = require('./fixture.cjs');
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
  WorkspaceReclaimService,
} = require('../../back/services/workspaceV2/reclaim');
const {
  WorkspacePreservationService,
} = require('../../back/services/workspaceV2/preservation');

test('preservation matches exact Git index bytes when HEAD, working bytes and porcelain flags remain identical', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  let row = await lifecycle.createGit({
    name: 'staged assets',
    requestKey: 'staged-create',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  const root = f.roots.path(row);
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  await files.create(row.id, 'staged.py', 'print("stable working bytes")\n');
  const stage = async (name, content) => {
    const file = path.join(f.root, name);
    await fs.writeFile(file, content);
    const blob = git(['hash-object', '-w', file], root);
    git(
      ['update-index', '--add', '--cacheinfo', '100644', blob, 'staged.py'],
      root,
    );
    return blob;
  };
  await stage('staged-before.py', 'print("first unique staged version")\n');
  row = await f.store.workspace(row.id);
  const beforeHead = git(['rev-parse', 'HEAD'], root);
  const beforeStatus = git(
    ['status', '--porcelain=v1', '--untracked-files=all'],
    root,
  );
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const oldSnapshot = await backup.create();
  await stage('staged-after.py', 'print("new unique staged version")\n');
  assert.equal(git(['rev-parse', 'HEAD'], root), beforeHead);
  assert.equal(
    git(['status', '--porcelain=v1', '--untracked-files=all'], root),
    beforeStatus,
  );
  assert.equal(
    await fs.readFile(path.join(root, 'staged.py'), 'utf8'),
    'print("stable working bytes")\n',
  );
  const reclaim = new WorkspaceReclaimService(
    f.store,
    f.roots,
    f.leases,
    new WorkspacePreservationService(backup),
  );
  await assert.rejects(
    reclaim.remove(row.id, row.version, {
      requestKey: 'stale-index-reclaim',
      snapshotId: oldSnapshot,
    }),
    { error_code: 'WORKSPACE_PRESERVATION_REQUIRED' },
  );
  assert.equal((await f.store.workspace(row.id)).lifecycle_state, 'READY');
  assert.equal(
    git(['show', ':staged.py'], root),
    'print("new unique staged version")',
  );
  const currentSnapshot = await backup.create();
  const after = await reclaim.remove(row.id, row.version, {
    requestKey: 'exact-index-reclaim',
    snapshotId: currentSnapshot,
  });
  assert.equal(after.storage_state, 'RECLAIMED');
  const retained = await backup.snapshot(currentSnapshot);
  const entry = retained.manifest.workspaces[0];
  const admin = path.join(
    retained.root,
    'data',
    entry.git.storage_key,
    'worktrees',
    entry.git.git_admin_key,
  );
  assert.equal(
    git(['--git-dir', admin, 'show', ':staged.py'], f.root),
    'print("new unique staged version")',
  );
});
