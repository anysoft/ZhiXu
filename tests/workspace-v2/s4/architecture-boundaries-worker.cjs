const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const projectRoot = path.resolve(__dirname, '../../..');
const caseRoot = process.argv[2];
const cacheObservations = [];
const retainedRuntimeModules = [
  'back/api/runtime.ts',
  'back/api/pythonEnvironment.ts',
  'back/api/nodeEnvironment.ts',
];
function loadedProjectModules() {
  return Object.keys(require.cache)
    .filter((file) => file.startsWith(projectRoot + path.sep))
    .map((file) => path.relative(projectRoot, file).split(path.sep).join('/'))
    .sort();
}
function checkArchitectureCache(phase) {
  const modules = loadedProjectModules();
  const forbidden = modules.filter(
    (file) =>
      file.startsWith('back/data/') ||
      (file.startsWith('back/api/') && !retainedRuntimeModules.includes(file)) ||
      /^back\/services\/(?:subscription|subscriptionGit|worktree|executionService|executionSubmission|executionResolver|executionAttemptCoordinator|schedule|user)\.[cm]?[jt]s$/.test(file) ||
      /^back\/shared\/(?:store|executionLauncher|executionSocket)\.[cm]?[jt]s$/.test(file) ||
      /^back\/(?:config\/util|loaders\/logger)\.[cm]?[jt]s$/.test(file) ||
      /(?:^|\/)node_modules\/(?:@keyv\/[^/]+|keyv)(?:\/|$)/.test(file),
  );
  cacheObservations.push({ phase, forbidden_matches: forbidden });
  assert.deepEqual(forbidden, [], 'V2_FORBIDDEN_LEGACY_MODULE_LOADED');
  return modules;
}

async function architectureBoundariesQualification() {
  let app;
  try {
    // This worker starts with an ordinary empty application-module cache. No
    // loader interception, cache deletion or replacement module is involved.
    const { V2Application } = require('../../../back/applicationV2/application');
    checkArchitectureCache('AFTER_REAL_APPLICATION_IMPORT');
    app = await V2Application.launch({
      dataRoot: path.join(caseRoot, 'actual-application-data'),
      initialize: true,
      projectRoot,
      port: 0,
    });
    assert.equal(app.ready, true);
    assert.equal(app.localWrites, true);
    assert.ok(app.runtime);
    assert.ok(app.notifications);
    checkArchitectureCache('AFTER_REAL_APPLICATION_BOOT');

    const http = [];
    let token, csrf;
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
      const text = await response.text();
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(text.includes(caseRoot), false, 'PUBLIC_HOST_PATH_EXPOSED');
      const value = JSON.parse(text);
      http.push({ method, path: '/api' + url, status: response.status, error_code: value.error_code ?? null });
      return { status: response.status, data: value.data, error_code: value.error_code };
    }
    const system = await request('GET', '/system');
    assert.equal(system.data.schema_identity, 'zhixu.workspace.v2.s0.1');
    assert.equal(system.data.local_write_admission, true);
    csrf = system.data.csrf_token;
    const password = 'S4Architecture!' + randomUUID();
    assert.equal((await request('POST', '/user/init', { username: 'owner', password })).status, 200);
    const login = await request('POST', '/user/login', { username: 'owner', password });
    assert.equal(login.status, 200);
    token = login.data.token;
    csrf = login.data.csrf_token;

    const workspaceResponse = await request('POST', '/workspaces', { type: 'LOCAL', name: 'Isolated actual architecture proof' }, randomUUID());
    assert.equal(workspaceResponse.status, 202);
    const workspace = workspaceResponse.data.workspace;
    const childMarker = 'actual-isolated-v2-shell-' + randomUUID();
    assert.equal((await request('POST', `/workspaces/${workspace.id}/files`, {
      path: 'main.sh',
      content: `printf '%s\\n' '${childMarker}'\n`,
      must_not_exist: true,
    })).status, 200);
    const taskResponse = await request('POST', '/tasks', {
      name: 'Actual isolated Shell Task', description: '', enabled: true,
      arguments: [], env_profile_id: null,
      source: { type: 'WORKSPACE_ENTRYPOINT', workspace_id: workspace.id, relative_entrypoint: 'main.sh', language: 'SHELL', cwd_mode: 'ENTRYPOINT_DIR', cwd_relative_path: null },
      runtime: { kind: 'SHELL', python_environment_id: null, node_environment_id: null },
      execution: { timeout_seconds: 30, max_attempts: 1, initial_delay_seconds: 0, backoff: 'FIXED', concurrency: 'QUEUE', notification: 'NONE' },
    });
    assert.equal(taskResponse.status, 200);
    const accepted = await request('POST', `/tasks/${taskResponse.data.id}/run`, { wait_mode: 'WAIT' }, randomUUID());
    assert.equal(accepted.status, 202);
    const deadline = Date.now() + 45000;
    let run;
    do {
      run = (await request('GET', `/task-runs/${accepted.data.id}`)).data;
      if (!['QUEUED', 'RESOLVING', 'RUNNING'].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(run.status, 'SUCCESS', 'ACTUAL_SHELL_RUN_NOT_SUCCESSFUL');
    assert.equal(run.attempt_count, 1);
    const attempts = (await request('GET', `/task-runs/${run.id}/attempts`)).data;
    assert.equal(attempts.length, 1);
    const log = (await request('GET', `/task-runs/${run.id}/log`)).data;
    assert.ok(log.text.includes(childMarker), 'ACTUAL_SHELL_CHILD_OUTPUT_MISSING');
    assert.equal(run.source_snapshot.workspace_type, 'LOCAL');
    assert.equal(run.source_snapshot.workspace_id, workspace.id);
    assert.equal(run.source_snapshot.relative_entrypoint, 'main.sh');
    assert.equal(run.source_snapshot.git, null);
    assert.equal((await app.services.store.all('SELECT id FROM Repositories')).length, 0);
    assert.equal((await app.services.store.all('SELECT id FROM TaskRuns')).length, 1);

    const contract = JSON.parse(await fs.readFile(path.join(projectRoot, 'docs/architecture/v2/contracts/api-contracts.json'), 'utf8'));
    const catalog = app.publicRouteCatalog();
    const frozen = catalog.filter((row) => row.scope === 'FROZEN_S0');
    assert.equal(frozen.length, 129);
    const keys = catalog.map((row) => row.method + ' ' + row.path);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(
      frozen.map((row) => row.method + ' ' + row.path).sort(),
      contract.routes.map((row) => row.method + ' /api' + row.path).sort(),
    );
    for (const row of catalog) {
      for (const field of ['controller', 'service', 'request_dto', 'response_dto', 'status'])
        assert.ok(typeof row[field] === 'string' && row[field].length, 'CATALOG_METADATA_MISSING');
      assert.ok(['IMPLEMENTED', 'DEFERRED_BY_CONTRACT', 'UNSUPPORTED_BY_FROZEN_SCHEMA'].includes(row.status), 'CATALOG_STATUS_INVALID');
      if (row.status !== 'IMPLEMENTED') assert.ok(row.reason, 'CATALOG_DEFERRED_REASON_MISSING');
    }
    assert.deepEqual(catalog.filter((row) => row.path === '/api/user/init').map((row) => row.method).sort(), ['POST', 'PUT']);
    const removed = [];
    for (const namespace of contract.removed_namespaces) {
      const url = namespace.replace(/:id/g, String(workspace.id));
      for (const method of ['GET', 'POST']) {
        const response = await request(method, url, method === 'POST' ? {} : undefined);
        assert.equal(response.status, 404, 'REMOVED_NAMESPACE_NOT_HTTP404');
        assert.equal(response.error_code, 'API_ROUTE_NOT_FOUND', 'REMOVED_NAMESPACE_NOT_SAFE_JSON');
        removed.push({ method, namespace, status: response.status, error_code: response.error_code });
      }
      assert.equal(catalog.some((row) => row.path === '/api' + namespace), false);
    }
    const retiredNotificationRoutes = [];
    for (const url of ['/user/notification', '/user/notification/init']) {
      const response = await request('PUT', url, {});
      assert.equal(response.status, 410);
      assert.equal(response.error_code, 'NOTIFICATION_CHANNEL_API_REQUIRED');
      const metadata = catalog.find((row) => row.method === 'PUT' && row.path === '/api' + url);
      assert.ok(metadata);
      assert.equal(metadata.status, 'UNSUPPORTED_BY_FROZEN_SCHEMA');
      assert.equal(metadata.retired, true);
      assert.equal(metadata.http_status, 410);
      assert.ok(metadata.reason);
      retiredNotificationRoutes.push(metadata);
    }
    const legacyRoot = path.join(caseRoot, 'untouched-private-legacy-domain');
    await fs.mkdir(legacyRoot, { mode: 0o700 });
    const legacySource = path.join(legacyRoot, 'unique-legacy-source.txt');
    await fs.writeFile(legacySource, 'preserve private legacy source ' + randomUUID(), { mode: 0o600, flag: 'wx' });
    const legacyBytes = await fs.readFile(legacySource);
    const rejectedDataRoot = path.join(caseRoot, 'rejected-fresh-data');
    await assert.rejects(V2Application.launch({
      dataRoot: rejectedDataRoot,
      backupRoot: legacyRoot,
      legacyDataRoots: [legacyRoot],
      initialize: true,
      projectRoot,
      port: 0,
    }), (error) => {
      assert.equal(error.error_code, 'STARTUP_REJECTED');
      assert.equal(error.reason, 'LEGACY_DATA_DOMAIN_FORBIDDEN');
      return true;
    });
    assert.deepEqual(await fs.readFile(legacySource), legacyBytes);
    assert.deepEqual(await fs.readdir(legacyRoot), ['unique-legacy-source.txt']);
    for (const root of [rejectedDataRoot, rejectedDataRoot + '.platform-control'])
      await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
    const modules = checkArchitectureCache('AFTER_ACTUAL_HTTP_LOCAL_TASK_RUN_AND_RETIREMENT_CHECKS');
    for (const file of ['back/applicationV2/runtimeDomain.ts', 'back/applicationV2/notificationApi.ts', 'back/services/taskExecutionV2/execution.ts'])
      assert.ok(modules.includes(file), 'ACTUAL_DOMAIN_MODULE_NOT_LOADED');
    const result = {
      status: 'PASS', actual_application_boot: true,
      schema_identity: system.data.schema_identity,
      workspace_id: workspace.id, task_id: taskResponse.data.id, task_run_id: run.id,
      task_run_status: run.status, actual_attempt_count: attempts.length,
      source_generation: run.source_snapshot.source_generation,
      source_revision: run.source_snapshot.content_revision,
      source_snapshot_sha256: createHash('sha256').update(JSON.stringify(run.source_snapshot)).digest('hex'),
      actual_child_log_sha256: createHash('sha256').update(log.text).digest('hex'),
      frozen_route_count: frozen.length, route_catalog: catalog,
      removed_namespace_checks: removed,
      retired_notification_routes: retiredNotificationRoutes,
      permitted_retained_runtime_modules: retainedRuntimeModules,
      permitted_retained_runtime_reason: 'Pure retained Runtime DTO/handler factories rebound to the explicit candidate domain; default global route autostart is not invoked.',
      loaded_project_modules: modules.filter((file) => file.startsWith('back/')),
      cache_observations: cacheObservations, http,
      backup_domain_legacy_rejection: {
        expected_error: 'STARTUP_REJECTED',
        expected_reason: 'LEGACY_DATA_DOMAIN_FORBIDDEN',
        legacy_source_sha256: createHash('sha256').update(legacyBytes).digest('hex'),
        source_bytes_and_directory_entries_unchanged: true,
        rejected_data_and_control_not_created: true,
      },
      module_loader_interception: false, module_cache_replacement: false,
      legacy_data_root_inert_file: true,
    };
    await app.close(); app = undefined;
    process.send({ success: true, result });
  } finally {
    await app?.close();
  }
}

architectureBoundariesQualification().catch((error) => {
  process.send({ success: false, error_code: /^[A-Z][A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'ARCHITECTURE_BOUNDARY_ASSERTION_FAILED', assertion: typeof error.message === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : undefined, cache_observations: cacheObservations });
  process.exitCode = 1;
});
