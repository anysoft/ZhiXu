const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const {
  createManagedRuntimeFixture,
  readPreparedReceipt,
} = require('../s2-runtime-fixture.cjs');
const { seedRepository, git } = require('../fixture.cjs');
const { createS3Fixture } = require('./fixture.cjs');
const { syncServices } = require('./sync-fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');

test(
  'real managed Python Task holds Workspace while Sync fetches safely and editor/apply remain excluded',
  { timeout: 1200000 },
  async (t) => {
    const f = await createManagedRuntimeFixture(t, { node: false });
    const scenario = await createS3Fixture(t, {
      caseId: 'S3-MANAGED-CONCURRENCY',
    });
    const repository = await seedRepository(
      f,
      700000 + Math.floor(Math.random() * 100000),
    );
    const gate = path.join(f.root, 's3-python-gate-' + randomUUID());
    const code = `import pathlib,sys,time\nprint('S3_MANAGED_STARTED',sys.executable,flush=True)\nwhile not pathlib.Path(sys.argv[1]).exists(): time.sleep(0.02)\nprint('S3_MANAGED_FINISHED',flush=True)\n`;
    await fs.writeFile(path.join(repository.source, 'main.py'), code);
    git(['add', 'main.py'], repository.source);
    git(['commit', '-m', 'actual Python mutual exclusion'], repository.source);
    const remote = pathToFileURL(repository.source).href,
      remoteIdentity = await fs.lstat(repository.source);
    await f.store.run(
      'UPDATE Repositories SET remote_url=?,normalized_url=? WHERE id=?',
      [remote, remote, repository.id],
    );
    const accessResolver = async (row) => {
      if (f.prepared)
        await readPreparedReceipt(process.env.ZHIXU_S2_MANAGED_RECEIPT);
      const current = await fs.lstat(repository.source);
      if (
        row.id !== repository.id ||
        row.remote_url !== remote ||
        (await fs.realpath(repository.source)) !== repository.source ||
        current.dev !== remoteIdentity.dev ||
        current.ino !== remoteIdentity.ino ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.mode & 0o077
      )
        throw Error('S3_OWNED_REMOTE_REQUIRED');
      return {
        remote,
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
    Object.assign(f, { repository, accessResolver });
    Object.assign(f, await syncServices(f));
    await f.leases.withRepository(
      repository.id,
      'MANAGED_INITIAL_FETCH',
      (repo) => f.gitAdapter.fetch(repository.id, repo),
    );
    const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
    const row = await lifecycle.createGit({
      name: 'S3 real managed mutex',
      requestKey: randomUUID(),
      repositoryId: repository.id,
      refType: 'branch',
      refName: 'main',
    });
    await f.policies.save(row.id, {
      expected_version: 1,
      enabled: true,
      mode: 'MANUAL',
      schedule: null,
    });
    const baseline = await f.sync.wait((await f.sync.submit(row.id)).id);
    assert.equal(baseline.status, 'SUCCESS', baseline.error_code);
    const task = await f.tasks.create({
      name: 'S3 actual managed Python',
      arguments: [gate],
      runtime: {
        kind: 'PYTHON',
        python_environment_id: f.managed.pythonEnvironment.id,
        node_environment_id: null,
      },
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: row.id,
        relative_entrypoint: 'main.py',
        language: 'PYTHON',
        cwd_mode: 'WORKSPACE_ROOT',
        cwd_relative_path: null,
      },
    });
    const run = await f.engine.submit(task.task.id);
    await f.engine.tick();
    const deadline = Date.now() + 30000;
    let logs = '';
    while (Date.now() < deadline) {
      logs = JSON.stringify(await f.engine.logs(run.id));
      if (logs.includes('S3_MANAGED_STARTED')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(logs.includes('S3_MANAGED_STARTED'));
    assert.ok(logs.includes(f.dataRoot + '/runtime/'));
    assert.equal((await f.leases.probeWorkspace(row.id)).busy, true);
    await assert.rejects(
      new WorkspaceFileService(f.store, f.roots, f.leases).create(
        row.id,
        'editor-must-wait.py',
        'print("blocked")\n',
      ),
      { error_code: 'WORKSPACE_BUSY' },
    );
    await fs.writeFile(
      path.join(repository.source, 'main.py'),
      code + 'print("UPDATED_SOURCE")\n',
    );
    git(['add', 'main.py'], repository.source);
    git(
      ['commit', '-m', 'remote advances while real Python active'],
      repository.source,
    );
    const target = git(['rev-parse', 'HEAD'], repository.source);
    const blocked = await f.sync.wait((await f.sync.submit(row.id)).id);
    assert.equal(blocked.status, 'BLOCKED', blocked.error_code);
    assert.equal(blocked.error_code, 'WORKSPACE_BUSY');
    assert.equal(
      git(['rev-parse', 'HEAD'], f.roots.path(row)),
      baseline.after_commit,
    );
    assert.equal(
      (
        await f.store.all(
          'SELECT COUNT(*) n FROM WorkspaceUpdateOutbox WHERE workspace_id=?',
          [row.id],
        )
      )[0].n,
      1,
    );
    await fs.writeFile(gate, 'release\n', { mode: 0o600, flag: 'wx' });
    const finished = await f.engine.wait(run.id);
    assert.equal(finished.status, 'SUCCESS', finished.result_code);
    assert.equal(
      JSON.parse(finished.source_snapshot).git.commit,
      baseline.after_commit,
    );
    const applied = await f.sync.wait((await f.sync.submit(row.id)).id);
    assert.equal(applied.status, 'SUCCESS', applied.error_code);
    assert.equal(applied.after_commit, target);
    assert.equal((await f.engine.attempts(run.id)).length, 1);
    await scenario.record('S3-MANAGED-CONCURRENCY', {
      prepared_runtime_reused: !!f.prepared,
      python_environment_id: f.managed.pythonEnvironment.id,
      workspace_id: row.id,
      task_id: task.task.id,
      task_run_id: run.id,
      attempt_count: 1,
      old_commit: baseline.after_commit,
      blocked_sync_id: blocked.id,
      blocked_reason: blocked.error_code,
      success_sync_id: applied.id,
      new_commit: target,
      managed_executable_proven: true,
      host_fallback: false,
    });
  },
);
