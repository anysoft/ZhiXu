const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createS1BFixture, hashFile } = require('./fixture.cjs');
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

test('actual bounded file-backed filesystem ENOSPC refuses backup without false READY or source loss', async (t) => {
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
  const definition = await new TaskService(a.store, a.roots, a.leases).create({
    name: 'disk proof',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: ws.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  const engine = a.track(new TaskExecutionService(a.store, a.roots, a.leases));
  const submitted = await engine.submit(definition.task.id);
  assert.equal((await engine.wait(submitted.id)).status, 'SUCCESS');
  await engine.close();
  const source = path.join(a.roots.path(ws), 'payload.txt');
  const sourceHash = await hashFile(source);
  const image = path.join(s.root, 'bounded-volume.dmg'),
    mount = path.join(s.root, 'bounded-mount');
  await fs.mkdir(mount, { mode: 0o700 });
  let attached = false;
  try {
    if (process.platform !== 'darwin')
      throw Error(
        'S1B_BOUNDED_VOLUME_IMPLEMENTATION_REQUIRED_ON_THIS_PLATFORM',
      );
    execFileSync(
      '/usr/bin/hdiutil',
      [
        'create',
        '-size',
        '32m',
        '-fs',
        'HFS+',
        '-volname',
        'ZhiXuS1B',
        '-type',
        'UDIF',
        image,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const attachedProof = execFileSync(
      '/usr/bin/hdiutil',
      [
        'attach',
        '-nobrowse',
        '-owners',
        'on',
        '-mountpoint',
        mount,
        '-plist',
        image,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    attached = true;
    assert.ok(attachedProof.includes(mount));
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
    // Actual statfs on the 32MiB image proves the production minimum rejects it.
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
    const filler = path.join(mount, 'controlled-filler.bin');
    let observedErrno = null,
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
                break;
              }
            }
            await fd.sync().catch((error) => {
              observedErrno ??= error.code;
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
    assert.equal(await hashFile(source), sourceHash);
    assert.equal(
      await hashFile(path.join(prior.root, 'manifest.json')),
      priorManifest,
    );
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
      input:
        '32MiB private file-backed HFS+ volume filled after official capacity admission',
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
      filler_bytes_written: written,
      source_sha256: sourceHash,
      prior_manifest_sha256: priorManifest,
      initial_backup_id: priorId,
      recovered_backup_id: recoveredId,
    });
  } finally {
    if (attached) {
      // Eject only this test's exact mount point after proving the backing image
      // path and private parent; never detach an arbitrary host disk identifier.
      assert.equal(await fs.realpath(image), image);
      assert.equal(path.dirname(mount), s.root);
      execFileSync('/usr/bin/hdiutil', ['detach', mount], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  }
});
