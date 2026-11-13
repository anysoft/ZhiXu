const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFixture } = require('./fixture.cjs');
const {
  ManagedRuntimeAdapter,
} = require('../../back/services/taskExecutionV2/runtime');

test('managed runtime readiness is read-only and rejects metadata without actual owned runtime/build bytes', async (t) => {
  const f = await createFixture(t);
  const adapter = new ManagedRuntimeAdapter(f.store);
  const before = (await fs.readdir(f.dataRoot)).sort();
  await assert.rejects(adapter.inspect('PYTHON', null, 'PYTHON'), {
    error_code: 'CONFIGURATION_REQUIRED',
  });
  await assert.rejects(adapter.inspect('NODE', null, 'TYPESCRIPT'), {
    error_code: 'CONFIGURATION_REQUIRED',
  });
  const now = new Date().toISOString();
  await f.store.run(
    "INSERT INTO RuntimeProviders(id,language,provider_type,state,install_root,createdAt,updatedAt) VALUES(1,'PYTHON','PYENV','READY','runtime/python/pyenv',?,?)",
    [now, now],
  );
  await f.store.run(
    "INSERT INTO RuntimeInstallations(id,provider_id,language,implementation,version,state,executable_relative_path,metadata,createdAt,updatedAt) VALUES(1,1,'PYTHON','CPYTHON','3.13.15','READY','bin/python',?,?,?)",
    [JSON.stringify({ executable_sha256: '0'.repeat(64) }), now, now],
  );
  await f.store.run(
    "INSERT INTO PythonEnvironments(id,name,runtime_id,state,createdAt,updatedAt) VALUES(1,'unproved metadata',1,'EMPTY',?,?)",
    [now, now],
  );
  await f.store.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO PythonEnvironmentRevisions(id,environment_id,runtime_id,spec_hash,createdAt,updatedAt) VALUES(1,1,1,'fixture-negative',?,?)",
      [now, now],
    );
    await tx.run(
      "INSERT INTO PythonEnvironmentBuilds(id,environment_id,revision_id,runtime_id,state,health,createdAt,updatedAt) VALUES(1,1,1,1,'READY','HEALTHY',?,?)",
      [now, now],
    );
    await tx.run(
      "UPDATE PythonEnvironments SET current_revision_id=1,current_build_id=1,state='READY' WHERE id=1",
    );
  });
  await assert.rejects(adapter.inspect('PYTHON', 1, 'PYTHON'), {
    error_code: 'RUNTIME_NOT_READY',
  });
  await assert.rejects(adapter.inspect('NODE', 1, 'JAVASCRIPT'), {
    error_code: 'RUNTIME_NOT_READY',
  });
  await assert.rejects(fs.lstat(path.join(f.dataRoot, 'runtime')), {
    code: 'ENOENT',
  });
  assert.deepEqual((await fs.readdir(f.dataRoot)).sort(), before);
  const shell = await adapter.inspect('SHELL', null, 'SHELL');
  assert.equal(shell.executable, '/bin/sh');
  assert.equal(shell.kind, 'SHELL');
  assert.deepEqual((await fs.readdir(f.dataRoot)).sort(), before);
});
