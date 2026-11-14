const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createS1BFixture, hashFile } = require('./fixture.cjs');
const { prepareBoundedFilesystem } = require('./bounded-volume.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../../back/services/workspaceV2/backup');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');

test(
  process.platform === 'linux'
    ? 'actual bounded Linux tmpfs ENOSPC refuses backup without false READY or source loss'
    : 'actual bounded file-backed filesystem ENOSPC refuses backup without false READY or source loss',
  async (t) => {
    const s = await createS1BFixture(t, { caseId: 'physical-enospc' });
    const a = await s.createInstance('A');
    const ws = await new WorkspaceLifecycleService(
      a.store,
      a.roots,
      a.leases,
    ).createLocal({
      name: 'physical disk exhaustion',
      requestKey: 'physical-enospc',
    });
    const files = new WorkspaceFileService(a.store, a.roots, a.leases);
    await files.create(ws.id, 'main.sh', 'printf "ENOSPC_REAL_CHILD\\n"\n');
    await files.create(ws.id, 'payload.txt', 'bounded-source\n'.repeat(65536));
    const definition = await new TaskService(a.store, a.roots, a.leases).create(
      {
        name: 'disk proof',
        source: {
          type: 'WORKSPACE_ENTRYPOINT',
          workspace_id: ws.id,
          relative_entrypoint: 'main.sh',
          language: 'SHELL',
          cwd_mode: 'WORKSPACE_ROOT',
          cwd_relative_path: null,
        },
      },
    );
    const engine = a.track(
      new TaskExecutionService(a.store, a.roots, a.leases),
    );
    const submitted = await engine.submit(definition.task.id);
    assert.equal((await engine.wait(submitted.id)).status, 'SUCCESS');
    await engine.close();
    const source = path.join(a.roots.path(ws), 'payload.txt');
    const sourceHash = await hashFile(source);
    const bounded = await prepareBoundedFilesystem(s);
    const mount = bounded.mount;
    try {
      if (process.platform === 'darwin')
        assert.equal(bounded.proof.attached_owned_mount, true);
      assert.notEqual((await fs.stat(mount)).dev, (await fs.stat(s.root)).dev);
      const catalog = path.join(mount, 'catalog');
      await fs.mkdir(catalog, { mode: 0o700 });
      const defaultBudget = new WorkspaceBackupService(
        a.store,
        a.roots,
        a.leases,
        catalog,
      );
      await assert.rejects(defaultBudget.create(), {
        error_code: 'DISK_BUDGET_EXCEEDED',
      });
      // Actual statfs on the 32MiB filesystem proves the production minimum rejects it.
      // Only the internal test budget is then lowered to exercise late OS ENOSPC.
      const good = new WorkspaceBackupService(
        a.store,
        a.roots,
        a.leases,
        catalog,
        { limits: { minimumFreeBytes: 1 } },
      );
      const priorId = await good.create();
      const prior = await good.snapshot(priorId);
      const priorManifest = await hashFile(
        path.join(prior.root, 'manifest.json'),
      );
      const priorReady = await hashFile(path.join(prior.root, 'READY'));
      const publishedBeforeFailure = (
        await fs.readdir(path.join(catalog, 'snapshots'))
      ).sort();
      const filler = path.join(mount, 'controlled-filler.bin');
      let observedErrno = null,
        observedErrnoNumber = null,
        written = 0;
      const failed = new WorkspaceBackupService(
        a.store,
        a.roots,
        a.leases,
        catalog,
        {
          limits: { minimumFreeBytes: 1 },
          fault: async (point) => {
            if (point !== 'backup-before-copy') return;
            const fd = await fs.open(filler, 'wx', 0o600);
            try {
              const bytes = Buffer.alloc(1024 * 1024, 0x6d);
              for (let i = 0; i < 40; i++) {
                try {
                  const result = await fd.write(bytes);
                  written += result.bytesWritten;
                } catch (error) {
                  observedErrno = error.code;
                  observedErrnoNumber = Math.abs(error.errno);
                  break;
                }
              }
              await fd.sync().catch((error) => {
                observedErrno ??= error.code;
                observedErrnoNumber ??= Math.abs(error.errno);
              });
            } finally {
              await fd.close();
            }
            assert.equal(
              observedErrno,
              'ENOSPC',
              'the actual OS must reject writes on the bounded image',
            );
          },
        },
      );
      let code;
      await assert.rejects(failed.create(), (error) => {
        code = error.error_code || error.code;
        return code === 'DISK_BUDGET_EXCEEDED';
      });
      assert.equal(observedErrno, 'ENOSPC');
      assert.equal(observedErrnoNumber, 28);
      assert.deepEqual(
        (await fs.readdir(path.join(catalog, 'snapshots'))).sort(),
        publishedBeforeFailure,
        'failed snapshot must never publish a new READY root',
      );
      for (const id of await fs.readdir(path.join(catalog, '.staging')))
        await assert.rejects(
          fs.lstat(path.join(catalog, '.staging', id, 'READY')),
          { code: 'ENOENT' },
        );
      assert.equal(await hashFile(source), sourceHash);
      assert.equal(
        await hashFile(path.join(prior.root, 'manifest.json')),
        priorManifest,
      );
      assert.equal(await hashFile(path.join(prior.root, 'READY')), priorReady);
      await fs.unlink(filler);
      await good.validateRoot(prior.root);
      const recoveredId = await good.create();
      assert.notEqual(recoveredId, priorId);
      await good.snapshot(recoveredId);
      assert.equal(
        (
          await a.store.all('SELECT status FROM TaskRuns WHERE id=?', [
            submitted.id,
          ])
        )[0].status,
        'SUCCESS',
      );
      await s.record('actual-os-enospc', {
        input: bounded.input,
        expected:
          'actual ENOSPC; no false successful snapshot; source/prior backup unchanged; retry succeeds after filler removal',
        actual: code,
        status: 'PASS',
        exit_code: 0,
        assertions: [
          'OS errno ENOSPC observed',
          'original source hash unchanged',
          'prior READY manifest hash unchanged',
          'original Run status unchanged',
          'official backup succeeds after capacity restored',
        ],
        os_errno: observedErrno,
        os_errno_number: observedErrnoNumber,
        bounded_filesystem: bounded.proof,
        filler_bytes_written: written,
        source_sha256: sourceHash,
        prior_manifest_sha256: priorManifest,
        prior_ready_sha256: priorReady,
        published_snapshots_before_failure: publishedBeforeFailure,
        published_snapshots_after_failure: publishedBeforeFailure,
        initial_backup_id: priorId,
        recovered_backup_id: recoveredId,
      });
    } finally {
      await bounded.close();
    }
  },
);
