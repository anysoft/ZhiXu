const fs = require('node:fs/promises');
const path = require('node:path');
const { assertOwnedInstance } = require('./fixture.cjs');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../../back/services/workspaceV2/lease');
const {
  PlatformBackupBarrier,
} = require('../../../back/services/backup/barrier');
const { syncServices } = require('./sync-fixture.cjs');
(async () => {
  const [instanceRoot, repoId, runId, checkpoint, evidenceFile] =
    process.argv.slice(2);
  const owner = await assertOwnedInstance(instanceRoot);
  if (path.dirname(evidenceFile) !== path.join(owner.caseRoot, 'evidence'))
    throw Error('S3_WORKER_EVIDENCE_PATH');
  const dataRoot = path.join(instanceRoot, 'data'),
    store = await WorkspaceStore.open(
      path.join(dataRoot, 'db/database.sqlite'),
      dataRoot,
    );
  const roots = new WorkspaceRootResolver(dataRoot),
    leases = new WorkspaceLeaseService(
      dataRoot,
      new PlatformBackupBarrier(dataRoot + '.platform-control'),
    );
  const tracked = [];
  const fixture = {
    root: instanceRoot,
    dataRoot,
    store,
    roots,
    leases,
    repository: { id: Number(repoId) },
    track(v) {
      tracked.push(v);
      return v;
    },
  };
  const evidence = async (details) => {
    const h = await fs.open(evidenceFile, 'wx', 0o600);
    try {
      await h.writeFile(JSON.stringify({ pid: process.pid, ...details }));
      await h.sync();
    } finally {
      await h.close();
    }
  };
  let services;
  services = await syncServices(fixture, {
    fault: async (point) => {
      if (point !== checkpoint) return;
      const run = await services.sync.get(Number(runId));
      await evidence({
        checkpoint: point,
        sync_run_id: run.id,
        workspace_id: run.workspace_id,
        status: run.status,
        phase: run.phase,
        git_update_status: run.git_update_status,
        discovery_status: run.discovery_status,
        before_commit: run.before_commit,
        target_commit: run.target_commit,
        actual_commit: run.actual_commit,
        outbox_count: (
          await store.all(
            'SELECT id FROM WorkspaceUpdateOutbox WHERE sync_run_id=?',
            [run.id],
          )
        ).length,
        workspace_state: (
          await store.workspace(run.workspace_id)
        ).lifecycle_state,
      });
      process.kill(process.pid, 'SIGKILL');
    },
  });
  if (checkpoint === 'RECOVER') {
    const deadline = Date.now() + 60000;
    let run;
    do {
      await services.sync.recover();
      run = await services.sync.get(Number(runId));
      if (!['RUNNING', 'QUEUED'].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    await evidence({
      checkpoint,
      sync_run_id: run.id,
      status: run.status,
      phase: run.phase,
      git_update_status: run.git_update_status,
      actual_commit: run.actual_commit,
      after_commit: run.after_commit,
      error_code: run.error_code,
      outbox_count: (
        await store.all(
          'SELECT id FROM WorkspaceUpdateOutbox WHERE sync_run_id=?',
          [run.id],
        )
      ).length,
      workspace_state: (
        await store.workspace(run.workspace_id)
      ).lifecycle_state,
      foreign_key_errors: (await store.all('PRAGMA foreign_key_check')).length,
    });
  } else {
    await services.sync.wait(Number(runId), 60000);
    throw Error('S3_KILL_POINT_NOT_REACHED');
  }
  for (const resource of tracked.reverse()) await resource.close();
  await store.close();
})().catch((e) => {
  process.stderr.write(String(e.stack || e));
  process.exitCode = 1;
});
