const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFixture, createDatabase } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../back/services/workspaceV2/lease');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const {
  WorkspaceRestoreService,
} = require('../../back/services/workspaceV2/restore');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  TaskResourceResolver,
} = require('../../back/services/taskExecutionV2/resources');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');

test('real executed candidate history, immutable source and references survive component restore; unknown injection journal blocks backup', async (t) => {
  const f = await createFixture(t);
  const ws = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'backup task', requestKey: 's2-backup' });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    ws.id,
    'main.sh',
    'printf "S2_BACKUP_REAL_CHILD\\n"\n',
  );
  const task = await new TaskService(f.store, f.roots, f.leases).create({
    name: 'history',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: ws.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  const engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  const submitted = await engine.submit(task.task.id);
  const run = await engine.wait(submitted.id);
  assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
  assert.match(await engine.logs(run.id), /S2_BACKUP_REAL_CHILD/);
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const id = await backup.create();
  const snapshot = await backup.snapshot(id);
  assert.equal(
    snapshot.manifest.workspaces[0].source_references[0].task_id,
    task.task.id,
  );
  const journalDir = await f.roots.directory(
    'tmp/config-materialization',
    true,
  );
  const unknown = path.join(journalDir, 'unknown.json');
  await fs.writeFile(unknown, 'unresolved private injection state', {
    mode: 0o600,
  });
  await assert.rejects(backup.create(100), {
    error_code: 'BACKUP_RECOVERY_REQUIRED',
  });
  assert.equal(
    await fs.readFile(unknown, 'utf8'),
    'unresolved private injection state',
  );
  await fs.unlink(unknown);
  const target = path.join(f.root, 'history-component-restore');
  const db = await createDatabase(target);
  const store = f.track(await WorkspaceStore.open(db, target));
  const roots = new WorkspaceRootResolver(target);
  const leases = new WorkspaceLeaseService(
    target,
    new PlatformBackupBarrier(target + '.platform-control'),
  );
  const restored = f.track(
    await new WorkspaceRestoreService(
      new WorkspaceBackupService(store, roots, leases, f.backupRoot),
    ).restore(id),
  );
  const history = (
    await restored.all('SELECT * FROM TaskRuns WHERE id=?', [run.id])
  )[0];
  assert.equal(history.status, 'SUCCESS');
  assert.equal(history.source_snapshot, run.source_snapshot);
  assert.equal(history.admission_snapshot, run.admission_snapshot);
  assert.equal(
    (
      await restored.all(
        'SELECT status FROM TaskRunAttempts WHERE task_run_id=?',
        [run.id],
      )
    )[0].status,
    'SUCCESS',
  );
  assert.equal(
    (
      await new TaskResourceResolver(restored, roots, leases).readiness(
        task.task.id,
      )
    ).status,
    'READY',
  );
  assert.deepEqual(await restored.all('PRAGMA foreign_key_check'), []);
  // Component restore only: A remains available and no task is executed in B.
  // The separately authorized S1.B disaster-recovery gate remains NOT_RUN.
  assert.equal((await restored.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 1);
  assert.equal(
    await fs.readFile(path.join(f.roots.path(ws), 'main.sh'), 'utf8'),
    'printf "S2_BACKUP_REAL_CHILD\\n"\n',
  );
});
