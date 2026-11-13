const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  createS1BFixture,
  seedRepository,
  git,
  hashFile,
} = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
const {
  GitWorkspaceStorageAdapter,
} = require('../../../back/services/workspaceV2/gitStorage');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');

test('verified local Git HEAD publication admits new Tasks while old queued snapshots and failed CAS remain immutable', async (t) => {
  const s = await createS1BFixture(t, { caseId: 'git-source-proof' });
  const a = await s.createInstance('A');
  const repo = await seedRepository(a);
  const ws = await new WorkspaceLifecycleService(
    a.store,
    a.roots,
    a.leases,
  ).createGit({
    name: 'verified local commits',
    requestKey: 'verified-head',
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  const files = new WorkspaceFileService(a.store, a.roots, a.leases);
  await files.create(
    ws.id,
    'main.sh',
    'printf "VERIFIED_LOCAL_HEAD_REAL_RUNNER\\n"\n',
  );
  await files.create(
    ws.id,
    'unique-local.txt',
    'unique commit is absent from original remote\n',
  );
  const tasks = new TaskService(a.store, a.roots, a.leases);
  const input = {
    name: 'before local commit',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: ws.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  };
  const original = await tasks.create(input);
  const engine = a.track(new TaskExecutionService(a.store, a.roots, a.leases));
  const old = await engine.submit(original.task.id, {
    submissionKey: 'before-local-commit',
  });
  const adapter = new GitWorkspaceStorageAdapter(a.store, a.roots, a.leases);
  let verified;
  await a.leases.withRepository(repo.id, 'S1B_LOCAL_COMMIT', () =>
    a.leases.withWorkspace(ws.id, 'S1B_LOCAL_COMMIT', async (lease) => {
      const root = a.roots.path(ws);
      git(['add', 'main.sh', 'unique-local.txt'], root);
      git(['commit', '-m', 'S1B local-only asset'], root);
      verified = await adapter.verify(await a.store.workspace(ws.id), lease);
    }),
  );
  assert.notEqual(verified.head, repo.commit);
  const current = await tasks.create({ ...input, name: 'after local commit' });
  const gitRow = (
    await a.store.all('SELECT * FROM GitWorkspaces WHERE workspace_id=?', [
      ws.id,
    ])
  )[0];
  assert.equal(gitRow.last_verified_commit, verified.head);
  const index = path.join(
    repo.bare,
    'worktrees',
    verified.git_admin_key,
    'index',
  );
  const indexHash = await hashFile(index);
  const skipped = await engine.wait(old.id);
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(skipped.error_code, 'SOURCE_SUPERSEDED');
  assert.equal(skipped.admission_snapshot, old.admission_snapshot);
  assert.equal((await engine.attempts(old.id)).length, 0);
  const next = await engine.submit(current.task.id);
  const run = await engine.wait(next.id);
  assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
  assert.equal(JSON.parse(run.source_snapshot).git.commit, verified.head);
  assert.match(await engine.logs(run.id), /VERIFIED_LOCAL_HEAD_REAL_RUNNER/);
  assert.equal(await hashFile(index), indexHash);
  let later;
  await a.leases.withRepository(repo.id, 'S1B_EMPTY_COMMIT', () =>
    a.leases.withWorkspace(ws.id, 'S1B_EMPTY_COMMIT', async (lease) => {
      git(
        ['commit', '--allow-empty', '-m', 'S1B subsequent local identity'],
        a.roots.path(ws),
      );
      later = await adapter.verify(await a.store.workspace(ws.id), lease);
    }),
  );
  assert.notEqual(later.head, verified.head);
  const oldDefinition = await tasks.get(original.task.id);
  await assert.rejects(
    tasks.update(original.task.id, oldDefinition.task.version + 100, {
      description: 'rejected CAS must not publish Git metadata',
    }),
    { error_code: 'TASK_VERSION_CONFLICT' },
  );
  assert.equal(
    (
      await a.store.all(
        'SELECT last_verified_commit FROM GitWorkspaces WHERE workspace_id=?',
        [ws.id],
      )
    )[0].last_verified_commit,
    verified.head,
  );
  await tasks.update(original.task.id, oldDefinition.task.version, {
    description: 'explicit checked mutation',
  });
  assert.equal(
    (
      await a.store.all(
        'SELECT last_verified_commit FROM GitWorkspaces WHERE workspace_id=?',
        [ws.id],
      )
    )[0].last_verified_commit,
    later.head,
  );
  assert.deepEqual(await a.store.all('PRAGMA foreign_key_check'), []);
  await s.record('verified-git-source', {
    input: 'real local-only commits, Task mutation and queued execution',
    expected:
      'new Tasks execute verified HEAD; old ticket skips; failed CAS changes no Git metadata',
    actual: 'PASS',
    status: 'PASS',
    exit_code: 0,
    assertions: [
      'verified local HEAD published only under Workspace lease',
      'old immutable admission retained',
      'old Run zero Attempts',
      'new Run real SUCCESS at actual local HEAD',
      'Git index unchanged by Runner',
      'failed CAS does not publish next HEAD',
      'valid Task update publishes next verified HEAD atomically',
    ],
    old_run_id: old.id,
    new_run_id: next.id,
    task_ids: [original.task.id, current.task.id],
    remote_commit: repo.commit,
    local_commit: verified.head,
    later_commit: later.head,
    index_sha256: indexHash,
  });
});
