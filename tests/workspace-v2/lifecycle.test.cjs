const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createFixture,
  seedRepository,
  git,
  insertTaskSource,
  insertHistoricalRunForReferenceTest,
} = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
test('LOCAL creation persists identity and independent source, without any Repository or Git metadata', async (t) => {
  const f = await createFixture(t);
  const phases = [];
  const roots = new WorkspaceRootResolver(f.dataRoot, async (p) => {
    phases.push(p);
  });
  const svc = new WorkspaceLifecycleService(f.store, roots, f.leases, {
    fault: async (p) => {
      phases.push(p);
    },
  });
  const row = await svc.createLocal({
    name: 'LOCAL',
    requestKey: 'local-basic',
  });
  assert.equal(row.lifecycle_state, 'READY');
  assert.equal(row.type, 'LOCAL');
  assert.equal((await f.store.all('SELECT * FROM Repositories')).length, 0);
  assert.equal((await f.store.all('SELECT * FROM GitWorkspaces')).length, 0);
  const root = roots.path(row);
  assert.equal((await roots.requireOwned(row)).marker.workspace_id, row.id);
  await fs.writeFile(path.join(root, 'restart.txt'), 'durable source');
  await f.store.close();
  const reopened = f.track(
    await WorkspaceStore.open(f.databasePath, f.dataRoot),
  );
  assert.equal((await reopened.workspace(row.id)).root_key, row.root_key);
  assert.equal(
    await fs.readFile(path.join(root, 'restart.txt'), 'utf8'),
    'durable source',
  );
});

test('create idempotency is stable and conflicting request never adopts a second owner', async (t) => {
  const f = await createFixture(t);
  const svc = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const a = await svc.createLocal({ name: 'same', requestKey: 'same-key' });
  assert.equal(
    (await svc.createLocal({ name: 'same', requestKey: 'same-key' })).id,
    a.id,
  );
  await assert.rejects(
    svc.createLocal({ name: 'different', requestKey: 'same-key' }),
    { error_code: 'IDEMPOTENCY_KEY_CONFLICT' },
  );
  assert.equal((await f.store.all('SELECT id FROM Workspaces')).length, 1);
});

test('same Repository/ref creates independent owned checkouts and private branches; LOCAL cannot get Git extension', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  const svc = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const a = await svc.createGit({
    name: 'A',
    requestKey: 'git-a',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  const b = await svc.createGit({
    name: 'B',
    requestKey: 'git-b',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  assert.notEqual(f.roots.path(a), f.roots.path(b));
  assert.equal(
    git(['branch', '--show-current'], f.roots.path(a)),
    `ws-${a.id}`,
  );
  assert.equal(
    git(['branch', '--show-current'], f.roots.path(b)),
    `ws-${b.id}`,
  );
  await fs.writeFile(path.join(f.roots.path(a), 'main.py'), 'A only');
  assert.equal(
    await fs.readFile(path.join(f.roots.path(b), 'main.py'), 'utf8'),
    'print("s1a-only-source")\n',
  );
  const local = await svc.createLocal({
    name: 'local',
    requestKey: 'git-no-local',
  });
  await assert.rejects(
    f.store.run(
      'INSERT INTO GitWorkspaces(workspace_id,repository_id,ref_type,ref_name,private_branch,resolved_commit) VALUES(?,?,?,?,?,?)',
      [local.id, repo.id, 'branch', 'main', `ws-${local.id}`, repo.commit],
    ),
  );
  await assert.rejects(
    f.store.run('UPDATE Workspaces SET type=? WHERE id=?', ['GIT', local.id]),
  );
});

test('archive preserves source, disables task admission, unarchive preserves disabled flags and validates owner', async (t) => {
  const f = await createFixture(t);
  const svc = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  let row = await svc.createLocal({
    name: 'archive',
    requestKey: 'archive-local',
  });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    row.id,
    'main.py',
    'source',
  );
  const task = await insertTaskSource(f.store, row.id);
  row = await f.store.workspace(row.id);
  const archived = await svc.archive(row.id, row.version, {
    requestKey: 'archive-1',
  });
  assert.equal(archived.lifecycle_state, 'ARCHIVED');
  assert.equal(
    (await f.store.all('SELECT enabled FROM Tasks WHERE id=?', [task]))[0]
      .enabled,
    0,
  );
  await assert.rejects(f.store.assertAccessible(row.id, true), {
    error_code: 'WORKSPACE_ARCHIVED',
  });
  assert.equal(
    await fs.readFile(path.join(f.roots.path(row), 'main.py'), 'utf8'),
    'source',
  );
  const ready = await svc.unarchive(row.id, archived.version, 'unarchive-1');
  assert.equal(ready.lifecycle_state, 'READY');
  assert.equal(
    (await f.store.all('SELECT enabled FROM Tasks WHERE id=?', [task]))[0]
      .enabled,
    0,
  );
});

test('archive deadline does not change queued/task flags or terminate a lease owner', async (t) => {
  const f = await createFixture(t);
  const svc = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const row = await svc.createLocal({
    name: 'busy',
    requestKey: 'busy-create',
  });
  let release, entered;
  const gate = new Promise((r) => (release = r));
  const owned = new Promise((r) => (entered = r));
  const holder = f.leases.withWorkspace(row.id, 'OWNED', async () => {
    entered();
    await gate;
  });
  await owned;
  await assert.rejects(
    svc.archive(row.id, row.version, {
      requestKey: 'busy-archive',
      drainTimeoutMs: 80,
    }),
    { error_code: 'WORKSPACE_BUSY' },
  );
  assert.equal((await f.store.workspace(row.id)).lifecycle_state, 'READY');
  assert.equal(
    (
      await f.store.all(
        "SELECT status FROM WorkspaceOperations WHERE operation_type='ARCHIVE'",
      )
    )[0].status,
    'FAILED',
  );
  release();
  await holder;
  assert.equal(
    (await svc.archive(row.id, row.version, { requestKey: 'next-archive' }))
      .lifecycle_state,
    'ARCHIVED',
  );
});

const { spawn } = require('node:child_process');
async function killWorker(f, options) {
  await f.store.close();
  const worker = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 'lifecycle-crash-worker.cjs'),
      JSON.stringify({
        databasePath: f.databasePath,
        dataRoot: f.dataRoot,
        backupRoot: f.backupRoot,
        ...options,
      }),
    ],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  worker.stdout.on('data', (b) => (output += b));
  worker.stderr.on('data', (b) => (output += b));
  const result = await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.signal, 'SIGKILL', output);
  assert.match(output, new RegExp('SIGKILL:' + options.phase));
  f.store = f.track(await WorkspaceStore.open(f.databasePath, f.dataRoot));
}
async function retryRecovery(action) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return await action();
    } catch (e) {
      if (e.error_code !== 'WORKSPACE_BUSY' || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
for (const phase of [
  'CREATE_AFTER_DB',
  'ROOT_STAGE_OWNED',
  'ROOT_MARKER_DURABLE',
  'ROOT_PUBLISHED',
  'CREATE_BEFORE_READY',
]) {
  test(`real SIGKILL at ${phase} converges the same candidate identity to READY after reopen`, async (t) => {
    const f = await createFixture(t);
    await killWorker(f, {
      action: 'create',
      phase,
      requestKey: 'kill-' + phase,
    });
    const rows = await f.store.all('SELECT * FROM Workspaces');
    assert.equal(rows.length, 1);
    const svc = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
    const after = await retryRecovery(() => svc.recover(rows[0].id));
    assert.equal(after.id, rows[0].id);
    assert.equal(after.lifecycle_state, 'READY');
    await f.roots.requireOwned(after);
    assert.equal(
      (
        await f.store.all(
          'SELECT status FROM WorkspaceOperations WHERE workspace_id=?',
          [after.id],
        )
      )[0].status,
      'SUCCEEDED',
    );
  });
}
test('real SIGKILL after archive admission reopens durable DRAINING operation and retains source', async (t) => {
  const f = await createFixture(t);
  const svc = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const row = await svc.createLocal({
    name: 'archive kill',
    requestKey: 'archive-kill-create',
  });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    row.id,
    'keep.txt',
    'same source',
  );
  await killWorker(f, {
    action: 'archive',
    phase: 'ARCHIVE_ADMISSION_CLOSED',
    workspaceId: row.id,
    version: row.version,
    requestKey: 'archive-kill',
  });
  const after = await retryRecovery(() =>
    new WorkspaceLifecycleService(f.store, f.roots, f.leases).recover(row.id),
  );
  assert.equal(after.lifecycle_state, 'ARCHIVED');
  assert.equal(
    await fs.readFile(path.join(f.roots.path(after), 'keep.txt'), 'utf8'),
    'same source',
  );
});

test('tag and commit Workspaces stay detached at their pinned commit', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  git(['--git-dir', repo.bare, 'tag', 'v1', repo.commit], f.root);
  const svc = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  for (const ref of [
    { refType: 'tag', refName: 'v1' },
    { refType: 'commit', refName: repo.commit },
  ]) {
    const row = await svc.createGit({
      name: ref.refType,
      requestKey: 'pinned-' + ref.refType,
      repositoryId: repo.id,
      ...ref,
    });
    assert.equal(git(['rev-parse', 'HEAD'], f.roots.path(row)), repo.commit);
    assert.equal(git(['branch', '--show-current'], f.roots.path(row)), '');
    const extension = await svc.git.get(row.id);
    assert.equal(extension.private_branch, null);
    assert.equal(extension.resolved_commit, repo.commit);
  }
});

test('archive and unarchive reject residual materialization journals and changed source proof', async (t) => {
  const f = await createFixture(t);
  const svc = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const row = await svc.createLocal({
    name: 'proof',
    requestKey: 'proof-create',
  });
  await fs.mkdir(path.join(f.dataRoot, 'tmp/config-materialization'), {
    recursive: true,
    mode: 0o700,
  });
  const journal = path.join(
    f.dataRoot,
    'tmp/config-materialization/unknown.json',
  );
  await fs.writeFile(journal, 'unresolved secret lifetime', { mode: 0o600 });
  await assert.rejects(
    svc.archive(row.id, row.version, { requestKey: 'journal-archive' }),
    { error_code: 'WORKSPACE_RECOVERY_REQUIRED' },
  );
  assert.equal(
    await fs.readFile(journal, 'utf8'),
    'unresolved secret lifetime',
  );
  await fs.unlink(journal);
  const archived = await svc.archive(row.id, row.version, {
    requestKey: 'proof-archive',
  });
  await fs.writeFile(
    path.join(f.roots.path(row), 'external.txt'),
    'unverified external source',
  );
  await assert.rejects(
    svc.unarchive(row.id, archived.version, 'proof-unarchive'),
    { error_code: 'WORKSPACE_VERSION_CONFLICT' },
  );
  assert.equal((await f.store.workspace(row.id)).lifecycle_state, 'ARCHIVED');
});

for (const phase of ['ROOT_STAGE_OWNED', 'ROOT_MARKER_DURABLE']) {
  test(`real SIGKILL during GIT ${phase} recovers only its proven stage and private branch`, async (t) => {
    const f = await createFixture(t);
    const repo = await seedRepository(f);
    await killWorker(f, {
      action: 'create-git',
      repositoryId: repo.id,
      phase,
      requestKey: 'kill-git-' + phase,
    });
    const row = (await f.store.all('SELECT * FROM Workspaces'))[0];
    const svc = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
    const after = await retryRecovery(() => svc.recover(row.id));
    assert.equal(after.lifecycle_state, 'READY');
    assert.equal(
      git(['branch', '--show-current'], f.roots.path(after)),
      `ws-${after.id}`,
    );
    assert.equal(git(['rev-parse', 'HEAD'], f.roots.path(after)), repo.commit);
  });
}

test('real corrupt Git object blocks verified backup and never creates a successful snapshot', async (t) => {
  const {
    WorkspaceBackupService,
  } = require('../../back/services/workspaceV2/backup');
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  const svc = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  await svc.createGit({
    name: 'integrity',
    requestKey: 'integrity-create',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
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
  await fs.writeFile(object, Buffer.from('corrupt actual git object'));
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  await assert.rejects(backup.create(), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
  assert.equal((await backup.list()).length, 0);
});
