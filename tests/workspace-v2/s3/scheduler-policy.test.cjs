const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createSyncFixture } = require('./sync-fixture.cjs');
test('S3-SCHEDULE-009 Cron/Interval and pinned-ref policy constraints reject without mutating canonical policy or history', async (t) => {
  const f = await createSyncFixture(t, { caseId: 'S3-SCHEDULE-009' });
  const before = await f.policies.get(f.row.id);
  const write = (schedule) => ({
    expected_version: before.version,
    enabled: true,
    mode: 'SCHEDULED',
    schedule,
  });
  const interval = {
    type: 'INTERVAL',
    interval_ms: 60000,
    anchor_at: new Date().toISOString(),
    misfire_policy: 'FIRE_ONCE',
  };
  const invalid = [
    {
      type: 'CRON',
      expression: 'invalid cron',
      timezone: 'UTC',
      misfire_policy: 'SKIP',
    },
    {
      type: 'CRON',
      expression: '* * * * *',
      timezone: 'Invalid/Zone',
      misfire_policy: 'SKIP',
    },
    { ...interval, interval_ms: 0 },
    { ...interval, interval_ms: -1 },
    { ...interval, interval_ms: 1.5 },
    { ...interval, interval_ms: Number.MAX_SAFE_INTEGER + 1 },
    { ...interval, anchor_at: '2026-01-01' },
    { ...interval, anchor_at: 'invalid' },
    { ...interval, misfire_policy: 'REPLAY_ALL' },
  ];
  for (const schedule of invalid) {
    await assert.rejects(
      f.policies.save(f.row.id, write(schedule)),
      (error) => error.error_code === 'SYNC_POLICY_INVALID',
    );
    assert.deepEqual(await f.policies.get(f.row.id), before);
  }
  await assert.rejects(
    f.policies.save(f.row.id, {
      ...write(interval),
      expected_version: before.version - 1,
    }),
    (error) => error.error_code === 'SYNC_POLICY_VERSION_CONFLICT',
  );
  const pinned = await f.createWorkspace({
    refType: 'commit',
    refName: f.repository.commit,
  });
  await assert.rejects(
    f.policies.save(pinned.id, { ...write(interval), expected_version: 1 }),
    (error) => error.error_code === 'SYNC_POLICY_INVALID',
  );
  assert.equal((await f.policies.get(pinned.id)).enabled, 0);
  assert.equal((await f.policies.get(pinned.id)).update_mode, 'MANUAL');
  const disabled = await f.policies.save(f.row.id, {
    expected_version: before.version,
    enabled: false,
    mode: 'MANUAL',
    schedule: null,
  });
  assert.equal(disabled.next_due_at, null);
  await assert.rejects(
    f.sync.submit(f.row.id),
    (error) => error.error_code === 'SYNC_POLICY_DISABLED',
  );
  assert.equal(
    (await f.store.all('SELECT id FROM WorkspaceSyncRuns')).length,
    0,
  );
  assert.equal(
    (await f.store.all('SELECT id FROM WorkspaceUpdateOutbox')).length,
    0,
  );
  assert.equal((await f.store.all('PRAGMA foreign_key_check')).length, 0);
  await f.scenario.record('S3-SCHEDULE-009', {
    rejected_schedule_inputs: invalid.length,
    policy_preserved_after_invalid: true,
    pinned_commit_workspace_id: pinned.id,
    pinned_schedule_rejected: true,
    disabled_submit_rejected: true,
    no_history_or_outbox: true,
  });
});

test('S3-SCHEDULE-010 actual archived Git Workspace permits CAS disable only and preserves source and schedule fields', async (t) => {
  const f = await createSyncFixture(t, { caseId: 'S3-SCHEDULE-010' });
  const schedule = {
    type: 'INTERVAL',
    interval_ms: 60000,
    anchor_at: new Date().toISOString(),
    misfire_policy: 'FIRE_ONCE',
  };
  let policy = await f.policies.save(f.row.id, {
    expected_version: 2,
    enabled: true,
    mode: 'SCHEDULED',
    schedule,
  });
  const pending = await f.sync.submit(f.row.id, {
    requestKey: 'archive-policy-pending',
  });
  await f.lifecycle.archive(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    { requestKey: 'archive-real-scheduled-policy' },
  );
  const archived = await f.store.workspace(f.row.id);
  assert.equal(archived.lifecycle_state, 'ARCHIVED');
  assert.equal((await f.sync.get(pending.id)).status, 'CANCELLED');
  assert.equal((await f.sync.get(pending.id)).error_code, 'WORKSPACE_ARCHIVED');
  policy = await f.policies.get(f.row.id);
  assert.equal(policy.enabled, 0);
  const source = JSON.stringify(
    (
      await f.store.all('SELECT * FROM GitWorkspaces WHERE workspace_id=?', [
        f.row.id,
      ])
    )[0],
  );
  const root = await fs.lstat(f.workspaceRoot);
  const head = f.git(['rev-parse', 'HEAD'], f.workspaceRoot);
  const unchanged = JSON.stringify(policy);
  for (const write of [
    {
      expected_version: policy.version,
      enabled: true,
      mode: 'SCHEDULED',
      schedule,
    },
    {
      expected_version: policy.version,
      enabled: false,
      mode: 'MANUAL',
      schedule: null,
    },
    {
      expected_version: policy.version,
      enabled: false,
      mode: 'SCHEDULED',
      schedule: { ...schedule, interval_ms: 30000 },
    },
  ]) {
    await assert.rejects(
      f.policies.save(f.row.id, write),
      (error) => error.error_code === 'WORKSPACE_ARCHIVED',
    );
    assert.equal(JSON.stringify(await f.policies.get(f.row.id)), unchanged);
  }
  await assert.rejects(
    f.policies.save(f.row.id, {
      expected_version: policy.version - 1,
      enabled: false,
      mode: 'SCHEDULED',
      schedule,
    }),
    (error) => error.error_code === 'SYNC_POLICY_VERSION_CONFLICT',
  );
  const disabled = await f.policies.save(f.row.id, {
    expected_version: policy.version,
    enabled: false,
    mode: 'SCHEDULED',
    schedule,
  });
  assert.equal(disabled.version, policy.version + 1);
  assert.equal(disabled.enabled, 0);
  assert.equal(disabled.next_due_at, null);
  for (const key of [
    'update_mode',
    'schedule_kind',
    'cron_expression',
    'timezone',
    'interval_ms',
    'anchor_at',
    'misfire_policy',
  ])
    assert.equal(disabled[key], policy[key]);
  assert.deepEqual(await f.store.workspace(f.row.id), archived);
  assert.equal(
    JSON.stringify(
      (
        await f.store.all('SELECT * FROM GitWorkspaces WHERE workspace_id=?', [
          f.row.id,
        ])
      )[0],
    ),
    source,
  );
  const after = await fs.lstat(f.workspaceRoot);
  assert.equal(after.dev, root.dev);
  assert.equal(after.ino, root.ino);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspaceRoot), head);
  await assert.rejects(
    f.sync.submit(f.row.id),
    (error) => error.error_code === 'WORKSPACE_ARCHIVED',
  );
  await f.scheduler.tick();
  assert.equal(
    (await f.store.all('SELECT id FROM WorkspaceSyncRuns')).length,
    1,
  );
  assert.equal(
    (await f.store.all('SELECT id FROM WorkspaceUpdateOutbox')).length,
    0,
  );
  await f.scenario.record('S3-SCHEDULE-010', {
    workspace_id: f.row.id,
    lifecycle_state: archived.lifecycle_state,
    disabled_policy_version: disabled.version,
    pending_run_cancelled: true,
    rejects_enable_and_schedule_change: true,
    source_identity_preserved: true,
    no_new_sync_or_outbox: true,
  });
});
