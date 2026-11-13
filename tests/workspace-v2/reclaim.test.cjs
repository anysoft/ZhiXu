const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createFixture,
  seedRepository,
  git,
  insertTaskSource,
  insertHistoricalRunForReferenceTest,
} = require('./fixture.cjs');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
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
  WorkspaceReclaimService,
} = require('../../back/services/workspaceV2/reclaim');
function services(f, options = {}) {
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const preservation = new WorkspacePreservationService(backup);
  return {
    lifecycle: new WorkspaceLifecycleService(f.store, f.roots, f.leases),
    files: new WorkspaceFileService(f.store, f.roots, f.leases),
    backup,
    preservation,
    reclaim: new WorkspaceReclaimService(
      f.store,
      f.roots,
      f.leases,
      preservation,
      options,
    ),
  };
}
async function local(f) {
  const s = services(f);
  let row = await s.lifecycle.createLocal({
    name: 'reclaim source',
    requestKey: 'reclaim-local',
  });
  await s.files.create(row.id, 'main.py', 'print("unique source")\n');
  return { ...s, row: await f.store.workspace(row.id) };
}

test('nonempty source requires real exact READY snapshot, failed delete leaves source and lifecycle unchanged', async (t) => {
  const f = await createFixture(t);
  const { row, files, backup, reclaim } = await local(f);
  await assert.rejects(
    reclaim.remove(row.id, row.version, { requestKey: 'no-snapshot' }),
    { error_code: 'WORKSPACE_PRESERVATION_REQUIRED' },
  );
  assert.equal((await f.store.workspace(row.id)).lifecycle_state, 'READY');
  assert.equal(
    await files.read(row.id, 'main.py').then((r) => r.content),
    'print("unique source")\n',
  );
  const snapshotId = await backup.create();
  await files.create(row.id, 'later.py', 'new revision');
  const changed = await f.store.workspace(row.id);
  await assert.rejects(
    reclaim.remove(row.id, changed.version, {
      requestKey: 'stale-snapshot',
      snapshotId,
    }),
    { error_code: 'WORKSPACE_PRESERVATION_REQUIRED' },
  );
  assert.equal((await f.store.workspace(row.id)).storage_state, 'PRESENT');
});

test('candidate TaskSources block deletion; historical TaskRun identity remains after owned source reclamation', async (t) => {
  const f = await createFixture(t);
  const s = await local(f);
  const task = await insertTaskSource(f.store, s.row.id);
  const run = await insertHistoricalRunForReferenceTest(
    f.store,
    task,
    s.row.id,
  );
  let row = await f.store.workspace(s.row.id);
  const snapshotId = await s.backup.create();
  await assert.rejects(
    s.reclaim.requestDelete(row.id, row.version, {
      requestKey: 'referenced',
      snapshotId,
    }),
    { error_code: 'WORKSPACE_REFERENCED' },
  );
  await f.store.transaction((tx) =>
    tx.run('DELETE FROM Tasks WHERE id=?', [task]),
  );
  row = await f.store.workspace(row.id);
  const after = await s.reclaim.remove(row.id, row.version, {
    requestKey: 'history-reclaim',
    snapshotId,
  });
  assert.equal(after.lifecycle_state, 'TOMBSTONED');
  assert.equal(after.storage_state, 'RECLAIMED');
  await assert.rejects(fs.lstat(f.roots.path(after)), { code: 'ENOENT' });
  const historical = (
    await f.store.all('SELECT workspace_id,task_id FROM TaskRuns WHERE id=?', [
      run,
    ])
  )[0];
  assert.equal(historical.workspace_id, row.id);
  assert.equal(historical.task_id, null);
  assert.equal((await s.preservation.usage()).active_holds, 1);
  await assert.rejects(s.backup.delete(snapshotId), {
    error_code: 'WORKSPACE_PRESERVATION_REQUIRED',
  });
  assert.equal((await f.store.all('PRAGMA foreign_key_check')).length, 0);
  const tombstoneSnapshot = await s.backup.create();
  assert.equal(
    (await s.backup.snapshot(tombstoneSnapshot)).manifest.workspaces[0]
      .storage_state,
    'RECLAIMED',
  );
});

test('unknown canonical replacement and unknown quarantine files survive fail-closed reclamation', async (t) => {
  const f = await createFixture(t);
  const s = await local(f);
  const snapshotId = await s.backup.create();
  const root = f.roots.path(s.row);
  const saved = root + '-original';
  await fs.rename(root, saved);
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'unknown.txt'), 'must survive');
  await assert.rejects(
    s.reclaim.remove(s.row.id, s.row.version, {
      requestKey: 'unknown-root',
      snapshotId,
    }),
  );
  assert.equal(
    await fs.readFile(path.join(root, 'unknown.txt'), 'utf8'),
    'must survive',
  );
  await fs.unlink(path.join(root, 'unknown.txt'));
  await fs.rmdir(root);
  await fs.rename(saved, root);
  const injected = services(f, {
    fault: async (phase) => {
      if (phase === 'DELETE_AFTER_QUARANTINE') throw Error('injected');
    },
  });
  const op = await injected.reclaim.requestDelete(s.row.id, s.row.version, {
    requestKey: 'unknown-quarantine',
    snapshotId,
  });
  await assert.rejects(injected.reclaim.reclaim(op.id));
  const quarantine = path.join(
    f.dataRoot,
    'tmp/workspace-v2/quarantine',
    op.id,
  );
  await fs.writeFile(path.join(quarantine, 'foreign.txt'), 'preserve unknown');
  await assert.rejects(s.reclaim.recover(s.row.id), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
  assert.equal(
    await fs.readFile(path.join(quarantine, 'foreign.txt'), 'utf8'),
    'preserve unknown',
  );
  assert.equal(
    await fs.readFile(path.join(quarantine, 'main.py'), 'utf8'),
    'print("unique source")\n',
  );
});

for (const phase of [
  'DELETE_AFTER_QUARANTINE',
  'RECLAIM_ENTRY_REMOVED',
  'RECLAIM_BEFORE_COMMIT',
]) {
  test(`real SIGKILL at ${phase} resumes owned quarantine and preserves tombstone/hold`, async (t) => {
    const f = await createFixture(t);
    const s = await local(f);
    const snapshotId = await s.backup.create();
    await f.store.close();
    const worker = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        path.join(__dirname, 'lifecycle-crash-worker.cjs'),
        JSON.stringify({
          action: 'reclaim',
          phase,
          databasePath: f.databasePath,
          dataRoot: f.dataRoot,
          backupRoot: f.backupRoot,
          workspaceId: s.row.id,
          version: s.row.version,
          requestKey: 'kill-' + phase,
          snapshotId,
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
    assert.match(output, new RegExp('SIGKILL:' + phase));
    f.store = f.track(await WorkspaceStore.open(f.databasePath, f.dataRoot));
    const resumed = services(f);
    let after;
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        after = await resumed.reclaim.recover(s.row.id);
        break;
      } catch (e) {
        if (e.error_code !== 'WORKSPACE_BUSY' || Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    assert.equal(after.storage_state, 'RECLAIMED');
    assert.equal(after.lifecycle_state, 'TOMBSTONED');
    assert.equal((await resumed.preservation.usage()).active_holds, 1);
    await assert.rejects(resumed.backup.delete(snapshotId), {
      error_code: 'WORKSPACE_PRESERVATION_REQUIRED',
    });
  });
}

test('GIT reclaim detaches only its owned private branch/admin and keeps another checkout intact', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  const s = services(f);
  const a = await s.lifecycle.createGit({
    name: 'A',
    requestKey: 'reclaim-git-a',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  const b = await s.lifecycle.createGit({
    name: 'B',
    requestKey: 'reclaim-git-b',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  const snapshotId = await s.backup.create();
  const after = await s.reclaim.remove(a.id, a.version, {
    requestKey: 'reclaim-git',
    snapshotId,
  });
  assert.equal(after.storage_state, 'RECLAIMED');
  assert.equal(
    git(['branch', '--show-current'], f.roots.path(b)),
    `ws-${b.id}`,
  );
  assert.equal(git(['rev-parse', 'HEAD'], f.roots.path(b)), repo.commit);
  assert.equal(
    (
      await f.store.all('SELECT * FROM GitWorkspaces WHERE workspace_id=?', [
        a.id,
      ])
    ).length,
    1,
  );
});

test('a stale Git snapshot cannot reclaim unique local commits when source tree bytes are unchanged', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  const s = services(f);
  const row = await s.lifecycle.createGit({
    name: 'local commits',
    requestKey: 'local-commit-create',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  const snapshotId = await s.backup.create();
  git(
    ['commit', '--allow-empty', '-m', 'unique local history'],
    f.roots.path(row),
  );
  const localHead = git(['rev-parse', 'HEAD'], f.roots.path(row));
  assert.notEqual(localHead, repo.commit);
  await assert.rejects(
    s.reclaim.remove(row.id, row.version, {
      requestKey: 'local-commit-reclaim',
      snapshotId,
    }),
    { error_code: 'WORKSPACE_PRESERVATION_REQUIRED' },
  );
  assert.equal((await f.store.workspace(row.id)).storage_state, 'PRESENT');
  assert.equal(git(['rev-parse', 'HEAD'], f.roots.path(row)), localHead);
});

test('real SIGKILL after Git detach resumes the owned source without adopting another worktree', async (t) => {
  const f = await createFixture(t);
  const repo = await seedRepository(f);
  const s = services(f);
  const row = await s.lifecycle.createGit({
    name: 'detach crash',
    requestKey: 'detach-crash-create',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  const snapshotId = await s.backup.create();
  await f.store.close();
  const phase = 'RECLAIM_GIT_DETACHED';
  const worker = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 'lifecycle-crash-worker.cjs'),
      JSON.stringify({
        action: 'reclaim',
        phase,
        databasePath: f.databasePath,
        dataRoot: f.dataRoot,
        backupRoot: f.backupRoot,
        workspaceId: row.id,
        version: row.version,
        requestKey: 'detach-crash-reclaim',
        snapshotId,
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
  f.store = f.track(await WorkspaceStore.open(f.databasePath, f.dataRoot));
  assert.equal(
    await fs.readFile(path.join(f.roots.path(row), 'main.py'), 'utf8'),
    'print("s1a-only-source")\n',
  );
  const resumed = services(f);
  let after;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      after = await resumed.reclaim.recover(row.id);
      break;
    } catch (e) {
      if (e.error_code !== 'WORKSPACE_BUSY' || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  assert.equal(after.storage_state, 'RECLAIMED');
  assert.equal(after.lifecycle_state, 'TOMBSTONED');
  assert.equal((await resumed.preservation.usage()).active_holds, 1);
});

test('directory-only LOCAL requires a real preservation snapshot and hold before reclamation', async (t) => {
  const f = await createFixture(t);
  const s = services(f);
  const created = await s.lifecycle.createLocal({
    name: 'directory source',
    requestKey: 'directory-source-create',
  });
  await s.files.createDirectory(created.id, 'owned-empty-directory');
  const row = await f.store.workspace(created.id);
  assert.equal(row.file_count, 0);
  await assert.rejects(
    s.reclaim.remove(row.id, row.version, {
      requestKey: 'directory-no-snapshot',
    }),
    { error_code: 'WORKSPACE_PRESERVATION_REQUIRED' },
  );
  assert.equal(
    (
      await fs.lstat(path.join(f.roots.path(row), 'owned-empty-directory'))
    ).isDirectory(),
    true,
  );
  const snapshotId = await s.backup.create();
  const after = await s.reclaim.remove(row.id, row.version, {
    requestKey: 'directory-preserved',
    snapshotId,
  });
  assert.equal(after.storage_state, 'RECLAIMED');
  assert.equal((await s.preservation.usage()).active_holds, 1);
});
