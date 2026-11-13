const test = require('node:test');
const assert = require('node:assert/strict');
const { createS1BFixture } = require('../s1b/fixture.cjs');
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
  WorkspaceEnvironmentService,
} = require('../../../back/services/taskExecutionV2/environment');
const {
  TaskResourceResolver,
} = require('../../../back/services/taskExecutionV2/resources');
const {
  WorkspaceCronSubmissions,
} = require('../../../back/services/taskExecutionV2/cron');
const {
  WorkspaceGitUpdateTriggers,
} = require('../../../back/services/gitWorkspaceV2/outbox');
const { taskApiRoutes } = require('../../../back/applicationV2/taskApi');
const {
  resourceApiRoutes,
} = require('../../../back/applicationV2/resourceApi');
const {
  triggerApiRoutes,
  CandidateTaskTriggers,
} = require('../../../back/applicationV2/triggerApi');

async function createResourceApiFixture(t, caseId) {
  const scenario = await createS1BFixture(t, { caseId }),
    f = await scenario.createInstance('A');
  const s = {
    ...f,
    lifecycle: new WorkspaceLifecycleService(f.store, f.roots, f.leases),
    files: new WorkspaceFileService(f.store, f.roots, f.leases),
    tasks: new TaskService(f.store, f.roots, f.leases),
    environment: new WorkspaceEnvironmentService(f.store, f.roots, f.leases),
    resources: new TaskResourceResolver(f.store, f.roots, f.leases),
    gitUpdateTriggers: new WorkspaceGitUpdateTriggers(
      f.store,
      f.roots,
      f.leases,
    ),
  };
  s.execution = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  s.cron = new WorkspaceCronSubmissions(
    f.store,
    f.roots,
    f.leases,
    s.execution,
  );
  const row = await s.lifecycle.createLocal({
      name: caseId,
      requestKey: caseId,
    }),
    routes = {
      ...taskApiRoutes(s),
      ...resourceApiRoutes(s),
      ...triggerApiRoutes(s),
    };
  return {
    ...f,
    s,
    row,
    scenario,
    async call(
      route,
      { params = {}, query = {}, body = {}, ifMatch, idempotencyKey } = {},
    ) {
      const headers = {};
      const handler = routes[route];
      assert.ok(handler, 'owned handler exists');
      const data = await (typeof handler === 'function'
        ? handler
        : handler.handle)({
        params: Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
        query,
        body,
        ifMatch,
        idempotencyKey,
        principal: {
          kind: 'PANEL_OWNER',
          username: 'candidate-test',
          platform: 'desktop',
        },
        setHeader: (name, value) => {
          headers[name] = value;
        },
      });
      return { data, headers };
    },
  };
}
function taskBody(row, name = 'Task from public DTO') {
  return {
    name,
    description: 'candidate route adapter',
    enabled: false,
    arguments: [],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: row.id,
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
      concurrency: 'FORBID',
      notification: 'NONE',
    },
    env_profile_id: null,
  };
}
const code = (expected) => (error) =>
  error.error_code === expected || error.code === expected;

test('S4 candidate Task/resource DTO handlers execute real Shell with masked ENV/Config, CAS clone and retained historical assets', async (t) => {
  const f = await createResourceApiFixture(t, 'S4-TASK-RESOURCE-001'),
    secret = 's4-private-env-' + Date.now(),
    config = 's4-private-config-' + Date.now();
  f.scenario.registerSecret(secret);
  f.scenario.registerSecret(config);
  await f.s.files.create(
    f.row.id,
    'main.sh',
    'printf "env=%s\\n" "$API_TOKEN"\ncat runtime.conf\nprintf "actual-public-adapter-run\\n"\n',
  );
  await f.s.files.create(f.row.id, 'runtime.conf', 'original-unique-config\n');
  const profile = (
    await f.call('POST /scoped-env/profiles', {
      body: {
        workspace_id: f.row.id,
        name: 'API profile',
        description: '',
        status: 'enabled',
      },
    })
  ).data;
  const variables = await f.call('PUT /scoped-env/profiles/:id/variables', {
    params: { id: profile.id },
    body: {
      expected_version: profile.version,
      variables: [
        {
          name: 'API_TOKEN',
          operation: 'SET',
          status: 'enabled',
          is_secret: true,
          value: secret,
          replace_secret: true,
        },
      ],
    },
  });
  assert.equal(variables.data[0].value, null);
  let task = (
    await f.call('POST /tasks', {
      body: { ...taskBody(f.row), env_profile_id: profile.id },
    })
  ).data;
  const asset = (
    await f.call('POST /config-assets', {
      body: { name: 'private Config', is_secret: true, content: config },
    })
  ).data;
  await assert.rejects(
    f.call('GET /config-assets/:id/content', { params: { id: asset.id } }),
    code('SECRET_CONTENT_UNAVAILABLE'),
  );
  const binding = (
    await f.call('POST /tasks/:id/config-bindings', {
      params: { id: task.id },
      body: {
        operation: 'ATTACH',
        asset_id: asset.id,
        revision_id: asset.current_revision_id,
        target_base: 'TASK_DIR',
        target_path: 'runtime.conf',
        materialization_mode: 'COPY',
        conflict_policy: 'REPLACE_RESTORE',
        writable: false,
        enabled: true,
      },
    })
  ).data;
  assert.equal(binding.target_base, 'TASK_DIR');
  assert.equal(binding.conflict_policy, 'REPLACE_RESTORE');
  const stored = (
    await f.store.all(
      'SELECT target_base,conflict_policy FROM TaskConfigBindings WHERE id=?',
      [binding.id],
    )
  )[0];
  assert.deepEqual(stored, {
    target_base: 'TASK_CWD',
    conflict_policy: 'BACKUP_AND_RESTORE',
  });
  await f.call('POST /tasks/:id/hooks', {
    params: { id: task.id },
    body: {
      name: 'before',
      phase: 'BEFORE',
      command: 'printf "actual-before-hook\\n"',
      cwd_base: 'TASK_CWD',
      position: 0,
      timeout_seconds: 10,
      failure_policy: 'FAIL_EXECUTION',
      enabled: true,
    },
  });
  const readiness = (
    await f.call('GET /tasks/:id/resources', { params: { id: task.id } })
  ).data;
  assert.equal(readiness.status, 'READY');
  assert.equal('runtime' in readiness, false);
  const preview = (
    await f.call('GET /scoped-env/tasks/:id/preview', {
      params: { id: task.id },
    })
  ).data;
  assert.equal(JSON.stringify(preview).includes(secret), false);
  assert.equal(preview.context.selected_profile_source, 'TASK');
  await assert.rejects(
    f.call('POST /tasks/:id/clone', {
      params: { id: task.id },
      body: { name: 'stale clone', expected_version: task.version },
    }),
    code('TASK_VERSION_CONFLICT'),
  );
  task = (await f.call('GET /tasks/:id', { params: { id: task.id } })).data;
  task = (
    await f.call('PUT /tasks/:id/enabled', {
      params: { id: task.id },
      body: { enabled: true, expected_version: task.version },
    })
  ).data;
  const accepted = (
    await f.call('POST /tasks/:id/run', {
      params: { id: task.id },
      body: { wait_mode: 'WAIT' },
      idempotencyKey: 'actual-public-adapter',
    })
  ).data;
  const run = await f.s.execution.wait(accepted.id);
  assert.equal(run.status, 'SUCCESS', run.error_code);
  assert.equal(run.attempt_count, 1);
  const publicRun = (
    await f.call('GET /task-runs/:id', { params: { id: run.id } })
  ).data;
  assert.equal(publicRun.source_snapshot.workspace_id, f.row.id);
  assert.equal(publicRun.source_snapshot.git, null);
  assert.equal(JSON.stringify(publicRun).includes(f.dataRoot), false);
  assert.equal('owner_token' in publicRun, false);
  const logs = (
    await f.call('GET /task-runs/:id/log', {
      params: { id: run.id },
      query: { limit_bytes: '1048576' },
    })
  ).data;
  assert.equal(logs.complete, true);
  assert.equal(logs.text.includes(secret), false);
  assert.equal(logs.text.includes(config), false);
  assert.equal(logs.text.includes('actual-before-hook'), true);
  assert.equal(logs.text.includes('actual-public-adapter-run'), true);
  assert.equal(
    (await f.s.files.read(f.row.id, 'runtime.conf')).content,
    'original-unique-config\n',
  );
  await f.call('DELETE /tasks/:id', {
    params: { id: task.id },
    body: { expected_version: task.version },
  });
  await assert.rejects(
    f.call('DELETE /config-assets/:id', {
      params: { id: asset.id },
      query: { version: String(asset.version) },
    }),
    code('CONFIG_ASSET_IN_USE'),
  );
  await f.scenario.record('S4-TASK-RESOURCE-001', {
    task_id: task.id,
    task_run_id: run.id,
    status: run.status,
    actual_attempts: run.attempt_count,
    public_config_mapping: true,
    secret_env_and_config_redacted: true,
    original_config_restored: true,
    historical_asset_reference_preserved: true,
    scope:
      'candidate handler qualification; HTTP authentication/browser qualified separately',
  });
});

test('S4 candidate Global ENV keeps frozen patch-array/ETag semantics, labels and secrets across unrelated changes', async (t) => {
  const f = await createResourceApiFixture(t, 'S4-GLOBAL-ENV-002'),
    secret = 's4-global-private-' + Date.now();
  f.scenario.registerSecret(secret);
  const initial = await f.call('GET /scoped-env/global/variables');
  assert.ok(/^"global-env-[1-9][0-9]*"$/.test(initial.headers.ETag));
  const saved = await f.call('PUT /scoped-env/global/variables', {
    ifMatch: initial.headers.ETag,
    body: [
      {
        name: 'API_GLOBAL_SECRET',
        value: secret,
        is_secret: true,
        replace_secret: true,
        labels: ['preserved-label'],
        position: 1.5,
      },
      { name: 'API_OTHER', value: 'first' },
    ],
  });
  assert.equal(
    saved.data.find((v) => v.name === 'API_GLOBAL_SECRET').value,
    null,
  );
  assert.equal(JSON.stringify(saved.data).includes(secret), false);
  await assert.rejects(
    f.call('PUT /scoped-env/global/variables', {
      ifMatch: initial.headers.ETag,
      body: [{ name: 'API_OTHER', value: 'stale' }],
    }),
    code('ENV_VERSION_CONFLICT'),
  );
  const changed = await f.call('PUT /scoped-env/global/variables', {
    ifMatch: saved.headers.ETag,
    body: [{ name: 'API_OTHER', value: 'second' }],
  });
  assert.deepEqual(
    changed.data.find((v) => v.name === 'API_GLOBAL_SECRET').labels,
    ['preserved-label'],
  );
  assert.equal(
    changed.data.find((v) => v.name === 'API_GLOBAL_SECRET').position,
    1.5,
  );
  await assert.rejects(
    f.call('PUT /scoped-env/global/variables', {
      ifMatch: changed.headers.ETag,
      body: [{ name: 'API_GLOBAL_SECRET', is_secret: false, value: secret }],
    }),
    code('ENV_SECRET_ACTION_INVALID'),
  );
  const removed = await f.call('PUT /scoped-env/global/variables', {
    ifMatch: changed.headers.ETag,
    body: [{ name: 'API_OTHER', clear: true }],
  });
  assert.equal(
    removed.data.some((v) => v.name === 'API_OTHER'),
    false,
  );
  assert.equal(
    removed.data.some((v) => v.name === 'API_GLOBAL_SECRET'),
    true,
  );
  await f.scenario.record('S4-GLOBAL-ENV-002', {
    public_array_retained: true,
    etag_cas: true,
    secret_masked: true,
    unrelated_patch_preserves_secret_and_labels: true,
    explicit_clear_deletes: true,
  });
});

test('S4 candidate Cron/Webhook APIs preserve CAS, one-time secret, durable idempotency and real TaskRuns without Subscription', async (t) => {
  const f = await createResourceApiFixture(t, 'S4-TRIGGER-003');
  await f.s.files.create(
    f.row.id,
    'main.sh',
    'printf "actual-webhook-or-cron-child\\n"\n',
  );
  let task = (await f.call('POST /tasks', { body: taskBody(f.row) })).data;
  const webhook = (
    await f.call('POST /tasks/:id/triggers', {
      params: { id: task.id },
      body: { type: 'WEBHOOK', enabled: true, config: {} },
    })
  ).data;
  assert.equal(typeof webhook.secret, 'string');
  f.scenario.registerSecret(webhook.secret);
  const listed = (
    await f.call('GET /tasks/:id/triggers', { params: { id: task.id } })
  ).data;
  assert.equal(JSON.stringify(listed).includes(webhook.secret), false);
  assert.equal(JSON.stringify(listed).includes('secret_hash'), false);
  task = (await f.call('GET /tasks/:id', { params: { id: task.id } })).data;
  await f.call('PUT /tasks/:id/enabled', {
    params: { id: task.id },
    body: { expected_version: task.version, enabled: true },
  });
  const api = new CandidateTaskTriggers(f.s);
  await assert.rejects(
    api.receiveWebhook(webhook.config.public_id, 'Bearer invalid', 'same'),
    code('WEBHOOK_UNAUTHORIZED'),
  );
  const first = await api.receiveWebhook(
      webhook.config.public_id,
      'Bearer ' + webhook.secret,
      'same',
    ),
    duplicate = await api.receiveWebhook(
      webhook.config.public_id,
      'Bearer ' + webhook.secret,
      'same',
    );
  assert.equal(first.run_id, duplicate.run_id);
  assert.equal(first.event_id, duplicate.event_id);
  assert.equal((await f.s.execution.wait(first.run_id)).status, 'SUCCESS');
  const event = (
    await f.call('GET /trigger-events/:id', { params: { id: first.event_id } })
  ).data;
  assert.equal(event.task_run_id, first.run_id);
  assert.equal(event.status, 'SUBMITTED');
  assert.equal(JSON.stringify(event).includes(webhook.secret), false);
  const rotated = (
    await f.call('POST /tasks/:id/triggers/:triggerId/rotate-secret', {
      params: { id: task.id, triggerId: webhook.id },
      body: { expected_version: webhook.version },
    })
  ).data;
  f.scenario.registerSecret(rotated.secret);
  await assert.rejects(
    api.receiveWebhook(
      webhook.config.public_id,
      'Bearer ' + webhook.secret,
      'new',
    ),
    code('WEBHOOK_UNAUTHORIZED'),
  );
  const next = await api.receiveWebhook(
    webhook.config.public_id,
    'Bearer ' + rotated.secret,
    'new',
  );
  assert.notEqual(next.run_id, first.run_id);
  assert.equal((await f.s.execution.wait(next.run_id)).status, 'SUCCESS');
  const cron = (
    await f.call('POST /tasks/:id/triggers', {
      params: { id: task.id },
      body: {
        type: 'CRON',
        enabled: true,
        config: {
          expression: '* * * * * *',
          timezone: 'UTC',
          misfire_policy: 'FIRE_ONCE',
        },
      },
    })
  ).data;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await f.s.cron.tick();
  const cronEvent = (
    await f.store.all(
      'SELECT * FROM TriggerEvents WHERE trigger_id=? ORDER BY id DESC',
      [cron.id],
    )
  )[0];
  assert.ok(cronEvent);
  assert.ok(cronEvent.task_run_id);
  assert.equal(
    (await f.s.execution.wait(cronEvent.task_run_id)).status,
    'SUCCESS',
  );
  await assert.rejects(
    f.call('POST /tasks/:id/triggers', {
      params: { id: task.id },
      body: {
        type: 'GIT_UPDATE',
        enabled: true,
        config: {
          mode: 'ANY_CHANGE',
          path_filters: [],
          fire_on_initial: false,
        },
      },
    }),
    code('WORKSPACE_TYPE_INVALID'),
  );
  assert.equal((await f.store.all('SELECT id FROM TaskRuns')).length, 3);
  assert.equal((await f.store.all('SELECT id FROM TaskRunAttempts')).length, 3);
  await f.scenario.record('S4-TRIGGER-003', {
    task_id: task.id,
    webhook_event_id: first.event_id,
    webhook_task_run_id: first.run_id,
    cron_event_id: cronEvent.id,
    cron_task_run_id: cronEvent.task_run_id,
    durable_idempotency: true,
    old_secret_rejected_after_rotate: true,
    actual_children: 3,
    no_subscription_dependency: true,
  });
});

test('S4 candidate resource adapters reject internal enums, cross-owner IDs, unsafe DTO fields and stale Config CAS', async (t) => {
  const f = await createResourceApiFixture(t, 'S4-RESOURCE-NEGATIVE-004');
  await f.s.files.create(f.row.id, 'main.sh', 'printf "never-run\\n"\n');
  const task = (await f.call('POST /tasks', { body: taskBody(f.row) })).data;
  const refs = (
    await f.call('GET /task-resources/:kind/:id/references', {
      params: { kind: 'workspace', id: f.row.id },
    })
  ).data;
  assert.deepEqual(refs.task_ids, [task.id]);
  assert.deepEqual(refs.workspace_ids, [f.row.id]);
  assert.equal(refs.history_count, 0);
  assert.equal(
    (await f.call('GET /tasks', { query: { language: 'SHELL' } })).data.total,
    1,
  );
  assert.equal(
    (await f.call('GET /tasks', { query: { language: 'PYTHON' } })).data.total,
    0,
  );
  await assert.rejects(
    f.call('POST /tasks', { body: { ...taskBody(f.row), subscription_id: 1 } }),
    code('INVALID_REQUEST'),
  );
  const asset = (
    await f.call('POST /config-assets', {
      body: {
        name: 'public',
        is_secret: false,
        content: 'actual-public-asset',
      },
    })
  ).data;
  const binding = {
    operation: 'ATTACH',
    asset_id: asset.id,
    revision_id: asset.current_revision_id,
    target_base: 'TASK_DIR',
    target_path: 'test.txt',
    materialization_mode: 'COPY',
    conflict_policy: 'REPLACE_RESTORE',
    writable: false,
    enabled: true,
  };
  await assert.rejects(
    f.call('POST /tasks/:id/config-bindings', {
      params: { id: task.id },
      body: { ...binding, target_base: 'TASK_CWD' },
    }),
    code('INVALID_REQUEST'),
  );
  await assert.rejects(
    f.call('POST /tasks/:id/config-bindings', {
      params: { id: task.id },
      body: { ...binding, conflict_policy: 'BACKUP_AND_RESTORE' },
    }),
    code('INVALID_REQUEST'),
  );
  const saved = (
    await f.call('POST /tasks/:id/config-bindings', {
      params: { id: task.id },
      body: binding,
    })
  ).data;
  const other = await f.s.lifecycle.createLocal({
    name: 'other owner',
    requestKey: 'other-owner',
  });
  await assert.rejects(
    f.call('DELETE /workspaces/:id/config-bindings/:bindingId', {
      params: { id: other.id, bindingId: saved.id },
      body: { expected_version: saved.version },
    }),
    code('CONFIG_BINDING_NOT_FOUND'),
  );
  await f.call('PUT /tasks/:id/config-bindings/:bindingId', {
    params: { id: task.id, bindingId: saved.id },
    body: { ...binding, expected_version: saved.version },
  });
  await assert.rejects(
    f.call('PUT /tasks/:id/config-bindings/:bindingId', {
      params: { id: task.id, bindingId: saved.id },
      body: { ...binding, expected_version: saved.version },
    }),
    code('CONFIG_EDIT_CONFLICT'),
  );
  await assert.rejects(
    f.call('PUT /scoped-env/tasks/:id/variables', {
      params: { id: task.id },
      body: {
        expected_version: task.version,
        variables: [
          {
            name: 'API',
            operation: 'SET',
            status: 'enabled',
            is_secret: false,
            value: 'v',
            labels: ['invalid-scoped-field'],
          },
        ],
      },
    }),
    code('INVALID_REQUEST'),
  );
  assert.equal((await f.store.all('SELECT id FROM TaskRuns')).length, 0);
  await f.scenario.record('S4-RESOURCE-NEGATIVE-004', {
    strict_public_enums: true,
    cross_owner_rejected: true,
    stale_binding_cas: true,
    unknown_fields_rejected: true,
    no_execution: true,
  });
});
