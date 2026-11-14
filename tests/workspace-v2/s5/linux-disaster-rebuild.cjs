// S5 copy of the original S1.B safety assertions, using only explicit compiled artifacts.
const {
  artifactModule,
  candidateIdentity,
  releaseRoot,
} = require('./artifact-support.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { attachRuntimeDomain } = require('./linux-disaster-runtime.cjs');
const { ManagedRuntimeAdapter } = artifactModule(
  'services/taskExecutionV2/runtime',
);

/** Recreate physical installations through the existing providers, retaining restored logical IDs. */
async function rebuildRestoredManagedRuntime(instance, expected) {
  const domain = instance.track(await attachRuntimeDomain(instance));
  const operations = [];
  const run = async (type, input = {}) => {
    const requested = await domain.operations.request(type, {
      timeout_seconds: 1800,
      jobs: 4,
      ...input,
    });
    const completed = await domain.operations.wait(requested.id);
    operations.push({
      id: completed.id,
      operation_type: type,
      status: completed.status,
      error_code: completed.error_code,
    });
    assert.equal(
      completed.status,
      'SUCCESS',
      JSON.stringify({
        type,
        id: completed.id,
        status: completed.status,
        error_code: completed.error_code,
      }),
    );
    return completed;
  };
  await run('PROVIDER_INSTALL');
  await run('RUNTIME_INSTALL', { version: expected.python.runtimeVersion });
  const python = await domain.python.environment(expected.python.environmentId);
  assert.equal(python.runtime_id, expected.python.runtimeId);
  await run('PYTHON_ENV_BUILD', {
    environment: {
      environment_id: python.id,
      expected_version: python.version,
    },
  });
  await run('NODE_CATALOG_REFRESH');
  await run('NODE_RUNTIME_INSTALL', {
    node: { version: expected.node.runtimeVersion },
  });
  await run('NODE_PACKAGE_MANAGER_INSTALL', {
    node: { runtime_id: expected.node.runtimeId, manager_type: 'NPM' },
  });
  const node = await domain.node.environment(expected.node.environmentId);
  assert.equal(node.runtime_id, expected.node.runtimeId);
  assert.equal(node.toolchain_id, expected.node.toolchainId);
  await run('NODE_ENV_REBUILD', {
    node: { environment_id: node.id, expected_version: node.version },
  });
  const adapter = new ManagedRuntimeAdapter(instance.store);
  const actual = {
    python: await adapter.inspect('PYTHON', python.id, 'PYTHON'),
    node: await adapter.inspect('NODE', node.id, 'TYPESCRIPT'),
  };
  for (const kind of ['python', 'node']) {
    assert.equal(actual[kind].environmentId, expected[kind].environmentId);
    assert.equal(actual[kind].runtimeId, expected[kind].runtimeId);
    assert.equal(actual[kind].revisionId, expected[kind].revisionId);
    assert.equal(actual[kind].runtimeVersion, expected[kind].runtimeVersion);
    assert.notEqual(actual[kind].buildId, expected[kind].buildId);
    assert.ok(actual[kind].executable.startsWith(instance.dataRoot + path.sep));
    assert.ok((await fs.stat(actual[kind].executable)).isFile());
  }
  assert.equal(
    actual.python.providerRevision,
    expected.python.providerRevision,
  );
  assert.equal(actual.node.toolchainId, expected.node.toolchainId);
  assert.equal(actual.node.toolchainVersion, expected.node.toolchainVersion);
  assert.equal(actual.node.dependencyHash, expected.node.dependencyHash);
  return { domain, operations, ...actual };
}

module.exports = { rebuildRestoredManagedRuntime };
