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
const {
  WorkspaceBackupService,
} = require('../../../back/services/workspaceV2/backup');
const {
  WorkspaceRestoreService,
} = require('../../../back/services/workspaceV2/restore');

(async () => {
  const [dataRoot, backupRoot, importedId, checkpoint, evidenceFile] =
    process.argv.slice(2);
  const owner = await assertOwnedInstance(path.dirname(dataRoot));
  if (
    dataRoot !== path.join(owner.root, 'data') ||
    backupRoot !== path.join(owner.root, 'backups') ||
    path.dirname(evidenceFile) !== path.join(owner.caseRoot, 'evidence')
  )
    throw Error('S1B_WORKER_PATH_PROOF_FAILED');
  const evidence = async (details) => {
    const handle = await fs.open(evidenceFile, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, ...details }));
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  if (checkpoint === 'RECOVER') {
    const restored = await WorkspaceRestoreService.recoverAt(
      dataRoot,
      backupRoot,
    );
    try {
      const journal = JSON.parse(
        await fs.readFile(
          path.join(
            dataRoot + '.platform-control',
            'workspace-restore-journal.json',
          ),
          'utf8',
        ),
      ).journal;
      await evidence({
        operation: 'RECOVER',
        stage: journal.stage,
        workspace_ids: (
          await restored.all('SELECT id FROM Workspaces ORDER BY id')
        ).map((row) => row.id),
      });
    } finally {
      await restored.close();
    }
    return;
  }
  const store = await WorkspaceStore.open(
    path.join(dataRoot, 'db/database.sqlite'),
    dataRoot,
  );
  const roots = new WorkspaceRootResolver(dataRoot);
  const leases = new WorkspaceLeaseService(
    dataRoot,
    new PlatformBackupBarrier(dataRoot + '.platform-control'),
  );
  const backup = new WorkspaceBackupService(store, roots, leases, backupRoot);
  await new WorkspaceRestoreService(backup, {
    fault: async (phase, metadata) => {
      if (phase !== checkpoint) return;
      const journal = JSON.parse(
        await fs.readFile(
          path.join(
            dataRoot + '.platform-control',
            'workspace-restore-journal.json',
          ),
          'utf8',
        ),
      ).journal;
      await evidence({
        operation: 'RESTORE',
        checkpoint: phase,
        durable_stage: journal.stage,
        operation_id: metadata.operation_id,
      });
      process.kill(process.pid, 'SIGKILL');
    },
  }).restore(importedId, 'imports');
  await store.close();
  throw Error('S1B_RESTORE_CHECKPOINT_NOT_REACHED');
})().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
