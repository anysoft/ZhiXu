const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createOutboxFixture } = require('./outbox-fixture.cjs');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');

async function worker(t, f, id, checkpoint, file, holdFile) {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 'outbox-crash-worker.cjs'),
      f.instance.root,
      String(id),
      checkpoint,
      file,
      ...(holdFile ? [holdFile] : []),
    ],
    { cwd: f.projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  t.after(() => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  assert.equal(output.includes(f.secret), false);
  await fs.writeFile(
    path.join(f.scenario.evidenceRoot, checkpoint.toLowerCase() + '.log'),
    output,
    { mode: 0o600, flag: 'wx' },
  );
  return { ...result, output };
}

for (const checkpoint of [
  'BEFORE_OUTBOX_DISPATCH',
  'AFTER_TASK_RUN_INSERT',
  'BEFORE_OUTBOX_ACK',
]) {
  test(
    'S3 actual dispatcher SIGKILL ' +
      checkpoint +
      ' recovers in a fresh process with one durable TaskRun and one real child effect',
    async (t) => {
      const f = await createOutboxFixture(t, {
        caseId: 's3-kill-' + checkpoint.toLowerCase(),
      });
      await f.createTrigger({ fireOnInitial: true });
      const sync = await f.buildSync();
      const update = await sync.wait(
        (
          await sync.submit(f.row.id, { requestKey: 'initial' })
        ).id,
      );
      assert.equal(update.status, 'SUCCESS', JSON.stringify(update));
      await sync.close();
      await f.execution.close();
      await f.store.close();
      const killedFile = path.join(f.scenario.evidenceRoot, 'killed.json');
      const holdFile =
        checkpoint === 'BEFORE_OUTBOX_DISPATCH'
          ? path.join(f.scenario.evidenceRoot, 'release-controller')
          : undefined;
      const killing = worker(t, f, update.id, checkpoint, killedFile, holdFile);
      if (holdFile) {
        const deadline = Date.now() + 15000;
        let liveOwner;
        while (true) {
          try {
            liveOwner = JSON.parse(await fs.readFile(killedFile, 'utf8'));
          } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError))
              throw error;
          }
          if (liveOwner?.checkpoint === checkpoint) break;
          if (Date.now() > deadline)
            throw Error('S3_LIVE_OUTBOX_PROOF_DEADLINE');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const probeFile = path.join(
          f.scenario.evidenceRoot,
          'live-owner-probe.json',
        );
        const probe = await worker(t, f, update.id, 'PROBE', probeFile);
        assert.equal(probe.code, 0, probe.output);
        const observed = JSON.parse(await fs.readFile(probeFile, 'utf8'));
        assert.equal(observed.expired_under_probe_clock, true);
        assert.equal(observed.outbox_status, 'PROCESSING');
        assert.equal(observed.owner_epoch_hash, liveOwner.owner_epoch_hash);
        assert.equal(observed.attempt_count, 1);
        assert.equal(observed.run_count, 0);
        await fs.writeFile(holdFile, 'release', { mode: 0o600, flag: 'wx' });
      }
      const killed = await killing;
      assert.equal(killed.signal, 'SIGKILL', killed.output);
      const before = JSON.parse(await fs.readFile(killedFile, 'utf8'));
      assert.equal(before.checkpoint, checkpoint);
      assert.equal(before.outbox_status, 'PROCESSING');
      assert.equal(before.owner_token_present, true);
      assert.equal(
        before.runs.length,
        checkpoint === 'BEFORE_OUTBOX_DISPATCH' ? 0 : 1,
      );
      if (before.runs.length) {
        assert.equal(before.runs[0].status, 'QUEUED');
        assert.equal(before.runs[0].attempt_count, 0);
      }
      assert.deepEqual(await f.effectsLines(), []);
      const recoveredFile = path.join(
        f.scenario.evidenceRoot,
        'recovered.json',
      );
      const recovered = await worker(t, f, update.id, 'RECOVER', recoveredFile);
      assert.equal(recovered.code, 0, recovered.output);
      const after = JSON.parse(await fs.readFile(recoveredFile, 'utf8'));
      assert.notEqual(after.pid, before.pid);
      assert.equal(after.outbox_status, 'DISPATCHED');
      assert.equal(after.runs.length, 1);
      assert.equal(after.runs[0].status, 'SUCCESS');
      assert.equal(after.runs[0].attempt_count, 1);
      assert.equal(after.runs[0].expected_git_commit, update.after_commit);
      assert.equal(after.foreign_key_errors, 0);
      if (before.runs.length) assert.equal(after.runs[0].id, before.runs[0].id);
      assert.deepEqual(await f.effectsLines(), [String(after.runs[0].id)]);
      const store = await WorkspaceStore.open(f.databasePath, f.dataRoot);
      await f.instance.useStore(store);
      const engine = f.track(
        new TaskExecutionService(store, f.roots, f.leases),
      );
      const event = (
        await store.all(
          'SELECT * FROM TriggerEvents WHERE workspace_update_id=?',
          [update.id],
        )
      )[0];
      const replay = await engine.submit(f.task.task.id, {
        triggerType: 'GIT_UPDATE',
        eventId: event.id,
      });
      assert.equal(replay.id, after.runs[0].id);
      assert.equal(
        (await store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
        1,
      );
      assert.equal(
        (await store.all('SELECT COUNT(*) n FROM TaskRunAttempts'))[0].n,
        1,
      );
      assert.equal((await engine.logs(replay.id)).includes(f.secret), false);
      const outbox = (
        await store.all('SELECT * FROM WorkspaceUpdateOutbox WHERE id=?', [
          update.id,
        ])
      )[0];
      assert.equal(outbox.owner_token, null);
      assert.equal(
        (
          await store.all(
            'SELECT event_status FROM WorkspaceSyncRuns WHERE id=?',
            [update.id],
          )
        )[0].event_status,
        'DISPATCHED',
      );
      await f.scenario.record('outbox-kill-' + checkpoint.toLowerCase(), {
        status: 'PASS',
        input: checkpoint,
        expected: 'fresh recovery reuses stable event submission identity',
        actual: {
          initial_worker_pid: before.pid,
          recovery_worker_pid: after.pid,
          killed_signal: killed.signal,
          committed_run_before_ack: before.runs.length === 1,
          final_run_id: replay.id,
          task_run_count: 1,
          attempt_count: 1,
          actual_effect_count: 1,
          source_commit: update.after_commit,
        },
        assertions: [
          'actual OS SIGKILL at requested callback',
          'independent process proves dead owner FD before reclaim',
          'insert-before-ack replay never creates second Run',
          'source tuple pinned',
          'one actual Shell child effect',
          'no secret output',
          'no false Sync/Task success',
        ],
      });
    },
  );
}
