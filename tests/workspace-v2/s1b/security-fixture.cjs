const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createS1BFixture } = require('./fixture.cjs');
const { seedRepository, git } = require('../fixture.cjs');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');
const {
  WorkspaceLifecycleService,
} = require('../../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../../back/services/workspaceV2/backup');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  WorkspaceEnvironmentService,
} = require('../../../back/services/taskExecutionV2/environment');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function backup(instance, options) {
  return new WorkspaceBackupService(
    instance.store,
    instance.roots,
    instance.leases,
    instance.backupRoot,
    options,
  );
}

async function s1bSecurityFixture(t, caseId, options = {}) {
  const started = performance.now();
  const scenario = await createS1BFixture(t, { caseId });
  const A = await scenario.createInstance('A');
  const B = await scenario.createInstance('B');
  const lifecycle = new WorkspaceLifecycleService(A.store, A.roots, A.leases);
  const files = new WorkspaceFileService(A.store, A.roots, A.leases);
  const row = await lifecycle.createLocal({
    name: 'unique qualified source',
    requestKey: 'source-local',
  });
  const source = 'cat helper.txt; printf "\\n%s\\n" "$QUALIFICATION_SECRET"\n';
  const helper = 'UNIQUE_S1B_SOURCE_' + randomUUID();
  const secret = scenario.registerSecret('S1B_SECRET_' + randomUUID());
  await files.create(row.id, 'main.sh', source);
  await files.create(row.id, 'helper.txt', helper);
  const tasks = new TaskService(A.store, A.roots, A.leases);
  let task = await tasks.create({
    name: 'original S1B task',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: row.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  task = await new WorkspaceEnvironmentService(
    A.store,
    A.roots,
    A.leases,
  ).replaceTaskVariables(task.task.id, task.task.version, [
    {
      name: 'QUALIFICATION_SECRET',
      value: secret,
      operation: 'SET',
      status: 'enabled',
      is_secret: true,
    },
  ]);
  const engine = A.track(new TaskExecutionService(A.store, A.roots, A.leases));
  const queued = await engine.submit(task.task.id, {
    submissionKey: 's1b-original',
  });
  const run = await engine.wait(queued.id);
  assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
  const logs = await engine.logs(run.id);
  assert.equal(logs.includes(secret), false);
  const attempts = await engine.attempts(run.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'SUCCESS');
  await engine.close();
  let repository, gitRow, gitExpected;
  if (options.gitWorkspace) {
    repository = await seedRepository(A);
    gitRow = await lifecycle.createGit({
      name: 'qualified Git source',
      requestKey: 'source-git',
      repositoryId: repository.id,
      refType: 'branch',
      refName: 'main',
    });
    await files.create(gitRow.id, 'unique-local.txt', helper + '-git');
    git(['add', 'unique-local.txt'], A.roots.path(gitRow));
    git(['commit', '-m', 'unique local S1B commit'], A.roots.path(gitRow));
    await files.create(gitRow.id, 'untracked.txt', 'unique untracked bytes');
    const root = A.roots.path(gitRow);
    const index = git(['rev-parse', '--git-path', 'index'], root);
    gitExpected = {
      head: git(['rev-parse', 'HEAD'], root),
      branch: git(['branch', '--show-current'], root),
      index_hash: digest(await fs.readFile(path.resolve(root, index))),
      untracked: 'unique untracked bytes',
    };
  }
  const bRow = await new WorkspaceLifecycleService(
    B.store,
    B.roots,
    B.leases,
  ).createLocal({
    name: 'existing destination',
    requestKey: 'destination-local',
  });
  await new WorkspaceFileService(B.store, B.roots, B.leases).create(
    bRow.id,
    'keep-user.txt',
    'ORIGINAL_DESTINATION_BYTES',
  );
  const f = {
    ...scenario,
    A,
    B,
    row: await A.store.workspace(row.id),
    gitRow,
    gitExpected,
    repository,
    files,
    task,
    run,
    attempts,
    source,
    helper,
    secret,
    logsHash: digest(logs),
    bRow,
    backupA: backup(A),
    backupB: backup(B),
  };
  f.record = (id, details) =>
    scenario.record(id, {
      duration_ms: performance.now() - started,
      exit_code: 0,
      ...details,
    });
  f.assertDestinationUnchanged = async () => {
    assert.equal(
      await fs.readFile(
        path.join(B.dataRoot, bRow.root_key, 'keep-user.txt'),
        'utf8',
      ),
      'ORIGINAL_DESTINATION_BYTES',
    );
  };
  f.assertSourceUnchanged = async () => {
    assert.equal(
      await fs.readFile(path.join(A.roots.path(row), 'main.sh'), 'utf8'),
      source,
    );
    assert.equal(
      await fs.readFile(path.join(A.roots.path(row), 'helper.txt'), 'utf8'),
      helper,
    );
  };
  f.portable = async () => {
    const id = await f.backupA.create();
    const snapshot = await f.backupA.snapshot(id);
    const passphrase = scenario.registerSecret(
      'S1B_PRIVATE_PASSPHRASE_' + randomUUID(),
    );
    const archive = await f.backupA.exportPortable(id, Buffer.from(passphrase));
    const transfer = path.join(
      f.transferRoot,
      'authenticated-' + randomUUID() + '.encrypted',
    );
    await fs.copyFile(archive, transfer, fs.constants.COPYFILE_EXCL);
    await fs.chmod(transfer, 0o600);
    const archiveBytes = await fs.readFile(transfer);
    assert.equal(archiveBytes.includes(Buffer.from(secret)), false);
    assert.equal(JSON.stringify(snapshot.manifest).includes(secret), false);
    return {
      id,
      snapshot,
      archive: transfer,
      passphrase,
      archiveHash: digest(archiveBytes),
    };
  };
  f.reopenB = async () => {
    const store = await WorkspaceStore.open(B.databasePath, B.dataRoot);
    await B.useStore(store);
    f.backupB = backup(B);
    return store;
  };
  f.assertRestored = async () => {
    const current = await B.store.workspace(row.id);
    const owned = await B.roots.requireOwned(current);
    assert.equal(
      await fs.readFile(path.join(owned.root, 'main.sh'), 'utf8'),
      source,
    );
    assert.equal(
      await fs.readFile(path.join(owned.root, 'helper.txt'), 'utf8'),
      helper,
    );
    assert.equal(current.content_inventory_hash, f.row.content_inventory_hash);
    assert.equal(
      (await B.store.all('SELECT id FROM Tasks'))[0].id,
      task.task.id,
    );
    const history = (
      await B.store.all('SELECT * FROM TaskRuns WHERE id=?', [run.id])
    )[0];
    assert.equal(history.status, 'SUCCESS');
    assert.equal(history.admission_snapshot, run.admission_snapshot);
    assert.equal(history.source_snapshot, run.source_snapshot);
    const restoredAttempts = await B.store.all(
      'SELECT * FROM TaskRunAttempts WHERE task_run_id=?',
      [run.id],
    );
    assert.deepEqual(
      restoredAttempts.map((entry) => [entry.id, entry.status]),
      attempts.map((entry) => [entry.id, entry.status]),
    );
    const restoredEngine = B.track(
      new TaskExecutionService(B.store, B.roots, B.leases),
    );
    assert.equal(digest(await restoredEngine.logs(run.id)), f.logsHash);
    await restoredEngine.close();
    assert.equal(
      (await B.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
      1,
    );
    assert.deepEqual(await B.store.all('PRAGMA foreign_key_check'), []);
    if (gitRow) {
      const restoredGit = await B.store.workspace(gitRow.id);
      const gitRoot = (await B.roots.requireOwned(restoredGit)).root;
      assert.equal(git(['rev-parse', 'HEAD'], gitRoot), gitExpected.head);
      assert.equal(
        git(['branch', '--show-current'], gitRoot),
        gitExpected.branch,
      );
      assert.equal(
        await fs.readFile(path.join(gitRoot, 'untracked.txt'), 'utf8'),
        gitExpected.untracked,
      );
      const index = git(['rev-parse', '--git-path', 'index'], gitRoot);
      assert.equal(
        digest(await fs.readFile(path.resolve(gitRoot, index))),
        gitExpected.index_hash,
      );
      assert.ok(path.resolve(gitRoot, index).startsWith(B.dataRoot + path.sep));
    }
    return {
      workspace_id: row.id,
      task_id: task.task.id,
      run_id: run.id,
      attempt_ids: attempts.map((entry) => entry.id),
      source_hash: digest(source),
      helper_hash: digest(helper),
      history_log_hash: f.logsHash,
    };
  };
  return f;
}

module.exports = { s1bSecurityFixture, backup, digest, fs, path, git };
