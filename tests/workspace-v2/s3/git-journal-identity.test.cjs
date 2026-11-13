const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createSyncFixture } = require('./sync-fixture.cjs');

for (const kind of ['admin-replacement', 'configuration-change'])
  test(
    'recovery rejects real ' +
      kind +
      ' despite clean target HEAD and owned root',
    { timeout: 120000 },
    async (t) => {
      const f = await createSyncFixture(t, { caseId: 'S3-JOURNAL-' + kind });
      const baseline = await f.sync.wait((await f.sync.submit(f.row.id)).id);
      assert.equal(baseline.status, 'SUCCESS', baseline.error_code);
      const target = await f.commit({
        'main.py': 'print("physically applied exact target")\n',
      });
      const run = await f.sync.submit(f.row.id);
      const proofFile = path.join(
        f.scenario.evidenceRoot,
        'actual-head-checkpoint.json',
      );
      const child = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          path.join(__dirname, 'sync-crash-worker.cjs'),
          f.root,
          String(f.repository.id),
          String(run.id),
          'AFTER_PHYSICAL_HEAD_CHANGED',
          proofFile,
        ],
        { env: process.env, stdio: 'ignore' },
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
      t.after(() => {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      });
      const [code, signal] = await once(child, 'exit');
      clearTimeout(timer);
      assert.equal(code, null);
      assert.equal(signal, 'SIGKILL');
      const checkpoint = JSON.parse(await fs.readFile(proofFile, 'utf8'));
      assert.equal(checkpoint.checkpoint, 'AFTER_PHYSICAL_HEAD_CHANGED');
      assert.equal(f.git(['rev-parse', 'HEAD'], f.workspaceRoot), target);
      const deadline = Date.now() + 15000;
      while ((await f.leases.probeWorkspace(f.row.id)).busy) {
        if (Date.now() > deadline) throw Error('GIT_OWNER_NOT_REAPED');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pointer = (
          await fs.readFile(path.join(f.workspaceRoot, '.git'), 'utf8')
        )
          .trim()
          .slice(8),
        admin = path.resolve(f.workspaceRoot, pointer);
      const original = await fs.lstat(admin);
      await f.withLeases(f.row.id, async () => {
        if (kind === 'admin-replacement') {
          const retained = path.join(
            f.scenario.transferRoot,
            'retained-original-admin',
          );
          await fs.rename(admin, retained);
          await fs.cp(retained, admin, {
            recursive: true,
            preserveTimestamps: true,
          });
          assert.notEqual((await fs.lstat(admin)).ino, original.ino);
        } else
          f.git(
            ['config', 'user.name', 'controlled identity proof change'],
            f.repository.bare,
          );
      });
      // The replacement is otherwise a valid S1 Git admin and the target is clean;
      // the durable operation identity, rather than a generic Git error, rejects it.
      const actual = await f.leases.withWorkspace(
        f.row.id,
        'VALID_REPLACEMENT_INSPECT',
        (lease) => f.gitAdapter.inspect(f.row.id, lease),
      );
      assert.equal(actual.head, target);
      await f.sync.recover();
      const blocked = await f.sync.get(run.id);
      assert.equal(blocked.status, 'RECOVERY_REQUIRED');
      assert.equal(blocked.after_commit, null);
      assert.equal(
        (await f.store.workspace(f.row.id)).lifecycle_state,
        'RECOVERY_REQUIRED',
      );
      assert.equal(
        (await f.store.all('SELECT COUNT(*) n FROM WorkspaceUpdateOutbox'))[0]
          .n,
        1,
      );
      assert.equal(
        (await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
        0,
      );
      await f.scenario.record('S3-JOURNAL-' + kind, {
        controller_pid: checkpoint.pid,
        sync_run_id: run.id,
        actual_commit: target,
        root_unchanged: true,
        otherwise_valid_admin: true,
        recovered_status: blocked.status,
        outboxes: 1,
        task_runs: 0,
      });
    },
  );
