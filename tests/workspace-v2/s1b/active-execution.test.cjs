const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { createS1BFixture } = require('./fixture.cjs');
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
  WorkspaceEnvironmentService,
} = require('../../../back/services/taskExecutionV2/environment');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');

function activeExecutionServices(instance) {
  return {
    lifecycle: new WorkspaceLifecycleService(
      instance.store,
      instance.roots,
      instance.leases,
    ),
    files: new WorkspaceFileService(
      instance.store,
      instance.roots,
      instance.leases,
    ),
    env: new WorkspaceEnvironmentService(
      instance.store,
      instance.roots,
      instance.leases,
    ),
    tasks: new TaskService(instance.store, instance.roots, instance.leases),
    engine: instance.track(
      new TaskExecutionService(instance.store, instance.roots, instance.leases),
    ),
    backup: new WorkspaceBackupService(
      instance.store,
      instance.roots,
      instance.leases,
      instance.backupRoot,
    ),
  };
}

async function createActiveExecutionFixture(t, caseId) {
  const started = Date.now();
  const h = await createS1BFixture(t, { caseId });
  const a = await h.createInstance('A');
  const s = activeExecutionServices(a);
  const row = await s.lifecycle.createLocal({
    name: caseId,
    requestKey: caseId,
  });
  await fs.mkdir(path.join(a.root, 'gates'), { mode: 0o700 });
  const gate = path.join(a.root, 'gates');
  const script =
    'printf "%s" "$$" > "$1/child.pid"\nprintf "REAL_S1B_ACTIVE_STARTED\\n"\ncat config.txt\nwhile [ ! -f "$1/release" ]; do sleep .02; done\n';
  await s.files.create(row.id, 'main.sh', script);
  await s.files.create(
    row.id,
    'config.txt',
    'ORIGINAL_S1B_USER_CONFIGURATION\n',
  );
  const secret = h.registerSecret(
    'S1B_PRIVATE_SENTINEL_' + randomBytes(32).toString('hex'),
  );
  const asset = (
    await a.store.run(
      "INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES('active-secret',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    )
  ).lastID;
  const directory = await a.roots.directory(
    `config-assets/asset-${asset}/revisions/1`,
    true,
  );
  await fs.writeFile(path.join(directory, 'content'), secret, { mode: 0o400 });
  const revision = (
    await a.store.run(
      'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,1,?,?,?,CURRENT_TIMESTAMP)',
      [
        asset,
        createHash('sha256').update(secret).digest('hex'),
        Buffer.byteLength(secret),
        `asset-${asset}/revisions/1/content`,
      ],
    )
  ).lastID;
  await a.store.run(
    'UPDATE ConfigAssets SET current_revision_id=? WHERE id=?',
    [revision, asset],
  );
  await s.env.saveWorkspaceConfig(
    row.id,
    (
      await a.store.workspace(row.id)
    ).version,
    {
      asset_id: asset,
      revision_id: revision,
      operation: 'ATTACH',
      target_base: 'WORKSPACE_ROOT',
      target_path: 'config.txt',
      materialization_mode: 'COPY',
      conflict_policy: 'BACKUP_AND_RESTORE',
      writable: false,
      enabled: true,
    },
  );
  const task = await s.tasks.create({
    name: caseId,
    arguments: [gate],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: row.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution: { timeout_seconds: 40, concurrency: 'ALLOW' },
  });
  const run = await s.engine.submit(task.task.id, {
    submissionKey: caseId + '-identity',
  });
  return { h, a, s, row, task, run, gate, secret, script, started };
}

async function waitActiveCondition(condition, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(label);
}

function startActiveWorker(t, fixture, mode) {
  const readyFile = path.join(fixture.a.root, 'controller-ready.json');
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 'active-worker.cjs'),
      mode,
      fixture.a.root,
      String(fixture.run.id),
      readyFile,
    ],
    {
      cwd: fixture.a.projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += bytes;
  });
  child.stderr.on('data', (bytes) => {
    output += bytes;
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await exited;
  });
  return { child, exited, readyFile, output: () => output };
}

test('S1B live secret materialization blocks short backup and drains safely before authenticated transfer', async (t) => {
  const f = await createActiveExecutionFixture(t, 'S1B-ACTIVE-DRAIN');
  await f.s.engine.tick();
  await waitActiveCondition(
    async () =>
      (await f.s.engine.logs(f.run.id)).includes('REAL_S1B_ACTIVE_STARTED'),
    'real Runner must enter its gated body',
  );
  assert.equal((await f.a.leases.probeWorkspace(f.row.id)).busy, true);
  assert.equal(
    await fs.readFile(path.join(f.a.roots.path(f.row), 'config.txt'), 'utf8'),
    f.secret,
  );
  await assert.rejects(f.s.backup.create(100), { error_code: 'BACKUP_BUSY' });
  assert.equal((await f.s.engine.get(f.run.id)).status, 'RUNNING');
  const completed = f.s.engine.wait(f.run.id);
  const draining = f.s.backup.create(15000);
  // Keep failed assertions from leaving live test work behind; awaiting these
  // original promises below still reports any coordinator or backup failure.
  void completed.catch(() => {});
  void draining.catch(() => {});
  t.after(async () => {
    await fs.writeFile(path.join(f.gate, 'release'), '', { mode: 0o600 });
    await Promise.allSettled([completed, draining]);
  });
  await waitActiveCondition(
    async () => (await f.a.barrier.state())?.phase === 'QUIESCING',
    'backup must publish durable QUIESCING before draining',
  );
  await assert.rejects(
    f.s.engine.submit(f.task.task.id),
    (error) =>
      (error.error_code ?? error.code) === 'PLATFORM_BACKUP_IN_PROGRESS',
  );
  // QUIESCING closes admission even for a fresh probe. The already admitted
  // gated child and its persisted active resource remain responsible for cleanup.
  assert.equal((await f.s.engine.get(f.run.id)).status, 'RUNNING');
  assert.equal((await f.s.engine.get(f.run.id)).active_workspace_id, f.row.id);
  assert.equal(
    await fs.readFile(path.join(f.a.roots.path(f.row), 'config.txt'), 'utf8'),
    f.secret,
  );
  await fs.writeFile(path.join(f.gate, 'release'), '', { mode: 0o600 });
  const run = await completed;
  assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
  const backupId = await draining;
  const snapshot = await f.s.backup.snapshot(backupId);
  const saved = path.join(snapshot.root, 'data', f.row.root_key, 'config.txt');
  assert.equal(
    await fs.readFile(saved, 'utf8'),
    'ORIGINAL_S1B_USER_CONFIGURATION\n',
  );
  assert.equal(JSON.stringify(snapshot.manifest).includes(f.secret), false);
  assert.equal((await f.s.engine.logs(run.id)).includes(f.secret), false);
  assert.equal((await f.s.engine.attempts(run.id))[0].status, 'SUCCESS');
  await f.h.record('S1B-ACTIVE-DRAIN', {
    status: 'PASS',
    input:
      'real long Shell child with secret Config covering original user bytes',
    expected:
      'short backup BUSY; durable QUIESCING drains actual owner before READY snapshot',
    actual:
      'BUSY while running, new submission rejected during drain, successful snapshot contains restored original file',
    exit_code: 0,
    duration_ms: Date.now() - f.started,
    assertions: [
      'actual child and Workspace FD observed',
      'secret injection active before backup',
      'short backup refuses active Run',
      'QUIESCING closes producer admission',
      'Runner SUCCESS and cleanup precede READY snapshot',
      'no secret in manifest or log',
    ],
    runId: run.id,
    backupId,
    shortBackup: 'BACKUP_BUSY',
    drainObserved: 'QUIESCING',
    originalConfigurationRestored: true,
    manifestHash: createHash('sha256')
      .update(JSON.stringify(snapshot.manifest))
      .digest('hex'),
    logHash: createHash('sha256')
      .update(await f.s.engine.logs(run.id))
      .digest('hex'),
    noSecretInManifestOrLog: true,
  });
});

test('S1B actual controller SIGKILL preserves recovery responsibility and restored INTERRUPTED history never replays', async (t) => {
  const f = await createActiveExecutionFixture(t, 'S1B-ACTIVE-CRASH-RESTORE');
  await f.s.engine.close();
  const running = startActiveWorker(t, f, 'RUN');
  await waitActiveCondition(
    async () =>
      !!(await fs
        .lstat(running.readyFile)
        .catch((error) =>
          error.code === 'ENOENT' ? null : Promise.reject(error),
        )),
    'independent controller must observe actual child output',
  );
  const controller = JSON.parse(await fs.readFile(running.readyFile, 'utf8'));
  assert.equal(controller.phase, 'DURING_RUNNER');
  const before = await f.s.engine.get(f.run.id);
  assert.equal(before.status, 'RUNNING');
  assert.equal(before.active_workspace_id, f.row.id);
  assert.ok(before.owner_token);
  assert.equal((await f.a.leases.probeWorkspace(f.row.id)).busy, true);
  await assert.rejects(f.s.backup.create(100), { error_code: 'BACKUP_BUSY' });
  running.child.kill('SIGKILL');
  const killed = await running.exited;
  assert.equal(killed.signal, 'SIGKILL', killed.output);
  const interruptedOwner = await f.s.engine.get(f.run.id);
  assert.equal(interruptedOwner.status, 'RUNNING');
  assert.equal(interruptedOwner.owner_token, before.owner_token);
  assert.equal(interruptedOwner.active_workspace_id, f.row.id);
  await assert.rejects(f.s.backup.create(100), { error_code: 'BACKUP_BUSY' });
  const recovering = startActiveWorker(t, f, 'RECOVER');
  const recovered = await recovering.exited;
  assert.equal(recovered.code, 0, recovered.output);
  const proof = JSON.parse(recovered.output.trim());
  assert.notEqual(proof.pid, controller.pid);
  assert.equal(proof.status, 'INTERRUPTED');
  const run = await f.s.engine.get(f.run.id);
  assert.equal(run.status, 'INTERRUPTED');
  assert.equal(run.active_workspace_id, null);
  assert.equal(run.owner_token, null);
  assert.equal(run.admission_snapshot, f.run.admission_snapshot);
  assert.equal((await f.s.engine.attempts(run.id))[0].status, 'INTERRUPTED');
  const pid = Number(await fs.readFile(path.join(f.gate, 'child.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const liveGroup = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([pgid, state]) => Number(pgid) === pid && !state.startsWith('Z'));
  assert.deepEqual(liveGroup, []);
  assert.equal(
    await fs.readFile(path.join(f.a.roots.path(f.row), 'config.txt'), 'utf8'),
    'ORIGINAL_S1B_USER_CONFIGURATION\n',
  );
  assert.equal((await f.a.leases.probeWorkspace(f.row.id)).busy, false);
  const log = await f.s.engine.logs(run.id);
  assert.equal(log.includes(f.secret), false);
  const backupId = await f.s.backup.create();
  const passphrase = f.h.registerSecret(randomBytes(32).toString('hex'));
  const encrypted = await f.s.backup.exportPortable(
    backupId,
    Buffer.from(passphrase),
  );
  const archivePath = path.join(
    f.h.transferRoot,
    'interrupted-history.encrypted',
  );
  await fs.copyFile(encrypted, archivePath);
  await fs.chmod(archivePath, 0o600);
  assert.equal(
    (await fs.readFile(archivePath)).includes(Buffer.from(f.secret)),
    false,
  );
  await f.h.safeDestroy(f.a, { archivePath });
  const b = await f.h.createInstance('B');
  const importer = new WorkspaceBackupService(
    b.store,
    b.roots,
    b.leases,
    b.backupRoot,
  );
  const imported = await importer.importPortable(
    archivePath,
    Buffer.from(passphrase),
  );
  await b.useStore(
    await new WorkspaceRestoreService(importer).restore(imported.id, 'imports'),
  );
  const services = activeExecutionServices(b);
  assert.equal((await services.engine.get(run.id)).status, 'INTERRUPTED');
  assert.equal(
    (await services.tasks.get(f.task.task.id)).source.workspace_id,
    f.row.id,
  );
  assert.equal(await services.engine.logs(run.id), log);
  const attempts = await services.engine.attempts(run.id);
  await services.engine.tick();
  await services.engine.tick();
  assert.deepEqual(await services.engine.attempts(run.id), attempts);
  assert.equal((await b.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 1);
  assert.equal(
    (
      await services.engine.submit(f.task.task.id, {
        submissionKey: f.run.submission_key,
      })
    ).id,
    run.id,
  );
  assert.equal((await services.engine.get(run.id)).status, 'INTERRUPTED');
  await assert.rejects(fs.lstat(f.a.dataRoot), { code: 'ENOENT' });
  assert.deepEqual(await b.store.all('PRAGMA foreign_key_check'), []);
  await f.h.record('S1B-ACTIVE-CRASH-RESTORE', {
    status: 'PASS',
    input:
      'real independent controller and active materialized Shell child; SIGKILL during actual output',
    expected:
      'durable owner survives controller death until fresh recovery restores original file and records INTERRUPTED; restore never replays it',
    actual:
      'fresh recovery process converged original Run and Attempt to INTERRUPTED; independent B preserved same history after A destruction',
    exit_code: 0,
    duration_ms: Date.now() - f.started,
    assertions: [
      'official backup refuses active Run before and after controller kill',
      'recovery process PID differs from controller',
      'no live child or process-group writer remains',
      'source Config restored before backup',
      'authenticated archive outside A',
      'A safely destroyed',
      'B history/log/Attempt preserved',
      'two dispatcher ticks and submission replay create no new Run or Attempt',
    ],
    runId: run.id,
    attemptIds: attempts.map((attempt) => attempt.id),
    checkpoint: controller.phase,
    signal: killed.signal,
    controllerPid: controller.pid,
    recoveryPid: proof.pid,
    backupId,
    restoredStatus: 'INTERRUPTED',
    noReplay: true,
    originalInstanceDestroyed: true,
    noLiveChild: true,
    sourceSnapshotHash: createHash('sha256')
      .update(run.source_snapshot)
      .digest('hex'),
    historicalLogHash: createHash('sha256').update(log).digest('hex'),
    archiveHash: await f.h.hashFile(archivePath),
  });
});

test('S1B unresolved materialization evidence blocks both official backup and candidate execution without consuming an Attempt', async (t) => {
  const f = await createActiveExecutionFixture(t, 'S1B-UNCLEAN-JOURNAL');
  const journal = path.join(
    await f.a.roots.directory('tmp/config-materialization', true),
    'unknown-journal.json',
  );
  const evidence = 'unresolved materialization must remain owned and untouched';
  await fs.writeFile(journal, evidence, { mode: 0o600 });
  await assert.rejects(f.s.backup.create(100), {
    error_code: 'BACKUP_RECOVERY_REQUIRED',
  });
  const run = await f.s.engine.wait(f.run.id);
  assert.equal(run.status, 'RECOVERY_REQUIRED');
  assert.equal(run.attempt_count, 0);
  assert.equal((await f.s.engine.attempts(run.id)).length, 0);
  assert.equal(await f.s.engine.logs(run.id), '');
  assert.equal(await fs.readFile(journal, 'utf8'), evidence);
  assert.equal(
    await fs.readFile(path.join(f.a.roots.path(f.row), 'config.txt'), 'utf8'),
    'ORIGINAL_S1B_USER_CONFIGURATION\n',
  );
  await f.h.record('S1B-UNCLEAN-JOURNAL', {
    status: 'PASS',
    input:
      'existing Task and actual queued Run plus unresolved private materialization evidence',
    expected:
      'backup blocked and execution RECOVERY_REQUIRED before any Attempt; evidence and original user file preserved',
    actual:
      'BACKUP_RECOVERY_REQUIRED and RECOVERY_REQUIRED with zero Attempt/output and unchanged evidence/source',
    exit_code: 0,
    duration_ms: Date.now() - f.started,
    assertions: [
      'official backup refuses unresolved journal',
      'candidate source resolver refuses execution',
      'unknown journal remains untouched',
      'no Attempt or child output',
      'original user configuration unchanged',
    ],
    runId: run.id,
    backup: 'BACKUP_RECOVERY_REQUIRED',
    execution: run.status,
    attempts: 0,
    journalPreserved: true,
    originalConfigurationPreserved: true,
  });
});

test('S1B source changed before resolution stays one SKIPPED Run with no injection, Attempt or implicit replay', async (t) => {
  const f = await createActiveExecutionFixture(t, 'S1B-SOURCE-SUPERSEDED');
  const old = await f.s.files.read(f.row.id, 'main.sh');
  await f.s.files.save(
    f.row.id,
    'main.sh',
    'printf "NEW_SOURCE_MUST_NOT_EXECUTE\\n"\n',
    old.hash,
  );
  const run = await f.s.engine.wait(f.run.id);
  assert.equal(run.status, 'SKIPPED');
  assert.equal(run.error_code, 'SOURCE_SUPERSEDED');
  assert.equal(run.attempt_count, 0);
  assert.equal((await f.s.engine.attempts(run.id)).length, 0);
  assert.equal(await f.s.engine.logs(run.id), '');
  assert.equal(
    (await f.a.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
    1,
  );
  assert.equal(
    await fs.readFile(path.join(f.a.roots.path(f.row), 'config.txt'), 'utf8'),
    'ORIGINAL_S1B_USER_CONFIGURATION\n',
  );
  await f.h.record('S1B-SOURCE-SUPERSEDED', {
    status: 'PASS',
    input:
      'actual TaskRun queued before Workspace file service changes source version',
    expected:
      'one SKIPPED/SOURCE_SUPERSEDED Run with no Config injection, Attempt, child output or replacement Run',
    actual:
      'same admitted Run skipped before side effects; original Config and Run count preserved',
    exit_code: 0,
    duration_ms: Date.now() - f.started,
    assertions: [
      'source changed through official file service',
      'Run is SKIPPED/SOURCE_SUPERSEDED',
      'zero Attempt and output',
      'one durable Run only',
      'original configuration unchanged',
    ],
    runId: run.id,
    execution: 'SKIPPED',
    errorCode: run.error_code,
    attempts: 0,
    noImplicitReplay: true,
    noInjection: true,
  });
});
