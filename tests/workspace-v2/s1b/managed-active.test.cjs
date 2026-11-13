const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { createS1BFixture } = require('./fixture.cjs');
const { provisionManagedRuntime } = require('../s2-runtime-fixture.cjs');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');
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
  WorkspaceEnvironmentService,
} = require('../../../back/services/taskExecutionV2/environment');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');
const {
  ManagedRuntimeAdapter,
} = require('../../../back/services/taskExecutionV2/runtime');

async function waitManagedActiveCondition(condition, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(label);
}

test('S1B fresh managed Node child retains actual Build pin and Config/Node ownership while backup refuses then drains to a complete snapshot', async (t) => {
  const started = Date.now();
  const h = await createS1BFixture(t, { caseId: 'S1B-MANAGED-ACTIVE-BACKUP' });
  const a = await h.createInstance('A');
  // This invokes the existing distribution provider, npm toolchain installer and
  // environment builder in this instance. It never opens an S2 prepared receipt.
  const managed = await h.measure('managed-active-provision-node', () =>
    provisionManagedRuntime(a, { python: false, node: true }),
  );
  assert.equal(managed.pythonEnvironment, null);
  assert.deepEqual(
    managed.operationHistory.map((operation) => operation.status),
    ['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS'],
  );
  const adapter = new ManagedRuntimeAdapter(a.store);
  const runtime = await adapter.inspect(
    'NODE',
    managed.nodeEnvironment.id,
    'JAVASCRIPT',
  );
  assert.ok(runtime.executable.startsWith(a.runtimeRoot + path.sep));
  assert.ok(runtime.nodeModulesRoot.startsWith(a.runtimeRoot + path.sep));
  const executableHash = await h.hashFile(runtime.executable);
  const runtimeRow = (
    await a.store.all('SELECT * FROM RuntimeInstallations WHERE id=?', [
      runtime.runtimeId,
    ])
  )[0];
  const runtimeMetadata = JSON.parse(runtimeRow.metadata);
  assert.equal(runtimeMetadata.executable_sha256, executableHash);
  assert.match(runtimeMetadata.artifact_sha256, /^[a-f0-9]{64}$/);
  assert.match(
    runtimeMetadata.checksum_source,
    /^https:\/\/nodejs\.org\/dist\/v/,
  );
  const unlocked = await adapter.node.lease('build', runtime.buildId);
  await unlocked.release();
  const lifecycle = new WorkspaceLifecycleService(a.store, a.roots, a.leases);
  const files = new WorkspaceFileService(a.store, a.roots, a.leases);
  const resources = new WorkspaceEnvironmentService(a.store, a.roots, a.leases);
  const tasks = new TaskService(a.store, a.roots, a.leases);
  const engine = a.track(new TaskExecutionService(a.store, a.roots, a.leases));
  const backup = new WorkspaceBackupService(
    a.store,
    a.roots,
    a.leases,
    a.backupRoot,
  );
  const workspace = await lifecycle.createLocal({
    name: 'managed active backup gate',
    requestKey: 'managed-active-backup-gate',
  });
  const gate = path.join(a.root, 'gates');
  await fs.mkdir(gate, { mode: 0o700 });
  const original = 'ORIGINAL_MANAGED_ACTIVE_USER_CONFIGURATION\n';
  const program =
    "const fs=require('node:fs'),path=require('node:path'),isNumber=require('is-number');\n" +
    "const gate=process.argv[2];if(!isNumber(42))process.exit(71);fs.writeFileSync(path.join(gate,'child.pid'),String(process.pid));console.log('REAL_S1B_MANAGED_NODE_ACTIVE',process.execPath);console.log(fs.readFileSync('settings.txt','utf8'));(async()=>{while(!fs.existsSync(path.join(gate,'release')))await new Promise(r=>setTimeout(r,20));console.log('REAL_S1B_MANAGED_NODE_FINISHED');})().catch(()=>process.exit(72));\n";
  await files.create(workspace.id, 'main.cjs', program);
  await files.create(workspace.id, 'settings.txt', original);
  const secret = h.registerSecret(
    'S1B_MANAGED_CONFIG_SENTINEL_' + randomBytes(32).toString('hex'),
  );
  const asset = (
    await a.store.run(
      "INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES('managed active secret',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    )
  ).lastID;
  const storage = `asset-${asset}/revisions/1/content`;
  const configDirectory = await a.roots.directory(
    `config-assets/asset-${asset}/revisions/1`,
    true,
  );
  await fs.writeFile(path.join(configDirectory, 'content'), secret, {
    mode: 0o400,
  });
  const revision = (
    await a.store.run(
      'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,1,?,?,?,CURRENT_TIMESTAMP)',
      [
        asset,
        createHash('sha256').update(secret).digest('hex'),
        Buffer.byteLength(secret),
        storage,
      ],
    )
  ).lastID;
  await a.store.run(
    'UPDATE ConfigAssets SET current_revision_id=? WHERE id=?',
    [revision, asset],
  );
  await resources.saveWorkspaceConfig(
    workspace.id,
    (
      await a.store.workspace(workspace.id)
    ).version,
    {
      asset_id: asset,
      revision_id: revision,
      operation: 'ATTACH',
      target_base: 'WORKSPACE_ROOT',
      target_path: 'settings.txt',
      materialization_mode: 'COPY',
      conflict_policy: 'BACKUP_AND_RESTORE',
      writable: false,
      enabled: true,
    },
  );
  const definition = await tasks.create({
    name: 'actual managed active Node',
    arguments: [gate],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: workspace.id,
      relative_entrypoint: 'main.cjs',
      language: 'JAVASCRIPT',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    runtime: {
      kind: 'NODE',
      node_environment_id: managed.nodeEnvironment.id,
      python_environment_id: null,
    },
    execution: { timeout_seconds: 40 },
  });
  const submitted = await engine.submit(definition.task.id, {
    submissionKey: 'managed-active-once',
  });
  await engine.tick();
  await waitManagedActiveCondition(
    async () =>
      (
        await engine.logs(submitted.id)
      ).includes('REAL_S1B_MANAGED_NODE_ACTIVE'),
    'fresh managed Node child must load its actual managed dependency and reach the gate',
  );
  const root = a.roots.path(workspace);
  assert.equal((await a.leases.probeWorkspace(workspace.id)).busy, true);
  const binding = await fs.lstat(path.join(root, 'node_modules'));
  assert.equal(binding.isSymbolicLink(), true);
  assert.equal(
    await fs.realpath(path.join(root, 'node_modules')),
    runtime.nodeModulesRoot,
  );
  assert.equal(
    await fs.readFile(path.join(root, 'settings.txt'), 'utf8'),
    secret,
  );
  // An exclusive lease succeeds before the Run and fails while its real managed
  // child inherits the immutable Build pin. No lock is simulated here.
  await assert.rejects(
    adapter.node.lease('build', runtime.buildId),
    (error) => error.error_code === 'RUNTIME_BUSY',
  );
  const live = await engine.get(submitted.id);
  assert.equal(live.status, 'RUNNING');
  assert.equal(live.active_workspace_id, workspace.id);
  assert.equal(live.attempt_count, 1);
  const pinned = JSON.parse(live.snapshot_metadata).runtime;
  assert.equal(pinned.build_id, runtime.buildId);
  assert.equal(pinned.revision_id, runtime.revisionId);
  assert.equal(pinned.runtime_id, runtime.runtimeId);
  assert.equal(pinned.environment_id, runtime.environmentId);
  assert.deepEqual(await backup.list(), []);
  await assert.rejects(backup.create(100), { error_code: 'BACKUP_BUSY' });
  assert.deepEqual(await backup.list(), []);
  assert.equal(await a.barrier.state(), null);
  assert.equal((await engine.get(submitted.id)).status, 'RUNNING');
  const completed = engine.wait(submitted.id);
  const draining = h.measure('managed-active-backup-drain', () =>
    backup.create(20000),
  );
  void completed.catch(() => {});
  void draining.catch(() => {});
  t.after(async () => {
    await fs.writeFile(path.join(gate, 'release'), '', { mode: 0o600 });
    await Promise.allSettled([completed, draining]);
  });
  await waitManagedActiveCondition(
    async () => (await a.barrier.state())?.phase === 'QUIESCING',
    'actual backup must publish durable QUIESCING while the managed child is active',
  );
  await assert.rejects(
    engine.submit(definition.task.id),
    (error) =>
      (error.error_code ?? error.code) === 'PLATFORM_BACKUP_IN_PROGRESS',
  );
  // No fresh Workspace or Runtime admission is attempted during QUIESCING.
  assert.equal((await engine.get(submitted.id)).status, 'RUNNING');
  assert.equal(
    (await fs.lstat(path.join(root, 'node_modules'))).isSymbolicLink(),
    true,
  );
  assert.equal(
    await fs.readFile(path.join(root, 'settings.txt'), 'utf8'),
    secret,
  );
  await fs.writeFile(path.join(gate, 'release'), '', { mode: 0o600 });
  const run = await completed;
  assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
  assert.equal(run.attempt_count, 1);
  const backupId = await draining;
  await engine.close();
  const released = await adapter.node.lease('build', runtime.buildId);
  await released.release();
  assert.equal((await a.leases.probeWorkspace(workspace.id)).busy, false);
  assert.equal(
    await fs.readFile(path.join(root, 'settings.txt'), 'utf8'),
    original,
  );
  await assert.rejects(fs.lstat(path.join(root, 'node_modules')), {
    code: 'ENOENT',
  });
  const childPid = Number(
    await fs.readFile(path.join(gate, 'child.pid'), 'utf8'),
  );
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  const log = await engine.logs(run.id);
  assert.match(log, /REAL_S1B_MANAGED_NODE_FINISHED/);
  assert.equal(log.includes(secret), false);
  const snapshot = await backup.snapshot(backupId);
  assert.equal(JSON.stringify(snapshot.manifest).includes(secret), false);
  const snapshotData = path.join(snapshot.root, 'data');
  assert.equal(
    await fs.readFile(
      path.join(snapshotData, workspace.root_key, 'settings.txt'),
      'utf8',
    ),
    original,
  );
  await assert.rejects(
    fs.lstat(path.join(snapshotData, workspace.root_key, 'node_modules')),
    { code: 'ENOENT' },
  );
  await assert.rejects(fs.lstat(path.join(snapshotData, 'runtime')), {
    code: 'ENOENT',
  });
  for (const relative of [
    'tmp/config-materialization',
    'tmp/execution/node-bindings',
    'tmp/execution/workspace-owners',
  ]) {
    assert.deepEqual(
      await fs
        .readdir(path.join(a.dataRoot, relative))
        .catch((error) =>
          error.code === 'ENOENT' ? [] : Promise.reject(error),
        ),
      [],
    );
    assert.deepEqual(
      await fs
        .readdir(path.join(snapshotData, relative))
        .catch((error) =>
          error.code === 'ENOENT' ? [] : Promise.reject(error),
        ),
      [],
    );
  }
  const snapshotStore = await WorkspaceStore.open(
    path.join(snapshotData, 'db/database.sqlite'),
    snapshotData,
    { readOnly: true },
  );
  let savedRun, savedAttempt;
  try {
    savedRun = (
      await snapshotStore.all('SELECT * FROM TaskRuns WHERE id=?', [run.id])
    )[0];
    savedAttempt = (
      await snapshotStore.all(
        'SELECT * FROM TaskRunAttempts WHERE task_run_id=?',
        [run.id],
      )
    )[0];
    assert.equal(savedRun.status, 'SUCCESS');
    assert.equal(savedRun.active_workspace_id, null);
    assert.equal(savedRun.owner_token, null);
    assert.equal(savedRun.attempt_count, 1);
    assert.equal(savedRun.source_snapshot, run.source_snapshot);
    assert.equal(savedAttempt.status, 'SUCCESS');
    assert.equal(savedAttempt.exit_code, 0);
    assert.deepEqual(await snapshotStore.all('PRAGMA foreign_key_check'), []);
  } finally {
    await snapshotStore.close();
  }
  await h.record('S1B-MANAGED-ACTIVE-BACKUP', {
    status: 'PASS',
    input:
      'fresh actual Node distribution/npm/environment plus gated real Task with secret Config and controlled node_modules binding',
    expected:
      'actual Runtime Build EX blocked while child holds pin; backup BUSY then drains only after cleanup into one complete terminal snapshot',
    actual:
      'Build EX unavailable during real child and available after cleanup; QUIESCING observed; READY snapshot has original Config and terminal Run/Attempt with no injection links or journals',
    exit_code: 0,
    duration_ms: Date.now() - started,
    assertions: [
      'fresh provider install and managed dependency build; no S2 receipt or copied Runtime',
      'actual managed dependency loaded by real Runner',
      'Build EX succeeds before/after and is RUNTIME_BUSY during child',
      'same Workspace lease protects active Config/Node materialization',
      '100ms backup BUSY creates no successful snapshot',
      'QUIESCING rejects new submission',
      'Runner cleanup precedes READY snapshot',
      'source and snapshot retain original Config without node_modules or journals',
      'snapshot contains SUCCESS Run/Attempt and released active owner',
      'secret absent from logs and manifest',
    ],
    workspace_id: workspace.id,
    task_id: definition.task.id,
    run_id: run.id,
    attempt_id: savedAttempt.id,
    backup_id: backupId,
    runtime: {
      provider_id: runtime.providerId,
      runtime_id: runtime.runtimeId,
      environment_id: runtime.environmentId,
      revision_id: runtime.revisionId,
      build_id: runtime.buildId,
      toolchain_id: runtime.toolchainId,
      version: runtime.runtimeVersion,
      toolchain_version: runtime.toolchainVersion,
      executable_sha256: executableHash,
      artifact_sha256: runtimeMetadata.artifact_sha256,
      checksum_source: runtimeMetadata.checksum_source,
      dependency_hash: runtime.dependencyHash,
    },
    runtime_operations: managed.operationHistory,
    short_backup: 'BACKUP_BUSY',
    backup_phase: 'QUIESCING',
    build_pin_during_child: 'RUNTIME_BUSY',
    saved_run_status: savedRun.status,
    saved_attempt_status: savedAttempt.status,
    original_config_sha256: createHash('sha256').update(original).digest('hex'),
    log_sha256: createHash('sha256').update(log).digest('hex'),
    manifest_sha256: createHash('sha256')
      .update(JSON.stringify(snapshot.manifest))
      .digest('hex'),
    schema_identity: snapshot.manifest.schema_identity,
  });
});
