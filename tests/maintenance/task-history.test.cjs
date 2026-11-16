const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  createFixture,
  insertTaskSource,
  insertHistoricalRunForReferenceTest,
} = require('../workspace-v2/fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const { taskApiRoutes } = require('../../back/applicationV2/taskApi');

test('Task history applies server time/status filters, timezone boundaries, default 7 days and SQL pagination', async (t) => {
  const f = await createFixture(t);
  const ws = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'history', requestKey: 'history' });
  const taskId = await insertTaskSource(f.store, ws.id);
  const seed = await insertHistoricalRunForReferenceTest(
    f.store,
    taskId,
    ws.id,
  );
  const base = (
    await f.store.all('SELECT * FROM TaskRuns WHERE id=?', [seed])
  )[0];
  async function row(start, status = 'SUCCESS', submitted = start) {
    const value = {
      ...base,
      started_at: null,
      submitted_at: submitted,
      finished_at: status === 'SKIPPED' ? submitted : null,
      status: status === 'SKIPPED' ? 'SKIPPED' : 'QUEUED',
      log_identity: 'history-' + randomUUID(),
    };
    const keys = Object.keys(value).filter((k) => k !== 'id');
    const id = (
      await f.store.run(
        `INSERT INTO TaskRuns(${keys.join(',')}) VALUES(${keys
          .map(() => '?')
          .join(',')})`,
        keys.map((k) => value[k]),
      )
    ).lastID;
    if (status !== 'SKIPPED') {
      await f.store.run(
        "UPDATE TaskRuns SET status='RESOLVING',owner_token='history-fixture',started_at=? WHERE id=?",
        [start, id],
      );
      if (status === 'SUCCESS')
        await f.store.run(
          "UPDATE TaskRuns SET status='RUNNING',active_workspace_id=workspace_id,source_snapshot=? WHERE id=?",
          [
            JSON.stringify({
              effective_resource_versions: {},
              workspace_type: 'LOCAL',
              entrypoint_checksum: '0'.repeat(64),
              git: null,
              workspace_id: ws.id,
              source_generation: base.expected_source_generation,
              content_revision: base.expected_content_revision,
              task_definition_version: base.expected_task_definition_version,
              inventory_hash: base.expected_inventory_hash,
            }),
            id,
          ],
        );
      await f.store.run(
        'UPDATE TaskRuns SET status=?,finished_at=?,active_workspace_id=NULL WHERE id=?',
        [status, submitted, id],
      );
    }
    return id;
  }
  const first = await row('2020-01-01T00:00:00.000Z');
  const second = await row('2020-01-01 01:00:00.000 +00:00', 'FAILED');
  await row('2020-01-02T00:00:00.000Z');
  await row(new Date(Date.now() - 8 * 86400000).toISOString());
  const recent = await row(new Date(Date.now() - 3600000).toISOString());
  const noStart = await row(
    null,
    'SKIPPED',
    new Date(Date.now() - 1800000).toISOString(),
  );
  const routes = taskApiRoutes({
    store: f.store,
    backup: { paths: { root: f.backupRoot } },
  });
  const query = (q) =>
    routes['GET /task-runs']({ params: {}, query: q, body: {} });
  const days = await query({});
  assert.equal(days.total, 3);
  assert.ok(days.items.some((r) => r.id === recent));
  assert.ok(days.items.some((r) => r.id === noStart));
  const range = {
    from: '2020-01-01T02:00:00+02:00',
    to: '2020-01-02T00:00:00Z',
  };
  const a = await query({ ...range, page: '1', size: '1' }),
    b = await query({ ...range, page: '2', size: '1' });
  assert.equal(a.total, 2);
  assert.equal(a.items.length, 1);
  assert.equal(b.total, 2);
  assert.equal(b.items.length, 1);
  assert.deepEqual(
    new Set([a.items[0].id, b.items[0].id]),
    new Set([first, second]),
  );
  const failed = await query({
    ...range,
    status: 'FAILED',
    workspace_id: String(ws.id),
    task_id: String(taskId),
  });
  assert.equal(failed.total, 1);
  assert.equal(failed.items[0].id, second);
  await assert.rejects(query({ from: '2020-02-30T00:00:00Z' }), {
    error_code: 'INVALID_REQUEST',
  });
  await assert.rejects(
    query({ from: '2020-01-02T00:00:00Z', to: '2020-01-01T00:00:00Z' }),
    { error_code: 'INVALID_REQUEST' },
  );
  await assert.rejects(query({ from: '2020-01-01T00:00:00' }), {
    error_code: 'INVALID_REQUEST',
  });
  await assert.rejects(query({ status: 'NOT_A_STATUS' }), {
    error_code: 'INVALID_REQUEST',
  });
});
