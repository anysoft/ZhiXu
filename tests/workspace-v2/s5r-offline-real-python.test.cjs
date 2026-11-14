// Real source builds from independently approved inputs. No Runtime, Provider,
// SQLite, executable or Task mock is used. SOURCE_DEV is never release evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { runtimeArtifactOptions } = require('./s5r-offline-options.cjs');

async function realPythonRuntime(t) {
  const compiled = !!process.env.ZHIXU_S5_RELEASE_ROOT;
  if (!compiled && process.env.ZHIXU_S5R_EXECUTION_KIND !== 'SOURCE_DEV')
    throw Error('EXPLICIT_SOURCE_DEV_OR_COMPILED_RELEASE_REQUIRED');
  const release = compiled ? require('./s5/artifact-support.cjs') : undefined;
  const projectRoot = compiled
    ? release.releaseRoot()
    : path.resolve(__dirname, '../..');
  const load = (relative) =>
    compiled
      ? release.artifactModule(relative)
      : require(path.join(projectRoot, 'back', relative));
  const { V2Application } = load('applicationV2/application');
  const { VerifiedRuntimeArtifactStore } = load('services/runtimeArtifacts');
  const { ManagedRuntimeAdapter } = load('services/taskExecutionV2/runtime');
  const RuntimePaths = load('services/runtimePaths').default;
  const options = runtimeArtifactOptions();
  assert.equal(options?.mode, 'OFFLINE_VERIFIED');
  const evidence = process.env.ZHIXU_S5R_EVIDENCE_ROOT;
  assert.ok(evidence && path.isAbsolute(evidence));
  assert.equal(await fs.realpath(evidence), evidence);
  const parent = await fs.lstat(evidence);
  assert.ok(
    parent.isDirectory() && !parent.isSymbolicLink() && !(parent.mode & 0o077),
  );
  assert.equal(parent.uid, process.getuid());
  const root = await fs.mkdtemp(path.join(evidence, 'real-python-cold-'));
  const st = await fs.lstat(root),
    nonce = randomUUID(),
    dataRoot = path.join(root, 'data');
  const record = {
    schema: 1,
    purpose: 'S5R_REAL_OFFLINE_PYTHON_SOURCE_BUILD',
    nonce,
    root,
    dev: st.dev,
    ino: st.ino,
    uid: process.getuid(),
    node: process.version,
    os: process.platform,
    architecture: process.arch,
    execution_kind: compiled ? 'COMPILED_ARTIFACT' : 'SOURCE_DEV',
    candidate: compiled ? release.candidateIdentity() : null,
    provider_mocked: false,
    database_mocked: false,
    operations: [],
    stages: [],
    resources: { roots: [root], containers: [], volumes: [] },
  };
  const save = () =>
    fs.writeFile(
      path.join(root, '.s5r-python-owner.json'),
      JSON.stringify(record, null, 2) + '\n',
      { mode: 0o600 },
    );
  await save();
  let app;
  t.after(async () => {
    if (app) await app.close();
    record.closed = !!app;
    record.status ??= 'FAIL_OR_INTERRUPTED';
    await save();
  });
  await assert.rejects(fs.lstat(dataRoot), { code: 'ENOENT' });
  record.network = { status: 'NOT_OS_ISOLATED', mode: 'OFFLINE_VERIFIED' };
  if (process.env.ZHIXU_S5R_REQUIRE_NETWORK_NAMESPACE === '1') {
    assert.equal(process.platform, 'linux');
    assert.deepEqual(
      Object.values(os.networkInterfaces())
        .flat()
        .filter((row) => row && !row.internal),
      [],
    );
    assert.deepEqual(
      (await fs.readFile('/proc/net/route', 'utf8'))
        .trim()
        .split('\n')
        .slice(1)
        .filter(Boolean),
      [],
    );
    const error = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '203.0.113.1', port: 443 });
      socket.once('connect', () => {
        socket.destroy();
        resolve('UNEXPECTED_EXTERNAL_CONNECTION');
      });
      socket.once('error', (error) => {
        socket.destroy();
        resolve(error.code);
      });
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve('TIMEOUT_NOT_NETWORK_PROOF');
      });
    });
    assert.ok(['ENETUNREACH', 'EHOSTUNREACH'].includes(error));
    record.network = {
      status: 'PASS_KERNEL_NO_EGRESS',
      mode: 'OFFLINE_VERIFIED',
      namespace: await fs.readlink('/proc/self/ns/net'),
      external_probe_error: error,
    };
  }
  const policy = { ...options, storeRoot: path.join(root, 'artifact-store') };
  const artifacts = await VerifiedRuntimeArtifactStore.open(policy, dataRoot);
  assert.equal(
    (await artifacts.importPackage(process.env.ZHIXU_S5R_RUNTIME_PACKAGE))
      .status,
    'VERIFIED_COMPLETE',
  );
  record.manifest_sha256 = artifacts.manifestSha256;
  record.trust_anchor_sha256 = artifacts.trustAnchorSha256;
  await save();
  const launchOptions = {
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
    runtimeArtifacts: policy,
  };
  app = await V2Application.launch(launchOptions);
  assert.deepEqual(
    await app.services.store.all('SELECT id FROM RuntimeInstallations'),
    [],
  );
  const pythonOperation = async (type, input = {}) => {
    const pending = await app.runtime.operations.request(type, {
      jobs: 2,
      timeout_seconds: 1800,
      ...input,
    });
    record.stages.push({
      operation_id: pending.id,
      type,
      utc: new Date().toISOString(),
    });
    await save();
    const final = await app.runtime.operations.wait(pending.id);
    record.operations.push({
      id: final.id,
      type,
      status: final.status,
      error_code: final.error_code,
    });
    await save();
    assert.equal(final.status, 'SUCCESS', type + ':' + final.error_code);
    return final;
  };
  await pythonOperation('PROVIDER_INSTALL');
  await pythonOperation('RUNTIME_INSTALL', { version: '3.13.15' });
  const runtime = (await app.runtime.operations.runtimes()).find(
    (r) => r.language === 'PYTHON' && r.state === 'READY',
  );
  assert.ok(runtime);
  const environment = await app.runtime.python.create({
    name: 'S5R approved static crypto Python',
    runtime_id: runtime.id,
    requirements: [],
  });
  await pythonOperation('PYTHON_ENV_BUILD', {
    environment: {
      environment_id: environment.id,
      expected_version: environment.version,
    },
  });
  const selected = await new ManagedRuntimeAdapter(app.services.store).inspect(
    'PYTHON',
    environment.id,
    'PYTHON',
  );
  const paths = new RuntimePaths(dataRoot);
  const row = (
    await app.services.store.all(
      'SELECT * FROM RuntimeInstallations WHERE id=?',
      [runtime.id],
    )
  )[0];
  const metadata =
    typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  const owner = await paths.readJson(await paths.ownership(runtime.id));
  assert.deepEqual(owner.verified_inputs, metadata.verified_inputs);
  assert.match(metadata.openssl_version, /^OpenSSL 3\.5\.9(?:\s|$)/);
  assert.equal(metadata.zlib_version, '1.4');
  assert.equal(metadata.sqlite_version, '3.54.1');
  assert.equal(metadata.pip_version, '26.3');
  assert.equal(metadata.verified_inputs.pip_version, '26.3');
  for (const key of ['ssl', 'hashlib', 'zlib', 'sqlite']) {
    assert.ok(metadata.linked_library_names[key].length > 0);
    assert.equal(
      metadata.linked_library_names[key].some((name) =>
        /^lib(?:ssl|crypto|sqlite3)(?:[.-]|$)|^libz(?:[.-]|$)/i.test(name),
      ),
      false,
    );
  }
  const profile = artifacts.manifest.python.find(
    (p) => p.version === runtime.version,
  );
  assert.equal(
    metadata.verified_inputs.ca_bundle_sha256,
    artifacts.artifact(profile.ca_bundle).sha256,
  );
  assert.equal(
    metadata.sqlite_source_id,
    artifacts.artifact(profile.sqlite).provenance.sqlite_source_id,
  );
  assert.equal(
    metadata.verified_inputs.sqlite_module_sha256,
    metadata.sqlite_module_sha256,
  );
  assert.equal(
    metadata.verified_inputs.pip_wheel_sha256,
    artifacts.artifact(profile.pip_wheel).sha256,
  );
  record.runtime = {
    runtime_id: runtime.id,
    environment_id: environment.id,
    executable: selected.executable,
    runtime_version: runtime.version,
    verified_inputs: metadata.verified_inputs,
    openssl_version: metadata.openssl_version,
    zlib_version: metadata.zlib_version,
    linked_library_names: metadata.linked_library_names,
    python_sqlite_version: metadata.python_sqlite_version ?? null,
  };
  await save();
  let token, csrf;
  const pythonRequest = async (method, url, body, key) => {
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
    assert.ok(
      [200, 202].includes(response.status),
      method + ':' + url + ':' + payload.error_code,
    );
    return payload.data;
  };
  csrf = (await pythonRequest('GET', '/system')).csrf_token;
  const password = 'S5R!' + randomUUID();
  await pythonRequest('POST', '/user/init', { username: 'owner', password });
  const session = await pythonRequest('POST', '/user/login', {
    username: 'owner',
    password,
  });
  token = session.token;
  csrf = session.csrf_token;
  const workspace = await pythonRequest(
    'POST',
    '/workspaces',
    { type: 'LOCAL', name: 'Approved Python task' },
    nonce,
  );
  const marker = 'S5R_PYTHON_' + randomUUID();
  const content =
    'import sys,ssl,zlib,json,sqlite3\nassert ssl.OPENSSL_VERSION.startswith("OpenSSL 3.5.9 ")\nassert zlib.ZLIB_RUNTIME_VERSION=="1.4"\nassert sqlite3.sqlite_version=="3.54.1"\nprint(json.dumps({"marker":' +
    JSON.stringify(marker) +
    ',"executable":sys.executable,"version":sys.version,"openssl":ssl.OPENSSL_VERSION,"zlib":zlib.ZLIB_RUNTIME_VERSION,"sqlite":sqlite3.sqlite_version}))\n';
  await pythonRequest(
    'POST',
    '/workspaces/' + workspace.workspace.id + '/files',
    { path: 'main.py', content, must_not_exist: true },
  );
  const task = await pythonRequest('POST', '/tasks', {
    name: 'Actual approved Python',
    description: '',
    enabled: true,
    arguments: [],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: workspace.workspace.id,
      relative_entrypoint: 'main.py',
      language: 'PYTHON',
      cwd_mode: 'ENTRYPOINT_DIR',
      cwd_relative_path: null,
    },
    runtime: {
      kind: 'PYTHON',
      node_environment_id: null,
      python_environment_id: environment.id,
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
  const pending = await pythonRequest(
    'POST',
    '/tasks/' + task.id + '/run',
    { wait_mode: 'WAIT' },
    marker,
  );
  const run = await app.services.execution.wait(pending.id, 60000);
  assert.equal(run.status, 'SUCCESS', run.error_code);
  const attempts = await app.services.execution.attempts(run.id),
    logs = await app.services.execution.logs(run.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].exit_code, 0);
  assert.ok(logs.includes(marker));
  assert.ok(logs.includes('OpenSSL 3.5.9'));
  assert.ok(logs.includes(selected.executable));
  record.task = {
    task_id: task.id,
    run_id: run.id,
    status: run.status,
    exit_code: attempts[0].exit_code,
    log_sha256: createHash('sha256').update(logs).digest('hex'),
  };
  if (process.env.ZHIXU_S5R_PYTHON_ONLINE_PIP === '1') {
    assert.notEqual(process.env.ZHIXU_S5R_REQUIRE_NETWORK_NAMESPACE, '1');
    await app.close();
    app = await V2Application.launch({
      ...launchOptions,
      initialize: false,
      runtimeArtifacts: { ...policy, mode: 'ONLINE_VERIFIED' },
    });
    token = undefined;
    csrf = (await pythonRequest('GET', '/system')).csrf_token;
    const onlineSession = await pythonRequest('POST', '/user/login', {
      username: 'owner',
      password,
    });
    token = onlineSession.token;
    csrf = onlineSession.csrf_token;
    const online = await app.runtime.python.create({
      name: 'Actual online pip compatibility',
      runtime_id: runtime.id,
      requirements: ['six==1.17.0'],
    });
    await pythonOperation('PYTHON_ENV_BUILD', {
      environment: {
        environment_id: online.id,
        expected_version: online.version,
      },
    });
    const onlineSelected = await new ManagedRuntimeAdapter(
      app.services.store,
    ).inspect('PYTHON', online.id, 'PYTHON');
    const onlineMarker = 'S5R_ONLINE_PIP_' + randomUUID();
    await pythonRequest(
      'POST',
      '/workspaces/' + workspace.workspace.id + '/files',
      {
        path: 'online.py',
        content:
          'import six\nassert six.__version__=="1.17.0"\nprint(' +
          JSON.stringify(onlineMarker) +
          ')\n',
        must_not_exist: true,
      },
    );
    const onlineTask = await pythonRequest('POST', '/tasks', {
      name: 'Actual online pip six',
      description: '',
      enabled: true,
      arguments: [],
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: workspace.workspace.id,
        relative_entrypoint: 'online.py',
        language: 'PYTHON',
        cwd_mode: 'ENTRYPOINT_DIR',
        cwd_relative_path: null,
      },
      runtime: {
        kind: 'PYTHON',
        node_environment_id: null,
        python_environment_id: online.id,
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
    const onlinePending = await pythonRequest(
      'POST',
      '/tasks/' + onlineTask.id + '/run',
      { wait_mode: 'WAIT' },
      onlineMarker,
    );
    const onlineRun = await app.services.execution.wait(
      onlinePending.id,
      60000,
    );
    assert.equal(onlineRun.status, 'SUCCESS', onlineRun.error_code);
    const onlineAttempts = await app.services.execution.attempts(onlineRun.id),
      onlineLogs = await app.services.execution.logs(onlineRun.id);
    assert.equal(onlineAttempts.length, 1);
    assert.equal(onlineAttempts[0].exit_code, 0);
    assert.ok(onlineLogs.includes(onlineMarker));
    record.online_pip = {
      status: 'PASS',
      mode: 'ONLINE_VERIFIED',
      cold_runtime: false,
      reused_previously_verified_runtime: true,
      environment_id: online.id,
      task_id: onlineTask.id,
      run_id: onlineRun.id,
      package: 'six==1.17.0',
      pip_version: '26.3',
      executable: onlineSelected.executable,
      log_sha256: createHash('sha256').update(onlineLogs).digest('hex'),
    };
  }
  assert.deepEqual(
    await app.services.store.all('PRAGMA foreign_key_check'),
    [],
  );
  await app.services.store.verifySchema();
  record.status = 'PASS';
  await save();
}

test(
  'S5R approved offline sources build fresh Python with actual static OpenSSL/zlib and execute a real Managed Task',
  { timeout: 3600000 },
  realPythonRuntime,
);
