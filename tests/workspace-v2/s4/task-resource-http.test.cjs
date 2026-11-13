const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createS4Fixture } = require('./fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');

test(
  'S4 real HTTP ENV, secret Config and Hooks preserve CAS, resource ownership, redaction and original files through actual execution',
  { timeout: 120000 },
  async (t) => {
    const h = await createS4Fixture(t, { caseId: 'S4-RESOURCE-HTTP-004' });
    const app = await V2Application.launch({
      dataRoot: path.join(h.root, 'resource-http-data'),
      initialize: true,
      projectRoot: h.projectRoot,
      frontendRoot: path.join(h.projectRoot, 'static/dist-v2'),
      port: 0,
    });
    t.after(() => app.close());
    let token, csrf;
    const envSecret = 's4-env-' + randomUUID(),
      configSecret = 's4-config-' + randomUUID();
    h.registerSecret(envSecret);
    h.registerSecret(configSecret);
    const request = async (method, url, body, extra = {}) => {
      const response = await fetch(app.origin + '/api' + url, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(method === 'GET' ? {} : { Origin: app.origin }),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json(),
        serialized = JSON.stringify(value);
      for (const privateValue of [h.root, envSecret, configSecret])
        assert.equal(serialized.includes(privateValue), false);
      return {
        status: response.status,
        data: value.data,
        error_code: value.error_code,
        etag: response.headers.get('etag'),
      };
    };
    csrf = (await request('GET', '/system')).data.csrf_token;
    const password = 'S4_RESOURCE_' + randomUUID();
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
    h.registerSecret(token);
    h.registerSecret(csrf);
    const workspace = (
      await request(
        'POST',
        '/workspaces',
        { type: 'LOCAL', name: 'Actual resource HTTP' },
        { 'Idempotency-Key': 'resource-http-ws' },
      )
    ).data.workspace;
    const other = (
      await request(
        'POST',
        '/workspaces',
        { type: 'LOCAL', name: 'Other resource scope' },
        { 'Idempotency-Key': 'resource-http-other' },
      )
    ).data.workspace;
    for (const ws of [workspace, other])
      assert.equal(
        (
          await request('POST', '/workspaces/' + ws.id + '/files', {
            path: 'main.sh',
            content:
              'printf "private-env=%s\\n" "$API_TOKEN"\ncat runtime.conf\nprintf "actual-resource-http-child\\n"\n',
            must_not_exist: true,
          })
        ).status,
        200,
      );
    const original = 'unique-original-http-config\n';
    assert.equal(
      (
        await request('POST', '/workspaces/' + workspace.id + '/files', {
          path: 'runtime.conf',
          content: original,
          must_not_exist: true,
        })
      ).status,
      200,
    );
    const profile = (
      await request('POST', '/scoped-env/profiles', {
        workspace_id: workspace.id,
        name: 'HTTP Profile',
        description: '',
        status: 'enabled',
      })
    ).data;
    const variablesBody = {
      expected_version: profile.version,
      variables: [
        {
          name: 'API_TOKEN',
          operation: 'SET',
          status: 'enabled',
          is_secret: true,
          value: envSecret,
          replace_secret: true,
        },
      ],
    };
    const variables = await request(
      'PUT',
      '/scoped-env/profiles/' + profile.id + '/variables',
      variablesBody,
    );
    assert.equal(variables.status, 200);
    assert.equal(variables.data[0].value, null);
    assert.equal(
      (
        await request(
          'PUT',
          '/scoped-env/profiles/' + profile.id + '/variables',
          variablesBody,
        )
      ).status,
      409,
    );
    const global = await request('GET', '/scoped-env/global/variables');
    assert.ok(/^"global-env-[1-9][0-9]*"$/.test(global.etag));
    assert.equal(
      (
        await request(
          'PUT',
          '/scoped-env/global/variables',
          [{ name: 'HTTP_GLOBAL', value: 'actual-value' }],
          { 'If-Match': global.etag },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          'PUT',
          '/scoped-env/global/variables',
          [{ name: 'HTTP_GLOBAL', value: 'stale-value' }],
          { 'If-Match': global.etag },
        )
      ).status,
      409,
    );
    const body = (ws) => ({
      name: 'Actual HTTP resource Task',
      description: '',
      enabled: false,
      arguments: [],
      env_profile_id: ws.id === workspace.id ? profile.id : null,
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: ws.id,
        relative_entrypoint: 'main.sh',
        language: 'SHELL',
        cwd_mode: 'ENTRYPOINT_DIR',
        cwd_relative_path: null,
      },
      runtime: {
        kind: 'SHELL',
        python_environment_id: null,
        node_environment_id: null,
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
    let task = (await request('POST', '/tasks', body(workspace))).data;
    const otherTask = (await request('POST', '/tasks', body(other))).data;
    assert.equal(
      (
        await request('POST', '/tasks', {
          ...body(workspace),
          subscription_id: 1,
        })
      ).status,
      400,
    );
    const asset = (
      await request('POST', '/config-assets', {
        name: 'HTTP private Config',
        is_secret: true,
        content: configSecret,
      })
    ).data;
    assert.equal(
      (await request('GET', '/config-assets/' + asset.id + '/content')).status,
      403,
    );
    const bindingBody = {
      operation: 'ATTACH',
      asset_id: asset.id,
      revision_id: asset.current_revision_id,
      target_base: 'TASK_DIR',
      target_path: 'runtime.conf',
      materialization_mode: 'COPY',
      conflict_policy: 'REPLACE_RESTORE',
      writable: false,
      enabled: true,
    };
    const binding = (
      await request(
        'POST',
        '/tasks/' + task.id + '/config-bindings',
        bindingBody,
      )
    ).data;
    assert.equal(binding.target_base, 'TASK_DIR');
    assert.equal(binding.conflict_policy, 'REPLACE_RESTORE');
    const stored = (
      await app.services.store.all(
        'SELECT target_base,conflict_policy FROM TaskConfigBindings WHERE id=?',
        [binding.id],
      )
    )[0];
    assert.deepEqual(stored, {
      target_base: 'TASK_CWD',
      conflict_policy: 'BACKUP_AND_RESTORE',
    });
    assert.equal(
      (
        await request('POST', '/tasks/' + task.id + '/config-bindings', {
          ...bindingBody,
          target_base: 'TASK_CWD',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request('POST', '/tasks/' + task.id + '/config-bindings', {
          ...bindingBody,
          conflict_policy: 'BACKUP_AND_RESTORE',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          'PUT',
          '/tasks/' + otherTask.id + '/config-bindings/' + binding.id,
          { ...bindingBody, expected_version: binding.version },
        )
      ).status,
      404,
    );
    const hook = await request('POST', '/tasks/' + task.id + '/hooks', {
      name: 'Actual HTTP before',
      phase: 'BEFORE',
      command: 'printf "actual-resource-http-hook\\n"',
      cwd_base: 'TASK_CWD',
      position: 0,
      timeout_seconds: 10,
      failure_policy: 'FAIL_EXECUTION',
      enabled: true,
    });
    assert.equal(hook.status, 200);
    assert.equal(
      (
        await request('POST', '/tasks/' + task.id + '/clone', {
          name: 'Stale clone',
          expected_version: task.version,
        })
      ).status,
      409,
    );
    assert.equal(
      (await request('GET', '/tasks/' + task.id + '/resources')).data.status,
      'READY',
    );
    const preview = await request(
      'GET',
      '/scoped-env/tasks/' + task.id + '/preview',
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.data.context.selected_profile_source, 'TASK');
    task = (await request('GET', '/tasks/' + task.id)).data;
    task = (
      await request('PUT', '/tasks/' + task.id + '/enabled', {
        expected_version: task.version,
        enabled: true,
      })
    ).data;
    const accepted = await request(
      'POST',
      '/tasks/' + task.id + '/run',
      { wait_mode: 'WAIT' },
      { 'Idempotency-Key': 'resource-http-real-run' },
    );
    assert.equal(accepted.status, 202);
    const duplicate = await request(
      'POST',
      '/tasks/' + task.id + '/run',
      { wait_mode: 'WAIT' },
      { 'Idempotency-Key': 'resource-http-real-run' },
    );
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.data.id, accepted.data.id);
    let run,
      deadline = Date.now() + 30000;
    do {
      run = (await request('GET', '/task-runs/' + accepted.data.id)).data;
      if (!['QUEUED', 'RESOLVING', 'RUNNING'].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(run.status, 'SUCCESS', run.error_code);
    assert.equal(run.attempt_count, 1);
    const log = (await request('GET', '/task-runs/' + run.id + '/log')).data;
    assert.equal(log.text.includes('actual-resource-http-child'), true);
    assert.equal(log.text.includes('actual-resource-http-hook'), true);
    assert.equal(log.text.includes('********'), true);
    let file;
    deadline = Date.now() + 5000;
    do {
      file = await request(
        'GET',
        '/workspaces/' + workspace.id + '/files?path=runtime.conf',
      );
      if (file.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(file.status, 200);
    assert.equal(file.data.content, original);
    assert.equal(
      (await request('GET', '/tasks/' + task.id + '/runs')).data.total,
      1,
    );
    assert.equal(
      (await request('GET', '/task-runs/' + run.id + '/attempts')).data.length,
      1,
    );
    assert.equal(
      (await app.services.store.all('PRAGMA foreign_key_check')).length,
      0,
    );
    await h.record('S4-RESOURCE-HTTP-004', {
      status: 'PASS',
      workspace_id: workspace.id,
      task_id: task.id,
      task_run_id: run.id,
      task_run_status: run.status,
      attempt_count: run.attempt_count,
      secret_env_config_redacted: true,
      original_config_restored: true,
      actual_hook_executed: true,
      public_config_mapping: true,
      internal_enum_aliases_rejected: true,
      stale_profile_and_global_cas_http: 409,
      stale_task_clone_http: 409,
      cross_resource_http: 404,
      secret_content_http: 403,
      duplicate_submission_same_run: true,
    });
  },
);
