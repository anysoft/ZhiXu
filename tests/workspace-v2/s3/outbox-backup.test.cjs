const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createOutboxFixture } = require('./outbox-fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../../back/services/workspaceV2/backup');
const {
  WorkspaceRestoreService,
} = require('../../../back/services/workspaceV2/restore');
const {
  WorkspaceGitUpdateOutbox,
} = require('../../../back/services/gitWorkspaceV2/outbox');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('S3 encrypted full-root restore after A destruction preserves LOCAL/GIT assets, Sync history, suppression and pending/completed Outbox without duplicate replay', async (t) => {
  const f = await createOutboxFixture(t, {
    caseId: 's3-outbox-backup',
    files: { 'ignored.sh': 'printf "IGNORED_SOURCE_PRESERVED\\n"\n' },
  });
  await f.createTrigger({ fireOnInitial: true });
  const local = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({
    name: 'unique LOCAL beside Git Sync',
    requestKey: 'local-preserved',
  });
  const localFiles = new WorkspaceFileService(f.store, f.roots, f.leases);
  await localFiles.create(
    local.id,
    'main.sh',
    'cat helper.txt; printf "\\nS3_LOCAL_PRESERVED\\n"\n',
  );
  await localFiles.create(local.id, 'helper.txt', f.helper + ':LOCAL');
  const localTask = await f.tasks.create({
    name: 'original LOCAL source',
    enabled: true,
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: local.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  const localRun = await f.execution.wait(
    (
      await f.execution.submit(localTask.task.id, {
        submissionKey: 'local-before-backup',
      })
    ).id,
  );
  assert.equal(localRun.status, 'SUCCESS');
  const sync = await f.buildSync();
  const policy = await sync.discovery.policy(f.row.id);
  await sync.discovery.savePolicy(f.row.id, {
    expected_version: policy.version,
    enabled: true,
    includes: ['ignored.sh'],
    excludes: [],
    languages: ['SHELL'],
  });
  const first = await sync.wait(
    (
      await sync.submit(f.row.id, { requestKey: 'initial' })
    ).id,
  );
  assert.equal(first.status, 'SUCCESS', JSON.stringify(first));
  await f.outbox.dispatchOne(first.id);
  const firstEvent = (
    await f.store.all(
      'SELECT * FROM TriggerEvents WHERE workspace_update_id=?',
      [first.id],
    )
  )[0];
  const firstTaskRun = await f.execution.wait(firstEvent.task_run_id);
  assert.equal(firstTaskRun.status, 'SUCCESS', JSON.stringify(firstTaskRun));
  const discovered = (
    await f.store.all(
      "SELECT * FROM Tasks WHERE origin='DISCOVERED' AND discovered_workspace_id=?",
      [f.row.id],
    )
  )[0];
  assert.ok(discovered);
  const suppression = await sync.discovery.suppress(f.row.id, {
    discovery_key: discovered.discovery_key,
    expected_policy_version: (await sync.discovery.policy(f.row.id)).version,
  });
  await f.commit({ 'main.sh': f.program('RESTORED_B') });
  const pending = await sync.wait(
    (
      await sync.submit(f.row.id, { requestKey: 'pending-update' })
    ).id,
  );
  assert.equal(pending.status, 'SUCCESS', JSON.stringify(pending));
  assert.equal((await f.outbox.get(pending.id)).status, 'PENDING');
  const originalHistory = await f.store.all(
    'SELECT * FROM TaskRuns ORDER BY id',
  );
  assert.equal(originalHistory.length, 2);
  const logHashes = new Map();
  for (const run of originalHistory)
    logHashes.set(run.id, hash(await f.execution.logs(run.id)));
  const syncFacts = await f.store.all(
    'SELECT id,workspace_id,source_generation,status,initial,before_commit,target_commit,actual_commit,after_commit,content_revision,update_outbox_id FROM WorkspaceSyncRuns ORDER BY id',
  );
  const originalOutboxes = await f.store.all(
    'SELECT id,trigger_plan,after_commit,status FROM WorkspaceUpdateOutbox ORDER BY id',
  );
  const originalSuppressions = await f.store.all(
    'SELECT * FROM WorkspaceDiscoverySuppressions',
  );
  assert.equal(originalSuppressions.length, 1);
  await sync.close();
  await f.execution.close();
  const backupA = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const snapshotId = await f.scenario.measure('s3-backup', () =>
    backupA.create(),
  );
  const snapshot = await backupA.snapshot(snapshotId);
  assert.equal(JSON.stringify(snapshot.manifest).includes(f.secret), false);
  const passphrase = f.scenario.registerSecret(
    'S3_PRIVATE_EXPORT_' + randomUUID(),
  );
  const exportFile = await backupA.exportPortable(
    snapshotId,
    Buffer.from(passphrase),
  );
  const archive = path.join(
    f.scenario.transferRoot,
    's3-authenticated.encrypted',
  );
  await fs.copyFile(exportFile, archive, fs.constants.COPYFILE_EXCL);
  await fs.chmod(archive, 0o600);
  assert.equal(
    (await fs.readFile(archive)).includes(Buffer.from(f.secret)),
    false,
  );
  const archiveHash = await f.scenario.hashFile(archive);
  const B = await f.scenario.createInstance('B');
  await f.scenario.safeDestroy(f.instance, { archivePath: archive });
  for (const removed of [
    f.instance.root,
    f.dataRoot,
    f.controlRoot,
    f.runtimeRoot,
    f.repository.source,
  ])
    await assert.rejects(fs.lstat(removed), { code: 'ENOENT' });
  const backupB = new WorkspaceBackupService(
    B.store,
    B.roots,
    B.leases,
    B.backupRoot,
  );
  const imported = await backupB.importPortable(
    archive,
    Buffer.from(passphrase),
  );
  assert.equal(imported.snapshot_id, snapshotId);
  await B.useStore(
    await f.scenario.measure('s3-restore', () =>
      new WorkspaceRestoreService(backupB).restore(imported.id, 'imports'),
    ),
  );
  const engine = B.track(new TaskExecutionService(B.store, B.roots, B.leases));
  const outbox = new WorkspaceGitUpdateOutbox(
    B.store,
    B.roots,
    B.leases,
    engine,
  );
  assert.deepEqual(
    await B.store.all(
      'SELECT id,workspace_id,source_generation,status,initial,before_commit,target_commit,actual_commit,after_commit,content_revision,update_outbox_id FROM WorkspaceSyncRuns ORDER BY id',
    ),
    syncFacts,
  );
  assert.deepEqual(
    await B.store.all('SELECT * FROM WorkspaceDiscoverySuppressions'),
    originalSuppressions,
  );
  assert.equal(
    (
      await B.store.all('SELECT discovery_state FROM Tasks WHERE id=?', [
        discovered.id,
      ])
    )[0].discovery_state,
    'RETIRED',
  );
  assert.equal(
    suppression.discovery_key,
    originalSuppressions[0].discovery_key,
  );
  assert.deepEqual(
    await B.store.all(
      'SELECT id,trigger_plan,after_commit,status FROM WorkspaceUpdateOutbox ORDER BY id',
    ),
    originalOutboxes,
  );
  const tasks = new TaskService(B.store, B.roots, B.leases);
  assert.equal((await tasks.get(f.task.task.id)).source.workspace_id, f.row.id);
  assert.equal(
    (await tasks.get(localTask.task.id)).source.workspace_id,
    local.id,
  );
  assert.equal(
    await fs.readFile(
      path.join(
        (
          await B.roots.requireOwned(await B.store.workspace(local.id))
        ).root,
        'helper.txt',
      ),
      'utf8',
    ),
    f.helper + ':LOCAL',
  );
  for (const historical of originalHistory) {
    const restored = await engine.get(historical.id);
    assert.equal(restored.status, historical.status);
    assert.equal(restored.admission_snapshot, historical.admission_snapshot);
    assert.equal(restored.source_snapshot, historical.source_snapshot);
    assert.equal(
      hash(await engine.logs(restored.id)),
      logHashes.get(restored.id),
    );
  }
  assert.deepEqual(await f.effectsLines(), [String(firstTaskRun.id)]);
  await outbox.recover();
  const restoredEvent = (
    await B.store.all(
      'SELECT * FROM TriggerEvents WHERE workspace_update_id=?',
      [pending.id],
    )
  )[0];
  const newRun = await engine.wait(restoredEvent.task_run_id);
  assert.equal(newRun.status, 'SUCCESS', JSON.stringify(newRun));
  assert.equal(newRun.task_id, f.task.task.id);
  assert.equal(newRun.expected_git_commit, pending.after_commit);
  assert.equal(newRun.attempt_count, 1);
  assert.match(await engine.logs(newRun.id), /S3_TASK_RESTORED_B/);
  assert.equal((await engine.logs(newRun.id)).includes(f.secret), false);
  await outbox.recover();
  assert.equal(
    (
      await engine.submit(f.task.task.id, {
        triggerType: 'GIT_UPDATE',
        eventId: restoredEvent.id,
      })
    ).id,
    newRun.id,
  );
  assert.deepEqual(await f.effectsLines(), [
    String(firstTaskRun.id),
    String(newRun.id),
  ]);
  const newLocal = await engine.wait(
    (
      await engine.submit(localTask.task.id, {
        submissionKey: 'local-after-restore',
      })
    ).id,
  );
  assert.equal(newLocal.status, 'SUCCESS');
  assert.match(await engine.logs(newLocal.id), /S3_LOCAL_PRESERVED/);
  assert.equal((await B.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 4);
  assert.equal(
    (await B.store.all('SELECT COUNT(*) n FROM TaskRunAttempts'))[0].n,
    4,
  );
  assert.deepEqual(await B.store.all('PRAGMA foreign_key_check'), []);
  const freshBackup = new WorkspaceBackupService(
    B.store,
    B.roots,
    B.leases,
    B.backupRoot,
  );
  assert.ok(
    await f.scenario.measure('s3-backup-after-replay', () =>
      freshBackup.create(),
    ),
  );
  assert.equal(await f.scenario.hashFile(archive), archiveHash);
  await assert.rejects(fs.lstat(f.instance.root), { code: 'ENOENT' });
  await f.scenario.record('outbox-full-root-restore', {
    status: 'PASS',
    input:
      'actual completed and pending successful Git updates beside LOCAL source, discovery suppression and real execution history',
    expected:
      'destroy A, authenticated import/restore B, replay only pending event once',
    actual: {
      A_absent: true,
      archive_sha256: archiveHash,
      snapshot_id: snapshotId,
      sync_run_ids: syncFacts.map((row) => row.id),
      historical_run_ids: originalHistory.map((row) => row.id),
      completed_outbox: first.id,
      pending_outbox: pending.id,
      pending_replay_run_id: newRun.id,
      restored_local_task_id: localTask.task.id,
      restored_local_new_run_id: newLocal.id,
      suppression_count: 1,
      final_task_runs: 4,
      final_attempts: 4,
      git_effect_count_total_A_and_B: 2,
    },
    assertions: [
      'independent encrypted transfer is sole restore input',
      'A source/remote/data/runtime/control all absent',
      'LOCAL unique helper and original Task ID execute again',
      'GIT updated source runs original Task in B',
      'Sync/Outbox source facts and complete plan unchanged',
      'Suppression remains RETIRED',
      'completed event and historical Runs never replay',
      'pending event dispatch idempotent',
      'history logs byte-identical',
      'no Secret in manifest/ciphertext/logs',
      'B Backup succeeds after replay',
    ],
  });
});
