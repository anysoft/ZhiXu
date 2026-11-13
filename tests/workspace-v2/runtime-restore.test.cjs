const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFixture, createDatabase } = require('./fixture.cjs');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../back/services/workspaceV2/lease');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const {
  WorkspaceRestoreService,
} = require('../../back/services/workspaceV2/restore');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');

// Real candidate SQL state exercises offline reconciliation. These rows never
// claim to install, invoke, or qualify a Python/Node interpreter or a v2 Runner.
async function seedReadyRuntimeReferences(store, workspaceId) {
  const now = '2026-11-13T00:00:00.000Z';
  return store.transaction(async (tx) => {
    for (const [id, language, providerType] of [
      [1, 'PYTHON', 'PYENV'],
      [2, 'NODE', 'NODE_DISTRIBUTION'],
    ]) {
      await tx.run(
        `INSERT INTO RuntimeProviders(id,language,provider_type,state,install_root,last_verified_at,createdAt,updatedAt)
        VALUES(?,?,?,'READY',?,?,?,?)`,
        [
          id,
          language,
          providerType,
          `runtime/${language.toLowerCase()}/provider`,
          now,
          now,
          now,
        ],
      );
      await tx.run(
        `INSERT INTO RuntimeInstallations(id,provider_id,language,implementation,version,state,executable_relative_path,verified_at,createdAt,updatedAt)
        VALUES(?,?,?,?,?,'READY',?,?,?,?)`,
        [
          id,
          id,
          language,
          language === 'PYTHON' ? 'CPYTHON' : 'NODEJS',
          language === 'PYTHON' ? '3.12.0' : '22.0.0',
          `runtime/${language.toLowerCase()}/versions/runtime-${id}/bin/${
            language === 'PYTHON' ? 'python' : 'node'
          }`,
          now,
          now,
          now,
        ],
      );
    }
    await tx.run(
      `INSERT INTO NodePackageManagerToolchains(id,runtime_id,manager_type,version,state,verified_at,createdAt,updatedAt)
      VALUES(1,2,'NPM','10.0.0','READY',?,?,?)`,
      [now, now, now],
    );
    await tx.run(
      `INSERT INTO PythonEnvironments(id,name,runtime_id,state,createdAt,updatedAt)
      VALUES(1,'restore-python',1,'EMPTY',?,?)`,
      [now, now],
    );
    await tx.run(
      `INSERT INTO PythonEnvironmentRevisions(id,environment_id,runtime_id,dependencies,spec_hash,createdAt,updatedAt)
      VALUES(1,1,1,?, ?,?,?)`,
      ['["fixture-python==1"]', 'a'.repeat(64), now, now],
    );
    await tx.run(
      `INSERT INTO PythonEnvironmentBuilds(id,environment_id,revision_id,runtime_id,state,health,resolved,resolved_hash,freeze,metadata,verified_at,createdAt,updatedAt)
      VALUES(1,1,1,1,'READY','HEALTHY',?,?,?,?,?,?,?)`,
      [
        '[{"name":"fixture-python","version":"1"}]',
        'b'.repeat(64),
        'fixture-python==1\n',
        '{"fixture":"immutable-python-snapshot"}',
        now,
        now,
        now,
      ],
    );
    await tx.run(
      "UPDATE PythonEnvironments SET state='READY',current_revision_id=1,current_build_id=1 WHERE id=1",
    );
    await tx.run(
      `INSERT INTO NodeEnvironments(id,name,runtime_id,toolchain_id,state,createdAt,updatedAt)
      VALUES(1,'restore-node',2,1,'EMPTY',?,?)`,
      [now, now],
    );
    await tx.run(
      `INSERT INTO NodeEnvironmentRevisions(id,environment_id,runtime_id,toolchain_id,dependencies,spec_hash,createdAt,updatedAt)
      VALUES(1,1,2,1,?,?,?,?)`,
      ['[{"name":"fixture-node","spec":"1"}]', 'c'.repeat(64), now, now],
    );
    await tx.run(
      `INSERT INTO NodeEnvironmentBuilds(id,environment_id,revision_id,runtime_id,toolchain_id,state,health,package_json,lockfile,lock_hash,resolved,resolved_hash,metadata,verified_at,createdAt,updatedAt)
      VALUES(1,1,1,2,1,'READY','HEALTHY',?,?,?,?,?,?,?,?,?)`,
      [
        '{"dependencies":{"fixture-node":"1"}}',
        '{"lockfileVersion":3}',
        'd'.repeat(64),
        '[{"name":"fixture-node","version":"1"}]',
        'e'.repeat(64),
        '{"fixture":"immutable-node-snapshot"}',
        now,
        now,
        now,
      ],
    );
    await tx.run(
      "UPDATE NodeEnvironments SET state='READY',current_revision_id=1,current_build_id=1 WHERE id=1",
    );
    await tx.run(
      "INSERT INTO WorkspaceRuntimeDefaults(workspace_id,kind,python_environment_id) VALUES(?,'PYTHON',1)",
      [workspaceId],
    );
    await tx.run(
      "INSERT INTO WorkspaceRuntimeDefaults(workspace_id,kind,node_environment_id) VALUES(?,'NODE',1)",
      [workspaceId],
    );
    return {
      defaults: await tx.all(
        'SELECT * FROM WorkspaceRuntimeDefaults ORDER BY id',
      ),
      pythonRevision: await tx.all('SELECT * FROM PythonEnvironmentRevisions'),
      nodeRevision: await tx.all('SELECT * FROM NodeEnvironmentRevisions'),
      pythonBuild: (await tx.all('SELECT * FROM PythonEnvironmentBuilds'))[0],
      nodeBuild: (await tx.all('SELECT * FROM NodeEnvironmentBuilds'))[0],
    };
  });
}

test('real backup/restore keeps logical runtime identities and immutable build snapshots while blocking missing physical readiness', async (t) => {
  const f = await createFixture(t);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const row = await lifecycle.createLocal({
    name: 'runtime references',
    requestKey: 'runtime-reference-create',
  });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    row.id,
    'main.py',
    'print("source retained")\n',
  );
  const before = await seedReadyRuntimeReferences(f.store, row.id);
  const runtime = await f.roots.directory('runtime', true);
  await fs.writeFile(
    path.join(runtime, 'physical-build-must-not-be-backed-up'),
    'excluded physical runtime data',
    { mode: 0o600 },
  );
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const snapshotId = await backup.create();
  const snapshot = await backup.snapshot(snapshotId);
  assert.equal(
    await fs.lstat(path.join(snapshot.root, 'data/runtime')).catch(() => null),
    null,
  );
  assert.equal(
    (await f.store.all('SELECT state FROM RuntimeInstallations WHERE id=1'))[0]
      .state,
    'READY',
  );

  const destination = path.join(f.root, 'runtime-restored-data');
  const databasePath = await createDatabase(destination);
  const targetStore = f.track(
    await WorkspaceStore.open(databasePath, destination),
  );
  const targetRoots = new WorkspaceRootResolver(destination);
  const targetLeases = new WorkspaceLeaseService(
    destination,
    new PlatformBackupBarrier(destination + '.platform-control'),
  );
  const targetBackup = new WorkspaceBackupService(
    targetStore,
    targetRoots,
    targetLeases,
    f.backupRoot,
  );
  await f.store.close();
  await fs.rm(f.dataRoot, { recursive: true });
  const restored = f.track(
    await new WorkspaceRestoreService(targetBackup).restore(snapshotId),
  );

  assert.deepEqual(
    await restored.all('SELECT * FROM WorkspaceRuntimeDefaults ORDER BY id'),
    before.defaults,
  );
  assert.deepEqual(
    await restored.all('SELECT * FROM PythonEnvironmentRevisions'),
    before.pythonRevision,
  );
  assert.deepEqual(
    await restored.all('SELECT * FROM NodeEnvironmentRevisions'),
    before.nodeRevision,
  );
  for (const installation of await restored.all(
    'SELECT state,verified_at,last_error FROM RuntimeInstallations',
  ))
    assert.deepEqual(installation, {
      state: 'MISSING',
      verified_at: null,
      last_error: 'RESTORE_REBUILD_REQUIRED',
    });
  assert.equal(
    (
      await restored.all(
        "SELECT state FROM RuntimeProviders WHERE language='PYTHON'",
      )
    )[0].state,
    'MISSING',
  );
  assert.deepEqual(
    (
      await restored.all(
        'SELECT state,verified_at,last_error FROM NodePackageManagerToolchains',
      )
    )[0],
    {
      state: 'ERROR',
      verified_at: null,
      last_error: 'RESTORE_REBUILD_REQUIRED',
    },
  );
  for (const prefix of ['Python', 'Node']) {
    const environment = (
      await restored.all(
        `SELECT state,current_revision_id,current_build_id,last_error FROM ${prefix}Environments`,
      )
    )[0];
    assert.deepEqual(environment, {
      state: 'ERROR',
      current_revision_id: 1,
      current_build_id: 1,
      last_error: 'RESTORE_REBUILD_REQUIRED',
    });
    const build = (
      await restored.all(`SELECT * FROM ${prefix}EnvironmentBuilds`)
    )[0];
    const original =
      prefix === 'Python' ? before.pythonBuild : before.nodeBuild;
    const { health, verified_at, last_error, ...immutable } = build;
    const {
      health: oldHealth,
      verified_at: oldVerified,
      last_error: oldError,
      ...originalImmutable
    } = original;
    assert.deepEqual(immutable, originalImmutable);
    assert.equal(health, 'MISSING');
    assert.equal(verified_at, null);
    assert.equal(last_error, 'RESTORE_REBUILD_REQUIRED');
  }
  assert.equal(
    await fs
      .lstat(
        path.join(destination, 'runtime/physical-build-must-not-be-backed-up'),
      )
      .catch(() => null),
    null,
  );
  assert.equal(
    await fs.readFile(
      path.join(targetRoots.path(await restored.workspace(row.id)), 'main.py'),
      'utf8',
    ),
    'print("source retained")\n',
  );
  assert.deepEqual(await restored.all('PRAGMA foreign_key_check'), []);
});
