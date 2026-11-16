const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { httpFixture } = require('../workspace-v2/s4/http-support.cjs');
test('maintenance HTTP requires auth, previews/deletes real finished run logs and keeps Runtime resources for logs-only cleanup', async (t) => {
  const f = await httpFixture(t, 'MAINTENANCE-HTTP'),
    s = f.app.services;
  assert.equal(
    (await fetch(f.app.origin + '/api/maintenance/usage')).status,
    401,
  );
  const settings = (await f.request('GET', '/api/maintenance/settings')).body
    .data;
  assert.equal(settings.auto_enabled, true);
  assert.equal(settings.task_days, 90);
  assert.equal(settings.runtime_days, 30);
  assert.equal(settings.cache_days, 30);
  const saved = await f.request('PUT', '/api/maintenance/settings', {
    auto_enabled: false,
    task_days: null,
    runtime_days: 30,
    cache_days: null,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.task_days, null);
  const ws = await s.lifecycle.createLocal({
    name: 'http history',
    requestKey: 'http-history',
  });
  await s.files.create(
    ws.id,
    'main.sh',
    'printf "maintenance-real-run-log\\n"\n',
  );
  const task = await s.tasks.create({
    name: 'maintenance HTTP task',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: ws.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  const run = await s.execution.wait(
    (
      await s.execution.submit(task.task.id)
    ).id,
  );
  assert.equal(run.status, 'SUCCESS');
  await s.store.run(
    'UPDATE TaskRuns SET started_at=?,finished_at=? WHERE id=?',
    ['2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z', run.id],
  );
  const protectedPreview = await f.request('POST', '/api/maintenance/preview', {
    kind: 'task',
    ids: [run.id],
    mode: 'records',
  });
  assert.equal(protectedPreview.body.data.count, 0);
  assert.ok(protectedPreview.body.data.skipped > 0);
  await s.store.run(
    'UPDATE TaskHealthStates SET last_run_id=NULL WHERE task_id=?',
    [task.task.id],
  );
  const scan = await f.request('POST', '/api/maintenance/preview', {
    kind: 'task',
    ids: [run.id],
    mode: 'records',
  });
  assert.equal(scan.status, 200);
  assert.equal(scan.body.data.count, 1);
  assert.ok(scan.body.data.bytes > 0);
  const cleaned = await f.request('POST', '/api/maintenance/clean', {
    preview_id: scan.body.data.preview_id,
  });
  assert.equal(cleaned.status, 200);
  assert.equal(cleaned.body.data.deleted, 1);
  assert.equal(cleaned.body.data.errors.length, 0);
  assert.equal(
    (await s.store.all('SELECT id FROM TaskRuns WHERE id=?', [run.id])).length,
    0,
  );
  assert.equal(
    (
      await f.request('POST', '/api/maintenance/clean', {
        preview_id: scan.body.data.preview_id,
      })
    ).body.data.replayed,
    true,
  );
  assert.equal(
    (await f.request('GET', '/api/workspaces/' + ws.id)).status,
    200,
  );
  const provider = await f.app.runtime.run(() =>
    f.app.runtime.operations.getProvider(),
  );
  const op = (
    await s.store.run(
      "INSERT INTO RuntimeOperations(provider_id,operation_type,status,stage,owner_token,owner_pid,started_at,finished_at,log_identity,metadata,createdAt,updatedAt) VALUES(?,'PROVIDER_VERIFY','SUCCESS','COMPLETE','fixture',1,?,?,'maintenance-http-runtime','{}',?,?)",
      [
        provider.id,
        '2020-01-01T00:00:00Z',
        '2020-01-01T00:00:01Z',
        '2020-01-01T00:00:00Z',
        '2020-01-01T00:00:01Z',
      ],
    )
  ).lastID;
  const directory = path.join(s.store.dataRoot, 'log/runtime');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(directory, `runtime-operation-${op}.log`),
    'old operation log',
    { mode: 0o600 },
  );
  const preview = await f.request('POST', '/api/maintenance/preview', {
    kind: 'runtime',
    ids: [op],
    mode: 'logs',
  });
  assert.equal(preview.body.data.count, 1);
  const result = await f.request('POST', '/api/maintenance/clean', {
    preview_id: preview.body.data.preview_id,
  });
  assert.equal(result.body.data.deleted, 0);
  assert.equal(result.body.data.logs_deleted, 1);
  const detail = await f.request('GET', '/api/runtime/operations/' + op);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.log_cleaned, true);
  const log = await f.request('GET', '/api/runtime/operations/' + op + '/log');
  assert.equal(log.status, 200);
  assert.equal(log.body.data.log_cleaned, true);
  assert.equal(log.body.data.text, '');
  assert.equal(
    (
      await s.store.all('SELECT id FROM RuntimeProviders WHERE id=?', [
        provider.id,
      ])
    ).length,
    1,
  );
  const usage = await f.request('GET', '/api/maintenance/usage');
  assert.equal(usage.status, 200);
  assert.ok(usage.body.data.disk.free_bytes > 0);
  const invalid = await f.request('POST', '/api/maintenance/clean', {
    preview_id: 'missing',
  });
  assert.equal(invalid.status, 409);
  assert.equal(invalid.body.error_code, 'MAINTENANCE_PREVIEW_EXPIRED');
});
