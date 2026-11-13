const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createManagedRuntimeFixture } = require('./s2-runtime-fixture.cjs');
const { seedRepository } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  WorkspaceEnvironmentService,
} = require('../../back/services/taskExecutionV2/environment');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');
const {
  ManagedRuntimeAdapter,
} = require('../../back/services/taskExecutionV2/runtime');

const variable = (name, value, secret = false) => ({
  name,
  value,
  operation: 'SET',
  status: 'enabled',
  is_secret: secret,
});
async function configAsset(f, name, content) {
  const asset = (
    await f.store.run(
      'INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES(?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
      [name],
    )
  ).lastID;
  const key = `asset-${asset}/revisions/1/content`;
  const file = path.join(f.dataRoot, 'config-assets', key);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, content, { mode: 0o600, flag: 'wx' });
  const revision = (
    await f.store.run(
      'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,1,?,?,?,CURRENT_TIMESTAMP)',
      [
        asset,
        createHash('sha256').update(content).digest('hex'),
        Buffer.byteLength(content),
        key,
      ],
    )
  ).lastID;
  await f.store.run(
    'UPDATE ConfigAssets SET current_revision_id=? WHERE id=?',
    [revision, asset],
  );
  return { asset, revision };
}
function program(language) {
  if (language === 'PYTHON')
    return `import os,sys,json,pathlib\nprint('S2_MAIN:PYTHON',sys.executable,os.getcwd(),sys.argv[1],os.environ.get('S2_VALUE'),os.environ.get('S2_GLOBAL'),os.environ.get('S2_UNSET','UNSET'),os.environ.get('S2_BACKEND_SECRET','NO_BACKEND'),pathlib.Path('settings.json').read_text(),os.environ.get('S2_SECRET'))\n`;
  if (language === 'JAVASCRIPT')
    return `const fs=require('fs'); const isNumber=require('is-number'); console.log('S2_MAIN:JAVASCRIPT',isNumber(42),process.execPath,process.cwd(),process.argv[2],process.env.S2_VALUE,process.env.S2_GLOBAL,process.env.S2_UNSET||'UNSET',process.env.S2_BACKEND_SECRET||'NO_BACKEND',fs.readFileSync('settings.json','utf8'),process.env.S2_SECRET);\n`;
  if (language === 'TYPESCRIPT')
    return `import fs from 'node:fs'; import isNumber from 'is-number'; const value: number=42; console.log('S2_MAIN:TYPESCRIPT',isNumber(value),process.execPath,process.cwd(),process.argv[2],process.env.S2_VALUE,process.env.S2_GLOBAL,process.env.S2_UNSET||'UNSET',process.env.S2_BACKEND_SECRET||'NO_BACKEND',fs.readFileSync('settings.json','utf8'),process.env.S2_SECRET);\n`;
  return `printf 'S2_MAIN:SHELL %s %s %s %s %s %s\n' "$PWD" "$1" "$S2_VALUE" "$S2_GLOBAL" "\${S2_UNSET-UNSET}" "\${S2_BACKEND_SECRET-NO_BACKEND}"\ncat settings.json\nprintf '\n%s\n' "$S2_SECRET"\n`;
}

test('real v2 engine executes all LOCAL/GIT Python, JavaScript, TypeScript and Shell combinations with resources and cleanup', async (t) => {
  const f = await createManagedRuntimeFixture(t);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  const tasks = new TaskService(f.store, f.roots, f.leases);
  const resources = new WorkspaceEnvironmentService(f.store, f.roots, f.leases);
  const execution = f.track(
    new TaskExecutionService(f.store, f.roots, f.leases),
  );
  const round = randomUUID().slice(0, 8);
  const ws = [
    await lifecycle.createLocal({
      name: 'S2 LOCAL ' + round,
      requestKey: 's2-local-' + round,
    }),
  ];
  const repository = await seedRepository(
    f,
    100 + Math.floor(Math.random() * 100000),
  );
  ws.push(
    await lifecycle.createGit({
      name: 'S2 GIT ' + round,
      requestKey: 's2-git-' + round,
      repositoryId: repository.id,
      refType: 'branch',
      refName: 'main',
    }),
  );
  const secret = 'S2_ACTUAL_ENV_SECRET_' + round;
  const configSecret = 'S2_ACTUAL_CONFIG_SECRET_' + round;
  const artifact = await configAsset(
    f,
    'S2 secret config ' + round,
    configSecret,
  );
  const globals = (
    await f.store.all(
      'SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1',
    )
  )[0];
  await resources.replaceGlobals(globals.version, [
    variable('S2_GLOBAL', 'global-value'),
    variable('S2_VALUE', 'global-value'),
    variable('S2_UNSET', 'must-unset'),
  ]);
  const previousBackend = process.env.S2_BACKEND_SECRET;
  process.env.S2_BACKEND_SECRET = 'S2_FORBIDDEN_BACKEND_' + round;
  t.after(() => {
    if (previousBackend === undefined) delete process.env.S2_BACKEND_SECRET;
    else process.env.S2_BACKEND_SECRET = previousBackend;
  });
  const summaries = [];
  for (const initial of ws) {
    const getWorkspace = () => f.store.workspace(initial.id);
    await resources.setRuntimeDefault(
      initial.id,
      (
        await getWorkspace()
      ).version,
      'PYTHON',
      f.managed.pythonEnvironment.id,
    );
    await resources.setRuntimeDefault(
      initial.id,
      (
        await getWorkspace()
      ).version,
      'NODE',
      f.managed.nodeEnvironment.id,
    );
    const profile = await resources.createProfile(
      initial.id,
      (
        await getWorkspace()
      ).version,
      { name: 'default ' + round },
    );
    await resources.replaceProfileVariables(profile.id, profile.version, [
      variable('S2_VALUE', 'profile-value'),
      variable('S2_SECRET', secret, true),
      variable('S2_PROFILE_CHOICE', 'workspace-profile'),
    ]);
    await resources.selectWorkspaceProfile(
      initial.id,
      (
        await getWorkspace()
      ).version,
      profile.id,
    );
    const taskProfile = await resources.createProfile(
      initial.id,
      (
        await getWorkspace()
      ).version,
      { name: 'task override ' + round },
    );
    await resources.replaceProfileVariables(
      taskProfile.id,
      taskProfile.version,
      [
        variable('S2_SECRET', secret, true),
        variable('S2_PROFILE_CHOICE', 'task-profile'),
      ],
    );
    await resources.saveWorkspaceConfig(
      initial.id,
      (
        await getWorkspace()
      ).version,
      {
        asset_id: artifact.asset,
        revision_id: artifact.revision,
        operation: 'ATTACH',
        target_base: 'TASK_CWD',
        target_path: 'settings.json',
        materialization_mode: 'COPY',
        conflict_policy: 'BACKUP_AND_RESTORE',
        writable: false,
        enabled: true,
      },
    );
    for (const [language, folder, extension] of [
      ['PYTHON', 'python', 'py'],
      ['JAVASCRIPT', 'javascript', 'cjs'],
      ['TYPESCRIPT', 'typescript', 'ts'],
      ['SHELL', 'shell', 'sh'],
    ]) {
      await t.test(
        initial.type +
          ' ' +
          language +
          ' real Runner, CWD/runtime/env/config/hooks/logs/attempt',
        async () => {
          const runtimeOverride =
            initial.type === 'GIT' && language === 'TYPESCRIPT';
          if (runtimeOverride) {
            // A real EMPTY default cannot execute TS; the explicit ready Task
            // override must take precedence rather than fall back to this row.
            const fallback = await f.managed.node.definition({
              name: 'not-built default ' + round,
              runtime_id: f.managed.nodeEnvironment.runtime_id,
              toolchain_id: f.managed.nodeEnvironment.toolchain_id,
              dependencies: [],
              install_scripts_policy: 'ALLOW',
            });
            await resources.setRuntimeDefault(
              initial.id,
              (
                await getWorkspace()
              ).version,
              'NODE',
              fallback.id,
            );
          }
          await files.createDirectory(initial.id, folder);
          await files.create(
            initial.id,
            `${folder}/check.${extension}`,
            program(language),
          );
          await files.create(
            initial.id,
            `${folder}/settings.json`,
            'ORIGINAL_' + language,
          );
          const definition = await tasks.create({
            name: initial.type + ' ' + language + ' ' + round,
            arguments: ['literal space $TOKEN'],
            env_profile_id:
              initial.type === 'GIT' && language === 'SHELL'
                ? taskProfile.id
                : null,
            runtime: runtimeOverride
              ? {
                  kind: 'NODE',
                  python_environment_id: null,
                  node_environment_id: f.managed.nodeEnvironment.id,
                }
              : null,
            source: {
              type: 'WORKSPACE_ENTRYPOINT',
              workspace_id: initial.id,
              relative_entrypoint: `${folder}/check.${extension}`,
              language,
              cwd_mode: 'ENTRYPOINT_DIR',
              cwd_relative_path: null,
            },
          });
          const id = definition.task.id;
          let current = await resources.replaceTaskVariables(
            id,
            definition.task.version,
            [
              variable('S2_VALUE', 'task-value'),
              {
                name: 'S2_UNSET',
                operation: 'UNSET',
                status: 'enabled',
                is_secret: false,
              },
            ],
          );
          current = await resources.replaceHooks(
            id,
            current.task.version,
            ['BEFORE', 'AFTER_SUCCESS', 'AFTER_FAILURE', 'FINALLY'].map(
              (phase, position) => ({
                name: phase,
                phase,
                command: `printf 'S2_HOOK_${phase}:%s:%s\\n' "$S2_VALUE" "$S2_PROFILE_CHOICE"`,
                cwd_base: 'TASK_CWD',
                position,
                timeout_seconds: 5,
                failure_policy: 'FAIL_EXECUTION',
                enabled: true,
              }),
            ),
          );
          const preview = await resources.preview(id);
          assert.equal(JSON.stringify(preview).includes(secret), false);
          const run = await execution.submit(id, {
            submissionKey: 's2-language-' + id + '-' + round,
          });
          const final = await execution.wait(run.id, 60000);
          assert.equal(final.status, 'SUCCESS', JSON.stringify(final));
          const log = await execution.logs(run.id);
          assert.match(log, new RegExp('S2_MAIN:' + language));
          assert.ok(log.includes(path.join(f.roots.path(initial), folder)));
          assert.ok(log.includes('literal space $TOKEN'));
          assert.ok(
            log.includes('task-value') &&
              log.includes('global-value') &&
              log.includes('UNSET') &&
              log.includes('NO_BACKEND'),
          );
          assert.ok(
            log.includes(
              initial.type === 'GIT' && language === 'SHELL'
                ? 'task-profile'
                : 'workspace-profile',
            ),
          );
          assert.equal(
            log.includes(secret) ||
              log.includes(configSecret) ||
              log.includes('S2_FORBIDDEN_BACKEND_' + round),
            false,
          );
          assert.ok(log.indexOf('S2_HOOK_BEFORE') < log.indexOf('S2_MAIN'));
          assert.ok(
            log.indexOf('S2_MAIN') < log.indexOf('S2_HOOK_AFTER_SUCCESS'),
          );
          assert.ok(
            log.indexOf('S2_HOOK_AFTER_SUCCESS') <
              log.indexOf('S2_HOOK_FINALLY'),
          );
          assert.equal(log.includes('S2_HOOK_AFTER_FAILURE'), false);
          const source = JSON.parse(final.source_snapshot),
            metadata = JSON.parse(final.snapshot_metadata);
          assert.equal(source.workspace_id, initial.id);
          assert.equal(source.workspace_type, initial.type);
          assert.equal(source.git === null, initial.type === 'LOCAL');
          if (language === 'PYTHON') {
            assert.equal(
              metadata.runtime.runtime_id,
              f.managed.pythonEnvironment.runtime_id,
            );
            assert.ok(log.includes('/venv/bin/python'));
          }
          if (language === 'JAVASCRIPT' || language === 'TYPESCRIPT') {
            assert.equal(
              metadata.runtime.runtime_id,
              f.managed.nodeEnvironment.runtime_id,
            );
            assert.ok(log.includes('/runtime/node/versions/runtime-'));
            assert.ok(log.includes('true'));
          }
          const attempts = await execution.attempts(run.id);
          assert.equal(attempts.length, 1);
          assert.equal(attempts[0].exit_code, 0);
          assert.equal(JSON.parse(attempts[0].result).cleanupResult, 'SUCCESS');
          assert.equal(
            await fs.readFile(
              path.join(f.roots.path(initial), folder, 'settings.json'),
              'utf8',
            ),
            'ORIGINAL_' + language,
          );
          for (const folderPath of [
            f.roots.path(initial),
            path.join(f.roots.path(initial), folder),
          ])
            await assert.rejects(
              fs.lstat(path.join(folderPath, 'node_modules')),
              { code: 'ENOENT' },
            );
          summaries.push({
            workspace_type: initial.type,
            language,
            task_id: id,
            run_id: run.id,
            status: final.status,
            runtime_id: metadata.runtime.runtime_id ?? null,
            build_id: metadata.runtime.build_id ?? null,
            attempt_count: attempts.length,
            exit_code: attempts[0].exit_code,
            cleanup: 'SUCCESS',
          });
          if (runtimeOverride)
            await resources.setRuntimeDefault(
              initial.id,
              (
                await getWorkspace()
              ).version,
              'NODE',
              f.managed.nodeEnvironment.id,
            );
        },
      );
    }
  }
  assert.equal(summaries.length, 8);
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
  process.stdout.write(
    JSON.stringify({
      s2_real_language_matrix: summaries,
      managed_provider_operations: f.managed.operationHistory,
    }) + '\n',
  );
});
