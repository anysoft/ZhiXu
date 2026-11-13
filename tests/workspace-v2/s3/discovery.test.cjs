const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { createS3Fixture, seedRepository, git } = require('./fixture.cjs');
const {
  GitWorkspaceDiscovery,
} = require('../../../back/services/gitWorkspaceV2/discovery');
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
const {
  scanWorkspace,
} = require('../../../back/services/workspaceV2/inventory');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  WorkspaceEnvironmentService,
} = require('../../../back/services/taskExecutionV2/environment');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');
const hash = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest('hex');
const key = (relative) => createHash('sha256').update(relative).digest('hex');

async function createDiscoveryFixture(t, caseId) {
  const h = await createS3Fixture(t, { caseId });
  const a = await h.createInstance('A');
  const repo = await seedRepository(a);
  const lifecycle = new WorkspaceLifecycleService(a.store, a.roots, a.leases);
  const row = await lifecycle.createGit({
    name: caseId,
    requestKey: caseId,
    repositoryId: repo.id,
    refType: 'branch',
    refName: 'main',
  });
  return {
    ...a,
    a,
    h,
    repo,
    row,
    lifecycle,
    files: new WorkspaceFileService(a.store, a.roots, a.leases),
    tasks: new TaskService(a.store, a.roots, a.leases),
    env: new WorkspaceEnvironmentService(a.store, a.roots, a.leases),
    discovery: new GitWorkspaceDiscovery(a.store, a.roots, a.leases),
    engine: a.track(new TaskExecutionService(a.store, a.roots, a.leases)),
  };
}
async function applyDiscoveryPreview(f, discovery = f.discovery) {
  const preview = await discovery.preview(f.row.id);
  const result = await discovery.apply(f.row.id, {
    preview_token: preview.preview_token,
    expected_version: (await discovery.store.workspace(f.row.id)).version,
  });
  return { preview, result };
}
async function advanceDiscoveryGit(f, action) {
  await f.leases.withRepository(f.repo.id, 'DISCOVERY_TEST_GIT', () =>
    f.leases.withWorkspace(f.row.id, 'DISCOVERY_TEST_GIT', async () => {
      const root = f.roots.path(f.row);
      await action(root);
      const row = await f.store.workspace(f.row.id);
      await f.store.updateInventory(
        row.id,
        row.content_revision,
        await scanWorkspace(root, 'GIT'),
      );
    }),
  );
}
const source = (f, entrypoint) => ({
  type: 'WORKSPACE_ENTRYPOINT',
  workspace_id: f.row.id,
  relative_entrypoint: entrypoint,
  language: 'SHELL',
  cwd_mode: 'ENTRYPOINT_DIR',
  cwd_relative_path: null,
});
async function enableDiscovery(f) {
  return f.discovery.savePolicy(f.row.id, {
    expected_version: (await f.discovery.policy(f.row.id)).version,
    enabled: true,
    includes: ['**/*.sh'],
    excludes: [],
    languages: ['SHELL'],
  });
}
async function domainDigest(store) {
  const value = {};
  for (const table of [
    'Workspaces',
    'GitWorkspaces',
    'Tasks',
    'TaskSources',
    'TaskExecutionSettings',
    'TaskRuntimeBindings',
    'TaskTriggers',
    'CronTriggers',
    'WorkspaceDiscoveryPolicies',
    'WorkspaceDiscoverySuppressions',
    'WorkspaceSyncRuns',
    'WorkspaceUpdateOutbox',
    'TriggerEvents',
    'TaskRuns',
  ])
    value[table] = await store.all(
      'SELECT * FROM ' + table + ' ORDER BY rowid',
    );
  return hash(value);
}

test('S3 disabled and enabled Discovery previews are read-only; actual apply creates one deterministic canonical Task and real S2 child', async (t) => {
  const f = await createDiscoveryFixture(t, 'S3-DISCOVERY-PREVIEW');
  await f.files.create(
    f.row.id,
    'first.sh',
    '# name: First discovered\n# cron: */5 * * * *\nprintf "REAL_S3_DISCOVERED_CHILD\\n"\n',
  );
  const initial = await domainDigest(f.store);
  const disabled = await f.discovery.preview(f.row.id);
  assert.deepEqual(disabled.actions, []);
  assert.equal(await domainDigest(f.store), initial);
  await enableDiscovery(f);
  const before = await domainDigest(f.store);
  const preview = await f.discovery.preview(f.row.id);
  assert.equal(preview.actions[0].action, 'CREATE');
  assert.equal(preview.actions[0].discovery_key, key('first.sh'));
  assert.equal(await domainDigest(f.store), before);
  assert.deepEqual(preview.diagnostics, []);
  const applied = await f.discovery.apply(f.row.id, {
    preview_token: preview.preview_token,
    expected_version: (await f.store.workspace(f.row.id)).version,
  });
  assert.equal(applied.created, 1);
  const row = (await f.store.all('SELECT * FROM Tasks'))[0];
  assert.equal(row.origin, 'DISCOVERED');
  assert.equal(row.discovery_key, key('first.sh'));
  assert.equal(row.discovered_workspace_id, f.row.id);
  assert.equal(row.enabled, 0);
  const task = await f.tasks.get(row.id);
  assert.equal(task.source.type, 'WORKSPACE_ENTRYPOINT');
  assert.equal(task.source.workspace_id, f.row.id);
  assert.equal(
    (await f.store.all('SELECT origin,discovery_key FROM TaskTriggers'))[0]
      .origin,
    'DISCOVERY',
  );
  const next = await applyDiscoveryPreview(f);
  assert.equal(next.result.created, 0);
  assert.equal(next.result.updated, 0);
  assert.equal((await f.tasks.get(row.id)).task.version, task.task.version);
  const enabled = await f.tasks.setEnabled(row.id, task.task.version, true);
  const run = await f.engine.wait((await f.engine.submit(row.id)).id);
  assert.equal(run.status, 'SUCCESS');
  assert.equal(run.attempt_count, 1);
  assert.match(await f.engine.logs(run.id), /REAL_S3_DISCOVERED_CHILD/);
  assert.equal((await f.engine.attempts(run.id))[0].status, 'SUCCESS');
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM Tasks'))[0].n, 1);
  await f.h.record('S3-DISCOVERY-PREVIEW', {
    status: 'PASS',
    input: 'real Git Workspace header metadata',
    expected: 'readonly previews, deterministic one Task, actual S2 execution',
    actual:
      'preview no mutation and repeated reconciliation idempotent; actual child SUCCESS',
    assertions: [
      'disabled preview empty',
      'preview DB digest unchanged',
      'SHA256 relative-path identity',
      'canonical Source/settings/owned Cron',
      'new Task disabled',
      'no Task version churn on unchanged source',
      'real Runner SUCCESS',
    ],
    workspace_id: f.row.id,
    task_id: enabled.task.id,
    run_id: run.id,
    source_hash: JSON.parse(run.source_snapshot).inventory_hash,
    exit_code: 0,
  });
});

test('S3 reconciliation preserves Manual Tasks and every user Task resource, name, enabled intent and USER Cron tombstone', async (t) => {
  const f = await createDiscoveryFixture(t, 'S3-DISCOVERY-USER-OWNERSHIP');
  await f.files.create(
    f.row.id,
    'owned.sh',
    '# name: Scanner old name\n# cron: */5 * * * *\nprintf owned\n',
  );
  await f.files.create(
    f.row.id,
    'manual.sh',
    '# name: Scanner must not own manual\nprintf manual\n',
  );
  const manual = await f.tasks.create({
    name: 'User manual',
    source: source(f, 'manual.sh'),
  });
  await enableDiscovery(f);
  await applyDiscoveryPreview(f);
  let owned = await f.tasks.get(
    (
      await f.store.all("SELECT id FROM Tasks WHERE origin='DISCOVERED'")
    )[0].id,
  );
  const profile = await f.env.createProfile(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    { name: 'owned user profile' },
  );
  owned = await f.tasks.update(owned.task.id, owned.task.version, {
    name: 'User preserved name',
    enabled: true,
    arguments: ['literal user argument'],
    env_profile_id: profile.id,
    runtime: {
      kind: 'SHELL',
      python_environment_id: null,
      node_environment_id: null,
    },
    execution: { concurrency: 'QUEUE', max_attempts: 2 },
  });
  const secret = f.h.registerSecret(
    'S3_DISCOVERY_SECRET_' + randomBytes(24).toString('hex'),
  );
  owned = await f.env.replaceTaskVariables(owned.task.id, owned.task.version, [
    {
      name: 'USER_SECRET',
      operation: 'SET',
      status: 'enabled',
      is_secret: true,
      value: secret,
    },
  ]);
  owned = await f.env.replaceHooks(owned.task.id, owned.task.version, [
    {
      name: 'user hook',
      phase: 'BEFORE',
      command: 'printf user-hook',
      cwd_base: 'TASK_CWD',
      position: 0,
      timeout_seconds: 5,
      failure_policy: 'FAIL_EXECUTION',
      enabled: true,
    },
  ]);
  owned = await f.tasks.get(owned.task.id);
  await f.env.saveTaskConfig(owned.task.id, owned.task.version, {
    asset_id: null,
    revision_id: null,
    operation: 'MASK',
    target_base: 'WORKSPACE_ROOT',
    target_path: 'settings.json',
    materialization_mode: 'COPY',
    conflict_policy: 'FAIL_IF_EXISTS',
    writable: false,
    enabled: true,
  });
  await f.store.transaction(async (tx) => {
    await tx.run(
      "UPDATE TaskTriggers SET origin='USER',enabled=0,version=version+1 WHERE task_id=? AND discovery_key='source-cron'",
      [owned.task.id],
    );
    await tx.run(
      "UPDATE CronTriggers SET expression='0 0 * * *',timezone='Asia/Singapore' WHERE trigger_id IN (SELECT id FROM TaskTriggers WHERE task_id=?)",
      [owned.task.id],
    );
  });
  const manualBefore = hash(await f.tasks.get(manual.task.id));
  const protectedBefore = {};
  for (const table of [
    'TaskRuntimeBindings',
    'TaskExecutionSettings',
    'TaskEnvVariables',
    'TaskConfigBindings',
    'TaskHooks',
    'TaskTriggers',
    'CronTriggers',
  ])
    protectedBefore[table] = await f.store.all(
      'SELECT * FROM ' + table + ' ORDER BY rowid',
    );
  const original = await f.tasks.get(owned.task.id);
  const old = await f.files.read(f.row.id, 'owned.sh');
  await f.files.save(
    f.row.id,
    'owned.sh',
    '# name: Scanner changed name\n# cron: */7 * * * *\nprintf changed\n',
    old.hash,
  );
  const applied = await applyDiscoveryPreview(f);
  assert.equal(applied.result.updated, 1);
  const after = await f.tasks.get(owned.task.id);
  assert.equal(after.task.name, 'User preserved name');
  assert.equal(after.task.enabled, 1);
  assert.equal(after.task.arguments, original.task.arguments);
  assert.equal(after.task.env_profile_id, profile.id);
  for (const [table, rows] of Object.entries(protectedBefore))
    assert.equal(
      hash(await f.store.all('SELECT * FROM ' + table + ' ORDER BY rowid')),
      hash(rows),
      table + ' user values must remain unchanged',
    );
  assert.equal(hash(await f.tasks.get(manual.task.id)), manualBefore);
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM Tasks'))[0].n, 2);
  assert.equal(
    applied.preview.actions.find((action) => action.path === 'manual.sh')
      .action,
    'PRESERVE_USER',
  );
  await f.h.record('S3-DISCOVERY-USER-OWNERSHIP', {
    status: 'PASS',
    expected: 'only owned baseline/name while user ownership is preserved',
    actual: 'Task resources and USER Cron unchanged; manual Task untouched',
    assertions: [
      'manual path not duplicated',
      'custom name preserved',
      'enabled/arguments/profile preserved',
      'runtime/ENV/config/hooks/settings byte-identical',
      'disabled USER source-cron tombstone retained',
    ],
    workspace_id: f.row.id,
    task_id: owned.task.id,
    exit_code: 0,
  });
});

test('S3 removed and renamed scripts retire historical identities with valid Backup proof; reappearance requires explicit restore', async (t) => {
  const f = await createDiscoveryFixture(t, 'S3-DISCOVERY-RETIRE');
  await f.files.create(
    f.row.id,
    'before.sh',
    '# name: Before rename\n# cron: */5 * * * *\nprintf "REAL_HISTORY_BEFORE_RETIRE\\n"\n',
  );
  await advanceDiscoveryGit(f, async (root) => {
    git(['add', 'before.sh'], root);
    git(['commit', '-m', 'actual discoverable script'], root);
  });
  await enableDiscovery(f);
  await applyDiscoveryPreview(f);
  let original = await f.tasks.get(
    (
      await f.store.all('SELECT id FROM Tasks')
    )[0].id,
  );
  original = await f.tasks.setEnabled(
    original.task.id,
    original.task.version,
    true,
  );
  const history = await f.engine.wait(
    (
      await f.engine.submit(original.task.id)
    ).id,
  );
  assert.equal(history.status, 'SUCCESS');
  await f.engine.close();
  await advanceDiscoveryGit(f, async (root) => {
    git(['mv', 'before.sh', 'after.sh'], root);
    git(['commit', '-m', 'actual source rename'], root);
  });
  const renamed = await applyDiscoveryPreview(f);
  assert.equal(renamed.result.created, 1);
  assert.equal(renamed.result.retired, 1);
  let retired = await f.tasks.get(original.task.id);
  assert.equal(retired.task.discovery_state, 'RETIRED');
  assert.equal(retired.task.enabled, 0);
  assert.equal(
    (
      await f.store.all('SELECT COUNT(*) n FROM TaskTriggers WHERE task_id=?', [
        retired.task.id,
      ])
    )[0].n,
    0,
  );
  assert.equal((await f.tasks.history(retired.task.id))[0].id, history.id);
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const snapshotId = await backup.create();
  const manifest = (await backup.snapshot(snapshotId)).manifest;
  assert.equal(
    manifest.workspaces[0].source_references.find(
      (entry) => entry.task_id === retired.task.id,
    ).availability,
    'RETIRED_MISSING_EXPECTED',
  );
  await f.files.create(
    f.row.id,
    'before.sh',
    '# name: Returned original\n# cron: */11 * * * *\nprintf returned\n',
  );
  const returned = await applyDiscoveryPreview(f);
  assert.equal(returned.result.created, 0);
  assert.ok(
    returned.preview.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'SOURCE_RETURNED' &&
        diagnostic.path === 'before.sh',
    ),
  );
  retired = await f.tasks.get(original.task.id);
  assert.equal(retired.task.discovery_state, 'RETIRED');
  assert.equal(retired.task.enabled, 0);
  await assert.rejects(
    new TaskExecutionService(f.store, f.roots, f.leases).submit(
      retired.task.id,
    ),
    { error_code: 'TASK_NOT_READY' },
  );
  const restored = await f.discovery.restoreRetired(
    retired.task.id,
    retired.task.version,
  );
  assert.equal(restored.task.id, original.task.id);
  assert.equal(restored.task.discovery_state, 'ACTIVE');
  assert.equal(restored.task.enabled, 0);
  assert.equal(
    (await f.tasks.history(restored.task.id))[0].source_snapshot,
    history.source_snapshot,
  );
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
  await f.h.record('S3-DISCOVERY-RETIRE', {
    status: 'PASS',
    expected:
      'old identity retired and held history; new rename key; no automatic reactivation',
    actual:
      'real Git rename produced RETIRE+CREATE; missing-source Backup proof accepted; reappearance retained disabled retirement until explicit restore',
    assertions: [
      'actual historical Runner SUCCESS retained',
      'canonical retirement tuple accepted by Backup',
      'Discovery Cron removed on retire',
      'reappearance SOURCE_RETURNED without enable',
      'same original Task ID explicitly restored disabled',
    ],
    workspace_id: f.row.id,
    original_task_id: original.task.id,
    historical_run_id: history.id,
    snapshot_id: snapshotId,
    exit_code: 0,
  });
});

test('S3 suppression persists across a real Store restart and unsuppress never revives a retired Task or USER Cron', async (t) => {
  const f = await createDiscoveryFixture(t, 'S3-DISCOVERY-SUPPRESSION');
  await f.files.create(
    f.row.id,
    'suppressed.sh',
    '# cron: */5 * * * *\nprintf suppressed\n',
  );
  await enableDiscovery(f);
  await applyDiscoveryPreview(f);
  const task = (await f.store.all('SELECT * FROM Tasks'))[0];
  await f.store.run(
    "UPDATE TaskTriggers SET origin='USER',enabled=0,version=version+1 WHERE task_id=?",
    [task.id],
  );
  const userCron = hash(
    await f.store.all('SELECT * FROM TaskTriggers WHERE task_id=?', [task.id]),
  );
  await f.discovery.suppress(f.row.id, {
    discovery_key: task.discovery_key,
    expected_policy_version: 1,
  });
  assert.equal((await f.tasks.get(task.id)).task.discovery_state, 'RETIRED');
  await f.engine.close();
  await f.store.close();
  const reopened = await WorkspaceStore.open(f.databasePath, f.dataRoot);
  await f.a.useStore(reopened);
  const restarted = new GitWorkspaceDiscovery(reopened, f.roots, f.leases);
  const preview = await restarted.preview(f.row.id);
  assert.equal(preview.actions[0].action, 'IGNORE');
  await restarted.apply(f.row.id, {
    preview_token: preview.preview_token,
    expected_version: (await reopened.workspace(f.row.id)).version,
  });
  assert.equal((await reopened.all('SELECT COUNT(*) n FROM Tasks'))[0].n, 1);
  await restarted.unsuppress(f.row.id, {
    discovery_key: task.discovery_key,
    expected_policy_version: 1,
  });
  const next = await restarted.preview(f.row.id);
  assert.equal(next.actions[0].action, 'PRESERVE_USER');
  assert.ok(
    next.diagnostics.some(
      (diagnostic) => diagnostic.code === 'SOURCE_RETURNED',
    ),
  );
  assert.equal(
    (
      await reopened.all(
        'SELECT discovery_state,enabled FROM Tasks WHERE id=?',
        [task.id],
      )
    )[0].discovery_state,
    'RETIRED',
  );
  assert.equal(
    hash(
      await reopened.all('SELECT * FROM TaskTriggers WHERE task_id=?', [
        task.id,
      ]),
    ),
    userCron,
  );
  await f.h.record('S3-DISCOVERY-SUPPRESSION', {
    status: 'PASS',
    expected: 'persistent ignore across restart without duplicate or revival',
    actual:
      'reopened DB retained suppression and USER Cron; explicit unignore only offered returned source',
    assertions: [
      'real Store closed/reopened',
      'suppression persisted',
      'one Task identity only',
      'USER Cron tombstone unchanged',
      'unignore leaves retired/disabled',
    ],
    workspace_id: f.row.id,
    task_id: task.id,
    exit_code: 0,
  });
});

test('S3 signed Preview rejects source changes, policy/Cron/user CAS changes and tampering without partial reconciliation', async (t) => {
  const f = await createDiscoveryFixture(t, 'S3-DISCOVERY-CAS');
  await f.files.create(
    f.row.id,
    'cas.sh',
    '# cron: */5 * * * *\nprintf original\n',
  );
  await enableDiscovery(f);
  let preview = await f.discovery.preview(f.row.id);
  await assert.rejects(
    f.discovery.apply(f.row.id, {
      preview_token: preview.preview_token + 'tampered',
      expected_version: (await f.store.workspace(f.row.id)).version,
    }),
    { error_code: 'DISCOVERY_PREVIEW_STALE' },
  );
  const old = await f.files.read(f.row.id, 'cas.sh');
  await f.files.save(
    f.row.id,
    'cas.sh',
    '# cron: */5 * * * *\nprintf changed\n',
    old.hash,
  );
  await assert.rejects(
    f.discovery.apply(f.row.id, {
      preview_token: preview.preview_token,
      expected_version: (await f.store.workspace(f.row.id)).version,
    }),
    { error_code: 'SOURCE_SUPERSEDED' },
  );
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM Tasks'))[0].n, 0);
  preview = await f.discovery.preview(f.row.id);
  await f.discovery.savePolicy(f.row.id, {
    expected_version: 1,
    enabled: true,
    includes: ['*.sh'],
    excludes: [],
    languages: ['SHELL'],
  });
  await assert.rejects(
    f.discovery.apply(f.row.id, {
      preview_token: preview.preview_token,
      expected_version: (await f.store.workspace(f.row.id)).version,
    }),
    { error_code: 'DISCOVERY_PREVIEW_STALE' },
  );
  await applyDiscoveryPreview(f);
  let task = await f.tasks.get(
    (
      await f.store.all('SELECT id FROM Tasks')
    )[0].id,
  );
  preview = await f.discovery.preview(f.row.id);
  task = await f.tasks.update(task.task.id, task.task.version, {
    name: 'User changed after preview',
  });
  await assert.rejects(
    f.discovery.apply(f.row.id, {
      preview_token: preview.preview_token,
      expected_version: (await f.store.workspace(f.row.id)).version,
    }),
    { error_code: 'DISCOVERY_PREVIEW_STALE' },
  );
  preview = await f.discovery.preview(f.row.id);
  await f.store.run(
    "UPDATE TaskTriggers SET origin='USER',enabled=0,version=version+1 WHERE task_id=?",
    [task.task.id],
  );
  await assert.rejects(
    f.discovery.apply(f.row.id, {
      preview_token: preview.preview_token,
      expected_version: (await f.store.workspace(f.row.id)).version,
    }),
    { error_code: 'DISCOVERY_PREVIEW_STALE' },
  );
  assert.equal(
    (await f.tasks.get(task.task.id)).task.name,
    'User changed after preview',
  );
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 0);
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM WorkspaceUpdateOutbox'))[0].n,
    0,
  );
  await f.h.record('S3-DISCOVERY-CAS', {
    status: 'PASS',
    expected:
      'authenticate and compare source/policy/Task/Trigger state before apply',
    actual:
      'tamper and stale policy/Task/Cron rejected; changed source SOURCE_SUPERSEDED; no partial Task or events',
    assertions: [
      'bounded authenticated token',
      'source version and actual inventory checked',
      'policy CAS',
      'Task CAS',
      'Trigger ownership/version CAS',
      'zero TaskRun/outbox effects',
    ],
    exit_code: 0,
  });
});

test('S3 invalid metadata and runtime kind prevent full apply; missing managed default is explicit and leaves new Task disabled', async (t) => {
  const f = await createDiscoveryFixture(t, 'S3-DISCOVERY-DIAGNOSTICS');
  await f.files.create(
    f.row.id,
    'bad.sh',
    '# name: one\n# name: duplicate\n# cron: definitely invalid\nprintf bad\n',
  );
  await f.files.create(f.row.id, 'good.sh', 'printf good\n');
  await enableDiscovery(f);
  let preview = await f.discovery.preview(f.row.id);
  assert.ok(
    preview.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'CRON_DEFINITION_INVALID' && diagnostic.blocking,
    ),
  );
  assert.ok(
    preview.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'DISCOVERY_METADATA_INVALID' && diagnostic.blocking,
    ),
  );
  await assert.rejects(
    f.discovery.apply(f.row.id, {
      preview_token: preview.preview_token,
      expected_version: (await f.store.workspace(f.row.id)).version,
    }),
    { error_code: 'DISCOVERY_RECONCILIATION_FAILED' },
  );
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM Tasks'))[0].n, 0);
  await f.files.remove(
    f.row.id,
    'bad.sh',
    (
      await f.files.read(f.row.id, 'bad.sh')
    ).hash,
  );
  await applyDiscoveryPreview(f);
  const shell = (await f.store.all('SELECT id FROM Tasks'))[0].id;
  await f.store.run(
    "INSERT INTO TaskRuntimeBindings(task_id,kind,createdAt,updatedAt) VALUES(?,'PYTHON',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    [shell],
  );
  preview = await f.discovery.preview(f.row.id);
  assert.ok(
    preview.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'TASK_RUNTIME_KIND_MISMATCH' && diagnostic.blocking,
    ),
  );
  await assert.rejects(
    f.discovery.apply(f.row.id, {
      preview_token: preview.preview_token,
      expected_version: (await f.store.workspace(f.row.id)).version,
    }),
    { error_code: 'DISCOVERY_RECONCILIATION_FAILED' },
  );
  await f.store.run('DELETE FROM TaskRuntimeBindings WHERE task_id=?', [shell]);
  await f.files.create(
    f.row.id,
    'managed.py',
    'print("needs explicit managed runtime")\n',
  );
  await f.discovery.savePolicy(f.row.id, {
    expected_version: 1,
    enabled: true,
    includes: ['**/*'],
    excludes: [],
    languages: ['PYTHON', 'SHELL'],
  });
  const applied = await applyDiscoveryPreview(f);
  assert.ok(
    applied.preview.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'CONFIGURATION_REQUIRED' && !diagnostic.blocking,
    ),
  );
  const python = (
    await f.store.all(
      "SELECT t.id,t.enabled FROM Tasks t JOIN TaskSources s ON s.task_id=t.id WHERE s.relative_entrypoint='managed.py'",
    )
  )[0];
  assert.equal(python.enabled, 0);
  assert.equal(
    (await f.tasks.readiness(python.id)).status,
    'CONFIGURATION_REQUIRED',
  );
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
  await f.h.record('S3-DISCOVERY-DIAGNOSTICS', {
    status: 'PASS',
    expected:
      'invalid declarations never partial-success; missing managed resources are explicit disabled Task diagnostics',
    actual:
      'ambiguous name/invalid Cron/runtime kind blocked reconciliation; unavailable Python default created disabled canonical Task',
    assertions: [
      'no partial Task after invalid metadata',
      'runtime kind violation explicit blocking',
      'missing managed runtime explicit',
      'no Host fallback',
    ],
    exit_code: 0,
  });
});

test('S3 reconciliation DB apply is filesystem-free and rolls back canonical Task/Source/Cron writes atomically', async (t) => {
  const f = await createDiscoveryFixture(t, 'S3-DISCOVERY-ATOMIC-APPLY');
  await f.files.create(
    f.row.id,
    'atomic.sh',
    '# cron: */5 * * * *\nprintf atomic\n',
  );
  await enableDiscovery(f);
  await f.leases.withWorkspace(
    f.row.id,
    'DISCOVERY_TEST_ATOMIC',
    async (lease) => {
      const plan = await f.discovery.prepareUnderLease(f.row.id, lease);
      const open = fs.open;
      fs.open = async () => {
        throw Error('FILESYSTEM_INSIDE_RECONCILIATION_TX');
      };
      try {
        await assert.rejects(
          f.store.transaction(async (tx) => {
            await f.discovery.applyPlanInTransaction(tx, plan);
            throw Error('INJECTED_COMPLETION_ROLLBACK');
          }),
          /INJECTED_COMPLETION_ROLLBACK/,
        );
      } finally {
        fs.open = open;
      }
    },
  );
  for (const table of [
    'Tasks',
    'TaskSources',
    'TaskExecutionSettings',
    'TaskTriggers',
    'CronTriggers',
  ])
    assert.equal(
      (await f.store.all('SELECT COUNT(*) n FROM ' + table))[0].n,
      0,
      table,
    );
  assert.equal((await applyDiscoveryPreview(f)).result.created, 1);
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
  const local = await f.lifecycle.createLocal({
    name: 'no LOCAL discovery',
    requestKey: 'no-local-discovery',
  });
  await assert.rejects(
    f.discovery.savePolicy(local.id, {
      expected_version: 0,
      enabled: true,
      includes: ['**/*'],
      excludes: [],
      languages: ['SHELL'],
    }),
    { error_code: 'WORKSPACE_TYPE_UNSUPPORTED' },
  );
  await f.h.record('S3-DISCOVERY-ATOMIC-APPLY', {
    status: 'PASS',
    expected:
      'DB-only atomic apply fits parent Sync completion transaction and never accepts LOCAL ownership',
    actual:
      'real candidate writes rolled back together, then fresh apply succeeded; LOCAL denied',
    assertions: [
      'no FS open during DB apply',
      'Task/Source/settings/Cron rollback together',
      'fresh canonical apply succeeds',
      'frozen FK constraints preserved',
      'LOCAL rejected',
    ],
    exit_code: 0,
  });
});
