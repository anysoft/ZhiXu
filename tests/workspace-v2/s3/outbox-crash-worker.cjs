const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
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
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');
const {
  WorkspaceGitUpdateOutbox,
} = require('../../../back/services/gitWorkspaceV2/outbox');

(async () => {
  const [instanceRoot, idText, checkpoint, evidenceFile, holdFile] =
    process.argv.slice(2);
  const proof = await assertOwnedInstance(instanceRoot);
  if (path.dirname(evidenceFile) !== path.join(proof.caseRoot, 'evidence'))
    throw Error('S3_OUTBOX_EVIDENCE_PATH_INVALID');
  if (
    holdFile &&
    path.dirname(holdFile) !== path.join(proof.caseRoot, 'evidence')
  )
    throw Error('S3_OUTBOX_HOLD_PATH_INVALID');
  const dataRoot = path.join(instanceRoot, 'data');
  const store = await WorkspaceStore.open(
    path.join(dataRoot, 'db/database.sqlite'),
    dataRoot,
  );
  const roots = new WorkspaceRootResolver(dataRoot),
    leases = new WorkspaceLeaseService(
      dataRoot,
      new PlatformBackupBarrier(dataRoot + '.platform-control'),
    );
  const engine = new TaskExecutionService(store, roots, leases);
  const id = Number(idText);
  const evidence = async (details) => {
    const file = await fs.open(evidenceFile, 'wx', 0o600);
    try {
      await file.writeFile(
        JSON.stringify({ pid: process.pid, checkpoint, ...details }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
  };
  const outbox = new WorkspaceGitUpdateOutbox(store, roots, leases, engine, {
    clock:
      checkpoint === 'PROBE'
        ? { now: () => new Date(Date.now() + 120000) }
        : undefined,
    fault: async (point) => {
      if (point !== checkpoint) return;
      const row = await outbox.get(id);
      await evidence({
        outbox_id: id,
        outbox_status: row.status,
        owner_token_present: !!row.owner_token,
        owner_epoch_hash: createHash('sha256')
          .update(row.owner_token || '')
          .digest('hex'),
        events: await store.all(
          'SELECT id,status,task_run_id FROM TriggerEvents WHERE workspace_update_id=? ORDER BY id',
          [id],
        ),
        runs: await store.all(
          'SELECT id,status,attempt_count,submission_key FROM TaskRuns ORDER BY id',
        ),
      });
      if (holdFile) {
        const deadline = Date.now() + 15000;
        while (true) {
          const stat = await fs.lstat(holdFile).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (stat) {
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.nlink !== 1 ||
              stat.mode & 0o077 ||
              (process.getuid && stat.uid !== process.getuid())
            )
              throw Error('S3_OUTBOX_HOLD_NOT_OWNED');
            break;
          }
          if (Date.now() > deadline) throw Error('S3_OUTBOX_HOLD_DEADLINE');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      process.kill(process.pid, 'SIGKILL');
    },
  });
  if (checkpoint === 'PROBE') {
    const row = await outbox.dispatchOne(id);
    await evidence({
      outbox_id: id,
      outbox_status: row.status,
      owner_epoch_hash: createHash('sha256')
        .update(row.owner_token || '')
        .digest('hex'),
      expired_under_probe_clock:
        new Date(row.claim_expires_at).getTime() < Date.now() + 120000,
      attempt_count: row.attempt_count,
      run_count: (await store.all('SELECT id FROM TaskRuns')).length,
    });
    await engine.close();
    await store.close();
    return;
  }
  if (checkpoint !== 'RECOVER') {
    await outbox.dispatchOne(id);
    throw Error('S3_OUTBOX_KILL_POINT_NOT_REACHED');
  }
  await outbox.recover();
  const runs = await store.all(
    'SELECT r.id FROM TaskRuns r JOIN TriggerEvents e ON e.task_run_id=r.id WHERE e.workspace_update_id=? ORDER BY r.id',
    [id],
  );
  const results = [];
  for (const run of runs) {
    const terminal = await engine.wait(run.id);
    results.push({
      id: terminal.id,
      status: terminal.status,
      attempt_count: terminal.attempt_count,
      expected_git_commit: terminal.expected_git_commit,
      log_sha256: createHash('sha256')
        .update(await engine.logs(run.id))
        .digest('hex'),
    });
  }
  await evidence({
    outbox_id: id,
    outbox_status: (await outbox.get(id)).status,
    runs: results,
    foreign_key_errors: (await store.all('PRAGMA foreign_key_check')).length,
  });
  await engine.close();
  await store.close();
})().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
