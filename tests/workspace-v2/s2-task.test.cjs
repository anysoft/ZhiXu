const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  createFixture,
  seedRepository,
  insertHistoricalRunForReferenceTest,
} = require('./fixture.cjs');
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
  TaskResourceResolver,
} = require('../../back/services/taskExecutionV2/resources');
async function setup(t, type = 'LOCAL') {
  const f = await createFixture(t);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  let row;
  if (type === 'GIT') {
    const repo = await seedRepository(f);
    row = await lifecycle.createGit({
      name: 'task Git',
      requestKey: 'task-git',
      repositoryId: repo.id,
      refType: 'branch',
      refName: 'main',
    });
  } else
    row = await lifecycle.createLocal({
      name: 'task local',
      requestKey: 'task-local',
    });
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  await files.createDirectory(row.id, 'scripts');
  await files.create(row.id, 'scripts/check.sh', 'printf "safe source\\n"\n');
  await files.createDirectory(row.id, 'custom');
  return {
    ...f,
    row,
    files,
    lifecycle,
    tasks: new TaskService(f.store, f.roots, f.leases),
    env: new WorkspaceEnvironmentService(f.store, f.roots, f.leases),
    resources: new TaskResourceResolver(f.store, f.roots, f.leases),
  };
}
async function historicalReference(f, taskId) {
  if (f.row.type === 'LOCAL')
    return insertHistoricalRunForReferenceTest(f.store, taskId, f.row.id);
  const ws = await f.store.workspace(f.row.id),
    task = (
      await f.store.all('SELECT version FROM Tasks WHERE id=?', [taskId])
    )[0],
    global = (
      await f.store.all('SELECT version FROM GlobalEnvironmentRevision')
    )[0],
    git = (
      await f.store.all(
        'SELECT resolved_commit FROM GitWorkspaces WHERE workspace_id=?',
        [ws.id],
      )
    )[0],
    now = new Date().toISOString();
  // A terminal reference fixture, not an executed Run or a Runner success claim.
  return (
    await f.store.run(
      `INSERT INTO TaskRuns(task_id,workspace_id,expected_workspace_version,expected_global_env_version,expected_task_definition_version,expected_source_generation,expected_content_revision,expected_git_commit,expected_inventory_hash,admission_snapshot,trigger_type,status,submitted_at,finished_at,log_identity,concurrency_policy,queue_deadline_at,next_eligible_at) VALUES(?,?,?,?,?,?,?,?,?,?,'MANUAL','SKIPPED',?,?,?,'ALLOW',?,?)`,
      [
        taskId,
        ws.id,
        ws.version,
        global.version,
        task.version,
        ws.source_generation,
        ws.content_revision,
        git.resolved_commit,
        ws.content_inventory_hash,
        JSON.stringify({ workspace_id: ws.id }),
        now,
        now,
        's2-history-reference-' + taskId,
        now,
        now,
      ],
    )
  ).lastID;
}
const write = (f, extra = {}) => ({
  name: 'candidate task',
  source: {
    type: 'WORKSPACE_ENTRYPOINT',
    workspace_id: f.row.id,
    relative_entrypoint: 'scripts/check.sh',
    language: 'SHELL',
    cwd_mode: 'ENTRYPOINT_DIR',
    cwd_relative_path: null,
  },
  ...extra,
});
for (const kind of ['LOCAL', 'GIT'])
  test(`S2 ${kind} Task create/update/clone/delete and readonly source/CWD readiness use Workspace ownership`, async (t) => {
    const f = await setup(t, kind);
    let task = await f.tasks.create(
      write(f, {
        runtime: {
          kind: 'SHELL',
          python_environment_id: null,
          node_environment_id: null,
        },
      }),
    );
    assert.equal(task.source.workspace_id, f.row.id);
    assert.equal(task.source.type, 'WORKSPACE_ENTRYPOINT');
    assert.equal((await f.tasks.readiness(task.task.id)).status, 'READY');
    for (const [cwd_mode, cwd_relative_path] of [
      ['WORKSPACE_ROOT', null],
      ['ENTRYPOINT_DIR', null],
      ['CUSTOM_RELATIVE', 'custom'],
    ]) {
      task = await f.tasks.update(task.task.id, task.task.version, {
        source: { ...task.source, cwd_mode, cwd_relative_path },
      });
      await f.leases.withWorkspace(f.row.id, 'TEST_SOURCE', async (lease) => {
        const resolved = await f.resources.resolveUnderLease(
          task.task.id,
          lease,
        );
        assert.equal(
          resolved.cwd,
          cwd_mode === 'WORKSPACE_ROOT'
            ? f.roots.path(f.row)
            : path.join(f.roots.path(f.row), cwd_relative_path ?? 'scripts'),
        );
        assert.equal(
          resolved.entrypointHash,
          createHash('sha256')
            .update('printf "safe source\\n"\n')
            .digest('hex'),
        );
      });
    }
    const stale = task.task.version;
    task = await f.tasks.setEnabled(task.task.id, stale, true);
    assert.equal(task.task.enabled, 1);
    await assert.rejects(
      f.tasks.update(task.task.id, stale, { name: 'stale' }),
      { error_code: 'TASK_VERSION_CONFLICT' },
    );
    task = await f.env.replaceTaskVariables(task.task.id, task.task.version, [
      {
        name: 'TASK_TOKEN',
        operation: 'SET',
        status: 'enabled',
        is_secret: true,
        value: 'private copied token',
      },
    ]);
    task = await f.env.replaceHooks(task.task.id, task.task.version, [
      {
        name: 'before',
        phase: 'BEFORE',
        command: 'printf before',
        cwd_base: 'TASK_CWD',
        position: 0,
        timeout_seconds: 5,
        failure_policy: 'FAIL_EXECUTION',
        enabled: true,
      },
    ]);
    const clone = await f.tasks.clone(task.task.id, 'copy');
    assert.equal(clone.task.origin, 'MANUAL');
    assert.equal(clone.task.enabled, 0);
    assert.equal(clone.variables[0].value, 'private copied token');
    assert.equal(clone.hooks[0].command, 'printf before');
    assert.notEqual(clone.hooks[0].id, task.hooks[0].id);
    assert.equal((await f.tasks.list(f.row.id)).length, 2);
    const run = await historicalReference(f, task.task.id);
    assert.equal((await f.tasks.references(task.task.id)).runs, 1);
    assert.equal((await f.tasks.history(task.task.id))[0].id, run);
    await f.tasks.remove(task.task.id, task.task.version);
    assert.equal(
      (
        await f.store.all(
          'SELECT task_id,workspace_id FROM TaskRuns WHERE id=?',
          [run],
        )
      )[0].task_id,
      null,
    );
    await assert.rejects(f.tasks.get(task.task.id), {
      error_code: 'TASK_NOT_FOUND',
    });
    await f.tasks.remove(clone.task.id, clone.task.version);
    assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
  });

test('S2 ENV selects one same-Workspace profile, Task override/UNSET and Global allowlist; previews never disclose secret values', async (t) => {
  const f = await setup(t);
  let task = await f.tasks.create(write(f));
  let version = (await f.store.workspace(f.row.id)).version;
  let profile = await f.env.createProfile(f.row.id, version, {
    name: 'default',
  });
  profile = await f.env.replaceProfileVariables(profile.id, profile.version, [
    {
      name: 'PROFILE_SECRET',
      operation: 'SET',
      status: 'enabled',
      is_secret: true,
      value: 's2-profile-private',
    },
    {
      name: 'CHOICE',
      operation: 'SET',
      status: 'enabled',
      is_secret: false,
      value: 'default',
    },
  ]);
  version = (await f.store.workspace(f.row.id)).version;
  await f.env.selectWorkspaceProfile(f.row.id, version, profile.id);
  const global = (
    await f.store.all('SELECT version FROM GlobalEnvironmentRevision')
  )[0].version;
  await f.env.replaceGlobals(global, [
    {
      name: 'GLOBAL_TOKEN',
      operation: 'SET',
      status: 'enabled',
      is_secret: true,
      value: 's2-global-private',
    },
    {
      name: 'CHOICE',
      operation: 'SET',
      status: 'enabled',
      is_secret: false,
      value: 'global',
    },
  ]);
  task = await f.env.replaceTaskVariables(task.task.id, task.task.version, [
    { name: 'CHOICE', operation: 'UNSET', status: 'enabled', is_secret: false },
    {
      name: 'LOCAL',
      operation: 'SET',
      status: 'enabled',
      is_secret: false,
      value: 'task',
    },
    {
      name: 'DISABLED',
      operation: 'SET',
      status: 'disabled',
      is_secret: false,
      value: 'ignored',
    },
  ]);
  let env = await f.env.resolve(task.task.id, {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    BACKEND_SERVICE_TOKEN: 'do not inherit',
    NODE_OPTIONS: 'do not inherit',
  });
  assert.equal(env.variables.GLOBAL_TOKEN, 's2-global-private');
  assert.equal(env.variables.PROFILE_SECRET, 's2-profile-private');
  assert.equal(env.variables.CHOICE, undefined);
  assert.equal(env.variables.LOCAL, 'task');
  assert.equal(env.variables.DISABLED, undefined);
  assert.equal(env.variables.BACKEND_SERVICE_TOKEN, undefined);
  assert.equal(env.variables.NODE_OPTIONS, undefined);
  const preview = JSON.stringify(await f.env.preview(task.task.id));
  assert.equal(preview.includes('s2-profile-private'), false);
  assert.equal(preview.includes('s2-global-private'), false);
  const retained = await f.env.replaceProfileVariables(
    profile.id,
    profile.version,
    [
      {
        name: 'PROFILE_SECRET',
        operation: 'SET',
        status: 'enabled',
        is_secret: true,
      },
      {
        name: 'CHOICE',
        operation: 'SET',
        status: 'enabled',
        is_secret: false,
        value: 'default',
      },
    ],
  );
  assert.equal(
    (await f.env.resolve(task.task.id)).variables.PROFILE_SECRET,
    's2-profile-private',
  );
  await assert.rejects(
    f.env.replaceProfileVariables(profile.id, retained.version, [
      {
        name: 'PROFILE_SECRET',
        operation: 'SET',
        status: 'enabled',
        is_secret: true,
        clear: true,
        value: 'ambiguous',
      },
    ]),
    { error_code: 'ENV_SECRET_ACTION_INVALID' },
  );
  assert.equal((await f.env.profile(profile.id)).version, retained.version);
  const alternative = await f.env.createProfile(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    { name: 'selected' },
  );
  await f.env.replaceProfileVariables(alternative.id, alternative.version, [
    {
      name: 'ONLY_SELECTED',
      operation: 'SET',
      status: 'enabled',
      is_secret: false,
      value: 'yes',
    },
  ]);
  task = await f.tasks.update(task.task.id, task.task.version, {
    env_profile_id: alternative.id,
  });
  env = await f.env.resolve(task.task.id);
  assert.equal(env.variables.PROFILE_SECRET, undefined);
  assert.equal(env.variables.ONLY_SELECTED, 'yes');
  const other = await f.lifecycle.createLocal({
    name: 'other',
    requestKey: 'other',
  });
  const foreign = await f.env.createProfile(other.id, other.version, {
    name: 'foreign',
  });
  await assert.rejects(
    f.tasks.update(task.task.id, task.task.version, {
      env_profile_id: foreign.id,
    }),
    { error_code: 'ENV_PROFILE_WORKSPACE_MISMATCH' },
  );
  assert.equal(
    (await f.tasks.get(task.task.id)).task.env_profile_id,
    alternative.id,
  );
  await assert.rejects(
    f.env.removeProfile(
      alternative.id,
      (
        await f.env.profile(alternative.id)
      ).version,
    ),
    { error_code: 'ENV_PROFILE_REFERENCED' },
  );
});

test('S2 effective Config ATTACH/MASK keeps exact pinned revision; Task clone rollback is atomic', async (t) => {
  const f = await setup(t);
  let task = await f.tasks.create(write(f));
  const content = 'private immutable config';
  const checksum = createHash('sha256').update(content).digest('hex');
  await f.store.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO ConfigAssets(id,name,is_secret,createdAt,updatedAt) VALUES(1,'private',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    );
    await tx.run(
      'INSERT INTO ConfigAssetRevisions(id,asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(1,1,1,?,?,?,CURRENT_TIMESTAMP)',
      [checksum, Buffer.byteLength(content), 'asset-1/revisions/1/content'],
    );
    await tx.run('UPDATE ConfigAssets SET current_revision_id=1 WHERE id=1');
  });
  const directory = await f.roots.directory(
    'config-assets/asset-1/revisions/1',
    true,
  );
  await fs.writeFile(path.join(directory, 'content'), content, { mode: 0o600 });
  const binding = {
    asset_id: 1,
    revision_id: 1,
    operation: 'ATTACH',
    target_base: 'TASK_CWD',
    target_path: 'config.json',
    materialization_mode: 'COPY',
    conflict_policy: 'BACKUP_AND_RESTORE',
    writable: false,
    enabled: true,
  };
  await f.env.saveWorkspaceConfig(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    binding,
  );
  let definition = await f.resources.definition(task.task.id);
  assert.equal(definition.configs[0].source, 'WORKSPACE');
  assert.equal(definition.configs[0].revision_id, 1);
  await f.env.saveTaskConfig(task.task.id, task.task.version, {
    ...binding,
    operation: 'MASK',
    asset_id: null,
    revision_id: null,
  });
  task = await f.tasks.get(task.task.id);
  assert.equal((await f.resources.definition(task.task.id)).configs.length, 0);
  const mask = task.configBindings[0];
  await f.env.removeTaskConfig(
    task.task.id,
    task.task.version,
    mask.id,
    mask.version,
  );
  task = await f.tasks.get(task.task.id);
  assert.equal((await f.resources.definition(task.task.id)).configs.length, 1);
  await f.env.replaceHooks(task.task.id, task.task.version, [
    {
      name: 'before',
      phase: 'BEFORE',
      command: 'true',
      cwd_base: 'TASK_CWD',
      position: 0,
      timeout_seconds: 2,
      failure_policy: 'CONTINUE',
      enabled: true,
    },
  ]);
  const before = await f.store.all('SELECT id FROM Tasks ORDER BY id');
  const original = f.store.run.bind(f.store);
  f.store.run = (sql, args) => {
    if (
      sql.startsWith('INSERT INTO TaskHooks(task_id,') &&
      sql.includes('SELECT')
    )
      throw Error('injected child copy failure');
    return original(sql, args);
  };
  await assert.rejects(f.tasks.clone(task.task.id));
  f.store.run = original;
  assert.deepEqual(
    await f.store.all('SELECT id FROM Tasks ORDER BY id'),
    before,
  );
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
});

test('S2 source/readiness rejects missing, unsafe, archived/reclaimed and cross-owner inputs without host execution', async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.tasks.create(
      write(f, {
        source: { ...write(f).source, relative_entrypoint: '../escape.sh' },
      }),
    ),
  );
  const outside = path.join(f.root, 'outside.sh');
  await fs.writeFile(outside, 'private outside');
  await fs.link(outside, path.join(f.roots.path(f.row), 'linked.sh'));
  await assert.rejects(
    f.tasks.create(
      write(f, {
        source: { ...write(f).source, relative_entrypoint: 'linked.sh' },
      }),
    ),
  );
  assert.equal(await fs.readFile(outside, 'utf8'), 'private outside');
  await fs.unlink(path.join(f.roots.path(f.row), 'linked.sh'));
  const task = await f.tasks.create(write(f));
  await fs.unlink(path.join(f.roots.path(f.row), 'scripts/check.sh'));
  assert.equal(
    (await f.tasks.readiness(task.task.id)).status,
    'SOURCE_MISSING',
  );
  await fs.writeFile(
    path.join(f.roots.path(f.row), 'scripts/check.sh'),
    'printf "safe source\\n"\n',
    { mode: 0o644 },
  );
  const archived = await f.lifecycle.archive(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    { requestKey: 'archive-task' },
  );
  assert.notEqual((await f.tasks.readiness(task.task.id)).status, 'READY');
  await assert.rejects(f.tasks.create(write(f)), {
    error_code: 'WORKSPACE_ARCHIVED',
  });
  const py = await f.lifecycle.createLocal({
    name: 'missing runtime',
    requestKey: 'runtime-missing',
  });
  await f.files.create(py.id, 'main.py', 'print("never executed")');
  const definition = await f.tasks.create({
    name: 'python needs managed env',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: py.id,
      relative_entrypoint: 'main.py',
      language: 'PYTHON',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  const readiness = await f.tasks.readiness(definition.task.id);
  assert.equal(readiness.status, 'CONFIGURATION_REQUIRED');
  assert.equal(readiness.diagnostics[0].code, 'CONFIGURATION_REQUIRED');
  await assert.rejects(
    f.tasks.setEnabled(definition.task.id, definition.task.version, true),
    { error_code: 'TASK_NOT_READY' },
  );
  const before = await f.store.all('SELECT id FROM Tasks');
  await assert.rejects(
    f.tasks.create({
      ...write(f),
      name: 'not managed',
      enabled: true,
      source: definition.source,
    }),
    { error_code: 'CONFIGURATION_REQUIRED' },
  );
  assert.deepEqual(await f.store.all('SELECT id FROM Tasks'), before);
});

test('S2 DISCOVERED identity belongs to its Git Workspace and cloned tasks become independent MANUAL definitions', async (t) => {
  const f = await setup(t, 'GIT');
  const discovered = await f.tasks.create(write(f), {
    discovered_workspace_id: f.row.id,
    discovery_key: 'a'.repeat(64),
    discovery_definition: { relative_entrypoint: 'scripts/check.sh' },
  });
  assert.equal(discovered.task.origin, 'DISCOVERED');
  const clone = await f.tasks.clone(discovered.task.id);
  assert.equal(clone.task.origin, 'MANUAL');
  assert.equal(clone.task.discovery_key, null);
  const other = await f.lifecycle.createLocal({
    name: 'cannot discover local',
    requestKey: 'local-no-discover',
  });
  await f.files.create(other.id, 'main.sh', 'true');
  await assert.rejects(
    f.tasks.create(
      {
        name: 'bad discovery',
        source: {
          type: 'WORKSPACE_ENTRYPOINT',
          workspace_id: other.id,
          relative_entrypoint: 'main.sh',
          language: 'SHELL',
          cwd_mode: 'WORKSPACE_ROOT',
          cwd_relative_path: null,
        },
      },
      {
        discovered_workspace_id: other.id,
        discovery_key: 'b'.repeat(64),
        discovery_definition: {},
      },
    ),
    { error_code: 'TASK_IDENTITY_INVALID' },
  );
});

test('S2 archived Workspace allows explicit default and reference unbinding while rejecting new resource configuration', async (t) => {
  const f = await setup(t);
  const profile = await f.env.createProfile(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    { name: 'archive profile' },
  );
  await f.env.selectWorkspaceProfile(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    profile.id,
  );
  let task = await f.tasks.create(write(f, { env_profile_id: profile.id }));
  const content = 'bound config';
  await f.store.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO ConfigAssets(id,name,createdAt,updatedAt) VALUES(1,'archive config',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    );
    await tx.run(
      'INSERT INTO ConfigAssetRevisions(id,asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(1,1,1,?,?,?,CURRENT_TIMESTAMP)',
      [
        createHash('sha256').update(content).digest('hex'),
        Buffer.byteLength(content),
        'asset-1/revisions/1/content',
      ],
    );
    await tx.run('UPDATE ConfigAssets SET current_revision_id=1 WHERE id=1');
  });
  const directory = await f.roots.directory(
    'config-assets/asset-1/revisions/1',
    true,
  );
  await fs.writeFile(path.join(directory, 'content'), content, { mode: 0o600 });
  const value = {
    asset_id: 1,
    revision_id: 1,
    operation: 'ATTACH',
    target_base: 'WORKSPACE_ROOT',
    target_path: 'archive.json',
    materialization_mode: 'COPY',
    conflict_policy: 'FAIL_IF_EXISTS',
    writable: false,
    enabled: true,
  };
  const workspaceBinding = await f.env.saveWorkspaceConfig(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    value,
  );
  const taskBinding = await f.env.saveTaskConfig(
    task.task.id,
    task.task.version,
    { ...value, target_path: 'task-archive.json' },
  );
  task = await f.tasks.get(task.task.id);
  await f.lifecycle.archive(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    { requestKey: 'archived-references' },
  );
  task = await f.tasks.get(task.task.id);
  await assert.rejects(
    f.env.createProfile(f.row.id, (await f.store.workspace(f.row.id)).version, {
      name: 'forbidden',
    }),
    { error_code: 'WORKSPACE_ARCHIVED' },
  );
  await assert.rejects(
    f.env.saveTaskConfig(task.task.id, task.task.version, {
      ...value,
      target_path: 'forbidden.json',
    }),
    { error_code: 'WORKSPACE_ARCHIVED' },
  );
  await f.env.removeTaskConfig(task.task.id, task.task.version, taskBinding, 1);
  task = await f.tasks.get(task.task.id);
  task = await f.env.selectTaskProfile(task.task.id, task.task.version, null);
  await f.env.removeWorkspaceConfig(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    workspaceBinding,
    1,
  );
  await f.env.selectWorkspaceProfile(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    null,
  );
  await f.env.setRuntimeDefault(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    'NODE',
    null,
  );
  assert.equal((await f.store.workspace(f.row.id)).lifecycle_state, 'ARCHIVED');
  assert.equal(
    (await f.store.workspace(f.row.id)).default_env_profile_id,
    null,
  );
  assert.equal(task.task.env_profile_id, null);
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM WorkspaceConfigBindings'))[0].n,
    0,
  );
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM TaskConfigBindings'))[0].n,
    0,
  );
  await f.tasks.remove(task.task.id, task.task.version);
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
});
