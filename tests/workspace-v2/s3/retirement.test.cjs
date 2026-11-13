const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSyncFixture } = require('./sync-fixture.cjs');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
const {
  WorkspaceEnvironmentService,
} = require('../../../back/services/taskExecutionV2/environment');
test('S3-RETIRE-001 fresh LOCAL and GIT real S2 execution, ENV, Discovery and Sync require no Subscription domain', async (t) => {
  const f = await createSyncFixture(t, {
    caseId: 'S3-RETIRE-001',
    files: {
      'retired-subscription.sh':
        'test "$OWNED_ENV" = workspace_v2 || exit 17\nprintf "S3_OWNED_OK\\n"\n',
    },
  });
  const local = await f.lifecycle.createLocal({
    name: 'without Subscription',
    requestKey: 'local-independent',
  });
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  await files.create(
    local.id,
    'local.sh',
    'test "$OWNED_ENV" = workspace_v2 || exit 17\nprintf "LOCAL_OWNED_OK\\n"\n',
  );
  const env = new WorkspaceEnvironmentService(f.store, f.roots, f.leases),
    runs = [];
  for (const [ws, entry] of [
    [local, 'local.sh'],
    [await f.store.workspace(f.row.id), 'retired-subscription.sh'],
  ]) {
    let task = await f.tasks.create({
      name: ws.type + ' owned task',
      enabled: true,
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: ws.id,
        relative_entrypoint: entry,
        language: 'SHELL',
        cwd_mode: 'WORKSPACE_ROOT',
        cwd_relative_path: null,
      },
    });
    task = await env.replaceTaskVariables(task.task.id, task.task.version, [
      {
        name: 'OWNED_ENV',
        value: 'workspace_v2',
        operation: 'SET',
        status: 'enabled',
        is_secret: false,
      },
    ]);
    const run = await f.engine.wait(
      (
        await f.engine.submit(task.task.id, {
          submissionKey: 'retire-' + ws.type,
        })
      ).id,
    );
    assert.equal(run.status, 'SUCCESS', run.error_code);
    assert.equal((await f.engine.attempts(run.id)).length, 1);
    runs.push({
      workspace_id: ws.id,
      task_id: task.task.id,
      task_run_id: run.id,
      status: run.status,
    });
  }
  await f.discovery.savePolicy(f.row.id, {
    expected_version: (await f.discovery.policy(f.row.id)).version,
    enabled: true,
    includes: ['**/*.sh'],
    excludes: [],
    languages: ['SHELL'],
  });
  const sync = await f.sync.wait(
    (
      await f.sync.submit(f.row.id, { requestKey: 'owned-sync' })
    ).id,
  );
  assert.equal(sync.status, 'SUCCESS', sync.error_code);
  assert.equal(
    (
      await f.store.all(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('Subscriptions','Worktrees')",
      )
    ).length,
    0,
  );
  for (const table of [
    'Workspaces',
    'GitWorkspaces',
    'Tasks',
    'TaskSources',
    'WorkspaceRuntimeDefaults',
    'WorkspaceSyncPolicies',
    'WorkspaceSyncRuns',
    'WorkspaceUpdateOutbox',
    'WorkspaceDiscoveryPolicies',
  ])
    assert.equal(
      (await f.store.all('PRAGMA table_info(' + table + ')')).some((c) =>
        /subscription|worktree_id/.test(c.name),
      ),
      false,
      table,
    );
  const root = path.resolve(__dirname, '../../..');
  for (const name of await fs.readdir(
    path.join(root, 'back/services/gitWorkspaceV2'),
  )) {
    if (!name.endsWith('.ts')) continue;
    const source = await fs.readFile(
      path.join(root, 'back/services/gitWorkspaceV2', name),
      'utf8',
    );
    assert.equal(
      /(?:from|require\()\s*['"][^'"]*\/(?:subscription|taskExecutionFacade|managedSync)['"]/.test(
        source,
      ),
      false,
      name,
    );
  }
  for (const name of [
    'back/services/subscription.ts',
    'back/data/subscription.ts',
  ])
    assert.ok((await fs.stat(path.join(root, name))).isFile());
  await f.scenario.record('S3-RETIRE-001', {
    subscription_tables: 0,
    subscription_identity_columns: 0,
    actual_runs: runs,
    sync_run_id: sync.id,
    status: sync.status,
    v9_files_retained: true,
  });
});
