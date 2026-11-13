const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFixture, insertTaskSource } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  manifestTriggerPlan,
} = require('../../back/services/workspaceV2/manifestReferences');

test('manifest trigger plans preserve source identities while excluding unknown payload and nested secret fields', () => {
  const secret = 'S1A_UNIQUE_TRIGGER_SECRET';
  const plan = manifestTriggerPlan(
    JSON.stringify([
      {
        trigger_id: 1,
        trigger_version: 2,
        task_id: 3,
        task_definition_version: 4,
        filter_result: 'MATCHED',
        command: secret,
        env: { TOKEN: secret },
        source_expectation: {
          workspace_id: 5,
          content_revision: 6,
          inventory_hash: 'a'.repeat(64),
          secret,
          values: { TOKEN: secret },
        },
      },
    ]),
  );
  assert.equal(plan[0].trigger_id, 1);
  assert.equal(plan[0].source_expectation.inventory_hash, 'a'.repeat(64));
  assert.equal(JSON.stringify(plan).includes(secret), false);
  assert.throws(
    () => manifestTriggerPlan('[{"filter_result":"' + secret + '"}]'),
    { error_code: 'BACKUP_SOURCE_INCOMPLETE' },
  );
  assert.throws(() => manifestTriggerPlan('../outside'), {
    error_code: 'BACKUP_SOURCE_INCOMPLETE',
  });
});

test('nonsecret manifest retains SET/UNSET identities while encrypted portable SQLite preserves actual secret values', async (t) => {
  const f = await createFixture(t);
  const row = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'secret metadata', requestKey: 'manifest-secrets' });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    row.id,
    'main.py',
    'print("safe")',
  );
  const task = await insertTaskSource(f.store, row.id);
  const secrets = [
    'S1A_UNIQUE_GLOBAL_VALUE',
    'S1A_UNIQUE_PROFILE_VALUE',
    'S1A_UNIQUE_TASK_VALUE',
  ];
  const profile = (
    await f.store.run(
      'INSERT INTO EnvironmentProfiles(workspace_id,name) VALUES(?,?)',
      [row.id, 'profile'],
    )
  ).lastID;
  await f.store.run(
    'UPDATE Workspaces SET default_env_profile_id=? WHERE id=?',
    [profile, row.id],
  );
  await f.store.run(
    "INSERT INTO Envs(name,value,operation,is_secret,createdAt,updatedAt) VALUES('GLOBAL_SECRET',?,'SET',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    [secrets[0]],
  );
  await f.store.run(
    "INSERT INTO WorkspaceProfileVariables(profile_id,name,value,operation,is_secret) VALUES(?,'PROFILE_SECRET',?,'SET',1)",
    [profile, secrets[1]],
  );
  await f.store.run(
    "INSERT INTO WorkspaceProfileVariables(profile_id,name,value,operation) VALUES(?,'PROFILE_MASK',NULL,'UNSET')",
    [profile],
  );
  await f.store.run(
    "INSERT INTO TaskEnvVariables(task_id,name,value,operation,is_secret,createdAt,updatedAt) VALUES(?,'TASK_SECRET',?,'SET',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    [task, secrets[2]],
  );
  await f.store.run(
    "INSERT INTO TaskEnvVariables(task_id,name,value,operation,createdAt,updatedAt) VALUES(?,'TASK_MASK',NULL,'UNSET',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    [task],
  );
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const id = await backup.create();
  const manifest = (await backup.snapshot(id)).manifest;
  const refs = manifest.workspaces[0].environment_config_references;
  assert.equal(refs.default_profile[0].profile_id, profile);
  assert.deepEqual(
    refs.profile_variables.map((v) => v.operation),
    ['SET', 'UNSET'],
  );
  assert.deepEqual(
    refs.task_variables.map((v) => v.operation),
    ['SET', 'UNSET'],
  );
  const serialized = JSON.stringify(manifest);
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false);
    assert.equal(
      serialized.includes(createHash('sha256').update(secret).digest('hex')),
      false,
    );
  }
  const encrypted = await backup.exportPortable(
    id,
    Buffer.from('manifest secret qualification'),
  );
  const payload = await fs.readFile(encrypted);
  for (const secret of secrets) assert.equal(payload.includes(secret), false);
  const imported = await backup.importPortable(
    encrypted,
    Buffer.from('manifest secret qualification'),
  );
  const root = path.join(imported.root, 'data');
  const restored = f.track(
    await WorkspaceStore.open(path.join(root, 'db/database.sqlite'), root, {
      readOnly: true,
    }),
  );
  assert.equal(
    (await restored.all('SELECT value FROM Envs'))[0].value,
    secrets[0],
  );
  assert.equal(
    (
      await restored.all(
        "SELECT value FROM WorkspaceProfileVariables WHERE operation='SET'",
      )
    )[0].value,
    secrets[1],
  );
  assert.equal(
    (
      await restored.all(
        "SELECT value FROM TaskEnvVariables WHERE operation='SET'",
      )
    )[0].value,
    secrets[2],
  );
});
