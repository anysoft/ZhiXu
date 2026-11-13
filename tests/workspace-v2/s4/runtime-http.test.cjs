const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createS4Fixture } = require('./fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');
const {
  publicRuntimeValue,
} = require('../../../back/applicationV2/runtimeApi');
const {
  ManagedRuntimeAdapter,
} = require('../../../back/services/taskExecutionV2/runtime');
const resumeCase = process.env.ZHIXU_S4_RUNTIME_HTTP_RESUME_CASE;

test('S4 Runtime public projection omits private paths and credentials while retaining public catalog URLs', () => {
  const projected = publicRuntimeValue(
    {
      executable: '/usr/bin/private-runtime',
      install_root: '/owned/private-runtime',
      diagnostic: 'verify /usr/local/bin/python then /etc/secret.conf',
      url: 'https://user:password@nodejs.org/dist/index.json',
      catalog: 'https://nodejs.org/dist/index.json',
      owner_token: randomUUID(),
    },
    '/owned',
  );
  assert.equal(
    projected.diagnostic,
    'verify <managed-resource> then <managed-resource>',
  );
  assert.equal(projected.url, 'https://<redacted>@nodejs.org/dist/index.json');
  assert.equal(projected.catalog, 'https://nodejs.org/dist/index.json');
  assert.equal('executable' in projected, false);
  assert.equal('install_root' in projected, false);
  assert.equal('owner_token' in projected, false);
  assert.equal(JSON.stringify(projected).includes('password'), false);
});

test(
  resumeCase
    ? 'S4 authenticated Runtime HTTP restarts the verified genuinely installed root and executes another real TypeScript Task'
    : 'S4 authenticated Runtime HTTP installs Node and npm, builds TSX and executes a real TypeScript Task',
  { timeout: 300000 },
  async (t) => {
    const h = await createS4Fixture(t, {
      caseId: 'S4-MANAGED-HTTP-003',
      ...(resumeCase ? { existingRoot: resumeCase } : {}),
    });
    const app = await V2Application.launch({
      dataRoot: path.join(h.root, 'http-application-data'),
      initialize: !resumeCase,
      projectRoot: h.projectRoot,
      frontendRoot: path.join(h.projectRoot, 'static/dist-v2'),
      port: 0,
    });
    t.after(() => app.close());
    let token, csrf;
    const request = async (method, url, body, key) => {
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
      const serialized = JSON.stringify(payload);
      assert.equal(
        serialized.includes(h.root),
        false,
        'public HTTP payload omits private test root',
      );
      return {
        status: response.status,
        data: payload.data,
        error_code: payload.error_code || payload.message,
      };
    };
    const system = await request('GET', '/system');
    if (resumeCase) {
      assert.equal(system.data.initialized, true);
      // Reuse the genuinely HTTP-issued persisted private test session. No auth
      // rows, JWTs, installations or prior TaskRun records are synthesized.
      const prior = await app.auth.info();
      token = prior.info.tokens.desktop.at(-1).value;
      assert.ok(token);
      const current = await request('GET', '/user');
      assert.equal(current.status, 200);
      assert.equal(current.data.username, 'owner');
      csrf = current.data.csrf_token;
    } else {
      csrf = system.data.csrf_token;
      const password = 'S4_HTTP_' + randomUUID();
      h.registerSecret(password);
      assert.equal(
        (await request('POST', '/user/init', { username: 'owner', password }))
          .status,
        200,
      );
      const login = await request('POST', '/user/login', {
        username: 'owner',
        password,
      });
      assert.equal(login.status, 200);
      token = login.data.token;
      csrf = login.data.csrf_token;
    }
    h.registerSecret(token);
    h.registerSecret(csrf);
    const history = [];
    async function operation(url, body) {
      const initial = await request('POST', url, body);
      assert.equal(initial.status, 202, initial.error_code);
      assert.ok(initial.data.id > 0);
      const deadline = Date.now() + 180000;
      let current;
      while (Date.now() < deadline) {
        const state = await request(
          'GET',
          '/runtime/operations/' + initial.data.id,
        );
        assert.equal(state.status, 200, state.error_code);
        current = state.data;
        if (
          ['SUCCESS', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(
            current.status,
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(current?.status, 'SUCCESS', current?.error_code);
      history.push({
        operation_id: current.id,
        operation_type: current.operation_type,
        status: current.status,
      });
      return current;
    }
    let runtime, environment, workspaceId, taskId;
    let priorRunIds = [];
    if (resumeCase) {
      const operations = await request(
        'GET',
        '/runtime/operations?language=NODE',
      );
      assert.equal(operations.status, 200);
      assert.equal(operations.data.length, 4);
      for (const previous of operations.data) {
        const op = await request('GET', '/runtime/operations/' + previous.id);
        assert.equal(op.status, 200);
        assert.equal(op.data.status, 'SUCCESS');
        history.push({
          operation_id: op.data.id,
          operation_type: op.data.operation_type,
          status: op.data.status,
        });
      }
      assert.deepEqual(history.map((op) => op.operation_type).sort(), [
        'NODE_CATALOG_REFRESH',
        'NODE_ENV_BUILD',
        'NODE_PACKAGE_MANAGER_INSTALL',
        'NODE_RUNTIME_INSTALL',
      ]);
      runtime = (await request('GET', '/runtime/node/installations')).data.find(
        (row) => row.state === 'READY',
      );
      environment = (
        await request('GET', '/runtime/node/environments')
      ).data.find(
        (row) => row.name === 'Actual HTTP TSX' && row.state === 'READY',
      );
      assert.ok(runtime);
      assert.ok(environment);
      workspaceId = (await request('GET', '/workspaces')).data.items.find(
        (row) => row.name === 'Managed HTTP Task',
      ).id;
      taskId = (
        await request('GET', '/tasks?workspace_id=' + workspaceId)
      ).data.items.find((row) => row.name === 'Actual HTTP TypeScript').id;
      const priorRuns = (await request('GET', '/tasks/' + taskId + '/runs'))
        .data.items;
      priorRunIds = priorRuns.map((row) => row.id);
      assert.ok(
        priorRuns.some(
          (row) => row.status === 'SUCCESS' && row.attempt_count === 1,
        ),
      );
    } else {
      await h.measure('authenticated_http_node_install_and_build', async () => {
        await operation('/runtime/node/catalog', { timeout_seconds: 180 });
        await operation('/runtime/node/installations', {
          version: '24.21.0',
          timeout_seconds: 180,
        });
      });
      runtime = (await request('GET', '/runtime/node/installations')).data.find(
        (row) => row.state === 'READY',
      );
      assert.ok(runtime);
      await operation('/runtime/node/toolchains', {
        runtime_id: runtime.id,
        manager_type: 'NPM',
        timeout_seconds: 180,
      });
      const toolchain = (
        await request('GET', '/runtime/node/toolchains')
      ).data.find(
        (row) => row.runtime_id === runtime.id && row.state === 'READY',
      );
      assert.ok(toolchain);
      const createdEnvironment = await request(
        'POST',
        '/runtime/node/environments',
        {
          name: 'Actual HTTP TSX',
          description: '',
          runtime_id: runtime.id,
          toolchain_id: toolchain.id,
          production_only: false,
          install_scripts_policy: 'ALLOW',
          dependencies: [
            { name: 'is-number', specifier: '7.0.0', type: 'DEPENDENCY' },
            { name: 'tsx', specifier: '4.20.6', type: 'DEPENDENCY' },
          ],
        },
      );
      assert.equal(
        createdEnvironment.status,
        200,
        createdEnvironment.error_code,
      );
      environment = createdEnvironment.data;
      await operation(
        '/runtime/node/environments/' + environment.id + '/build',
        {
          expected_version: environment.version,
          timeout_seconds: 180,
        },
      );
      const workspaceResult = await request(
        'POST',
        '/workspaces',
        { type: 'LOCAL', name: 'Managed HTTP Task' },
        's4-managed-http-workspace',
      );
      assert.equal(workspaceResult.status, 202, workspaceResult.error_code);
      workspaceId = workspaceResult.data.workspace.id;
      assert.equal(
        (
          await request('POST', '/workspaces/' + workspaceId + '/files', {
            path: 'main.ts',
            content:
              'import isNumber from "is-number"; const value: boolean = isNumber(42); console.log("s4-actual-http-typescript", value);\n',
            must_not_exist: true,
          })
        ).status,
        200,
      );
      const taskResult = await request('POST', '/tasks', {
        name: 'Actual HTTP TypeScript',
        description: '',
        enabled: true,
        arguments: [],
        env_profile_id: null,
        source: {
          type: 'WORKSPACE_ENTRYPOINT',
          workspace_id: workspaceId,
          relative_entrypoint: 'main.ts',
          language: 'TYPESCRIPT',
          cwd_mode: 'ENTRYPOINT_DIR',
          cwd_relative_path: null,
        },
        runtime: {
          kind: 'NODE',
          python_environment_id: null,
          node_environment_id: environment.id,
        },
        execution: {
          timeout_seconds: 30,
          max_attempts: 1,
          initial_delay_seconds: 0,
          backoff: 'FIXED',
          concurrency: 'QUEUE',
          notification: 'NONE',
        },
      });
      assert.equal(taskResult.status, 200, taskResult.error_code);
      taskId = taskResult.data.id;
    }
    const physical = await new ManagedRuntimeAdapter(
      app.services.store,
    ).inspect('NODE', environment.id, 'TYPESCRIPT');
    const buildHash = await h.hashFile(
      path.join(physical.buildRoot, 'package-lock.json'),
    );
    const readiness = await request('GET', '/tasks/' + taskId + '/resources');
    assert.equal(readiness.status, 200);
    assert.equal(readiness.data.status, 'READY');
    const submitted = await request(
      'POST',
      '/tasks/' + taskId + '/run',
      { wait_mode: 'WAIT' },
      resumeCase
        ? 's4-managed-http-restarted-run-' + randomUUID()
        : 's4-managed-http-run',
    );
    assert.equal(submitted.status, 202, submitted.error_code);
    const runId = submitted.data.id,
      deadline = Date.now() + 60000;
    let run;
    while (Date.now() < deadline) {
      run = (await request('GET', '/task-runs/' + runId)).data;
      if (
        [
          'SUCCESS',
          'FAILED',
          'SKIPPED',
          'TIMEOUT',
          'INTERRUPTED',
          'CANCELLED',
        ].includes(run.status)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(run.status, 'SUCCESS', run.error_code);
    assert.equal(priorRunIds.includes(run.id), false);
    assert.equal(run.attempt_count, 1);
    assert.equal(
      (await request('GET', '/task-runs/' + runId + '/attempts')).data.length,
      1,
    );
    const logResponse = await request('GET', '/task-runs/' + runId + '/log');
    assert.equal(logResponse.status, 200);
    const logs = logResponse.data;
    assert.equal(logs.text.includes('s4-actual-http-typescript true'), true);
    const references = await request(
      'GET',
      '/task-resources/node/' + environment.id + '/references',
    );
    assert.equal(references.status, 200);
    assert.equal(references.data.task_ids.includes(taskId), true);
    const currentEnvironment = (
      await request('GET', '/runtime/node/environments/' + environment.id)
    ).data;
    const rejectedDelete = await request(
      'DELETE',
      '/runtime/node/environments/' + environment.id,
      { expected_version: currentEnvironment.version, timeout_seconds: 180 },
    );
    assert.equal(rejectedDelete.status, 409);
    assert.equal(rejectedDelete.error_code, 'NODE_ENV_TASK_REFERENCED');
    assert.equal(
      (await app.services.store.all('PRAGMA foreign_key_check')).length,
      0,
    );
    await app.services.store.verifySchema();
    const finalPhysical = await new ManagedRuntimeAdapter(
      app.services.store,
    ).inspect('NODE', environment.id, 'TYPESCRIPT');
    assert.equal(finalPhysical.buildId, physical.buildId);
    assert.equal(
      await h.hashFile(path.join(finalPhysical.buildRoot, 'package-lock.json')),
      buildHash,
    );
    assert.equal(
      (await request('GET', '/runtime/operations?language=NODE')).data.length,
      history.length,
    );
    const failureEntry = 'failure-' + randomUUID() + '.js';
    assert.equal(
      (
        await request('POST', '/workspaces/' + workspaceId + '/files', {
          path: failureEntry,
          content: 'throw new Error("S4_CONTROLLED_NODE_FAILURE");\n',
          must_not_exist: true,
        })
      ).status,
      200,
    );
    const failureTask = await request('POST', '/tasks', {
      name: 'Actual managed Node diagnostic',
      description: '',
      enabled: true,
      arguments: [],
      env_profile_id: null,
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: workspaceId,
        relative_entrypoint: failureEntry,
        language: 'JAVASCRIPT',
        cwd_mode: 'ENTRYPOINT_DIR',
        cwd_relative_path: null,
      },
      runtime: {
        kind: 'NODE',
        python_environment_id: null,
        node_environment_id: environment.id,
      },
      execution: {
        timeout_seconds: 30,
        max_attempts: 1,
        initial_delay_seconds: 0,
        backoff: 'FIXED',
        concurrency: 'QUEUE',
        notification: 'NONE',
      },
    });
    assert.equal(failureTask.status, 200);
    const failureSubmitted = await request(
      'POST',
      '/tasks/' + failureTask.data.id + '/run',
      { wait_mode: 'WAIT' },
      's4-controlled-node-failure-' + randomUUID(),
    );
    assert.equal(failureSubmitted.status, 202);
    let failure;
    const failureDeadline = Date.now() + 60000;
    do {
      failure = (await request('GET', '/task-runs/' + failureSubmitted.data.id))
        .data;
      if (!['QUEUED', 'RESOLVING', 'RUNNING'].includes(failure.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < failureDeadline);
    assert.equal(failure.status, 'FAILED');
    assert.equal(failure.attempt_count, 1);
    const rawFailure = await app.services.execution.logs(failure.id);
    assert.equal(rawFailure.includes(app.services.store.dataRoot), true);
    const rawFailureHash = createHash('sha256')
      .update(rawFailure)
      .digest('hex');
    const projectedFailure = await request(
      'GET',
      '/task-runs/' + failure.id + '/log',
    );
    assert.equal(projectedFailure.status, 200);
    assert.equal(
      projectedFailure.data.text.includes('S4_CONTROLLED_NODE_FAILURE'),
      true,
    );
    assert.equal(projectedFailure.data.text.includes('<workspace-data>'), true);
    assert.equal(
      projectedFailure.data.text.includes(app.services.store.dataRoot),
      false,
    );
    assert.equal(
      createHash('sha256')
        .update(await app.services.execution.logs(failure.id))
        .digest('hex'),
      rawFailureHash,
    );
    await h.record(
      resumeCase ? 'S4-MANAGED-HTTP-003-RESTART' : 'S4-MANAGED-HTTP-003',
      {
        status: 'PASS',
        operation_history: history,
        http_operation_status: 202,
        node_runtime_version: runtime.version,
        node_environment_id: environment.id,
        node_build_id: physical.buildId,
        build_lock_sha256: buildHash,
        workspace_id: workspaceId,
        task_id: taskId,
        task_run_id: runId,
        task_run_status: run.status,
        source_generation: run.source_snapshot.source_generation,
        source_revision: run.source_snapshot.content_revision,
        attempt_count: run.attempt_count,
        actual_managed_child: true,
        host_fallback: false,
        public_runtime_paths_omitted: true,
        task_references_block_delete: true,
        controlled_node_failure_run_id: failure.id,
        controlled_node_failure_status: failure.status,
        controlled_node_failure_attempt_count: failure.attempt_count,
        controlled_node_failure_log_sha256: rawFailureHash,
        public_failure_roots_projected: true,
        stored_failure_log_unchanged: true,
        actual_application_restart: !!resumeCase,
        initial_http_install_proof: resumeCase
          ? 'same owned root retained real SUCCESS operation history; no copied assets or receipt import'
          : 'fresh real HTTP 202 requests and polling',
      },
    );
  },
);
