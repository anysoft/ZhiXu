const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { s1bSecurityFixture, fs, path } = require('./security-fixture.cjs');

const points = [
  ['Before Candidate Validation', 'restore-after-copy', 'PREPARING'],
  [
    'After Candidate Validation',
    'restore-after-candidate-validation',
    'PREPARED',
  ],
  ['After Old Root Rename', 'restore-after-old-rename', 'PREPARED'],
  [
    'After Candidate Publish',
    'restore-after-candidate-publish',
    'OLD_ROOT_MOVED',
  ],
  ['Before Final Validation', 'restore-before-final-validation', 'VALIDATING'],
  ['After Final Validation', 'restore-after-final-validation', 'VALIDATING'],
  ['Before COMPLETE Commit', 'restore-before-complete', 'VALIDATING'],
];

async function processRestore(t, f, importedId, checkpoint, evidenceFile) {
  const worker = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 'restore-crash-worker.cjs'),
      f.B.dataRoot,
      f.B.backupRoot,
      importedId,
      checkpoint,
      evidenceFile,
    ],
    { cwd: f.projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  worker.stdout.on('data', (chunk) => {
    output += chunk;
  });
  worker.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => worker.kill('SIGKILL'), 60000);
  t.after(() => {
    clearTimeout(timer);
    if (worker.exitCode === null && worker.signalCode === null)
      worker.kill('SIGKILL');
  });
  const result = await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code, signal) =>
      resolve({ code, signal, pid: worker.pid }),
    );
  });
  clearTimeout(timer);
  assert.equal(output.includes(f.secret), false);
  const log = path.join(
    f.evidenceRoot,
    checkpoint.toLowerCase() + '-worker.log',
  );
  await fs.writeFile(log, output, { mode: 0o600, flag: 'wx' });
  return { ...result, output, log };
}

for (const [label, checkpoint, durableStage] of points) {
  test(
    'S1B actual restore SIGKILL ' +
      label +
      ' resumes in a new independent recovery process after A destruction',
    async (t) => {
      const caseId = 'restore-kill-' + checkpoint.replace(/^restore-/, '');
      const f = await s1bSecurityFixture(t, caseId, { gitWorkspace: true });
      const portable = await f.portable();
      await f.safeDestroy(f.A, { archivePath: portable.archive });
      await assert.rejects(fs.lstat(f.A.root), { code: 'ENOENT' });
      const imported = await f.backupB.importPortable(
        portable.archive,
        Buffer.from(portable.passphrase),
      );
      assert.equal(imported.snapshot_id, portable.id);
      await f.B.store.close();
      const killedEvidence = path.join(f.evidenceRoot, 'restore-killed.json');
      const killed = await processRestore(
        t,
        f,
        imported.id,
        checkpoint,
        killedEvidence,
      );
      assert.equal(killed.signal, 'SIGKILL', killed.output);
      const before = JSON.parse(await fs.readFile(killedEvidence, 'utf8'));
      assert.equal(before.checkpoint, checkpoint);
      assert.equal(before.durable_stage, durableStage);
      assert.notEqual(before.durable_stage, 'COMPLETE');
      const recoveryEvidence = path.join(
        f.evidenceRoot,
        'restore-recovered.json',
      );
      const recovered = await processRestore(
        t,
        f,
        imported.id,
        'RECOVER',
        recoveryEvidence,
      );
      assert.equal(recovered.code, 0, recovered.output);
      const after = JSON.parse(await fs.readFile(recoveryEvidence, 'utf8'));
      assert.notEqual(after.pid, before.pid);
      assert.equal(after.stage, 'COMPLETE');
      await f.reopenB();
      const assets = await f.assertRestored();
      await assert.rejects(fs.lstat(f.A.root), { code: 'ENOENT' });
      assert.equal(await f.hashFile(portable.archive), portable.archiveHash);
      assert.equal(await f.backupB.barrier.state(), null);
      await f.record(caseId, {
        status: 'PASS',
        input: {
          requested_point: label,
          checkpoint,
          import_id: imported.id,
          snapshot_id: portable.id,
        },
        expected: 'SIGKILL followed by independent recovery COMPLETE without A',
        actual: {
          killed_signal: killed.signal,
          durable_stage: before.durable_stage,
          recovery_exit_code: recovered.code,
          recovery_stage: after.stage,
          different_controller_pid: before.pid !== after.pid,
          original_A_absent: true,
          archive_hash: portable.archiveHash,
          ...assets,
        },
        assertions: [
          'original Task/Run/Attempt identity and log hash preserved',
          'source and helper bytes preserved',
          'independent process completes durable journal',
          'no false COMPLETE at killed boundary',
          'original A nonexistent',
          'no secret in worker output',
        ],
        evidence_files: [
          path.basename(killedEvidence),
          path.basename(recoveryEvidence),
        ],
      });
    },
  );
}
