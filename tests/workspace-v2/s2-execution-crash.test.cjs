const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createFixture, git } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  WorkspaceEnvironmentService,
} = require('../../back/services/taskExecutionV2/environment');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');

async function fixture(
  t,
  language = 'SHELL',
  gitWorkspace = false,
  complete = false,
) {
  const managed = language !== 'SHELL';
  const f = managed
    ? await require('./s2-runtime-fixture.cjs').createManagedRuntimeFixture(t)
    : await createFixture(t);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const key = randomUUID();
  let row;
  if (gitWorkspace) {
    const repoId = (
      await f.store.all('SELECT COALESCE(MAX(id),0)+1 id FROM Repositories')
    )[0].id;
    const remote = path.join(f.root, 'crash-remote-' + key);
    await fs.mkdir(remote, { mode: 0o700 });
    git(['init', '--initial-branch=main'], remote);
    await fs.writeFile(path.join(remote, 'seed.txt'), 'owned Git source');
    git(['add', '.'], remote);
    git(['commit', '-m', 'S2 isolated crash fixture'], remote);
    const bare = path.join(
      await f.roots.directory('git', true),
      `repository-${repoId}.git`,
    );
    git(['clone', '--no-hardlinks', '--bare', remote, bare], f.root);
    await f.store.run(
      "INSERT INTO Repositories(id,name,provider,remote_url,normalized_url,storage_path,storage_state,default_branch) VALUES(?,?,'github',?,?,?,'READY','main')",
      [
        repoId,
        'crash-repo-' + key,
        'https://example.invalid/' + key,
        'https://example.invalid/' + key,
        bare,
      ],
    );
    row = await lifecycle.createGit({
      name: 'engine crash Git',
      requestKey: key,
      repositoryId: repoId,
      refType: 'branch',
      refName: 'main',
    });
  } else
    row = await lifecycle.createLocal({
      name: 'engine crash LOCAL',
      requestKey: key,
    });
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  await files.createDirectory(row.id, 'scripts');
  await files.createDirectory(row.id, 'custom');
  await files.create(row.id, 'custom/config.txt', 'ORIGINAL_USER_BYTES');
  const extension =
    language === 'PYTHON' ? 'py' : language === 'JAVASCRIPT' ? 'js' : 'sh';
  const source =
    language === 'PYTHON'
      ? 'import os,sys,time\nopen(sys.argv[1],"w").write(str(os.getpid()))\nprint("REAL_MAIN_STARTED",flush=True)\ntime.sleep(30)\n'
      : language === 'JAVASCRIPT'
      ? 'require("fs").writeFileSync(process.argv[2],String(process.pid));console.log("REAL_MAIN_STARTED");setTimeout(()=>{},30000);\n'
      : 'printf "%s" "$$" > "$1"; printf "REAL_MAIN_STARTED\\n"; sleep ' +
        (complete ? '0.1' : '30') +
        '\n';
  await files.create(row.id, 'scripts/main.' + extension, source);
  const tasks = new TaskService(f.store, f.roots, f.leases);
  const pidFile = path.join(f.root, 'child-pid-' + key);
  const definition = await tasks
    .create({
      name: 'real crash task',
      arguments: [pidFile],
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: row.id,
        relative_entrypoint: 'scripts/main.' + extension,
        language,
        cwd_mode: 'CUSTOM_RELATIVE',
        cwd_relative_path: 'custom',
      },
      runtime:
        language === 'PYTHON'
          ? {
              kind: 'PYTHON',
              python_environment_id: f.managed.pythonEnvironment.id,
              node_environment_id: null,
            }
          : language === 'JAVASCRIPT'
          ? {
              kind: 'NODE',
              node_environment_id: f.managed.nodeEnvironment.id,
              python_environment_id: null,
            }
          : null,
      execution: { timeout_seconds: 40, max_attempts: 1, concurrency: 'ALLOW' },
    })
    .catch((error) => {
      error.message = 'FIXTURE_TASK_CREATE:' + error.message;
      throw error;
    });
  const secret = 'S2_ENGINE_CRASH_SECRET_' + key;
  const assetId = (
    await f.store
      .run(
        'INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES(?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        ['crash-secret-' + key],
      )
      .catch((error) => {
        error.message = 'FIXTURE_ASSET_CREATE:' + error.message;
        throw error;
      })
  ).lastID;
  const directory = await f.roots.directory(
    `config-assets/asset-${assetId}/revisions/1`,
    true,
  );
  await fs.writeFile(path.join(directory, 'content'), secret, { mode: 0o400 });
  const revisionId = (
    await f.store.run(
      'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,size,checksum,storage_key,createdAt) VALUES(?,1,?,?,?,CURRENT_TIMESTAMP)',
      [
        assetId,
        Buffer.byteLength(secret),
        createHash('sha256').update(secret).digest('hex'),
        `asset-${assetId}/revisions/1/content`,
      ],
    )
  ).lastID;
  await f.store.run(
    'UPDATE ConfigAssets SET current_revision_id=? WHERE id=?',
    [revisionId, assetId],
  );
  await new WorkspaceEnvironmentService(f.store, f.roots, f.leases)
    .saveWorkspaceConfig(row.id, (await f.store.workspace(row.id)).version, {
      asset_id: assetId,
      revision_id: revisionId,
      operation: 'ATTACH',
      target_base: 'TASK_CWD',
      target_path: 'config.txt',
      materialization_mode: 'COPY',
      conflict_policy: 'BACKUP_AND_RESTORE',
      writable: false,
      enabled: true,
    })
    .catch((error) => {
      error.message = 'FIXTURE_CONFIG_BINDING:' + error.message;
      throw error;
    });
  const engine = new TaskExecutionService(f.store, f.roots, f.leases);
  const run = await engine
    .submit(definition.task.id, { submissionKey: 'crash-' + key })
    .catch((error) => {
      error.message = 'FIXTURE_RUN_SUBMIT:' + error.message;
      throw error;
    });
  await engine.close();
  return { ...f, row, definition, run, pidFile, secret };
}

async function worker(t, f, checkpoint) {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 's2-execution-crash-worker.cjs'),
      f.dataRoot,
      String(f.run.id),
      checkpoint,
    ],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stderr.on('data', (b) => {
    output += b;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  return {
    ...(await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    })),
    output,
  };
}

function assertChildStopped(pid) {
  if (!pid) return;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  // Darwin can retain a zombie-only process group after the leader is reaped.
  // No live descendant may remain; do not confuse that kernel artifact with a writer.
  const members = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([group, status]) => Number(group) === pid && !status.startsWith('Z'),
    );
  assert.deepEqual(members, []);
}

const cases = [
  'BEFORE_LEASE',
  'AFTER_LEASE',
  'AFTER_SOURCE_SNAPSHOT',
  'BEFORE_CONFIG_INJECTION',
  'DURING_CONFIG_INJECTION',
  'AFTER_CONFIG_INJECTION',
  'DURING_RUNNER',
  'DURING_CLEANUP',
  'AFTER_CHILD_EXIT',
  'BEFORE_TERMINAL_COMMIT',
];
for (const checkpoint of cases) {
  test(
    'candidate engine real SIGKILL ' +
      checkpoint +
      ' keeps one Run and recovers original custom-CWD config',
    async (t) => {
      const f = await fixture(
        t,
        'SHELL',
        false,
        [
          'DURING_CLEANUP',
          'AFTER_CHILD_EXIT',
          'BEFORE_TERMINAL_COMMIT',
        ].includes(checkpoint),
      );
      await f.store.close();
      const killed = await worker(t, f, checkpoint);
      assert.equal(killed.signal, 'SIGKILL', killed.output);
      const recovered = await worker(t, f, 'RECOVER');
      assert.equal(recovered.code, 0, recovered.output);
      const store = f.track(
        await WorkspaceStore.open(f.databasePath, f.dataRoot),
      );
      const rows = await store.all(
        'SELECT * FROM TaskRuns WHERE submission_key=?',
        [f.run.submission_key],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, f.run.id);
      assert.equal(rows[0].status, 'INTERRUPTED');
      assert.equal(rows[0].active_workspace_id, null);
      assert.equal(rows[0].owner_token, null);
      assert.equal(rows[0].admission_snapshot, f.run.admission_snapshot);
      assert.equal(
        await fs.readFile(
          path.join(f.roots.path(f.row), 'custom/config.txt'),
          'utf8',
        ),
        'ORIGINAL_USER_BYTES',
      );
      const configRoot = path.join(f.dataRoot, 'tmp/config-materialization');
      assert.deepEqual(
        await fs
          .readdir(configRoot)
          .catch((e) => (e.code === 'ENOENT' ? [] : Promise.reject(e))),
        [],
      );
      // At the terminal-commit boundary the child's completed Attempt is already
      // durable; only the enclosing Run was interrupted before committing success.
      for (const attempt of await store.all(
        'SELECT status FROM TaskRunAttempts WHERE task_run_id=?',
        [f.run.id],
      ))
        assert.equal(
          attempt.status,
          checkpoint === 'BEFORE_TERMINAL_COMMIT' ? 'SUCCESS' : 'INTERRUPTED',
        );
      const pid = Number(await fs.readFile(f.pidFile, 'utf8').catch(() => '0'));
      assertChildStopped(pid);
    },
  );
}

for (const [checkpoint, language, kind] of [
  ['AFTER_RUNTIME_PIN', 'PYTHON', 'LOCAL'],
  ['NODE_INSTALLED', 'JAVASCRIPT', 'LOCAL'],
  ['DURING_RUNNER', 'JAVASCRIPT', 'GIT'],
]) {
  test(
    'managed ' +
      language +
      ' ' +
      kind +
      ' actual engine SIGKILL ' +
      checkpoint +
      ' releases pin only after child recovery',
    async (t) => {
      const f = await fixture(t, language, kind === 'GIT');
      await f.store.close();
      const killed = await worker(t, f, checkpoint);
      assert.equal(killed.signal, 'SIGKILL', killed.output);
      const recovered = await worker(t, f, 'RECOVER');
      assert.equal(recovered.code, 0, recovered.output);
      const store = f.track(
        await WorkspaceStore.open(f.databasePath, f.dataRoot),
      );
      const run = (
        await store.all('SELECT * FROM TaskRuns WHERE id=?', [f.run.id])
      )[0];
      assert.equal(run.status, 'INTERRUPTED');
      assert.equal(run.active_workspace_id, null);
      assert.equal(run.owner_token, null);
      assert.equal(
        await fs.readFile(
          path.join(f.roots.path(f.row), 'custom/config.txt'),
          'utf8',
        ),
        'ORIGINAL_USER_BYTES',
      );
      await assert.rejects(
        fs.lstat(path.join(f.roots.path(f.row), 'node_modules')),
        { code: 'ENOENT' },
      );
      const pid = Number(await fs.readFile(f.pidFile, 'utf8').catch(() => '0'));
      assertChildStopped(pid);
    },
  );
}
