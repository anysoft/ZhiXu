const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
process.env.TS_NODE_PROJECT = path.resolve('back/tsconfig.json');
require('ts-node/register/transpile-only');
const { createFixture } = require('../workspace-v2/fixture.cjs');
const { BackupPaths } = require('../../back/services/backup/paths');
const { BackupOperations } = require('../../back/services/backup/operations');
const { privateJson } = require('../../back/services/backup/files');
const {
  RuntimeRestoreReconciler,
} = require('../../back/services/backup/runtimeRestore');
const { RestoreRebuildService } = require('../../back/services/backup/rebuild');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const { OfflineBackupManager } = require('../../back/services/backup/offline');
const { TaskService } = require('../../back/services/taskExecutionV2/task');

test('current v2 FULL snapshot validates and restores LOCAL Workspace and Task into a different offline data root', async (t) => {
  const f = await createFixture(t);
  const workspace = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'Current backup source', requestKey: randomUUID() });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    workspace.id,
    'main.sh',
    'echo restored-local-backup\n',
  );
  const task = await new TaskService(f.store, f.roots, f.leases).create({
    name: 'Current backup task',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: workspace.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const id = await backup.create();
  assert.equal((await backup.snapshot(id)).manifest.backup_mode, 'FULL');
  const dataRoot = path.join(f.root, 'restored-data');
  const manager = new OfflineBackupManager({
    dataRoot,
    backupRoot: f.backupRoot,
    projectRoot: f.projectRoot,
  });
  await manager.restoreSnapshot(id);
  const restored = f.track(
    await WorkspaceStore.open(
      path.join(dataRoot, 'db/database.sqlite'),
      dataRoot,
    ),
  );
  const row = await restored.workspace(workspace.id);
  const owner = await new WorkspaceRootResolver(dataRoot).requireOwned(row);
  assert.equal(
    await fs.readFile(path.join(owner.root, 'main.sh'), 'utf8'),
    'echo restored-local-backup\n',
  );
  assert.equal(
    (await restored.all('SELECT name FROM Tasks WHERE id=?', [task.task.id]))[0]
      .name,
    'Current backup task',
  );
  assert.equal(
    (
      await restored.all(
        'SELECT relative_entrypoint FROM TaskSources WHERE task_id=?',
        [task.task.id],
      )
    )[0].relative_entrypoint,
    'main.sh',
  );
  assert.deepEqual(await restored.all('PRAGMA foreign_key_check'), []);
});

// These shared assertions previously lived in the retired v9 coordinator suite.
// A fresh v2 database now supplies their fixture without any legacy bootstrap.
test('failed managed resource remains visible and prevents a false successful rebuild', async (t) => {
  const f = await createFixture(t);
  await f.store.run(
    "INSERT INTO RuntimeProviders(id,language,provider_type,state,install_root,createdAt,updatedAt) VALUES(1,'PYTHON','PYENV','READY','runtime/python/pyenv',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  );
  await f.store.run(
    "INSERT INTO RuntimeInstallations(id,provider_id,language,implementation,version,state,executable_relative_path,last_error,createdAt,updatedAt) VALUES(1,1,'PYTHON','CPYTHON','3.13.15','ERROR','bin/python','INSTALL_FAILED',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  );
  const reconciler = new RuntimeRestoreReconciler();
  assert.equal((await reconciler.plan(f.dataRoot)).python_runtimes[0].id, 1);
  await assert.rejects(
    new RestoreRebuildService(
      new BackupPaths(f.dataRoot, f.backupRoot),
      {},
    ).run(),
    /RESTORE_REBUILD_FAILED/,
  );
  await f.store.run(
    "UPDATE RuntimeInstallations SET state='READY',last_error=NULL",
  );
  assert.equal((await reconciler.plan(f.dataRoot)).python_runtimes.length, 0);
});

test('runtime restore invalidates physical Python provider while retaining logical Node catalog provider', async (t) => {
  const f = await createFixture(t);
  await f.store.run(
    "INSERT INTO RuntimeProviders(id,language,provider_type,state,install_root,createdAt,updatedAt) VALUES(1,'PYTHON','PYENV','READY','runtime/python/pyenv',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),(2,'NODE','NODE_DISTRIBUTION','READY','runtime/node',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  );
  await new RuntimeRestoreReconciler().reconcile(f.dataRoot);
  assert.deepEqual(
    (await f.store.all('SELECT state FROM RuntimeProviders ORDER BY id')).map(
      (row) => row.state,
    ),
    ['MISSING', 'READY'],
  );
});

test('operation status endpoint reader survives progress publication between open and fstat', async (t) => {
  const f = await createFixture(t);
  const paths = new BackupPaths(f.dataRoot, f.backupRoot);
  await paths.initialize();
  const id = randomUUID(),
    file = await paths.bucket('operations', id);
  await privateJson(file, { id, kind: 'REBUILD', status: 'RUNNING' });
  const original = fs.open;
  let reads = 0;
  const handles = [];
  t.mock.method(fs, 'open', async function (name, ...args) {
    const handle = await original.call(fs, name, ...args);
    if (name === file) {
      handles.push(handle);
      if (++reads === 1)
        await privateJson(file, {
          id,
          kind: 'REBUILD',
          status: 'SUCCESS',
          result: { rebuilt: true },
        });
    }
    return handle;
  });
  assert.deepEqual(await new BackupOperations(paths).get(id), {
    id,
    kind: 'REBUILD',
    status: 'SUCCESS',
    result: { rebuilt: true },
  });
  assert.equal(reads, 2);
  assert.ok(handles.every((handle) => handle.fd === -1));
});
