const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutboxFixture } = require('./outbox-fixture.cjs');

test('S3 candidate GitUpdate trigger CRUD uses Workspace ownership/CAS and pure plans freeze every initial/filter decision', async (t) => {
  const f = await createOutboxFixture(t, { caseId: 's3-outbox-plan' });
  const any = await f.createTrigger(),
    initial = await f.createTrigger({ fireOnInitial: true }),
    source = await f.createTrigger({ mode: 'SOURCE_CHANGE' }),
    filtered = await f.createTrigger({
      mode: 'PATH_FILTER',
      pathFilters: ['lib/**/*.txt'],
      fireOnInitial: true,
    }),
    disabled = await f.createTrigger({ enabled: false });
  const row = await f.store.workspace(f.row.id);
  const fact = {
    id: 1,
    workspaceId: row.id,
    workspaceVersion: row.version,
    sourceGeneration: row.source_generation,
    contentRevision: row.content_revision,
    initial: true,
    beforeCommit: f.repository.commit,
    afterCommit: f.repository.commit,
    inventoryHash: row.content_inventory_hash,
  };
  const plan = await f.store.transaction((tx) =>
    f.outbox.preparePlan(tx, fact, [
      'main.sh',
      'helper.txt',
      'lib/nested/one.txt',
    ]),
  );
  const decision = (id) => plan.find((item) => item.origin_trigger_id === id);
  assert.equal(decision(any.id).skip_reason, 'GIT_INITIAL_SYNC_SKIPPED');
  assert.equal(decision(initial.id).skip_reason, null);
  assert.equal(decision(source.id).skip_reason, 'GIT_INITIAL_SYNC_SKIPPED');
  assert.equal(decision(filtered.id).skip_reason, null);
  assert.equal(decision(disabled.id).skip_reason, 'TRIGGER_DISABLED');
  const currentTask = await f.tasks.get(f.task.task.id);
  for (const item of plan) {
    assert.equal(item.task_definition_version, currentTask.task.version);
    assert.equal(
      item.admission.expected_task_definition_version,
      currentTask.task.version,
    );
    assert.equal(item.admission.expected_workspace_version, row.version);
    assert.equal(item.admission.expected_git_commit, f.repository.commit);
    assert.match(item.event_key, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(item).includes(f.secret), false);
  }
  for (const table of [
    'WorkspaceSyncRuns',
    'WorkspaceUpdateOutbox',
    'TriggerEvents',
    'TaskRuns',
  ])
    assert.equal(
      (await f.store.all('SELECT COUNT(*) n FROM ' + table))[0].n,
      0,
    );
  const unsafe = JSON.parse(JSON.stringify(plan));
  unsafe[0].admission.untrusted_host_path = '/untrusted-host-path';
  await assert.rejects(f.outbox.commit(f.store, fact, unsafe), {
    error_code: 'TRIGGER_EVENT_INVALID',
  });
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM WorkspaceUpdateOutbox'))[0].n,
    0,
  );
  const updated = await f.triggers.update(any.id, any.version, {
    mode: 'PATH_FILTER',
    pathFilters: ['**/*.sh'],
    enabled: true,
    fireOnInitial: false,
  });
  assert.equal(updated.version, any.version + 1);
  await assert.rejects(
    f.triggers.update(any.id, any.version, { mode: 'ANY_CHANGE' }),
    { error_code: 'TRIGGER_VERSION_CONFLICT' },
  );
  await assert.rejects(f.triggers.remove(any.id, any.version), {
    error_code: 'TRIGGER_VERSION_CONFLICT',
  });
  await assert.rejects(
    f.createTrigger({ mode: 'PATH_FILTER', pathFilters: ['../unsafe'] }),
  );
  await f.triggers.remove(updated.id, updated.version);
  assert.equal(
    (await f.triggers.list(f.task.task.id)).some(
      (item) => item.id === updated.id,
    ),
    false,
  );
  const changed = await f.store.transaction((tx) =>
    f.outbox.preparePlan(
      tx,
      { ...fact, initial: false, afterCommit: 'f'.repeat(40) },
      ['unrelated.txt'],
    ),
  );
  assert.equal(
    changed.find((item) => item.origin_trigger_id === source.id).skip_reason,
    'GIT_SOURCE_UNCHANGED',
  );
  assert.equal(
    changed.find((item) => item.origin_trigger_id === filtered.id).skip_reason,
    'GIT_PATH_UNMATCHED',
  );
  await f.scenario.record('outbox-plan', {
    status: 'PASS',
    expected:
      'read-only complete frozen plan, trigger CAS and stable event identity',
    actual: {
      trigger_count: plan.length,
      pure_plan_created_runs: 0,
      source_commit: f.repository.commit,
    },
    assertions: [
      'Task versions frozen after all trigger changes',
      'initial opt-in only',
      'path/source filters explicit',
      'disabled target explicit',
      'no secret in plan',
      'no SyncRun/Outbox/Event/TaskRun fabricated by preview',
    ],
  });
});
