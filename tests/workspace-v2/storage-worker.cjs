// Real process crash qualification. Uses only the explicit isolated fixture root.
const fs = require('node:fs');
const path = require('node:path');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../back/services/workspaceV2/lease');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');

async function main() {
  const [mode, dataRoot, workspaceId, argument] = process.argv.slice(2);
  const id = Number(workspaceId);
  const roots = new WorkspaceRootResolver(dataRoot);
  const leases = new WorkspaceLeaseService(
    dataRoot,
    new PlatformBackupBarrier(dataRoot + '.platform-control'),
  );
  if (mode === 'fd') {
    await leases.withWorkspace(id, 'FD_INHERITANCE_TEST', (lease) =>
      lease.run(
        process.execPath,
        [path.join(__dirname, 'storage-child.cjs'), argument],
        dataRoot,
        process.env,
        20,
      ),
    );
    return;
  }
  const store = await WorkspaceStore.open(
    path.join(dataRoot, 'db/database.sqlite'),
    dataRoot,
  );
  let watcher;
  try {
    const files = new WorkspaceFileService(store, roots, leases, {
      fault: async (phase) => {
        if (mode === 'save' && phase === argument)
          process.kill(process.pid, 'SIGKILL');
        if (mode === 'mid-save' && phase === 'FILE_PREPARED') {
          watcher = fs.watch(
            roots.path(await store.workspace(id)),
            (_event, name) => {
              if (String(name).startsWith('.platform-workspace-'))
                process.kill(process.pid, 'SIGKILL');
            },
          );
        }
      },
    });
    const prior = await files.read(id, 'atomic.txt');
    await files.save(
      id,
      'atomic.txt',
      'N'.repeat(1024 * 1024) + '\n',
      prior.hash,
    );
  } finally {
    watcher?.close();
    await store.close();
  }
}
main().catch((error) => {
  process.stderr.write(
    String(error.error_code || error.code || 'WORKER_FAILED'),
  );
  process.exitCode = 1;
});
