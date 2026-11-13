const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { httpFixture, shellTask, until } = require('./http-support.cjs');

test('S4 real HTTP Task logs project owned roots across byte-page boundaries while retaining original history and URLs', async (t) => {
  const f = await httpFixture(t, 'S4-LOG-ROOTS-001'),
    r = f.request;
  const created = await r(
    'POST',
    '/api/workspaces',
    { type: 'LOCAL', name: 'Actual private root log' },
    { 'Idempotency-Key': 'log-root-workspace' },
  );
  assert.equal(created.status, 202);
  const workspaceId = created.body.data.workspace.id;
  assert.equal(
    (
      await r('POST', '/api/workspaces/' + workspaceId + '/files', {
        path: 'main.sh',
        content:
          'printf "BEGIN\\n"\npwd\nprintf "https://example.invalid/valid/path\\n"\n',
        must_not_exist: true,
      })
    ).status,
    200,
  );
  const task = await r('POST', '/api/tasks', shellTask(workspaceId));
  assert.equal(task.status, 200);
  const submitted = await r(
    'POST',
    '/api/tasks/' + task.body.data.id + '/run',
    { wait_mode: 'WAIT' },
    { 'Idempotency-Key': 'log-root-run' },
  );
  assert.equal(submitted.status, 202);
  const runId = submitted.body.data.id;
  const complete = await until(
    () => r('GET', '/api/task-runs/' + runId),
    (value) =>
      !['QUEUED', 'RESOLVING', 'RUNNING'].includes(value.body.data?.status),
  );
  assert.equal(complete.body.data.status, 'SUCCESS');
  const raw = Buffer.from(await f.app.services.execution.logs(runId));
  const rootBytes = Buffer.from(f.app.services.store.dataRoot),
    privateOffset = raw.indexOf(rootBytes);
  assert.ok(privateOffset >= 0, 'actual pwd emitted the original owned root');
  const beforeHash = createHash('sha256').update(raw).digest('hex');
  const whole = await r('GET', '/api/task-runs/' + runId + '/log');
  assert.equal(whole.status, 200);
  assert.equal(
    whole.body.data.text.includes(f.app.services.store.dataRoot),
    false,
  );
  assert.equal(whole.body.data.text.includes('<workspace-data>'), true);
  assert.equal(
    whole.body.data.text.includes('https://example.invalid/valid/path'),
    true,
  );
  const boundary = privateOffset + Math.floor(rootBytes.length / 2);
  const first = await r(
    'GET',
    '/api/task-runs/' + runId + '/log?limit_bytes=' + boundary,
  );
  assert.equal(first.status, 200);
  assert.equal(
    Number(Buffer.from(first.body.data.next_cursor, 'base64url').toString()),
    boundary,
  );
  const second = await r(
    'GET',
    '/api/task-runs/' +
      runId +
      '/log?cursor=' +
      encodeURIComponent(first.body.data.next_cursor),
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.data.complete, true);
  assert.equal(
    (first.body.data.text + second.body.data.text).includes(
      f.app.services.store.dataRoot,
    ),
    false,
  );
  assert.equal(
    createHash('sha256')
      .update(await f.app.services.execution.logs(runId))
      .digest('hex'),
    beforeHash,
  );
  await f.h.record('S4-LOG-ROOTS-001', {
    status: 'PASS',
    workspace_id: workspaceId,
    task_id: task.body.data.id,
    task_run_id: runId,
    actual_pwd_child: true,
    private_root_projected: true,
    boundary_cursor_original_bytes: boundary,
    pagination_root_overlap_protected: true,
    public_url_preserved: true,
    retained_log_sha256: beforeHash,
    stored_history_unchanged: true,
  });
});
