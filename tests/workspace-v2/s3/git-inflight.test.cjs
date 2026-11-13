const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createSyncFixture } = require('./sync-fixture.cjs');

for (const mode of ['FETCH', 'CHECKOUT'])
  test(
    'Sync SIGKILL during actual ' +
      mode +
      ' retains real FD ownership and honest recovery',
    { timeout: 240000 },
    async (t) => {
      const files = {};
      for (let index = 0; index < 4000; index++)
        files['bulk/f' + String(index).padStart(4, '0') + '.txt'] =
          'A' + index + '\n';
      const f = await createSyncFixture(t, {
        caseId: 'S3-INFLIGHT-' + mode,
        files,
      });
      const baseline = await f.sync.wait(
        (
          await f.sync.submit(f.row.id, { requestKey: 'baseline' })
        ).id,
      );
      assert.equal(baseline.status, 'SUCCESS', baseline.error_code);
      const before = await f.store.workspace(f.row.id),
        beforeHead = baseline.after_commit;
      const update = {};
      for (let index = 0; index < 4000; index++)
        update['bulk/f' + String(index).padStart(4, '0') + '.txt'] =
          'B' + crypto.randomBytes(8192).toString('hex') + '\n';
      const target = await f.commit(
        update,
        'actual bounded in-flight Git tree',
      );
      const child = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          path.join(__dirname, 'git-sync-worker.cjs'),
          f.root,
          String(f.row.id),
          mode,
        ],
        {
          cwd: f.projectRoot,
          env: process.env,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      });
      let runId;
      const observed = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('ACTUAL_GIT_CHECKPOINT_TIMEOUT')),
          150000,
        );
        child.on('message', (message) => {
          if (message.runId) runId = message.runId;
          if (message.failure) {
            clearTimeout(timer);
            reject(
              Object.assign(Error(message.failure), { code: message.failure }),
            );
          }
          if (message.point) {
            clearTimeout(timer);
            resolve(message);
          }
        });
        child.on('exit', () => {
          clearTimeout(timer);
          reject(Error('CONTROLLER_EXITED_BEFORE_CHECKPOINT'));
        });
      });
      assert.equal(observed.actualInFlight, true);
      assert.ok(observed.liveGitPids.length);
      assert.ok(runId);
      await assert.rejects(
        f.leases.withRepository(
          f.repository.id,
          'INFLIGHT_REPO_PROBE',
          async () => {},
        ),
        { error_code: 'WORKSPACE_BUSY' },
      );
      if (mode === 'CHECKOUT')
        assert.equal((await f.leases.probeWorkspace(f.row.id)).busy, true);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      const [killedExitCode, killedSignal] = await exited;
      assert.equal(killedExitCode, null);
      assert.equal(killedSignal, 'SIGKILL');
      const deadline = Date.now() + 30000;
      for (;;) {
        try {
          await f.leases.withRepository(
            f.repository.id,
            'REAPED_PROBE',
            async () => {},
          );
          break;
        } catch (error) {
          if (error.error_code !== 'WORKSPACE_BUSY' || Date.now() > deadline)
            throw error;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      const recoveryEvidence = path.join(
        f.scenario.evidenceRoot,
        'fresh-recovery-' + mode + '.json',
      );
      const recovery = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          path.join(__dirname, 'sync-crash-worker.cjs'),
          f.root,
          String(f.repository.id),
          String(runId),
          'RECOVER',
          recoveryEvidence,
        ],
        { cwd: f.projectRoot, env: process.env, stdio: 'ignore' },
      );
      const recoveryTimer = setTimeout(() => recovery.kill('SIGKILL'), 90000);
      t.after(() => {
        clearTimeout(recoveryTimer);
        if (recovery.exitCode === null && recovery.signalCode === null)
          recovery.kill('SIGKILL');
      });
      const [recoveryExitCode, recoverySignal] = await once(recovery, 'exit');
      clearTimeout(recoveryTimer);
      assert.equal(recoveryExitCode, 0);
      assert.equal(recoverySignal, null);
      const recoveryProof = JSON.parse(
        await fs.readFile(recoveryEvidence, 'utf8'),
      );
      assert.equal(recoveryProof.checkpoint, 'RECOVER');
      assert.equal(recoveryProof.pid, recovery.pid);
      assert.notEqual(recoveryProof.pid, observed.controller);
      const recovered = await f.sync.get(runId),
        after = await f.store.workspace(f.row.id);
      assert.equal(recoveryProof.status, recovered.status);
      if (mode === 'FETCH') {
        assert.equal(recovered.status, 'INTERRUPTED', recovered.error_code);
        assert.equal(after.lifecycle_state, 'READY');
        assert.equal(
          after.content_inventory_hash,
          before.content_inventory_hash,
        );
        assert.equal(f.git(['rev-parse', 'HEAD'], f.workspaceRoot), beforeHead);
      } else {
        assert.ok(
          ['SUCCESS', 'RECOVERY_REQUIRED', 'INTERRUPTED'].includes(
            recovered.status,
          ),
        );
        if (recovered.status === 'SUCCESS') {
          assert.equal(recovered.after_commit, target);
          assert.equal(after.lifecycle_state, 'READY');
        }
        if (recovered.status === 'RECOVERY_REQUIRED') {
          assert.equal(after.lifecycle_state, 'RECOVERY_REQUIRED');
          assert.equal(recovered.after_commit, null);
        }
        if (recovered.status === 'INTERRUPTED')
          assert.equal(
            f.git(['rev-parse', 'HEAD'], f.workspaceRoot),
            beforeHead,
          );
      }
      const expectedOutboxes = recovered.status === 'SUCCESS' ? 2 : 1;
      assert.equal(
        (await f.store.all('SELECT COUNT(*) n FROM WorkspaceUpdateOutbox'))[0]
          .n,
        expectedOutboxes,
      );
      assert.equal(
        (await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
        0,
      );
      await f.scenario.record('S3-INFLIGHT-' + mode, {
        controller_pid: observed.controller,
        killed_exit_code: killedExitCode,
        killed_signal: killedSignal,
        recovery_controller_pid: recoveryProof.pid,
        recovery_exit_code: recoveryExitCode,
        recovery_signal: recoverySignal,
        recovery_evidence: path.basename(recoveryEvidence),
        live_git_pids: observed.liveGitPids,
        actual_inflight: observed.actualInFlight,
        first_file_changed: !!observed.firstFileChanged,
        index_locked: !!observed.indexLocked,
        before_commit: beforeHead,
        target_commit: target,
        sync_run_id: runId,
        recovered_status: recovered.status,
        workspace_state: after.lifecycle_state,
        outbox_count: expectedOutboxes,
        task_run_count: 0,
      });
    },
  );
