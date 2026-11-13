// Actual independent controller; all service/lease objects are opened here.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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
const { git } = require('./git-fixture.cjs');

async function gitAdapterCrashWorker() {
  const [instanceRoot, selected, mode] = process.argv.slice(2),
    workspaceId = Number(selected);
  const dataRoot = path.join(instanceRoot, 'data'),
    store = await WorkspaceStore.open(
      path.join(dataRoot, 'db/database.sqlite'),
      dataRoot,
    );
  const roots = new WorkspaceRootResolver(dataRoot),
    barrier = new PlatformBackupBarrier(dataRoot + '.platform-control');
  const f = {
    root: instanceRoot,
    dataRoot,
    store,
    roots,
    leases: new WorkspaceLeaseService(dataRoot, barrier),
    repository: { id: 1 },
    track: (resource) => resource,
  };
  const row = await store.workspace(workspaceId),
    root = roots.path(row),
    before = git(['rev-parse', 'HEAD'], root);
  const pointer = (await fs.readFile(path.join(root, '.git'), 'utf8'))
      .trim()
      .slice(8),
    admin = path.resolve(root, pointer);
  let notified = false;
  const descendants = () => {
    const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
    })
      .split('\n')
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match
          ? [
              {
                id: Number(match[1]),
                parent: Number(match[2]),
                command: match[3],
              },
            ]
          : [];
      });
    const owned = new Set([process.pid]);
    for (let round = 0; round < 8; round++)
      for (const process of processes)
        if (owned.has(process.parent)) owned.add(process.id);
    return processes.filter(
      (process) => owned.has(process.id) && process.id !== global.process.pid,
    );
  };
  const fault = async (phase) => {
    if (
      notified ||
      phase !== (mode === 'FETCH' ? 'DURING_FETCH' : 'DURING_CHECKOUT')
    )
      return;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const processes = descendants(),
        gitChildren = processes.filter((p) =>
          /(?:^|\/)git(?: |-|$)/.test(p.command),
        );
      let physical;
      if (mode === 'FETCH')
        physical = gitChildren.some((p) =>
          /upload-pack|pack-objects/.test(p.command),
        );
      else
        physical =
          (
            await fs
              .readFile(path.join(root, 'bulk/f0000.txt'), 'utf8')
              .catch(() => '')
          ).startsWith('B') &&
          !!(await fs
            .lstat(path.join(admin, 'index.lock'))
            .catch(() => null)) &&
          git(['rev-parse', 'HEAD'], root) === before &&
          gitChildren.length > 0;
      if (physical) {
        notified = true;
        process.send({
          point: mode,
          controller: process.pid,
          liveGitPids: gitChildren.map((p) => p.id),
          headBefore: before,
          actualInFlight: true,
          ...(mode === 'CHECKOUT'
            ? {
                firstFileChanged: true,
                indexLocked: true,
                headStillBefore: true,
              }
            : { realUploadPack: true }),
        });
        await new Promise(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw Object.assign(Error('PHYSICAL_CHECKPOINT_NOT_OBSERVED'), {
      code: 'PHYSICAL_CHECKPOINT_NOT_OBSERVED',
    });
  };
  const { sync } = await syncServices(f, { fault });
  const run = await sync.submit(workspaceId, {
    requestKey: 'real-inflight-' + mode,
  });
  process.send({ runId: run.id });
  await sync.wait(run.id, 120000);
  throw Object.assign(Error('CHECKPOINT_NOT_REACHED'), {
    code: 'CHECKPOINT_NOT_REACHED',
  });
}
gitAdapterCrashWorker().catch((error) => {
  process.send?.({
    failure: /^[A-Z0-9_]+$/.test(error.code || error.error_code || '')
      ? error.code || error.error_code
      : 'WORKER_FAILURE',
    frames: String(error.stack || '')
      .split('\n')
      .filter((line) => line.trim().startsWith('at ')),
  });
  process.exitCode = 1;
});
