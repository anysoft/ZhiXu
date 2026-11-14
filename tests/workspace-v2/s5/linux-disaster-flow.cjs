// S5 copy of the original S1.B safety assertions, using only explicit compiled artifacts.
const {
  artifactModule,
  candidateIdentity,
  releaseRoot,
} = require('./artifact-support.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { provisionManagedRuntime } = require('./linux-disaster-runtime.cjs');
const {
  seedRepository,
  git,
  projectRoot,
} = require('./linux-disaster-base.cjs');
const {
  rebuildRestoredManagedRuntime,
} = require('./linux-disaster-rebuild.cjs');
const { WorkspaceLifecycleService } = artifactModule(
  'services/workspaceV2/lifecycle',
);
const { WorkspaceFileService } = artifactModule('services/workspaceV2/files');
const { WorkspaceBackupService } = artifactModule(
  'services/workspaceV2/backup',
);
const { WorkspaceRestoreService } = artifactModule(
  'services/workspaceV2/restore',
);
const { scanWorkspace } = artifactModule('services/workspaceV2/inventory');
const { TaskService } = artifactModule('services/taskExecutionV2/task');
const { WorkspaceEnvironmentService } = artifactModule(
  'services/taskExecutionV2/environment',
);
const { TaskExecutionService } = artifactModule(
  'services/taskExecutionV2/execution',
);
const { ManagedRuntimeAdapter } = artifactModule(
  'services/taskExecutionV2/runtime',
);

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const variable = (name, value, secret = false) => ({
  name,
  value,
  operation: 'SET',
  status: 'enabled',
  is_secret: secret,
});
const extensions = {
  PYTHON: 'py',
  JAVASCRIPT: 'cjs',
  TYPESCRIPT: 'ts',
  SHELL: 'sh',
};
const directories = {
  PYTHON: 'python',
  JAVASCRIPT: 'javascript',
  TYPESCRIPT: 'typescript',
  SHELL: 'shell',
};

async function executeDisasterMatrix(
  instance,
  label,
  { cases, physicalA, localCommit, secretList, oldDataRoot },
) {
  const execution = instance.execution;
  const result = [];
  for (const c of cases) {
    const submitted = await execution.submit(c.taskId, {
      submissionKey: 's1b-' + label + '-' + c.taskId,
    });
    assert.equal(
      (
        await execution.submit(c.taskId, {
          submissionKey: submitted.submission_key,
        })
      ).id,
      submitted.id,
    );
    const run = await execution.wait(submitted.id, 60000);
    assert.equal(
      run.status,
      'SUCCESS',
      JSON.stringify({
        label,
        taskId: c.taskId,
        language: c.language,
        status: run.status,
        error: run.error_code,
      }),
    );
    const attempts = await execution.attempts(run.id),
      logs = await execution.logs(run.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'SUCCESS');
    assert.equal(attempts[0].exit_code, 0);
    assert.equal(JSON.parse(attempts[0].result).cleanupResult, 'SUCCESS');
    for (const secret of secretList)
      assert.equal(
        logs.includes(secret),
        false,
        'runtime log must redact every private sentinel',
      );
    assert.match(logs, new RegExp('S1B_MAIN_' + c.language));
    assert.ok(logs.includes('literal argument $NOT_EXPANDED'));
    for (const hook of ['BEFORE', 'AFTER_SUCCESS', 'FINALLY'])
      assert.ok(logs.includes('S1B_HOOK_' + hook));
    assert.equal(logs.includes('S1B_HOOK_AFTER_FAILURE'), false);
    if (label === 'B')
      assert.equal(
        logs.includes(oldDataRoot),
        false,
        'new child must not resolve an old A path',
      );
    const snapshot = JSON.parse(run.source_snapshot),
      runtime = JSON.parse(run.snapshot_metadata).runtime;
    assert.equal(snapshot.workspace_id, c.workspace.id);
    assert.equal(snapshot.workspace_type, c.workspace.type);
    assert.equal(
      snapshot.relative_entrypoint,
      `${directories[c.language]}/main.${extensions[c.language]}`,
    );
    if (c.workspace.type === 'GIT')
      assert.equal(snapshot.git.commit, localCommit);
    else assert.equal(snapshot.git, null);
    if (c.language === 'PYTHON') {
      assert.equal(runtime.runtime_id, physicalA.python.runtimeId);
      assert.ok(logs.includes(instance.dataRoot + '/runtime/python/'));
    }
    if (['JAVASCRIPT', 'TYPESCRIPT'].includes(c.language)) {
      assert.equal(runtime.runtime_id, physicalA.node.runtimeId);
      assert.ok(logs.includes(instance.dataRoot + '/runtime/node/'));
    }
    assert.equal(
      await fs.readFile(
        path.join(instance.roots.path(c.workspace), 'config/settings.json'),
        'utf8',
      ),
      'ORIGINAL_CONFIG_BYTES',
    );
    await assert.rejects(
      fs.lstat(path.join(instance.roots.path(c.workspace), 'node_modules')),
      { code: 'ENOENT' },
    );
    assert.equal(
      (await instance.leases.probeWorkspace(c.workspace.id)).busy,
      false,
    );
    result.push({
      case_id: label + '-' + c.workspace.type + '-' + c.language,
      expected: 'SUCCESS/one-real-Attempt/exit-0/restored-config',
      workspace_type: c.workspace.type,
      workspace_id: c.workspace.id,
      language: c.language,
      task_id: c.taskId,
      run_id: run.id,
      attempt_id: attempts[0].id,
      status: run.status,
      exit_code: attempts[0].exit_code,
      duration_ms: JSON.parse(run.result).duration,
      source_generation: snapshot.source_generation,
      source_hash: snapshot.inventory_hash,
      entrypoint_hash: snapshot.entrypoint_checksum,
      runtime,
      log_sha256: sha(logs),
      cleanup: 'SUCCESS',
    });
  }
  // The actual application owns and closes its one execution engine.
  return result;
}

async function runInstanceA(sandbox) {
  const A = await sandbox.createInstance('A');
  const key = randomBytes(48);
  const secrets = {
    env: 'S1B_ENV_' + randomBytes(24).toString('hex'),
    workspace: 'S1B_CONFIG_' + randomBytes(24).toString('hex'),
    task: 'S1B_TASK_CONFIG_' + randomBytes(24).toString('hex'),
  };
  const secretList = Object.values(secrets);
  // Restored B authenticates using this same private value recovered from its archive.
  A.ownerPassword = secrets.env;
  for (const secret of secretList) sandbox.registerSecret(secret);
  sandbox.registerSecret(key.toString('base64'));
  const asset = async (instance, label, bytes) => {
    const id = (
      await instance.store.run(
        'INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES(?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        [label],
      )
    ).lastID;
    const key = `asset-${id}/revisions/1/content`;
    const directory = await instance.roots.directory(
      `config-assets/asset-${id}/revisions/1`,
      true,
    );
    await fs.writeFile(path.join(directory, 'content'), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    const revision = (
      await instance.store.run(
        'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,1,?,?,?,CURRENT_TIMESTAMP)',
        [id, sha(bytes), Buffer.byteLength(bytes), key],
      )
    ).lastID;
    await instance.store.run(
      'UPDATE ConfigAssets SET current_revision_id=? WHERE id=?',
      [revision, id],
    );
    return { id, revision };
  };
  const source = (language) => {
    if (language === 'PYTHON')
      return "import os,sys,pathlib\nsys.dont_write_bytecode=True\nfrom helper import VALUE\nc=pathlib.Path('../config/settings.json').read_text()\nassert c==os.environ['S1B_EXPECT_CONFIG']\nassert os.environ['S1B_VALUE']=='task-value' and os.environ['S1B_GLOBAL']=='global-value' and 'S1B_UNSET' not in os.environ\nassert os.environ['S1B_SECRET']\nprint('S1B_MAIN_PYTHON',VALUE,sys.executable,os.getcwd(),sys.argv[1],os.environ['S1B_SECRET'],c)\n";
    if (language === 'JAVASCRIPT' || language === 'TYPESCRIPT') {
      const head =
        language === 'JAVASCRIPT'
          ? "const fs=require('node:fs'),isNumber=require('is-number');"
          : "import fs from 'node:fs'; import isNumber from 'is-number'; const typed: number=42;";
      return `${head}\nconst c=fs.readFileSync('../config/settings.json','utf8'); if(c!==process.env.S1B_EXPECT_CONFIG || process.env.S1B_VALUE!=='task-value' || process.env.S1B_GLOBAL!=='global-value' || 'S1B_UNSET' in process.env || !process.env.S1B_SECRET || !isNumber(42))process.exit(71);console.log('S1B_MAIN_${language}',process.execPath,process.cwd(),process.argv[2],process.env.S1B_SECRET,c);\n`;
    }
    return (
      'test "$S1B_VALUE" = task-value && test "$S1B_GLOBAL" = global-value && test "${S1B_UNSET-unset}" = unset && test -n "$S1B_SECRET" || exit 72\n' +
      'test "$(cat ../config/settings.json)" = "$S1B_EXPECT_CONFIG" || exit 73\nprintf "S1B_MAIN_SHELL %s %s %s\\n" "$PWD" "$1" "$S1B_SECRET"\ncat ../config/settings.json\n'
    );
  };
  let phase = 'PROVISION_A';
  try {
    const managedA = await sandbox.measure('runtime-provision-A', () =>
      provisionManagedRuntime(A),
    );
    const adapterA = new ManagedRuntimeAdapter(A.store);
    const physicalA = {
      python: await adapterA.inspect(
        'PYTHON',
        managedA.pythonEnvironment.id,
        'PYTHON',
      ),
      node: await adapterA.inspect(
        'NODE',
        managedA.nodeEnvironment.id,
        'TYPESCRIPT',
      ),
    };
    const lifecycle = A.app.services.lifecycle;
    const files = A.app.services.files;
    const tasks = A.app.services.tasks;
    const resources = A.app.services.environment;
    const engine = A.execution;
    const repository = await seedRepository(A);
    const workspaces = [
      await lifecycle.createLocal({
        name: 'S1B unique LOCAL',
        requestKey: 's1b-local',
      }),
      await lifecycle.createGit({
        name: 'S1B actual GIT',
        requestKey: 's1b-git',
        repositoryId: repository.id,
        refType: 'branch',
        refName: 'main',
      }),
    ];
    const config = await asset(
      A,
      'S1B Workspace private config',
      secrets.workspace,
    );
    const taskConfig = await asset(A, 'S1B Task private config', secrets.task);
    const globals = (
      await A.store.all(
        'SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1',
      )
    )[0];
    await resources.replaceGlobals(globals.version, [
      variable('S1B_GLOBAL', 'global-value'),
      variable('S1B_VALUE', 'global-value'),
      variable('S1B_UNSET', 'must-remove'),
      // Keep transpiled user code in process memory; B must not consume A's
      // transformations from a shared operating-system temporary cache.
      variable('TSX_DISABLE_CACHE', '1'),
    ]);
    for (const workspace of workspaces) {
      for (const directory of [
        'python',
        'javascript',
        'typescript',
        'shell',
        'config',
      ])
        await files.createDirectory(workspace.id, directory);
      await files.create(
        workspace.id,
        'config/settings.json',
        'ORIGINAL_CONFIG_BYTES',
      );
      await files.create(
        workspace.id,
        'python/helper.py',
        "VALUE='UNIQUE_AUXILIARY_SOURCE'\n",
      );
      for (const language of Object.keys(extensions))
        await files.create(
          workspace.id,
          `${directories[language]}/main.${extensions[language]}`,
          source(language),
        );
      await files.create(workspace.id, 'dirty.txt', 'tracked clean bytes\n');
      await files.create(
        workspace.id,
        'staged.txt',
        'tracked initial index bytes\n',
      );
      for (const [kind, id] of [
        ['PYTHON', managedA.pythonEnvironment.id],
        ['NODE', managedA.nodeEnvironment.id],
      ])
        await resources.setRuntimeDefault(
          workspace.id,
          (
            await A.store.workspace(workspace.id)
          ).version,
          kind,
          id,
        );
      const profile = await resources.createProfile(
        workspace.id,
        (
          await A.store.workspace(workspace.id)
        ).version,
        { name: 'S1B selected profile ' + workspace.id },
      );
      await resources.replaceProfileVariables(profile.id, profile.version, [
        variable('S1B_VALUE', 'profile-value'),
        variable('S1B_SECRET', secrets.env, true),
        variable('S1B_EXPECT_CONFIG', secrets.workspace, true),
      ]);
      await resources.selectWorkspaceProfile(
        workspace.id,
        (
          await A.store.workspace(workspace.id)
        ).version,
        profile.id,
      );
      await resources.saveWorkspaceConfig(
        workspace.id,
        (
          await A.store.workspace(workspace.id)
        ).version,
        {
          asset_id: config.id,
          revision_id: config.revision,
          operation: 'ATTACH',
          target_base: 'WORKSPACE_ROOT',
          target_path: 'config/settings.json',
          materialization_mode: 'COPY',
          conflict_policy: 'BACKUP_AND_RESTORE',
          writable: false,
          enabled: true,
        },
      );
    }
    const gitWorkspace = workspaces[1],
      gitRoot = A.roots.path(gitWorkspace);
    await A.leases.withRepository(
      repository.id,
      'S1B_UNIQUE_LOCAL_COMMIT',
      () =>
        A.leases.withWorkspace(
          gitWorkspace.id,
          'S1B_UNIQUE_LOCAL_COMMIT',
          async () => {
            git(
              [
                'add',
                'python',
                'javascript',
                'typescript',
                'shell',
                'config',
                'dirty.txt',
                'staged.txt',
              ],
              gitRoot,
            );
            git(
              ['commit', '-m', 'S1B local-only source and helper commit'],
              gitRoot,
            );
          },
        ),
    );
    const localCommit = git(['rev-parse', 'HEAD'], gitRoot);
    assert.notEqual(localCommit, repository.commit);
    let read = await files.read(gitWorkspace.id, 'staged.txt');
    await files.save(
      gitWorkspace.id,
      'staged.txt',
      'STAGED_UNIQUE_INDEX_BYTES\n',
      read.hash,
    );
    await A.leases.withRepository(repository.id, 'S1B_STAGE_INDEX', () =>
      A.leases.withWorkspace(gitWorkspace.id, 'S1B_STAGE_INDEX', async () =>
        git(['add', 'staged.txt'], gitRoot),
      ),
    );
    read = await files.read(gitWorkspace.id, 'dirty.txt');
    await files.save(
      gitWorkspace.id,
      'dirty.txt',
      'DIRTY_UNCOMMITTED_BYTES\n',
      read.hash,
    );
    await files.create(
      gitWorkspace.id,
      'untracked.txt',
      'UNTRACKED_UNIQUE_BYTES\n',
    );
    const cases = [];
    for (const workspace of workspaces)
      for (const language of Object.keys(extensions)) {
        let definition = await tasks.create({
          name: workspace.type + ' restored ' + language,
          arguments: ['literal argument $NOT_EXPANDED'],
          source: {
            type: 'WORKSPACE_ENTRYPOINT',
            workspace_id: workspace.id,
            relative_entrypoint: `${directories[language]}/main.${extensions[language]}`,
            language,
            cwd_mode: 'ENTRYPOINT_DIR',
            cwd_relative_path: null,
          },
          execution: { concurrency: 'ALLOW', timeout_seconds: 20 },
        });
        let values = [
          variable('S1B_VALUE', 'task-value'),
          {
            name: 'S1B_UNSET',
            operation: 'UNSET',
            status: 'enabled',
            is_secret: false,
          },
        ];
        if (language === 'JAVASCRIPT') {
          await resources.saveTaskConfig(
            definition.task.id,
            definition.task.version,
            {
              asset_id: taskConfig.id,
              revision_id: taskConfig.revision,
              operation: 'ATTACH',
              target_base: 'WORKSPACE_ROOT',
              target_path: 'config/settings.json',
              materialization_mode: 'COPY',
              conflict_policy: 'BACKUP_AND_RESTORE',
              writable: false,
              enabled: true,
            },
          );
          values.push(variable('S1B_EXPECT_CONFIG', secrets.task, true));
        } else if (language === 'SHELL') {
          await resources.saveTaskConfig(
            definition.task.id,
            definition.task.version,
            {
              operation: 'MASK',
              asset_id: null,
              revision_id: null,
              target_base: 'WORKSPACE_ROOT',
              target_path: 'config/settings.json',
              materialization_mode: 'COPY',
              conflict_policy: 'BACKUP_AND_RESTORE',
              writable: false,
              enabled: true,
            },
          );
          values.push(variable('S1B_EXPECT_CONFIG', 'ORIGINAL_CONFIG_BYTES'));
        }
        definition = await tasks.get(definition.task.id);
        definition = await resources.replaceTaskVariables(
          definition.task.id,
          definition.task.version,
          values,
        );
        definition = await resources.replaceHooks(
          definition.task.id,
          definition.task.version,
          ['BEFORE', 'AFTER_SUCCESS', 'AFTER_FAILURE', 'FINALLY'].map(
            (hook, position) => ({
              name: 'S1B ' + hook,
              phase: hook,
              position,
              command: `printf 'S1B_HOOK_${hook}\\n'`,
              cwd_base: 'TASK_CWD',
              timeout_seconds: 5,
              failure_policy: 'FAIL_EXECUTION',
              enabled: true,
            }),
          ),
        );
        cases.push({ workspace, language, taskId: definition.task.id });
        assert.equal(
          JSON.stringify(await resources.preview(definition.task.id)).includes(
            secrets.env,
          ),
          false,
        );
      }
    phase = 'EXECUTE_A';
    const matrixA = await sandbox.measure('execute-eight-A', () =>
      executeDisasterMatrix(A, 'A', {
        cases,
        physicalA,
        localCommit,
        secretList,
      }),
    );
    const historyTask = async (name, code, settings = {}) => {
      await files.create(workspaces[0].id, name + '.sh', code);
      let definition = await tasks.create({
        name,
        source: {
          type: 'WORKSPACE_ENTRYPOINT',
          workspace_id: workspaces[0].id,
          relative_entrypoint: name + '.sh',
          language: 'SHELL',
          cwd_mode: 'WORKSPACE_ROOT',
          cwd_relative_path: null,
        },
        execution: { concurrency: 'ALLOW', timeout_seconds: 40, ...settings },
      });
      definition = await resources.replaceHooks(
        definition.task.id,
        definition.task.version,
        ['BEFORE', 'AFTER_SUCCESS', 'AFTER_FAILURE', 'FINALLY'].map(
          (hook, position) => ({
            name: hook,
            phase: hook,
            position,
            command: `printf 'HISTORY_${hook}\\n'`,
            cwd_base: 'TASK_CWD',
            timeout_seconds: 5,
            failure_policy: 'FAIL_EXECUTION',
            enabled: true,
          }),
        ),
      );
      return definition.task.id;
    };
    const failedTask = await historyTask(
      'history-failure',
      'printf "ACTUAL_FAILURE\\n"\nexit 7\n',
    );
    const failed = await engine.wait((await engine.submit(failedTask)).id);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.exit_code, 7);
    assert.match(await engine.logs(failed.id), /HISTORY_AFTER_FAILURE/);
    const retryTask = await historyTask(
      'history-retry',
      'if [ "$PLATFORM_TASK_ATTEMPT" = 1 ]; then exit 9; fi\nprintf "ACTUAL_RETRY_SUCCESS\\n"\n',
      { max_attempts: 2, initial_delay_seconds: 0 },
    );
    const retried = await engine.wait((await engine.submit(retryTask)).id);
    assert.equal(retried.status, 'SUCCESS');
    assert.equal(retried.attempt_count, 2);
    assert.deepEqual(
      (await engine.attempts(retried.id)).map((attempt) => attempt.status),
      ['FAILED', 'SUCCESS'],
    );
    const cancelTask = await historyTask(
      'history-cancel',
      'printf "ACTUAL_CANCEL_READY\\n"\nsleep 30\n',
    );
    const cancellation = await engine.submit(cancelTask);
    const cancellationDeadline = Date.now() + 15000;
    while (
      !(await engine.logs(cancellation.id)).includes('ACTUAL_CANCEL_READY')
    ) {
      // The application's real scheduler tick drives this queue with its owner FD.
      assert.ok(
        Date.now() < cancellationDeadline,
        'actual cancellation child must start',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await engine.cancel(cancellation.id);
    assert.equal((await engine.wait(cancellation.id)).status, 'CANCELLED');
    // Keep the application engine alive until the complete instance closes.
    const definitions = {};
    for (const table of [
      'Tasks',
      'TaskSources',
      'TaskRuntimeBindings',
      'TaskExecutionSettings',
      'TaskHooks',
      'TaskEnvVariables',
      'WorkspaceRuntimeDefaults',
      'EnvironmentProfiles',
      'WorkspaceProfileVariables',
      'WorkspaceConfigBindings',
      'TaskConfigBindings',
      'Envs',
    ])
      definitions[table] = JSON.stringify(
        await A.store.all('SELECT * FROM ' + table + ' ORDER BY rowid'),
      );
    const history = {};
    for (const table of ['TaskRuns', 'TaskRunAttempts', 'TaskRunEvents'])
      history[table] = await A.store.all(
        'SELECT * FROM ' + table + ' ORDER BY id',
      );
    const logHashes = {};
    for (const run of history.TaskRuns)
      logHashes[run.id] = sha(await engine.logs(run.id));
    const inventories = {};
    for (const workspace of workspaces)
      inventories[workspace.id] = await scanWorkspace(
        A.roots.path(workspace),
        workspace.type,
      );
    const gitIndex = git(['rev-parse', '--git-path', 'index'], gitRoot);
    const gitState = {
      head: git(['rev-parse', 'HEAD'], gitRoot),
      branch: git(['symbolic-ref', '--short', 'HEAD'], gitRoot),
      porcelain: git(
        [
          '--no-optional-locks',
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
        ],
        gitRoot,
      ),
      index_sha256: sha(
        await fs.readFile(
          path.isAbsolute(gitIndex) ? gitIndex : path.join(gitRoot, gitIndex),
        ),
      ),
    };
    assert.ok(gitState.porcelain.includes('M dirty.txt'));
    assert.ok(gitState.porcelain.includes('M  staged.txt'));
    assert.ok(gitState.porcelain.includes('?? untracked.txt'));
    phase = 'BACKUP_EXPORT';
    const backupA = new WorkspaceBackupService(
      A.store,
      A.roots,
      A.leases,
      A.backupRoot,
    );
    const snapshotId = await sandbox.measure('backup-A', () =>
      backupA.create(),
    );
    const snapshot = await backupA.snapshot(snapshotId);
    assert.equal(snapshot.manifest.format_family, 'zhixu-workspace-backup');
    assert.equal(snapshot.manifest.format_version, 2);
    assert.equal(snapshot.manifest.workspaces.length, 2);
    const manifestBytes = await fs.readFile(
      path.join(snapshot.root, 'manifest.json'),
    );
    for (const secret of secretList)
      assert.equal(
        manifestBytes.includes(Buffer.from(secret)),
        false,
        'public manifest must not contain private sentinel',
      );
    const encrypted = await sandbox.measure('encrypted-export-A', () =>
      backupA.exportPortable(snapshotId, Buffer.from(key)),
    );
    const portable = path.join(sandbox.transferRoot, 'full-asset.encrypted');
    await fs.copyFile(encrypted, portable, fs.constants?.COPYFILE_EXCL || 1);
    await fs.chmod(portable, 0o600);
    const archiveBytes = await fs.readFile(portable),
      archiveHash = sha(archiveBytes);
    for (const secret of secretList)
      assert.equal(
        archiveBytes.includes(Buffer.from(secret)),
        false,
        'portable archive must not expose private sentinel',
      );
    await sandbox.record('full-disaster-A-assets', {
      status: 'PASS',
      workspace_ids: workspaces.map((ws) => ws.id),
      task_ids: cases.map((c) => c.taskId),
      matrix: matrixA,
      history_run_ids: history.TaskRuns.map((run) => run.id),
      failed_run_id: failed.id,
      cancelled_run_id: cancellation.id,
      retry_run_id: retried.id,
      historical_log_hashes: logHashes,
      source_inventories: inventories,
      git: gitState,
      initial_runtime: physicalA,
      backup: {
        id: snapshotId,
        format_version: 2,
        manifest_sha256: sha(manifestBytes),
        archive_sha256: archiveHash,
        archive_size: archiveBytes.length,
        source_bytes: Object.values(inventories).reduce(
          (total, inventory) => total + inventory.totalBytes,
          0,
        ),
        authenticated_encryption: true,
      },
      secret_sentinel_hashes: Object.values(secrets).map(sha),
    });
    phase = 'DESTROY_A';
    const destruction = await sandbox.measure('destroy-A', () =>
      sandbox.safeDestroy(A, { archivePath: portable }),
    );
    for (const name of [
      A.root,
      A.dataRoot,
      path.join(A.dataRoot, 'runtime'),
      A.controlRoot,
      repository.source,
    ])
      await assert.rejects(fs.lstat(name), { code: 'ENOENT' });
    assert.equal(sha(await fs.readFile(portable)), archiveHash);

    assert.equal(
      archiveBytes.includes(key),
      false,
      'raw transfer key must not appear in the encrypted export',
    );
    const strip = (runtime) =>
      Object.fromEntries(
        Object.entries(runtime).filter(
          ([name]) =>
            ![
              'executable',
              'venvRoot',
              'buildRoot',
              'nodeModulesRoot',
              'tsxCli',
            ].includes(name),
        ),
      );
    const baseline = {
      version: 1,
      A_controller_pid: process.pid,
      workspaces: workspaces.map((ws) => ({
        id: ws.id,
        type: ws.type,
        root_key: ws.root_key,
      })),
      cases: cases.map((c) => ({
        workspace_id: c.workspace.id,
        workspace_type: c.workspace.type,
        language: c.language,
        taskId: c.taskId,
      })),
      physicalA: {
        python: strip(physicalA.python),
        node: strip(physicalA.node),
      },
      matrixA,
      definitions: Object.fromEntries(
        Object.entries(definitions).map(([table, rows]) => [table, sha(rows)]),
      ),
      history: Object.fromEntries(
        Object.entries(history).map(([table, rows]) => [
          table,
          { ids: rows.map((row) => row.id), sha256: sha(JSON.stringify(rows)) },
        ]),
      ),
      logHashes,
      inventories: Object.fromEntries(
        Object.entries(inventories).map(([id, inventory]) => [
          id,
          {
            hash: inventory.hash,
            fileCount: inventory.fileCount,
            totalBytes: inventory.totalBytes,
            entryCount: inventory.entryCount,
          },
        ]),
      ),
      gitState: {
        head: gitState.head,
        branch: gitState.branch,
        porcelain_sha256: sha(gitState.porcelain),
        index_sha256: gitState.index_sha256,
      },
      repositoryId: repository.id,
      gitWorkspaceId: gitWorkspace.id,
      backup: {
        id: snapshotId,
        archive_sha256: archiveHash,
        manifest_sha256: sha(manifestBytes),
        archive_size: archiveBytes.length,
      },
      secret_hashes: secretList.map(sha).sort(),
    };
    const encoded = JSON.stringify(baseline, null, 2) + '\n';
    for (const secret of secretList)
      assert.equal(
        encoded.includes(secret),
        false,
        'baseline must contain only hashes/IDs, never private values',
      );
    assert.equal(encoded.includes(key.toString('base64')), false);
    const baselinePath = path.join(sandbox.transferRoot, 'full-baseline.json');
    const handle = await fs.open(baselinePath, 'wx', 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await sandbox.record('full-disaster-A-process-complete', {
      status: 'PASS',
      controller_pid: process.pid,
      archive_sha256: archiveHash,
      baseline_sha256: sha(encoded),
      A_data_absent: true,
      A_runtime_absent: true,
      A_control_absent: true,
      destruction,
    });
    return { baselinePath, archivePath: portable, key };
  } catch (error) {
    key.fill(0);
    await sandbox.record('full-disaster-A-failure', {
      status: 'FAIL',
      phase,
      error_code: error.error_code ?? error.code ?? 'ASSERTION_FAILED',
    });
    throw error;
  }
}

async function runInstanceB(sandbox, key) {
  assert.ok(
    Buffer.isBuffer(key) && key.length === 48,
    'B must receive a bounded binary transfer key',
  );
  sandbox.registerSecret(key.toString('base64'));
  const baselinePath = path.join(sandbox.transferRoot, 'full-baseline.json');
  const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
  assert.equal(baseline.version, 1);
  assert.notEqual(
    process.pid,
    baseline.A_controller_pid,
    'B controller must be a new OS process',
  );
  const A = { root: path.join(sandbox.root, 'instance-A') };
  A.dataRoot = path.join(A.root, 'data');
  A.controlRoot = A.dataRoot + '.platform-control';
  for (const file of [
    A.root,
    A.dataRoot,
    path.join(A.dataRoot, 'runtime'),
    A.controlRoot,
  ])
    await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  const {
    physicalA,
    matrixA,
    definitions,
    history,
    inventories,
    logHashes,
    gitState,
  } = baseline;
  const workspaces = baseline.workspaces;
  const localCommit = gitState.head;
  const portable = path.join(sandbox.transferRoot, 'full-asset.encrypted');
  assert.equal(
    sha(await fs.readFile(portable)),
    baseline.backup.archive_sha256,
  );
  let phase = 'RESTORE_B';
  try {
    const B = await sandbox.createInstance('B');
    assert.notEqual(A.dataRoot, B.dataRoot);
    assert.notEqual(A.controlRoot, B.controlRoot);
    const backupB = new WorkspaceBackupService(
      B.store,
      B.roots,
      B.leases,
      B.backupRoot,
    );
    const imported = await sandbox.measure('authenticated-import-B', () =>
      backupB.importPortable(portable, Buffer.from(key)),
    );
    const checkpoints = [];
    const restore = new WorkspaceRestoreService(backupB, {
      fault: async (name) => {
        checkpoints.push(name);
      },
    });
    const restored = await sandbox.measure('whole-root-restore-B', () =>
      restore.restore(imported.id, 'imports'),
    );
    await B.useStore(restored);
    assert.equal((await restore.status()).stage, 'COMPLETE');

    // Secrets cross the disaster boundary only within the authenticated archive.
    // B obtains them from its own recovered private database/revisions.
    const secretValues = new Set();
    for (const table of [
      'Envs',
      'TaskEnvVariables',
      'WorkspaceProfileVariables',
    ])
      for (const row of await B.store.all(
        `SELECT value FROM ${table} WHERE is_secret=1 AND operation='SET'`,
      ))
        if (typeof row.value === 'string' && row.value)
          secretValues.add(row.value);
    const { WorkspaceRevisionReader } = artifactModule(
      'services/taskExecutionV2/materialization',
    );
    const reader = new WorkspaceRevisionReader(B.store, B.roots);
    for (const revision of await B.store.all(
      'SELECT r.* FROM ConfigAssetRevisions r JOIN ConfigAssets a ON a.id=r.asset_id WHERE a.is_secret=1',
    ))
      secretValues.add((await reader.readRevision(revision)).toString('utf8'));
    const secretList = [...secretValues];
    for (const secret of secretList) sandbox.registerSecret(secret);
    assert.deepEqual(
      secretList.map(sha).sort(),
      baseline.secret_hashes,
      'B restored its own private sentinels',
    );
    for (const table of Object.keys(definitions))
      assert.equal(
        sha(
          JSON.stringify(
            await B.store.all('SELECT * FROM ' + table + ' ORDER BY rowid'),
          ),
        ),
        definitions[table],
        'restored private definitions and reference hashes must be identical: ' +
          table,
      );
    for (const table of Object.keys(history))
      assert.equal(
        sha(
          JSON.stringify(
            await B.store.all('SELECT * FROM ' + table + ' ORDER BY id'),
          ),
        ),
        history[table].sha256,
        'historical row identity and bytes must be identical: ' + table,
      );
    const engineB = B.execution;
    for (const id of history.TaskRuns.ids)
      assert.equal(sha(await engineB.logs(id)), logHashes[id]);
    await engineB.recover();
    assert.equal(
      (await B.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
      history.TaskRuns.ids.length,
      'completed history must never replay',
    );
    for (const workspace of workspaces) {
      const row = await B.store.workspace(workspace.id);
      assert.equal(row.id, workspace.id);
      assert.equal(row.lifecycle_state, 'READY');
      assert.equal(row.storage_state, 'PRESENT');
      assert.ok(B.roots.path(row).startsWith(B.dataRoot + path.sep));
      assert.equal(
        (await scanWorkspace(B.roots.path(row), row.type)).hash,
        inventories[row.id].hash,
      );
      assert.equal(
        await fs.readFile(
          path.join(B.roots.path(row), 'config/settings.json'),
          'utf8',
        ),
        'ORIGINAL_CONFIG_BYTES',
      );
    }
    const restoredGitRoot = B.roots.path(
      await B.store.workspace(baseline.gitWorkspaceId),
    );
    assert.equal(git(['rev-parse', 'HEAD'], restoredGitRoot), gitState.head);
    assert.equal(
      git(['symbolic-ref', '--short', 'HEAD'], restoredGitRoot),
      gitState.branch,
    );
    const restoredIndex = git(
      ['rev-parse', '--git-path', 'index'],
      restoredGitRoot,
    );
    const indexFile = path.isAbsolute(restoredIndex)
      ? restoredIndex
      : path.join(restoredGitRoot, restoredIndex);
    assert.equal(sha(await fs.readFile(indexFile)), gitState.index_sha256);
    const status = git(
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ],
      restoredGitRoot,
    );
    assert.equal(sha(status), gitState.porcelain_sha256);
    assert.equal(
      await fs.readFile(path.join(restoredGitRoot, 'dirty.txt'), 'utf8'),
      'DIRTY_UNCOMMITTED_BYTES\n',
    );
    assert.equal(
      await fs.readFile(path.join(restoredGitRoot, 'untracked.txt'), 'utf8'),
      'UNTRACKED_UNIQUE_BYTES\n',
    );
    assert.equal(
      git(['show', ':staged.txt'], restoredGitRoot),
      'STAGED_UNIQUE_INDEX_BYTES',
    );
    assert.equal(
      (
        await B.store.all('SELECT storage_path FROM Repositories WHERE id=?', [
          baseline.repositoryId,
        ])
      )[0].storage_path,
      path.join(B.dataRoot, 'git', `repository-${baseline.repositoryId}.git`),
    );
    const cases = [];
    for (const original of baseline.cases)
      cases.push({
        language: original.language,
        taskId: original.taskId,
        workspace: await B.store.workspace(original.workspace_id),
      });

    phase = 'MISSING_RUNTIME_REJECTION';
    const tasksB = B.app.services.tasks;
    const missingInstallations = await B.store.all(
      'SELECT id,language,version,state FROM RuntimeInstallations ORDER BY id',
    );
    assert.equal(missingInstallations.length, 2);
    assert.ok(
      missingInstallations.every((runtime) => runtime.state === 'MISSING'),
    );
    for (const relative of [
      `runtime/python/environments/env-${physicalA.python.environmentId}/builds/build-${physicalA.python.buildId}/venv/bin/python`,
      `runtime/node/versions/runtime-${physicalA.node.runtimeId}/bin/node`,
    ])
      await assert.rejects(fs.lstat(path.join(B.dataRoot, relative)), {
        code: 'ENOENT',
      });
    const missing = [];
    for (const c of cases.filter((c) => c.language !== 'SHELL')) {
      const readiness = await tasksB.readiness(c.taskId);
      assert.equal(readiness.status, 'RESOURCE_UNAVAILABLE');
      assert.ok(
        readiness.diagnostics.some((item) => item.code === 'RUNTIME_NOT_READY'),
      );
      const submitted = await engineB.submit(c.taskId, {
        submissionKey: 's1b-missing-runtime-' + c.taskId,
      });
      const blocked = await engineB.wait(submitted.id);
      assert.notEqual(blocked.status, 'SUCCESS');
      assert.equal(blocked.attempt_count, 0);
      assert.equal((await engineB.attempts(blocked.id)).length, 0);
      assert.equal(await engineB.logs(blocked.id), '');
      missing.push({
        task_id: c.taskId,
        language: c.language,
        readiness: readiness.status,
        diagnostics: readiness.diagnostics.map((item) => item.code),
        run_id: blocked.id,
        status: blocked.status,
        attempt_count: 0,
      });
    }
    // The real application retains its execution engine through runtime rebuilding.
    phase = 'REBUILD_B';
    const coldCache = await sandbox.treeUsage(path.join(B.dataRoot, 'cache'));
    assert.equal(
      coldCache.files,
      0,
      'B must not reuse any A Runtime/provider/package cache files',
    );
    await sandbox.record('linux-B-cold-cache-before-rebuild', {
      status: 'PASS',
      controller_pid: process.pid,
      cached_files: coldCache.files,
      cached_bytes: coldCache.bytes,
      independent_runtime_root: true,
      A_root_absent: true,
    });
    const rebuilt = await sandbox.measure('managed-runtime-rebuild-B', () =>
      rebuildRestoredManagedRuntime(B, physicalA),
    );
    for (const c of cases)
      assert.equal((await tasksB.readiness(c.taskId)).status, 'READY');
    phase = 'EXECUTE_B';
    const matrixB = await sandbox.measure('execute-eight-B', () =>
      executeDisasterMatrix(B, 'B', {
        cases,
        physicalA,
        localCommit,
        secretList,
        oldDataRoot: A.dataRoot,
      }),
    );
    assert.deepEqual(
      matrixB.map((row) => row.task_id),
      matrixA.map((row) => row.task_id),
    );
    for (let index = 0; index < matrixA.length; index++) {
      assert.equal(
        matrixB[index].entrypoint_hash,
        matrixA[index].entrypoint_hash,
      );
      assert.equal(
        matrixB[index].source_generation,
        matrixA[index].source_generation,
      );
      assert.notEqual(matrixB[index].run_id, matrixA[index].run_id);
    }
    for (const workspace of workspaces)
      assert.equal(
        (await scanWorkspace(B.roots.path(workspace), workspace.type)).hash,
        inventories[workspace.id].hash,
      );
    assert.equal(sha(await fs.readFile(indexFile)), gitState.index_sha256);
    for (const table of Object.keys(history)) {
      const ids = history[table].ids;
      const actual = await B.store.all(
        'SELECT * FROM ' +
          table +
          ' WHERE id IN (' +
          ids.map(() => '?').join(',') +
          ') ORDER BY id',
        ids,
      );
      assert.equal(
        sha(JSON.stringify(actual)),
        history[table].sha256,
        'old history remains byte-identical after B execution: ' + table,
      );
    }
    for (const id of history.TaskRuns.ids)
      assert.equal(sha(await engineB.logs(id)), logHashes[id]);
    for (const file of [
      A.root,
      A.dataRoot,
      path.join(A.dataRoot, 'runtime'),
      A.controlRoot,
    ])
      await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    for (const relative of [
      'tmp/config-materialization',
      'tmp/execution/node-bindings',
      'tmp/execution/workspace-owners',
    ]) {
      const entries = await fs
        .readdir(path.join(B.dataRoot, relative))
        .catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
      assert.deepEqual(entries, []);
    }
    assert.deepEqual(await B.store.all('PRAGMA foreign_key_check'), []);
    const finalBackup = new WorkspaceBackupService(
      B.store,
      B.roots,
      B.leases,
      B.backupRoot,
    );
    const finalSnapshot = await sandbox.measure(
      'backup-after-restored-execution-B',
      () => finalBackup.create(),
    );
    assert.equal(
      (await finalBackup.snapshot(finalSnapshot)).manifest.workspaces.length,
      2,
    );
    await sandbox.record('full-disaster-eight-original-tasks', {
      status: 'PASS',
      assertions: [
        'DISTINCT_A_B_OS_PROCESSES',
        'A_EXITED_AND_DESTROYED_BEFORE_B',
        'SOURCE_GIT_INDEX_LOCAL_COMMIT_PRESERVED',
        'TASK_HISTORY_ATTEMPT_LOG_IDS_PRESERVED',
        'MISSING_RUNTIME_NO_ATTEMPT',
        'FORMAL_MANAGED_REBUILD',
        'B_SAME_EIGHT_TASK_IDS_REAL_SUCCESS',
        'B_BACKUP_AGAIN',
      ],
      controllers: {
        A: baseline.A_controller_pid,
        B: process.pid,
        distinct: true,
      },
      A: {
        root_sha256: sha(A.root),
        data_root_absent: true,
        runtime_root_absent: true,
        control_root_absent: true,
      },
      B: {
        root_sha256: sha(B.root),
        matrix: matrixB,
        runtime: { python: rebuilt.python, node: rebuilt.node },
        runtime_rebuild_operations: rebuilt.operations,
        missing_runtime: missing,
        missing_runtime_installations: missingInstallations,
        restore_status: 'COMPLETE',
        restore_checkpoints: checkpoints,
        historical_runs_unchanged: history.TaskRuns.ids.length,
        historical_attempts_unchanged: history.TaskRunAttempts.ids.length,
        historical_log_hashes: logHashes,
        backup_again: finalSnapshot,
      },
      backup: { ...baseline.backup, encrypted: true },
      secret_sentinel_hashes: secretList.map(sha).sort(),
    });
    return {
      status: 'PASS',
      controller_pid: process.pid,
      executed_task_ids: matrixB.map((row) => row.task_id),
      archive_sha256: baseline.backup.archive_sha256,
    };
  } catch (error) {
    await sandbox.record('full-disaster-B-failure', {
      status: 'FAIL',
      phase,
      error_code: error.error_code ?? error.code ?? 'ASSERTION_FAILED',
    });
    throw error;
  }
}

module.exports = { runInstanceA, runInstanceB };
