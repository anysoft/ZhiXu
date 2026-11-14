const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createS1BFixture } = require('../s1b/fixture.cjs');
const { openOwnedRuntimeInstance } = require('./runtime-test-resume.cjs');
const resumeCase = process.env.ZHIXU_S4_RUNTIME_DOMAIN_RESUME_CASE;
const {
  runtimeArtifactOptions,
  MANAGED_NODE_VERSION,
  MANAGED_TSX_VERSION,
} = require('../s5r-offline-options.cjs');
const {
  createRuntimeDomain,
} = require('../../../back/applicationV2/runtimeDomain');
const { runtimeApiRoutes } = require('../../../back/applicationV2/runtimeApi');
const {
  WorkspaceLifecycleService,
} = require('../../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');
const {
  ManagedRuntimeAdapter,
} = require('../../../back/services/taskExecutionV2/runtime');

function runtimeCall(routes) {
  return async (route, { params = {}, body = {}, query = {} } = {}) => {
    let httpStatus = 200;
    const definition = routes[route],
      handler =
        typeof definition === 'function' ? definition : definition?.handle;
    assert.ok(handler, 'actual retained runtime handler registered');
    const data = await handler({
      params: Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
      query,
      body,
      principal: {
        kind: 'PANEL_OWNER',
        username: 'runtime-test',
        platform: 'desktop',
      },
      setStatus: (value) => {
        httpStatus = value;
      },
    });
    return { data, httpStatus };
  };
}
test('S4 production Runtime scope binds real independent databases, all SQLite transaction guards and no legacy models', async (t) => {
  const scenario = await createS1BFixture(t, {
      caseId: 'S4-RUNTIME-SCOPE-001',
    }),
    a = await scenario.createInstance('A'),
    b = await scenario.createInstance('B');
  const da = a.track(await createRuntimeDomain(a, runtimeArtifactOptions())),
    db = b.track(await createRuntimeDomain(b, runtimeArtifactOptions()));
  const [pa, pb] = await Promise.all([
    da.operations.getProvider(),
    db.operations.getProvider(),
  ]);
  assert.equal(pa.id, 1);
  assert.equal(pb.id, 1);
  await db.node.getProvider();
  assert.equal(
    (await a.store.all('SELECT id FROM RuntimeProviders')).length,
    1,
  );
  assert.equal(
    (await b.store.all('SELECT id FROM RuntimeProviders')).length,
    2,
  );
  await da.run(() =>
    da.context.sequelize.transaction(async (transaction) => {
      const rows = await da.context.sequelize.query('PRAGMA foreign_keys', {
        transaction,
        type: 'SELECT',
      });
      const recursive = await da.context.sequelize.query(
        'PRAGMA recursive_triggers',
        { transaction, type: 'SELECT' },
      );
      assert.equal(rows[0].foreign_keys, 1);
      assert.equal(recursive[0].recursive_triggers, 1);
    }),
  );
  const routes = runtimeApiRoutes(a, da);
  assert.ok(Object.keys(routes).length > 50);
  assert.equal(da.operations.recoveryTimer, undefined);
  const value = (await runtimeCall(routes)('GET /runtime/python/provider'))
    .data;
  assert.equal('install_root' in value, false);
  assert.equal(
    Object.keys(require.cache).some((key) =>
      /\/back\/data\/(?:index|runtime|task|worktree|subscription|pythonEnvironment|nodeEnvironment)\./.test(
        key,
      ),
    ),
    false,
  );
  await assert.rejects(
    runtimeCall(routes)('POST /runtime/node/installations', {
      body: { version: MANAGED_NODE_VERSION, unexpected: 'reject' },
    }),
  );
  await a.store.verifySchema();
  await b.store.verifySchema();
  await scenario.record('S4-RUNTIME-SCOPE-001', {
    independent_provider_counts: [1, 2],
    all_transaction_guards_enabled: true,
    legacy_models_loaded: false,
    eager_recovery_started: false,
    registered_runtime_routes: Object.keys(routes).length,
  });
});

test(
  resumeCase
    ? 'S4 retained candidate Runtime APIs reopen verified real Python/Node installations and execute actual Python/TypeScript Tasks'
    : 'S4 retained candidate Runtime APIs install real managed Python/Node, build environments and execute actual Python/TypeScript Tasks',
  { timeout: 1200000 },
  async (t) => {
    const scenario = await createS1BFixture(t, {
        caseId: 'S4-MANAGED-API-002',
        ...(resumeCase ? { existingRoot: resumeCase } : {}),
      }),
      a = resumeCase
        ? await openOwnedRuntimeInstance(scenario)
        : await scenario.createInstance('A'),
      domain = a.track(await createRuntimeDomain(a, runtimeArtifactOptions())),
      routes = runtimeApiRoutes(a, domain),
      call = runtimeCall(routes),
      history = [];
    if (resumeCase) t.after(() => a.close());
    async function operation(route, options = {}) {
      const started = await call(route, options);
      assert.equal(started.httpStatus, 202);
      const done = await domain.operations.wait(started.data.id);
      history.push({
        id: done.id,
        type: done.operation_type,
        status: done.status,
        error_code: done.error_code,
      });
      assert.equal(done.status, 'SUCCESS', done.error_code);
      return done;
    }
    let pythonRuntime, python, nodeRuntime, node;
    if (resumeCase) {
      const operations = (await call('GET /runtime/operations')).data;
      assert.equal(operations.length, 7);
      for (const prior of operations) {
        assert.equal(prior.status, 'SUCCESS');
        history.push({
          id: prior.id,
          type: prior.operation_type,
          status: prior.status,
          error_code: prior.error_code,
        });
      }
      assert.deepEqual(
        history.map((op) => op.type).sort(),
        [
          'PROVIDER_INSTALL',
          'RUNTIME_INSTALL',
          'PYTHON_ENV_BUILD',
          'NODE_CATALOG_REFRESH',
          'NODE_RUNTIME_INSTALL',
          'NODE_PACKAGE_MANAGER_INSTALL',
          'NODE_ENV_BUILD',
        ].sort(),
      );
      pythonRuntime = (
        await call('GET /runtime/python/installations')
      ).data.find((row) => row.state === 'READY');
      nodeRuntime = (await call('GET /runtime/node/installations')).data.find(
        (row) => row.state === 'READY',
      );
      python = (await call('GET /runtime/python/environments')).data.find(
        (row) => row.state === 'READY',
      );
      node = (await call('GET /runtime/node/environments')).data.find(
        (row) => row.state === 'READY',
      );
      assert.ok(pythonRuntime && nodeRuntime && python && node);
    } else {
      await scenario.measure('real_managed_api_install_and_build', async () => {
        await operation('POST /runtime/python/provider/setup', {
          body: { timeout_seconds: 1800, jobs: 4 },
        });
        await operation('POST /runtime/python/installations', {
          body: { version: '3.13.15', timeout_seconds: 1800, jobs: 4 },
        });
      });
      pythonRuntime = (
        await call('GET /runtime/python/installations')
      ).data.find((row) => row.state === 'READY');
      assert.ok(pythonRuntime);
      python = (
        await call('POST /runtime/python/environments', {
          body: {
            name: 'S4 real Python API environment',
            description: '',
            runtime_id: pythonRuntime.id,
            requirements: [],
          },
        })
      ).data;
      await operation('POST /runtime/python/environments/:id/build', {
        params: { id: python.id },
        body: { expected_version: python.version, timeout_seconds: 1800 },
      });
      python = (
        await call('GET /runtime/python/environments/:id', {
          params: { id: python.id },
        })
      ).data;
      await operation('POST /runtime/node/catalog', {
        body: { timeout_seconds: 1800 },
      });
      await operation('POST /runtime/node/installations', {
        body: { version: MANAGED_NODE_VERSION, timeout_seconds: 1800 },
      });
      nodeRuntime = (await call('GET /runtime/node/installations')).data.find(
        (row) => row.state === 'READY',
      );
      assert.ok(nodeRuntime);
      await operation('POST /runtime/node/toolchains', {
        body: {
          runtime_id: nodeRuntime.id,
          manager_type: 'NPM',
          timeout_seconds: 1800,
        },
      });
      const tool = (await call('GET /runtime/node/toolchains')).data.find(
        (row) =>
          row.runtime_id === nodeRuntime.id &&
          row.manager_type === 'NPM' &&
          row.state === 'READY',
      );
      assert.ok(tool);
      node = (
        await call('POST /runtime/node/environments', {
          body: {
            name: 'S4 actual TSX environment',
            description: '',
            runtime_id: nodeRuntime.id,
            toolchain_id: tool.id,
            dependencies: [
              { name: 'is-number', specifier: '7.0.0', type: 'DEPENDENCY' },
              {
                name: 'tsx',
                specifier: MANAGED_TSX_VERSION,
                type: 'DEPENDENCY',
              },
            ],
            production_only: false,
            install_scripts_policy: 'ALLOW',
          },
        })
      ).data;
      await operation('POST /runtime/node/environments/:id/build', {
        params: { id: node.id },
        body: { expected_version: node.version, timeout_seconds: 1800 },
      });
      node = (
        await call('GET /runtime/node/environments/:id', {
          params: { id: node.id },
        })
      ).data;
    }
    const adapter = new ManagedRuntimeAdapter(a.store),
      pyProof = await adapter.inspect('PYTHON', python.id, 'PYTHON'),
      nodeProof = await adapter.inspect('NODE', node.id, 'TYPESCRIPT');
    assert.equal(pyProof.runtimeId, pythonRuntime.id);
    assert.equal(nodeProof.runtimeId, nodeRuntime.id);
    assert.equal(pyProof.executable.startsWith(a.dataRoot + '/runtime/'), true);
    assert.equal(
      nodeProof.executable.startsWith(a.dataRoot + '/runtime/'),
      true,
    );
    const pythonConfigHash = await scenario.hashFile(
      path.join(pyProof.venvRoot, 'pyvenv.cfg'),
    );
    const nodeLockHash = await scenario.hashFile(
      path.join(nodeProof.buildRoot, 'package-lock.json'),
    );
    const lifecycle = new WorkspaceLifecycleService(a.store, a.roots, a.leases),
      files = new WorkspaceFileService(a.store, a.roots, a.leases),
      tasks = new TaskService(a.store, a.roots, a.leases),
      engine = a.track(new TaskExecutionService(a.store, a.roots, a.leases)),
      row = await lifecycle.createLocal({
        name: 'S4 actual managed children',
        requestKey: 'actual-managed-api-children-' + randomUUID(),
      });
    await files.create(
      row.id,
      'main.py',
      'import sys\nprint("s4-managed-python", sys.version_info[0])\n',
    );
    await files.create(
      row.id,
      'main.ts',
      'import isNumber from "is-number"; const actual: boolean = isNumber(42); console.log("s4-managed-typescript", actual);\n',
    );
    const runs = [];
    for (const [entry, language, runtime] of [
      [
        'main.py',
        'PYTHON',
        {
          kind: 'PYTHON',
          python_environment_id: python.id,
          node_environment_id: null,
        },
      ],
      [
        'main.ts',
        'TYPESCRIPT',
        {
          kind: 'NODE',
          python_environment_id: null,
          node_environment_id: node.id,
        },
      ],
    ]) {
      const d = await tasks.create({
        name: language,
        enabled: true,
        source: {
          type: 'WORKSPACE_ENTRYPOINT',
          workspace_id: row.id,
          relative_entrypoint: entry,
          language,
          cwd_mode: 'ENTRYPOINT_DIR',
          cwd_relative_path: null,
        },
        runtime,
      });
      const run = await engine.wait((await engine.submit(d.task.id)).id);
      assert.equal(run.status, 'SUCCESS', run.error_code);
      assert.equal(run.attempt_count, 1);
      assert.equal(
        (await engine.logs(run.id)).includes(
          language === 'PYTHON'
            ? 's4-managed-python'
            : 's4-managed-typescript true',
        ),
        true,
      );
      runs.push({
        task_id: d.task.id,
        task_run_id: run.id,
        language,
        status: run.status,
        attempt_count: run.attempt_count,
      });
    }
    const safe = (
      await call('GET /runtime/node/environments/:id/resolve', {
        params: { id: node.id },
      })
    ).data;
    assert.equal(JSON.stringify(safe).includes(a.dataRoot), false);
    assert.equal('executable' in safe, false);
    await assert.rejects(
      call('DELETE /runtime/node/environments/:id', {
        params: { id: node.id },
        body: { expected_version: node.version, timeout_seconds: 1800 },
      }),
      (error) =>
        (error.error_code || error.code) === 'NODE_ENV_TASK_REFERENCED',
    );
    await a.store.verifySchema();
    assert.equal((await a.store.all('PRAGMA foreign_key_check')).length, 0);
    await scenario.record(
      resumeCase ? 'S4-MANAGED-API-002-REOPEN' : 'S4-MANAGED-API-002',
      {
        operation_history: history,
        python_environment_id: python.id,
        node_environment_id: node.id,
        python_runtime_version: pythonRuntime.version,
        node_runtime_version: nodeRuntime.version,
        task_runs: runs,
        actual_managed_executables: true,
        host_fallback: false,
        task_references_block_delete: true,
        public_runtime_paths_omitted: true,
        python_build_id: pyProof.buildId,
        node_build_id: nodeProof.buildId,
        python_config_sha256: pythonConfigHash,
        node_lock_sha256: nodeLockHash,
        actual_runtime_domain_reopen: !!resumeCase,
        initial_api_install_proof: resumeCase
          ? 'same marker-verified owned root retains all seven real successful operations; no copying or receipt import'
          : 'fresh real retained API operations',
        scope:
          'retained candidate API handler qualification; HTTP/browser qualified separately',
      },
    );
  },
);
