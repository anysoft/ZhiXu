const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createManagedRuntimeFixture } = require('./s2-runtime-fixture.cjs');
const {
  ManagedRuntimeAdapter,
} = require('../../back/services/taskExecutionV2/runtime');

test('real managed immutable Build pins survive new Python and Node generation promotion and block old-build deletion', async (t) => {
  const f = await createManagedRuntimeFixture(t);
  const adapter = new ManagedRuntimeAdapter(f.store);
  for (const kind of ['PYTHON', 'NODE'])
    await t.test(
      kind + ' actual rebuild/promotion retains original Build FD',
      async () => {
        const service = kind === 'PYTHON' ? f.managed.python : f.managed.node;
        const id =
          kind === 'PYTHON'
            ? f.managed.pythonEnvironment.id
            : f.managed.nodeEnvironment.id;
        const pinned = await adapter.pin(
          { kind, environmentId: id },
          kind === 'PYTHON' ? 'PYTHON' : 'TYPESCRIPT',
        );
        try {
          const snapshot = JSON.stringify(pinned.runtime);
          await assert.rejects(
            kind === 'PYTHON'
              ? adapter.python.lock(pinned.runtime.buildId, 'build')
              : adapter.node.lease('build', pinned.runtime.buildId),
            (error) =>
              ['RUNTIME_BUSY', 'PYTHON_ENV_BUSY'].includes(error.error_code),
          );
          const current = await service.environment(id);
          const payload = {
            environment_id: id,
            expected_version: current.version,
          };
          const requested = await f.managed.operations.request(
            kind === 'PYTHON' ? 'PYTHON_ENV_REBUILD' : 'NODE_ENV_REBUILD',
            {
              timeout_seconds: 120,
              [kind === 'PYTHON' ? 'environment' : 'node']: payload,
            },
          );
          const done = await f.managed.operations.wait(requested.id);
          assert.equal(done.status, 'SUCCESS', JSON.stringify(done));
          const next = await adapter.inspect(
            kind,
            id,
            kind === 'PYTHON' ? 'PYTHON' : 'TYPESCRIPT',
          );
          assert.notEqual(next.buildId, pinned.runtime.buildId);
          assert.equal(JSON.stringify(pinned.runtime), snapshot);
          assert.ok((await fs.stat(pinned.runtime.executable)).isFile());
          await assert.rejects(
            kind === 'PYTHON'
              ? adapter.python.lock(pinned.runtime.buildId, 'build')
              : adapter.node.lease('build', pinned.runtime.buildId),
            (error) =>
              ['RUNTIME_BUSY', 'PYTHON_ENV_BUSY'].includes(error.error_code),
          );
          process.stdout.write(
            JSON.stringify({
              s2_runtime_pin: kind,
              pinned_build: pinned.runtime.buildId,
              promoted_build: next.buildId,
              old_pin_retained: true,
              runtime_id: next.runtimeId,
              runtime_version: next.runtimeVersion,
            }) + '\n',
          );
        } finally {
          await pinned.release();
        }
        const old = kind === 'PYTHON' ? adapter.python : adapter.node;
        const probe =
          kind === 'PYTHON'
            ? await old.lock(pinned.runtime.buildId, 'build')
            : await old.lease('build', pinned.runtime.buildId);
        await probe.release();
      },
    );
});
