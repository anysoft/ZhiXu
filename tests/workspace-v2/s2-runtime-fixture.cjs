// Real managed-provider provisioning against only the unchanged Runtime domain
// tables of the complete candidate DB. No v9 Task or execution model is loaded.
const fs = require('node:fs/promises');
const path = require('node:path');
const { Sequelize } = require('sequelize');
const { randomUUID } = require('node:crypto');
const load = require('../../test/helpers/load-security-module.cjs');
const { createFixture, projectRoot } = require('./fixture.cjs');
const {
  runtimeArtifactOptions,
  MANAGED_NODE_VERSION,
  MANAGED_TSX_VERSION,
} = require('./s5r-offline-options.cjs');

async function attachRuntimeDomain(f) {
  // Resource requests use optimistic SQL checks plus writes. Acquire the SQLite
  // writer before reading their snapshot, avoiding DEFERRED upgrade failures
  // against the candidate executor's separate connection.
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: f.databasePath,
    logging: false,
    transactionType: 'IMMEDIATE',
  });
  await db.query('PRAGMA foreign_keys=ON');
  await db.query('PRAGMA recursive_triggers=ON');
  const config = {
    rootPath: process.env.QL_DIR || projectRoot,
    dataPath: f.dataRoot,
    dbPath: path.join(f.dataRoot, 'db'),
    scriptPath: path.join(f.dataRoot, 'unused-scripts'),
  };
  const cache = new Map();
  class ForbiddenLegacyTaskReferences {
    async requireUnusedEnvironment() {
      throw Error('S2_LEGACY_TASK_REFERENCE_FORBIDDEN');
    }
  }
  const mocks = {
    '.': { sequelize: db },
    '../data': { sequelize: db },
    '../config': { default: config, __esModule: true },
    './taskReferences': {
      default: ForbiddenLegacyTaskReferences,
      __esModule: true,
    },
  };
  const models = {};
  for (const name of ['runtime', 'pythonEnvironment', 'nodeEnvironment']) {
    const module = load(
      path.join(projectRoot, 'back/data', name + '.ts'),
      mocks,
      cache,
    );
    Object.assign(models, module);
    mocks['../data/' + name] = module;
  }
  const module = (file) => load(path.join(projectRoot, file), mocks, cache);
  const Paths = module('back/services/runtimePaths.ts').default;
  const Provider = module('back/services/pyenvProvider.ts').default;
  const Operations = module('back/services/runtimeOperations.ts').default;
  const operations = new Operations(new Provider(new Paths(f.dataRoot)));
  const python = new (module('back/services/pythonEnvironment.ts').default)(
    operations,
  );
  const artifactOptions = runtimeArtifactOptions();
  let context, unbind;
  const scoped = (action) =>
    context
      ? module('back/services/runtimeDomainScope.ts').withRuntimeDomain(
          context,
          action,
        )
      : action();
  if (artifactOptions) {
    // The normal module instances are shared with the real Task adapter's
    // per-WorkspaceStore policy. The original loader still maps actual Runtime
    // models to this real SQLite database; no Provider/build/SQLite is mocked.
    const {
      VerifiedRuntimeArtifactStore,
    } = require('../../back/services/runtimeArtifacts');
    const {
      bindRuntimeArtifacts,
    } = require('../../back/services/runtimeArtifactScope');
    const artifacts = await VerifiedRuntimeArtifactStore.open(
      artifactOptions,
      f.dataRoot,
    );
    context = {
      sequelize: db,
      models,
      store: f.store,
      barrier: f.barrier,
      artifacts,
    };
    unbind = bindRuntimeArtifacts(f.store, artifacts);
  }
  const node = context
    ? new Proxy(operations.node, {
        get(target, key) {
          const member = Reflect.get(target, key, target);
          return typeof member === 'function'
            ? (...args) => scoped(() => member.apply(target, args))
            : member;
        },
      })
    : operations.node;
  const publicOperations = context
    ? new Proxy(operations, {
        get(target, key) {
          if (key === 'node') return node;
          const member = Reflect.get(target, key, target);
          return typeof member === 'function'
            ? (...args) => scoped(() => member.apply(target, args))
            : member;
        },
      })
    : operations;
  const publicPython = context
    ? new Proxy(python, {
        get(target, key) {
          const member = Reflect.get(target, key, target);
          return typeof member === 'function'
            ? (...args) => scoped(() => member.apply(target, args))
            : member;
        },
      })
    : python;
  let closed = false;
  return {
    db,
    operations: publicOperations,
    python: publicPython,
    node,
    models,
    module,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await scoped(() => operations.close());
      } finally {
        unbind?.();
        await db.close();
      }
    },
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
    await run('NODE_RUNTIME_INSTALL', {
      node: { version: MANAGED_NODE_VERSION },
    });
    const runtime = (await domain.node.runtimes()).find(
      (row) => row.language === 'NODE' && row.state === 'READY',
    );
    if (!runtime) throw Error('S2_REAL_MANAGED_NODE_REQUIRED');
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
        { name: 'tsx', specifier: MANAGED_TSX_VERSION, type: 'DEPENDENCY' },
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

async function createManagedRuntimeFixture(t, options = {}) {
  if (process.env.ZHIXU_S2_MANAGED_RECEIPT)
    return openPreparedManagedRuntimeFixture(
      t,
      process.env.ZHIXU_S2_MANAGED_RECEIPT,
    );
  const f = await createFixture(t);
  return { ...f, managed: await provisionManagedRuntime(f, options) };
}

async function writePreparedReceipt(f, managed, destination) {
  const {
    ManagedRuntimeAdapter,
  } = require('../../back/services/taskExecutionV2/runtime');
  const adapter = new ManagedRuntimeAdapter(f.store);
  const python = managed.pythonEnvironment
    ? await adapter.inspect('PYTHON', managed.pythonEnvironment.id, 'PYTHON')
    : null;
  const node = managed.nodeEnvironment
    ? await adapter.inspect('NODE', managed.nodeEnvironment.id, 'TYPESCRIPT')
    : null;
  const stat = await fs.lstat(f.root),
    token = randomUUID();
  const receipt = {
    version: 1,
    token,
    root: f.root,
    dataRoot: f.dataRoot,
    databasePath: f.databasePath,
    root_device: stat.dev,
    root_inode: stat.ino,
    python,
    node,
    pythonEnvironment: managed.pythonEnvironment?.id || null,
    nodeEnvironment: managed.nodeEnvironment?.id || null,
    operationHistory: managed.operationHistory,
    status: 'PASS',
  };
  await fs.writeFile(
    path.join(f.root, '.s2-managed-fixture.json'),
    JSON.stringify({ token, dev: stat.dev, ino: stat.ino }),
    { flag: 'wx', mode: 0o600 },
  );
  await fs.writeFile(destination, JSON.stringify(receipt, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  return receipt;
}

async function readPreparedReceipt(filename) {
  const stat = await fs.lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error('S2_MANAGED_FIXTURE_RECEIPT_INVALID');
  const receipt = JSON.parse(await fs.readFile(filename, 'utf8'));
  const root = receipt.root;
  if (
    receipt.version !== 1 ||
    receipt.status !== 'PASS' ||
    typeof root !== 'string' ||
    !/^zhixu-s1a-[A-Za-z0-9]+$/.test(path.basename(root)) ||
    (await fs.realpath(root)) !== root ||
    receipt.dataRoot !== path.join(root, 'data') ||
    receipt.databasePath !== path.join(root, 'data/db/database.sqlite')
  )
    throw Error('S2_MANAGED_FIXTURE_RECEIPT_INVALID');
  const owner = await fs.lstat(root);
  if (
    !owner.isDirectory() ||
    owner.isSymbolicLink() ||
    owner.mode & 0o077 ||
    (process.getuid && owner.uid !== process.getuid()) ||
    owner.dev !== receipt.root_device ||
    owner.ino !== receipt.root_inode
  )
    throw Error('S2_MANAGED_FIXTURE_RECEIPT_INVALID');
  const marker = path.join(root, '.s2-managed-fixture.json'),
    markerStat = await fs.lstat(marker);
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.nlink !== 1 ||
    markerStat.mode & 0o077
  )
    throw Error('S2_MANAGED_FIXTURE_RECEIPT_INVALID');
  const proof = JSON.parse(await fs.readFile(marker, 'utf8'));
  if (
    proof.token !== receipt.token ||
    proof.dev !== owner.dev ||
    proof.ino !== owner.ino
  )
    throw Error('S2_MANAGED_FIXTURE_RECEIPT_INVALID');
  return receipt;
}

async function openPreparedManagedRuntimeFixture(t, filename) {
  const receipt = await readPreparedReceipt(filename);
  const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
  const {
    WorkspaceRootResolver,
  } = require('../../back/services/workspaceV2/roots');
  const {
    WorkspaceLeaseService,
  } = require('../../back/services/workspaceV2/lease');
  const {
    PlatformBackupBarrier,
  } = require('../../back/services/backup/barrier');
  const store = await WorkspaceStore.open(
    receipt.databasePath,
    receipt.dataRoot,
  );
  const resources = [];
  const f = {
    root: receipt.root,
    dataRoot: receipt.dataRoot,
    backupRoot: path.join(receipt.root, 'backups'),
    databasePath: receipt.databasePath,
    dbPath: receipt.databasePath,
    projectRoot,
    store,
    roots: new WorkspaceRootResolver(receipt.dataRoot),
    barrier: new PlatformBackupBarrier(receipt.dataRoot + '.platform-control'),
    prepared: true,
    receipt,
    track(resource) {
      resources.push(resource);
      return resource;
    },
  };
  f.leases = new WorkspaceLeaseService(f.dataRoot, f.barrier);
  const domain = f.track(await attachRuntimeDomain(f));
  f.managed = {
    ...domain,
    pythonEnvironment: receipt.pythonEnvironment
      ? await domain.python.environment(receipt.pythonEnvironment)
      : null,
    nodeEnvironment: receipt.nodeEnvironment
      ? await domain.node.environment(receipt.nodeEnvironment)
      : null,
    operationHistory: receipt.operationHistory,
  };
  t.after(async () => {
    for (const resource of resources.reverse()) await resource.close();
    await store.close();
  });
  return f;
}

async function cleanupPreparedManagedRuntimeFixture(filename) {
  const receipt = await readPreparedReceipt(filename);
  await fs.rm(receipt.root, { recursive: true, force: false });
  await fs.unlink(filename);
}
module.exports = {
  attachRuntimeDomain,
  provisionManagedRuntime,
  createManagedRuntimeFixture,
  writePreparedReceipt,
  readPreparedReceipt,
  openPreparedManagedRuntimeFixture,
  cleanupPreparedManagedRuntimeFixture,
};
