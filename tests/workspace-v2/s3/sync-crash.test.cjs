const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSyncFixture } = require('./sync-fixture.cjs');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../../back/services/workspaceV2/backup');
const points = [
  'BEFORE_FETCH',
  'AFTER_FETCH',
  'BEFORE_FF_APPLY',
  'AFTER_PHYSICAL_HEAD_CHANGED',
  'BEFORE_DISCOVERY',
  'DURING_DISCOVERY',
  'AFTER_DISCOVERY',
  'BEFORE_DB_SUCCESS_COMMIT',
  'AFTER_DB_COMMIT',
];
async function worker(t, f, runId, checkpoint, evidence) {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 'sync-crash-worker.cjs'),
      f.root,
      String(f.repository.id),
      String(runId),
      checkpoint,
      evidence,
    ],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (output += b));
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  t.after(() => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  const result = await new Promise((res, rej) => {
    child.once('error', rej);
    child.once('exit', (code, signal) => res({ code, signal, pid: child.pid }));
  });
  clearTimeout(timer);
  return { ...result, output };
}
for (const checkpoint of points)
  test(
    'S3-CRASH ' + checkpoint + ' actual SIGKILL and independent recovery',
    async (t) => {
      const f = await createSyncFixture(t, {
        caseId: 'S3-CRASH-' + checkpoint,
        files: { 'one.sh': 'echo baseline\n' },
      });
      const baseline = await f.sync.wait(
        (
          await f.sync.submit(f.row.id, { requestKey: 'baseline' })
        ).id,
      );
      assert.equal(baseline.status, 'SUCCESS', baseline.error_code);
      await f.discovery.savePolicy(f.row.id, {
        expected_version: (await f.discovery.policy(f.row.id)).version,
        enabled: true,
        includes: ['**/*.sh'],
        excludes: [],
        languages: ['SHELL'],
      });
      const target = await f.commit({
        'one.sh': 'echo new\n',
        'two.sh': 'echo discovered\n',
      });
      const run = await f.sync.submit(f.row.id, { requestKey: 'crash' });
      const killedEvidence = path.join(
        f.scenario.evidenceRoot,
        checkpoint + '.json',
      );
      const killed = await worker(t, f, run.id, checkpoint, killedEvidence);
      assert.equal(killed.signal, 'SIGKILL', killed.output);
      const before = JSON.parse(await fs.readFile(killedEvidence, 'utf8'));
      assert.equal(before.checkpoint, checkpoint);
      const committed = checkpoint === 'AFTER_DB_COMMIT';
      assert.equal(before.status, committed ? 'SUCCESS' : 'RUNNING');
      assert.equal(before.outbox_count, committed ? 1 : 0);
      const applied = ![
        'BEFORE_FETCH',
        'AFTER_FETCH',
        'BEFORE_FF_APPLY',
      ].includes(checkpoint);
      if (applied && !committed) {
        assert.equal(
          (await f.store.workspace(f.row.id)).lifecycle_state,
          'RECOVERY_REQUIRED',
        );
        const files = new WorkspaceFileService(f.store, f.roots, f.leases);
        await assert.rejects(
          files.tree(f.row.id),
          (e) => e.error_code === 'WORKSPACE_RECOVERY_REQUIRED',
        );
        const backup = new WorkspaceBackupService(
          f.store,
          f.roots,
          f.leases,
          f.backupRoot,
        );
        await assert.rejects(backup.create(100), (e) =>
          [
            'WORKSPACE_RECOVERY_REQUIRED',
            'BACKUP_BUSY',
            'BACKUP_SOURCE_NOT_IDLE',
            'BACKUP_RECOVERY_REQUIRED',
          ].includes(e.error_code),
        );
      }
      const recoveryEvidence = path.join(
        f.scenario.evidenceRoot,
        checkpoint + '-recovered.json',
      );
      const recovered = await worker(t, f, run.id, 'RECOVER', recoveryEvidence);
      assert.equal(recovered.code, 0, recovered.output);
      const after = JSON.parse(await fs.readFile(recoveryEvidence, 'utf8'));
      assert.notEqual(after.pid, before.pid);
      assert.equal(after.foreign_key_errors, 0);
      assert.equal(
        after.status,
        applied ? 'SUCCESS' : 'INTERRUPTED',
        after.error_code,
      );
      assert.equal(after.outbox_count, applied ? 1 : 0);
      assert.equal(after.workspace_state, 'READY');
      if (applied) {
        assert.equal(after.after_commit, target);
        assert.equal(after.actual_commit, target);
      } else {
        const retry = await f.sync.wait(
          (
            await f.sync.submit(f.row.id, { requestKey: 'after-interrupted' })
          ).id,
        );
        assert.equal(retry.status, 'SUCCESS', retry.error_code);
        assert.equal(retry.after_commit, target);
      }
      await f.sync.recover();
      assert.equal(
        (
          await f.store.all(
            'SELECT id FROM WorkspaceUpdateOutbox WHERE after_commit=?',
            [target],
          )
        ).length,
        1,
      );
      assert.equal((await f.store.all('SELECT id FROM TaskRuns')).length, 0);
      await f.scenario.record('S3-CRASH-' + checkpoint, {
        checkpoint,
        killed_signal: killed.signal,
        independent_recovery: before.pid !== after.pid,
        repository_id: f.repository.id,
        workspace_id: f.row.id,
        before_commit: before.before_commit,
        target_commit: target,
        actual_commit: after.actual_commit,
        sync_run_id: run.id,
        status: after.status,
        outbox_count: after.outbox_count,
        no_false_success: committed || before.status !== 'SUCCESS',
        source_generation: (
          await f.store.workspace(f.row.id)
        ).source_generation,
      });
    },
  );
module.exports = { worker };
