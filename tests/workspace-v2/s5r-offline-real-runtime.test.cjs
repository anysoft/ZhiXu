// Real fresh App/SQLite/Provider installation. No synthetic READY rows, Runtime
// substitution or Provider mocks. SOURCE_DEV is explicit; compiled runs require
// the existing release-root/candidate manifest verifier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const diagnostics = require('node:diagnostics_channel');
const { randomUUID, createHash } = require('node:crypto');
const { runtimeArtifactOptions } = require('./s5r-offline-options.cjs');
const sourceRoot = path.resolve(__dirname, '../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;

async function createOfflineRealRuntimeFixture(t) {
  const manager = process.env.ZHIXU_S5R_REAL_NODE_MANAGER || 'NPM';
  assert.ok(['NPM', 'PNPM'].includes(manager));
  const onlineCold = process.env.ZHIXU_S5R_ONLINE_COLD_NODE === '1';
  const compiled = !!process.env.ZHIXU_S5_RELEASE_ROOT;
  if (!compiled && process.env.ZHIXU_S5R_EXECUTION_KIND !== 'SOURCE_DEV')
    throw Error('S5R_EXPLICIT_SOURCE_DEV_OR_COMPILED_RELEASE_REQUIRED');
  const release = compiled ? require('./s5/artifact-support.cjs') : undefined;
  const projectRoot = compiled ? release.releaseRoot() : sourceRoot;
  const load = (relative) =>
    compiled
      ? release.artifactModule(relative)
      : require(path.join(sourceRoot, 'back', relative));
  const { V2Application } = load('applicationV2/application');
  const { VerifiedRuntimeArtifactStore } = load('services/runtimeArtifacts');
  const { ManagedRuntimeAdapter } = load('services/taskExecutionV2/runtime');
  const NodePaths = load('services/nodePaths').default;
  const { runtimeTreeDigest } = load('services/runtimeTreeWitness');
  const inputs = runtimeArtifactOptions();
  assert.ok(
    inputs &&
      inputs.mode === (onlineCold ? 'ONLINE_VERIFIED' : 'OFFLINE_VERIFIED'),
  );
  if (manager === 'PNPM')
    assert.equal(
      onlineCold,
      true,
      'approved PNPM remains an ONLINE capability',
    );
  const evidence = process.env.ZHIXU_S5R_EVIDENCE_ROOT;
  assert.ok(evidence && path.isAbsolute(evidence));
  assert.equal(await fs.realpath(evidence), evidence);
  const parent = await fs.lstat(evidence);
  assert.ok(
    parent.isDirectory() && !parent.isSymbolicLink() && !(parent.mode & 0o077),
  );
  assert.equal(parent.uid, process.getuid());
  const root = await fs.mkdtemp(path.join(evidence, 'real-node-cold-'));
  const st = await fs.lstat(root),
    nonce = randomUUID();
  const record = {
    schema: 1,
    purpose: 'S5R_REAL_APPROVED_NODE_PROVIDER',
    nonce,
    root,
    dev: st.dev,
    ino: st.ino,
    uid: process.getuid(),
    node: process.version,
    architecture: process.arch,
    kernel: os.release(),
    execution_kind: compiled ? 'COMPILED_ARTIFACT' : 'SOURCE_DEV',
    candidate: compiled ? release.candidateIdentity() : null,
    source_application: !compiled,
    provider_mocked: false,
    database_mocked: false,
    manager,
    online_cold_node: onlineCold,
    resources: { roots: [root], containers: [], volumes: [] },
    stages: [],
    operations: [],
    tasks: [],
    http: [],
  };
  const save = async () => {
    const h = await fs.open(
      path.join(root, '.s5r-real-runtime-owner.json'),
      'w',
      0o600,
    );
    try {
      await h.writeFile(JSON.stringify(record, null, 2) + '\n');
      await h.sync();
    } finally {
      await h.close();
    }
  };
  const stage = async (name) => {
    record.stages.push({ name, utc: new Date().toISOString() });
    await save();
  };
  await save();
  let app, token, csrf;
  const trace = diagnostics.channel('child_process');
  const commands = [];
  const observe = ({ process: child }) => {
    child.once('spawn', () => {
      const argv = child.spawnargs || [];
      if (
        !argv.includes('/usr/bin/curl') &&
        !argv.some((arg) => /\/pnpm\.cjs$/.test(arg))
      )
        return;
      const command = {
        pid: child.pid,
        executable: child.spawnfile,
        argv,
        exit_code: null,
        signal: null,
      };
      commands.push(command);
      child.once('close', (code, signal) => {
        command.exit_code = code;
        command.signal = signal;
      });
    });
  };
  trace.subscribe(observe);
  t.after(async () => {
    if (app) await app.close();
    record.app_closed = !!app;
    record.retained_for_review = true;
    trace.unsubscribe(observe);
    record.actual_supervised_commands = commands;
    if (record.status !== 'PASS') record.status = 'FAIL_OR_INTERRUPTED';
    await save();
  });
  const dataRoot = path.join(root, 'data');
  const options = { ...inputs, storeRoot: path.join(root, 'artifact-store') };
  const packageRoot = process.env.ZHIXU_S5R_RUNTIME_PACKAGE;
  assert.ok(
    packageRoot && path.isAbsolute(packageRoot),
    'trusted package must be supplied separately from its independent allowlist',
  );
  assert.equal(await fs.realpath(packageRoot), packageRoot);
  const network = {
    status: 'NOT_OS_ISOLATED',
    mode: inputs.mode,
    network_namespace: null,
  };
  if (process.env.ZHIXU_S5R_REQUIRE_NETWORK_NAMESPACE === '1') {
    assert.equal(process.platform, 'linux');
    network.network_namespace = await fs.readlink('/proc/self/ns/net');
    const external = Object.values(os.networkInterfaces())
      .flat()
      .filter((address) => address && !address.internal);
    assert.deepEqual(
      external,
      [],
      'fresh private network namespace must have no external interface',
    );
    const routes = (await fs.readFile('/proc/net/route', 'utf8'))
      .trim()
      .split('\n')
      .slice(1)
      .filter(Boolean);
    assert.deepEqual(routes, [], 'private namespace must have no IPv4 route');
    const error = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '203.0.113.1', port: 443 });
      socket.once('connect', () => {
        socket.destroy();
        resolve({ code: 'UNEXPECTED_EXTERNAL_CONNECTION' });
      });
      socket.once('error', (error) => {
        socket.destroy();
        resolve({ code: error.code });
      });
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve({ code: 'TIMEOUT_NOT_NETWORK_PROOF' });
      });
    });
    assert.ok(
      ['ENETUNREACH', 'EHOSTUNREACH'].includes(error.code),
      JSON.stringify(error),
    );
    Object.assign(network, {
      status: 'PASS_KERNEL_NO_EGRESS',
      external_probe_error: error.code,
      interfaces: Object.keys(os.networkInterfaces()),
      ipv4_routes: routes,
    });
  }
  record.network = network;
  await stage('EMPTY_DATA_AND_RUNTIME_CONFIRMED');
  await assert.rejects(fs.lstat(dataRoot), { code: 'ENOENT' });
  const acquired = await VerifiedRuntimeArtifactStore.open(options, dataRoot);
  record.input_manifest_sha256 = acquired.manifestSha256;
  record.trust_anchor_sha256 = acquired.trustAnchorSha256;
  if (onlineCold) {
    assert.deepEqual(
      await fs.readdir(path.join(options.storeRoot, 'objects')),
      [],
    );
    await stage('ONLINE_STORE_CONFIRMED_EMPTY_NO_PACKAGE_IMPORT');
  } else {
    const imported = await acquired.importPackage(packageRoot);
    assert.equal(imported.status, 'VERIFIED_COMPLETE');
    record.import_receipt = imported;
    await stage('APPROVED_PACKAGE_IMPORTED_INTO_NEW_OWNED_STORE');
  }
  app = await V2Application.launch({
    dataRoot,
    backupRoot: path.join(root, 'backups'),
    projectRoot,
    artifactRoot: path.join(
      projectRoot,
      compiled
        ? 'static/build/applicationV2/contracts'
        : 'docs/architecture/v2/contracts',
    ),
    frontendRoot: path.join(projectRoot, 'static/dist-v2'),
    initialize: true,
    background: true,
    host: '127.0.0.1',
    port: 0,
    runtimeArtifacts: options,
  });
  assert.equal(app.ready, true);
  assert.deepEqual(
    await app.services.store.all('SELECT id FROM RuntimeInstallations'),
    [],
  );
  assert.deepEqual(
    await app.services.store.all('SELECT id FROM NodeEnvironmentBuilds'),
    [],
  );
  assert.deepEqual(
    await fs
      .readdir(path.join(dataRoot, 'runtime/node/versions'))
      .catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return [];
      }),
    [],
  );
  await stage('ACTUAL_APP_FRESH_SQLITE_STARTED_NO_MANAGED_RUNTIME');
  async function request(method, url, body, key) {
    const response = await fetch(app.origin + '/api' + url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { Origin: app.origin }),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    record.http.push({
      method,
      path: '/api' + url,
      status: response.status,
      error_code: payload.error_code,
    });
    assert.ok(
      [200, 202].includes(response.status),
      method + ':' + url + ':' + response.status + ':' + payload.error_code,
    );
    assert.equal(payload.code, response.status);
    return payload.data;
  }
  const system = await request('GET', '/system');
  csrf = system.csrf_token;
  const password = 'S5R!' + randomUUID();
  await request('POST', '/user/init', { username: 'owner', password });
  const session = await request('POST', '/user/login', {
    username: 'owner',
    password,
  });
  token = session.token;
  csrf = session.csrf_token;
  async function operation(url, body) {
    const pending = await request('POST', url, {
      timeout_seconds: 180,
      ...body,
    });
    await stage('OPERATION_' + pending.id + '_ACCEPTED');
    const final = await app.runtime.operations.wait(pending.id);
    record.operations.push({
      id: final.id,
      operation_type: final.operation_type,
      status: final.status,
      error_code: final.error_code,
    });
    await save();
    assert.equal(
      final.status,
      'SUCCESS',
      final.operation_type + ':' + final.error_code,
    );
    return final;
  }
  await operation('/runtime/node/catalog');
  await operation('/runtime/node/installations', { version: '24.22.3' });
  const runtime = (await request('GET', '/runtime/node/installations')).find(
    (row) => row.state === 'READY',
  );
  assert.ok(runtime);
  assert.equal(runtime.version, '24.22.3');
  if (onlineCold) {
    const approved = acquired.nodeDistribution(runtime.version);
    for (const id of [approved.archive, approved.npm]) {
      const url = acquired.artifact(id).source_url;
      assert.ok(
        commands.some(
          (command) =>
            command.argv.includes('/usr/bin/curl') &&
            command.argv.includes(url) &&
            command.exit_code === 0,
        ),
        'actual successful supervised official HTTPS download required: ' + id,
      );
    }
    await stage('ACTUAL_OFFICIAL_NODE_AND_SAFE_NPM_HTTPS_FROM_EMPTY_STORE');
    const imported = await acquired.importPackage(packageRoot);
    assert.equal(imported.status, 'VERIFIED_COMPLETE');
    record.import_receipt = imported;
    await stage(
      'CONTROLLED_CLOSURE_INPUTS_IMPORTED_AFTER_REAL_COLD_HTTPS_NODE_INSTALL',
    );
  }
  await operation('/runtime/node/toolchains', {
    runtime_id: runtime.id,
    manager_type: manager,
    ...(manager === 'PNPM' ? { version: '10.34.9' } : {}),
  });
  const tool = (await request('GET', '/runtime/node/toolchains')).find(
    (row) =>
      row.state === 'READY' &&
      row.runtime_id === runtime.id &&
      row.manager_type === manager,
  );
  assert.ok(tool);
  assert.equal(tool.version, manager === 'NPM' ? '11.21.2' : '10.34.9');
  const environment = await request('POST', '/runtime/node/environments', {
    name: 'S5R real offline cold TSX',
    description: '',
    runtime_id: runtime.id,
    toolchain_id: tool.id,
    production_only: false,
    install_scripts_policy: 'ALLOW',
    dependencies: [
      { name: 'is-number', specifier: '7.0.0', type: 'DEPENDENCY' },
      { name: 'tsx', specifier: '4.23.15', type: 'DEPENDENCY' },
    ],
  });
  await operation('/runtime/node/environments/' + environment.id + '/build', {
    expected_version: environment.version,
  });
  const adapter = new ManagedRuntimeAdapter(app.services.store);
  const selected = await adapter.inspect('NODE', environment.id, 'TYPESCRIPT');
  const paths = new NodePaths(dataRoot);
  const runtimeRow = (
    await app.services.store.all(
      'SELECT * FROM RuntimeInstallations WHERE id=?',
      [runtime.id],
    )
  )[0];
  const runtimeMetadata = object(runtimeRow.metadata);
  const buildRow = (
    await app.services.store.all(
      'SELECT * FROM NodeEnvironmentBuilds WHERE id=?',
      [selected.buildId],
    )
  )[0];
  const buildMetadata = object(buildRow.metadata);
  const runtimeMarker = await paths.readJson(
    await paths.marker('runtime', runtime.id),
  );
  const buildMarker = await paths.readJson(
    await paths.marker('build', selected.buildId),
  );
  assert.deepEqual(
    runtimeMarker.verified_inputs,
    runtimeMetadata.verified_inputs,
  );
  assert.deepEqual(
    buildMarker.verified_inputs,
    buildMetadata.verified_artifacts,
  );
  assert.equal(
    runtimeMetadata.verified_inputs.manifest_sha256,
    acquired.manifestSha256,
  );
  assert.equal(
    runtimeMetadata.verified_inputs.trust_anchor_sha256,
    acquired.trustAnchorSha256,
  );
  assert.equal(
    runtimeMetadata.verified_npm.trust_method,
    'INDEPENDENT_PREAPPROVED_MANIFEST_SHA256',
  );
  assert.equal(
    buildMetadata.verified_artifacts.esbuild_build_provenance.go_version,
    'go1.26.11',
  );
  const nodeRoot = path.dirname(path.dirname(selected.executable));
  const npmRoot = path.join(nodeRoot, 'lib/node_modules/npm');
  const npm = JSON.parse(
    await fs.readFile(path.join(npmRoot, 'package.json'), 'utf8'),
  );
  assert.equal(npm.name, 'npm');
  assert.equal(npm.version, '11.21.2');
  assert.equal(
    (await runtimeTreeDigest(npmRoot)).sha256,
    runtimeMetadata.verified_inputs.npm_tree_sha256,
  );
  const tsxRoot = await acquired.packageRoot(selected.buildRoot, 'tsx');
  const esbuildRoot = await acquired.packageRoot(
    selected.buildRoot,
    'esbuild',
    tsxRoot,
  );
  const binaryRoot = await acquired.packageRoot(
    selected.buildRoot,
    buildMetadata.verified_artifacts.esbuild_package,
    esbuildRoot,
  );
  for (const location of [
    path.join(binaryRoot, 'bin/esbuild'),
    path.join(esbuildRoot, 'bin/esbuild'),
  ])
    assert.equal(
      sha(await fs.readFile(location)),
      buildMetadata.verified_artifacts.esbuild_sha256,
    );
  record.runtime = {
    runtime_id: runtime.id,
    toolchain_id: tool.id,
    environment_id: environment.id,
    build_id: selected.buildId,
    runtime_version: selected.runtimeVersion,
    toolchain_version: selected.toolchainVersion,
    tsx_version: selected.tsxVersion,
    executable_sha256: sha(await fs.readFile(selected.executable)),
    runtime_inputs: runtimeMetadata.verified_inputs,
    build_inputs: buildMetadata.verified_artifacts,
    node_executable: selected.executable,
  };
  await stage(
    'REAL_READY_WITH_DATABASE_FILESYSTEM_AND_APPROVED_POLICY_WITNESS',
  );
  const workspace = await request(
    'POST',
    '/workspaces',
    { type: 'LOCAL', name: 'offline real Node tasks' },
    'offline-real-' + nonce,
  );
  const workspaceId = workspace.workspace.id;
  for (const [language, extension] of [
    ['JAVASCRIPT', 'js'],
    ['TYPESCRIPT', 'ts'],
  ]) {
    const marker = 'S5R_REAL_' + language + '_' + randomUUID();
    const content =
      language === 'JAVASCRIPT'
        ? 'const isNumber=require("is-number");if(!isNumber(42))throw Error("DEPENDENCY");console.log(JSON.stringify({marker:' +
          JSON.stringify(marker) +
          ',version:process.version,executable:process.execPath}));\n'
        : 'import isNumber from "is-number"; const answer:number=42;if(!isNumber(answer))throw Error("DEPENDENCY");console.log(JSON.stringify({marker:' +
          JSON.stringify(marker) +
          ',version:process.version,executable:process.execPath}));\n';
    await request('POST', '/workspaces/' + workspaceId + '/files', {
      path: 'main.' + extension,
      content,
      must_not_exist: true,
    });
    const task = await request('POST', '/tasks', {
      name: language,
      description: '',
      enabled: true,
      arguments: [],
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: workspaceId,
        relative_entrypoint: 'main.' + extension,
        language,
        cwd_mode: 'ENTRYPOINT_DIR',
        cwd_relative_path: null,
      },
      runtime: {
        kind: 'NODE',
        node_environment_id: environment.id,
        python_environment_id: null,
      },
      execution: {
        timeout_seconds: 30,
        max_attempts: 1,
        initial_delay_seconds: 0,
        backoff: 'FIXED',
        concurrency: 'QUEUE',
        notification: 'NONE',
      },
      env_profile_id: null,
    });
    const pending = await request(
      'POST',
      '/tasks/' + task.id + '/run',
      { wait_mode: 'WAIT' },
      marker,
    );
    const final = await app.services.execution.wait(pending.id, 60000);
    assert.equal(final.status, 'SUCCESS', final.error_code);
    const attempts = await app.services.execution.attempts(final.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].exit_code, 0);
    const logs = await app.services.execution.logs(final.id);
    assert.ok(logs.includes(marker));
    assert.ok(logs.includes('v24.22.3'));
    assert.ok(logs.includes(selected.executable));
    record.tasks.push({
      task_id: task.id,
      run_id: final.id,
      language,
      status: final.status,
      attempt_count: attempts.length,
      exit_code: attempts[0].exit_code,
      log_sha256: sha(logs),
      marker,
    });
    await stage('ACTUAL_' + language + '_TASK_SUCCESS');
  }
  assert.deepEqual(
    await app.services.store.all('PRAGMA foreign_key_check'),
    [],
  );
  await app.services.store.verifySchema();
  // Existing READY state remains unchanged. Removing only its authentication
  // witness must not trigger silent repair, reinterpretation or host fallback.
  const oldMetadata = { ...runtimeMetadata };
  delete oldMetadata.verified_inputs;
  await app.services.store.run(
    'UPDATE RuntimeInstallations SET metadata=? WHERE id=?',
    [JSON.stringify(oldMetadata), runtime.id],
  );
  const beforeMarker = await fs.readFile(
    await paths.marker('runtime', runtime.id),
  );
  await assert.rejects(adapter.inspect('NODE', environment.id, 'TYPESCRIPT'), {
    error_code: 'RUNTIME_NOT_READY',
  });
  assert.deepEqual(
    await fs.readFile(await paths.marker('runtime', runtime.id)),
    beforeMarker,
  );
  const unchanged = (
    await app.services.store.all(
      'SELECT * FROM RuntimeInstallations WHERE id=?',
      [runtime.id],
    )
  )[0];
  assert.equal(unchanged.state, 'READY');
  assert.deepEqual(object(unchanged.metadata), oldMetadata);
  await app.services.store.run(
    'UPDATE RuntimeInstallations SET metadata=? WHERE id=?',
    [JSON.stringify(runtimeMetadata), runtime.id],
  );
  await adapter.inspect('NODE', environment.id, 'TYPESCRIPT');
  record.legacy_ready_without_witness = {
    status: 'REJECTED_READ_ONLY',
    state_preserved: true,
    sidecar_unchanged: true,
  };
  await stage(
    'LEGACY_READY_WITHOUT_WITNESS_REFUSED_AND_REAL_ORIGINAL_REVALIDATED',
  );
  record.tamper_checks = [];
  for (const [kind, file] of [
    ['NPM_TRANSITIVE_TREE', path.join(npmRoot, 'node_modules/semver/index.js')],
    ['ESBUILD_EXECUTABLE', path.join(esbuildRoot, 'bin/esbuild')],
  ]) {
    const original = await fs.readFile(file),
      cli = await fs.readFile(path.join(npmRoot, 'bin/npm-cli.js'));
    const markerBefore = await fs.readFile(
      await paths.marker('runtime', runtime.id),
    );
    const buildMarkerBefore = await fs.readFile(
      await paths.marker('build', selected.buildId),
    );
    const rowsBefore = await app.services.store.all(
      'SELECT state,metadata FROM RuntimeInstallations WHERE id=?',
      [runtime.id],
    );
    const altered = Buffer.concat([
      original,
      Buffer.from('\nS5R_OWNED_TAMPER_NOT_EXECUTED\n'),
    ]);
    await fs.writeFile(file, altered);
    try {
      await assert.rejects(
        adapter.inspect('NODE', environment.id, 'TYPESCRIPT'),
        { error_code: 'RUNTIME_NOT_READY' },
      );
      assert.deepEqual(
        await fs.readFile(file),
        altered,
        'readiness never repairs changed installed bytes',
      );
      assert.deepEqual(
        await fs.readFile(path.join(npmRoot, 'bin/npm-cli.js')),
        cli,
      );
      assert.deepEqual(
        await fs.readFile(await paths.marker('runtime', runtime.id)),
        markerBefore,
      );
      assert.deepEqual(
        await fs.readFile(await paths.marker('build', selected.buildId)),
        buildMarkerBefore,
      );
      assert.deepEqual(
        await app.services.store.all(
          'SELECT state,metadata FROM RuntimeInstallations WHERE id=?',
          [runtime.id],
        ),
        rowsBefore,
      );
      record.tamper_checks.push({
        kind,
        status: 'RUNTIME_NOT_READY_READ_ONLY',
        original_sha256: sha(original),
        altered_sha256: sha(altered),
        npm_cli_unchanged: true,
        database_unchanged: true,
        markers_unchanged: true,
      });
    } finally {
      await fs.writeFile(file, original);
    }
    await adapter.inspect('NODE', environment.id, 'TYPESCRIPT');
    await stage('ACTUAL_' + kind + '_TAMPER_REFUSED_AND_ORIGINAL_REVALIDATED');
  }
  record.status = 'PASS';
  await save();
  return { record, root };
}

test(
  'S5R real ' +
    (process.env.ZHIXU_S5R_REAL_NODE_MANAGER || 'NPM') +
    ' cold App installs approved Node/manager/TSX and executes actual JS/TS Tasks',
  { timeout: 600000 },
  async (t) => {
    await createOfflineRealRuntimeFixture(t);
  },
);
