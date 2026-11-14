// Real compiled App Runtime domain; operation requests cross actual authenticated HTTP.
const fs = require('node:fs/promises');
async function requestRuntimeOperation(instance, type, input) {
  const timeout = { timeout_seconds: input.timeout_seconds ?? 1800 };
  if (type === 'PROVIDER_INSTALL')
    return instance.request('POST', '/runtime/python/provider/setup', {
      ...timeout,
      jobs: input.jobs ?? 4,
    });
  if (type === 'RUNTIME_INSTALL')
    return instance.request('POST', '/runtime/python/installations', {
      ...timeout,
      jobs: input.jobs ?? 4,
      version: input.version,
    });
  if (type === 'PYTHON_ENV_BUILD')
    return instance.request(
      'POST',
      '/runtime/python/environments/' +
        input.environment.environment_id +
        '/build',
      { ...timeout, expected_version: input.environment.expected_version },
    );
  if (type === 'NODE_CATALOG_REFRESH')
    return instance.request('POST', '/runtime/node/catalog', timeout);
  if (type === 'NODE_RUNTIME_INSTALL')
    return instance.request('POST', '/runtime/node/installations', {
      ...timeout,
      version: input.node.version,
    });
  if (type === 'NODE_PACKAGE_MANAGER_INSTALL')
    return instance.request('POST', '/runtime/node/toolchains', {
      ...timeout,
      runtime_id: input.node.runtime_id,
      manager_type: input.node.manager_type,
    });
  if (type === 'NODE_ENV_BUILD' || type === 'NODE_ENV_REBUILD')
    return instance.request(
      'POST',
      '/runtime/node/environments/' +
        input.node.environment_id +
        (type === 'NODE_ENV_REBUILD' ? '/rebuild' : '/build'),
      { ...timeout, expected_version: input.node.expected_version },
    );
  throw Error('S5_UNSUPPORTED_RUNTIME_TEST_OPERATION');
}
async function attachRuntimeDomain(instance) {
  if (!instance.app?.ready || instance.app.services.store !== instance.store)
    throw Error('S5_LIVE_COMPILED_APPLICATION_REQUIRED');
  const domain = instance.app.runtime;
  return {
    ...domain,
    operations: new Proxy(domain.operations, {
      get(target, key) {
        if (key === 'request')
          return (type, input = {}) =>
            requestRuntimeOperation(instance, type, input);
        return Reflect.get(target, key, target);
      },
    }),
  };
}
async function provisionManagedRuntime(f, options = {}) {
  const domain = f.track(await attachRuntimeDomain(f));
  const history = [];
  async function run(type, input = {}) {
    const requested = await domain.operations.request(type, {
      timeout_seconds: 1800,
      jobs: 4,
      ...input,
    });
    const done = await domain.operations.wait(requested.id);
    history.push({
      id: done.id,
      operation_type: type,
      status: done.status,
      error_code: done.error_code,
    });
    if (done.status !== 'SUCCESS') {
      const log = await fs
        .readFile(await domain.operations.paths.log(done.id), 'utf8')
        .catch(() => '');
      throw Error(type + ':' + done.error_code + '\n' + log.slice(-12000));
    }
    return done;
  }
  let pythonEnvironment = null,
    nodeEnvironment = null;
  if (options.python !== false) {
    await run('PROVIDER_INSTALL');
    await run('RUNTIME_INSTALL', { version: '3.13.15' });
    const runtime = (await domain.operations.runtimes()).find(
      (row) => row.language === 'PYTHON' && row.state === 'READY',
    );
    if (!runtime) throw Error('S2_REAL_MANAGED_PYTHON_REQUIRED');
    pythonEnvironment = await domain.python.create({
      name: 'S2 actual managed Python',
      runtime_id: runtime.id,
      requirements: [],
    });
    await run('PYTHON_ENV_BUILD', {
      environment: {
        environment_id: pythonEnvironment.id,
        expected_version: pythonEnvironment.version,
      },
    });
    pythonEnvironment = await domain.python.environment(pythonEnvironment.id);
  }
  if (options.node !== false) {
    await run('NODE_CATALOG_REFRESH');
    await run('NODE_RUNTIME_INSTALL', { node: { version: '24.22.3' } });
    const runtime = (await domain.node.runtimes()).find(
      (row) => row.language === 'NODE' && row.state === 'READY',
    );
    if (!runtime) throw Error('S2_REAL_MANAGED_NODE_REQUIRED');
    if (runtime.version !== '24.22.3')
      throw Error('S5_SAFE_MANAGED_NODE_VERSION_REQUIRED');
    await run('NODE_PACKAGE_MANAGER_INSTALL', {
      node: { runtime_id: runtime.id, manager_type: 'NPM' },
    });
    const tool = (await domain.node.toolchains()).find(
      (row) =>
        row.runtime_id === runtime.id &&
        row.manager_type === 'NPM' &&
        row.state === 'READY',
    );
    nodeEnvironment = await domain.node.definition({
      name: 'S2 actual managed Node + TSX',
      runtime_id: runtime.id,
      toolchain_id: tool.id,
      dependencies: [
        { name: 'is-number', specifier: '7.0.0', type: 'DEPENDENCY' },
        { name: 'tsx', specifier: '4.20.6', type: 'DEPENDENCY' },
      ],
      install_scripts_policy: 'ALLOW',
    });
    await run('NODE_ENV_BUILD', {
      node: {
        environment_id: nodeEnvironment.id,
        expected_version: nodeEnvironment.version,
      },
    });
    nodeEnvironment = await domain.node.environment(nodeEnvironment.id);
  }
  await f.store.verifySchema();
  return {
    ...domain,
    pythonEnvironment,
    nodeEnvironment,
    operationHistory: history,
    runOperation: run,
  };
}

module.exports = { attachRuntimeDomain, provisionManagedRuntime };
