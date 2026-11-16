const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFixture } = require('../workspace-v2/fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');
const {
  StorageMaintenance,
} = require('../../back/services/storageMaintenance');
const {
  WorkspaceExecutionPaths,
} = require('../../back/services/taskExecutionV2/paths');
const RuntimePathResolver = require('../../back/services/runtimePaths').default;
const { RuntimeLease } = require('../../back/services/runtimeProcess');
const NOW = new Date('2030-06-01T12:00:00.000Z');
const OLD = '2029-01-01T00:00:00.000Z';
async function file(f, relative, text = 'owned-data') {
  const target = path.join(f.dataRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, text, { mode: 0o600 });
  return target;
}
async function setup(t, options = {}) {
  const f = await createFixture(t);
  const ws = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'maintenance', requestKey: 'maintenance' });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    ws.id,
    'main.sh',
    'echo keep-workspace\n',
  );
  const task = await new TaskService(f.store, f.roots, f.leases).create({
    name: 'maintenance task',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: ws.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
  });
  await f.store.run(
    "INSERT INTO RuntimeProviders(id,language,provider_type,state,install_root,createdAt,updatedAt) VALUES(1,'PYTHON','PYENV','READY','runtime/python/pyenv',?,?)",
    [OLD, OLD],
  );
  const maintenance = new StorageMaintenance(f.store, f.leases, {
    now: () => NOW,
    ...options,
  });
  const engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  async function run(when = OLD) {
    const id = (await engine.submit(task.task.id)).id;
    await engine.cancel(id);
    await f.store.run(
      'UPDATE TaskRuns SET started_at=?,finished_at=? WHERE id=?',
      [when, when, id],
    );
    await file(f, `log/task-runs/run-${id}.log`, `task-log-${id}`);
    return id;
  }
  async function operation(status = 'SUCCESS', when = OLD) {
    const row = await f.store.run(
      "INSERT INTO RuntimeOperations(provider_id,operation_type,status,stage,owner_token,owner_pid,started_at,finished_at,log_identity,metadata,createdAt,updatedAt) VALUES(1,'PROVIDER_VERIFY',?,'COMPLETE','test-owner',1,?,?,?,'{}',?,?)",
      [
        status,
        when,
        status === 'QUEUED' ? null : when,
        'test-' + Math.random(),
        when,
        when,
      ],
    );
    await file(
      f,
      `log/runtime/runtime-operation-${row.lastID}.log`,
      `runtime-log-${row.lastID}`,
    );
    return row.lastID;
  }
  return { ...f, ws, task, engine, maintenance, run, operation };
}
test('referenced Runtime operations retain records while their old logs can be cleaned', async (t) => {
  const f = await setup(t, { batchSize: 1 });
  const referenced = await f.operation();
  const later = await f.operation();
  await f.store.run(
    "INSERT INTO RuntimeInstallations(provider_id,language,implementation,version,state,executable_relative_path,metadata,createdAt,updatedAt) VALUES(1,'PYTHON','CPYTHON','3.12.0','READY','runtime/python/installed/bin/python',?,?,?)",
    [JSON.stringify({ last_verify_operation_id: referenced }), OLD, OLD],
  );
  const records = await f.maintenance.preview({
    kind: 'runtime',
    mode: 'records',
  });
  assert.equal(records.count, 1);
  const removal = await f.maintenance.clean({ preview_id: records.preview_id });
  assert.equal(removal.deleted, 1);
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeOperations WHERE id=?', [later]))
      .length,
    0,
  );
  assert.equal(
    (
      await f.store.all('SELECT id FROM RuntimeOperations WHERE id=?', [
        referenced,
      ])
    ).length,
    1,
  );
  const logs = await f.maintenance.preview({
    kind: 'runtime',
    mode: 'logs',
    ids: [referenced],
  });
  assert.equal(logs.count, 1);
  assert.equal(
    (await f.maintenance.clean({ preview_id: logs.preview_id })).logs_deleted,
    1,
  );
  const preserved = (
    await f.store.all('SELECT metadata FROM RuntimeOperations WHERE id=?', [
      referenced,
    ])
  )[0];
  assert.equal(JSON.parse(preserved.metadata).log_cleaned, true);
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeInstallations')).length,
    1,
  );
});
test('automatic scheduling uses one startup timer then hourly due checks', async (t) => {
  const f = await setup(t),
    timers = [];
  let checks = 0;
  t.mock.method(global, 'setTimeout', (fn, delay) => {
    const timer = { fn, delay, unref() {} };
    timers.push(timer);
    return timer;
  });
  const clear = t.mock.method(global, 'clearTimeout', () => {});
  t.mock.method(f.maintenance, 'runAutomatic', async () => {
    checks++;
  });
  f.maintenance.start();
  f.maintenance.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 30000);
  timers[0].fn();
  await new Promise(setImmediate);
  assert.equal(checks, 1);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, 3600000);
  await f.maintenance.close();
  assert.equal(clear.mock.callCount(), 1);
});
test('an explicitly invalid cleanup ID selection never becomes an unscoped cleanup', async (t) => {
  const f = await setup(t);
  const id = await f.operation();
  for (const ids of [null, 0, false, []])
    await assert.rejects(f.maintenance.preview({ kind: 'runtime', ids }), {
      error_code: 'MAINTENANCE_FILTER_INVALID',
    });
  await assert.rejects(f.maintenance.preview({ kind: 'storage', mode: 'logs' }), {
    error_code: 'MAINTENANCE_FILTER_INVALID',
  });
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeOperations WHERE id=?', [id]))
      .length,
    1,
  );
  assert.ok(
    await fs.readFile(
      path.join(f.dataRoot, `log/runtime/runtime-operation-${id}.log`),
      'utf8',
    ),
  );
});
test('maintenance defaults, settings persistence, managed storage usage and free disk are accurate', async (t) => {
  const f = await setup(t);
  assert.deepEqual(await f.maintenance.getSettings(), {
    auto_enabled: true,
    task_days: 90,
    runtime_days: 30,
    cache_days: 30,
    last_automatic_at: null,
  });
  const id = await f.operation();
  await f.run();
  await file(f, 'cache/python/pip/object', 'cache');
  await file(
    f,
    'runtime/python/pyenv/versions/installed-do-not-touch',
    'runtime',
  );
  const usage = await f.maintenance.usage();
  assert.equal(usage.categories.runtime_logs.files, 1);
  assert.equal(
    usage.categories.runtime_logs.bytes,
    Buffer.byteLength(`runtime-log-${id}`),
  );
  assert.equal(usage.categories.download_cache.bytes, 5);
  assert.ok(usage.categories.database.bytes > 0);
  assert.ok(usage.disk.free_bytes > 0);
  assert.ok(usage.disk.total_bytes >= usage.disk.free_bytes);
  await f.maintenance.saveSettings({
    auto_enabled: false,
    task_days: null,
    runtime_days: 12,
    cache_days: null,
  });
  assert.equal(
    (await new StorageMaintenance(f.store, f.leases).getSettings()).task_days,
    null,
  );
  assert.deepEqual(await f.maintenance.runAutomatic(), { disabled: true });
  await assert.rejects(f.maintenance.saveSettings({ runtime_days: 0 }), {
    error_code: 'MAINTENANCE_SETTINGS_INVALID',
  });
});
test('Task cleanup honors exact inclusive/exclusive range, skips active/referenced/held runs and retains user data', async (t) => {
  const f = await setup(t),
    first = await f.run('2029-01-01T00:00:00.000Z'),
    end = await f.run('2029-01-02T00:00:00.000Z'),
    held = await f.run(OLD);
  const active = (await f.engine.submit(f.task.task.id)).id;
  await file(f, `log/task-runs/run-${active}.log`, 'task-log-active');
  await f.store.run(
    'UPDATE TaskHealthStates SET last_run_id=? WHERE task_id=?',
    [held, f.task.task.id],
  );
  const preview = await f.maintenance.preview({
    kind: 'task',
    from: OLD,
    to: '2029-01-02T00:00:00.000Z',
    workspace_id: f.ws.id,
  });
  assert.equal(preview.count, 1);
  const result = await f.maintenance.clean({ preview_id: preview.preview_id });
  assert.equal(result.deleted, 1);
  assert.equal(result.logs_deleted, 1);
  assert.equal(
    (await f.store.all('SELECT id FROM TaskRuns WHERE id=?', [first])).length,
    0,
  );
  assert.equal(
    (
      await f.store.all('SELECT id FROM TaskRuns WHERE id IN (?,?,?)', [
        end,
        active,
        held,
      ])
    ).length,
    3,
  );
  assert.equal(
    (await f.maintenance.clean({ preview_id: preview.preview_id })).replayed,
    true,
  );
  const history = await f.maintenance.preview({ kind: 'task', ids: [end] });
  const owner = await new WorkspaceExecutionPaths(f.dataRoot).owner(end);
  try {
    assert.equal(
      (await f.maintenance.clean({ preview_id: history.preview_id })).deleted,
      0,
    );
  } finally {
    await owner.release();
  }
  assert.ok(
    (
      await fs.readFile(
        path.join(f.dataRoot, 'log/task-runs/run-' + active + '.log'),
        'utf8',
      )
    ).includes('task-log'),
  );
  assert.equal((await f.store.workspace(f.ws.id)).storage_state, 'PRESENT');
});
test('Runtime logs-only cleanup persists explicit cleaned marker, record removal never uninstalls resource', async (t) => {
  const f = await setup(t),
    op = await f.operation(),
    active = await f.operation('QUEUED');
  const installed = await file(
    f,
    'runtime/python/pyenv/versions/3.13.15/bin/python',
    'installed-runtime',
  );
  const preview = await f.maintenance.preview({
    kind: 'runtime',
    ids: [op, active],
    mode: 'logs',
  });
  assert.equal(preview.count, 1);
  const result = await f.maintenance.clean({ preview_id: preview.preview_id });
  assert.equal(result.logs_deleted, 1);
  assert.equal(result.deleted, 0);
  assert.equal(
    JSON.parse(
      (
        await f.store.all('SELECT metadata FROM RuntimeOperations WHERE id=?', [
          op,
        ])
      )[0].metadata,
    ).log_cleaned,
    true,
  );
  assert.equal(await fs.readFile(installed, 'utf8'), 'installed-runtime');
  const second = await f.maintenance.preview({
    kind: 'runtime',
    ids: [op],
    mode: 'records',
  });
  assert.equal(
    (await f.maintenance.clean({ preview_id: second.preview_id })).deleted,
    1,
  );
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeOperations WHERE id=?', [active]))
      .length,
    1,
  );
  assert.equal(await fs.readFile(installed, 'utf8'), 'installed-runtime');
});
test('filesystem failure preserves row and repeat safely completes cleanup; stale changed log is skipped', async (t) => {
  let fail = true;
  const f = await setup(t, {
    fault: async (point) => {
      if (point === 'after-files' && fail) {
        fail = false;
        throw Error('test controlled failure');
      }
    },
  });
  const id = await f.operation();
  const preview = await f.maintenance.preview({ kind: 'runtime', ids: [id] });
  const first = await f.maintenance.clean({ preview_id: preview.preview_id });
  assert.equal(first.errors.length, 1);
  assert.equal(first.deleted, 0);
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeOperations WHERE id=?', [id]))
      .length,
    1,
  );
  const second = await f.maintenance.clean({ preview_id: preview.preview_id });
  assert.equal(second.errors.length, 0);
  assert.equal(second.deleted, 1);
  const changed = await f.operation();
  const scan = await f.maintenance.preview({ kind: 'runtime', ids: [changed] });
  await fs.appendFile(
    path.join(f.dataRoot, `log/runtime/runtime-operation-${changed}.log`),
    'changed',
  );
  assert.equal(
    (await f.maintenance.clean({ preview_id: scan.preview_id })).deleted,
    0,
  );
});
test('automatic expiration uses finish time and settings; active operations protect all caches', async (t) => {
  const f = await setup(t),
    old = await f.operation(),
    fresh = await f.operation('SUCCESS', '2030-06-01T11:00:00.000Z');
  await f.store.run('UPDATE RuntimeOperations SET started_at=? WHERE id=?', [
    OLD,
    fresh,
  ]);
  const cached = await file(
    f,
    'cache/runtime/python/downloads/old-source.tar.xz',
    'rebuildable',
  );
  const artifact = await file(
    f,
    'verified-artifact-store/objects/keep',
    'trusted',
  );
  const first = await f.maintenance.runAutomatic();
  assert.equal(
    first.results.some((r) => r.errors.length),
    false,
  );
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeOperations WHERE id=?', [old]))
      .length,
    0,
  );
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeOperations WHERE id=?', [fresh]))
      .length,
    1,
  );
  await assert.rejects(fs.stat(cached), { code: 'ENOENT' });
  assert.equal(await fs.readFile(artifact, 'utf8'), 'trusted');
  assert.deepEqual(await f.maintenance.runAutomatic(), { not_due: true });
  const active = await f.operation('QUEUED');
  await file(f, 'cache/node/npm/old-package', 'cache');
  const blocked = await f.maintenance.preview({ kind: 'storage' });
  assert.equal(blocked.count, 0);
  await f.store.run(
    "UPDATE RuntimeOperations SET status='SUCCESS',finished_at=? WHERE id=?",
    [OLD, active],
  );
  const scan = await f.maintenance.preview({ kind: 'storage' });
  assert.ok(scan.count > 0);
  await f.operation('QUEUED');
  const skipped = await f.maintenance.clean({ preview_id: scan.preview_id });
  assert.equal(skipped.errors.length, 0);
  assert.equal(
    await fs.readFile(
      path.join(f.dataRoot, 'cache/node/npm/old-package'),
      'utf8',
    ),
    'cache',
  );
});
test('storage preview confirms saved retention cleanup of history and referenced logs without touching active resources', async (t) => {
  const f = await setup(t),
    task = await f.run(),
    operation = await f.operation(),
    referenced = await f.operation();
  // The most recent run remains referenced by health state and must be preserved.
  const recentTask = await f.run('2030-06-01T11:00:00.000Z');
  const activeTask = (await f.engine.submit(f.task.task.id)).id;
  const activeOperation = await f.operation('QUEUED');
  const fresh = await f.operation('SUCCESS', '2030-06-01T11:00:00.000Z');
  const runtime = await file(
    f,
    'runtime/python/installed/bin/python',
    'installed',
  );
  const cache = await file(f, 'cache/python/pip/active-cache', 'busy-cache');
  await file(
    f,
    `tmp/runtime/python/operation-${operation}/build-output`,
    'expired-temporary',
  );
  await f.store.run(
    "INSERT INTO RuntimeInstallations(provider_id,language,implementation,version,state,executable_relative_path,metadata,createdAt,updatedAt) VALUES(1,'PYTHON','CPYTHON','3.12.0','READY','runtime/python/installed/bin/python',?,?,?)",
    [JSON.stringify({ last_verify_operation_id: referenced }), OLD, OLD],
  );
  const preview = await f.maintenance.preview({ kind: 'storage' });
  assert.equal(preview.count, 3); // Task, Runtime record (including its temp), referenced Runtime log.
  assert.ok(preview.bytes > 0);
  assert.equal(
    (await f.store.all('SELECT id FROM TaskRuns WHERE id=?', [task])).length,
    1,
  );
  const result = await f.maintenance.clean({ preview_id: preview.preview_id });
  assert.equal(result.errors.length, 0);
  assert.equal(result.deleted, 2);
  assert.equal(result.logs_deleted, 3);
  assert.equal(
    (await f.store.all('SELECT id FROM TaskRuns WHERE id=?', [task])).length,
    0,
  );
  assert.equal(
    (
      await f.store.all('SELECT id FROM RuntimeOperations WHERE id=?', [
        operation,
      ])
    ).length,
    0,
  );
  const kept = (
    await f.store.all('SELECT metadata FROM RuntimeOperations WHERE id=?', [
      referenced,
    ])
  )[0];
  assert.equal(JSON.parse(kept.metadata).log_cleaned, true);
  assert.equal(
    (await f.store.all('SELECT id FROM TaskRuns WHERE id=?', [activeTask]))
      .length,
    1,
  );
  assert.equal(
    (await f.store.all('SELECT id FROM TaskRuns WHERE id=?', [recentTask]))
      .length,
    1,
  );
  assert.equal(
    (
      await f.store.all('SELECT id FROM RuntimeOperations WHERE id IN (?,?)', [
        activeOperation,
        fresh,
      ])
    ).length,
    2,
  );
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeInstallations')).length,
    1,
  );
  assert.equal(await fs.readFile(runtime, 'utf8'), 'installed');
  assert.equal(await fs.readFile(cache, 'utf8'), 'busy-cache');
  assert.equal(
    await fs.readFile(path.join(f.roots.path(f.ws), 'main.sh'), 'utf8'),
    'echo keep-workspace\n',
  );
});
test('temporary usage includes only expired recognized operation data and respects permanent cache retention', async (t) => {
  const f = await setup(t),
    old = await f.operation(),
    fresh = await f.operation('SUCCESS', '2030-06-01T11:00:00.000Z');
  await file(f, `tmp/runtime/python/operation-${old}/old`, 'expired');
  await file(f, `tmp/runtime/python/operation-${fresh}/fresh`, 'keep-new');
  const usage = await f.maintenance.usage();
  assert.equal(usage.categories.temporary.files, 1);
  assert.equal(usage.categories.temporary.bytes, Buffer.byteLength('expired'));
  await f.maintenance.saveSettings({ cache_days: null });
  assert.equal((await f.maintenance.usage()).categories.temporary.files, 0);
});
test('automatic retention expires referenced Runtime logs and skips already-cleaned prefixes before batching', async (t) => {
  const f = await setup(t, { batchSize: 1 }),
    first = await f.operation(),
    second = await f.operation(),
    third = await f.operation();
  await f.store.run('UPDATE RuntimeOperations SET metadata=? WHERE id=?', [
    JSON.stringify({ log_cleaned: true }),
    first,
  ]);
  await fs.unlink(
    path.join(f.dataRoot, `log/runtime/runtime-operation-${first}.log`),
  );
  await f.store.run(
    "INSERT INTO RuntimeInstallations(provider_id,language,implementation,version,state,executable_relative_path,metadata,createdAt,updatedAt) VALUES(1,'PYTHON','CPYTHON','3.12.0','READY','runtime/python/installed/bin/python',?,?,?)",
    [
      JSON.stringify({
        last_install_operation_id: first,
        last_verify_operation_id: second,
        last_operation_id: third,
      }),
      OLD,
      OLD,
    ],
  );
  const result = await f.maintenance.runAutomatic();
  assert.equal(result.results.length, 2);
  assert.equal(
    result.results.reduce((n, r) => n + r.logs_deleted, 0),
    2,
  );
  assert.equal(
    result.results.some((r) => r.errors.length),
    false,
  );
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeOperations')).length,
    3,
  );
  for (const row of await f.store.all('SELECT metadata FROM RuntimeOperations'))
    assert.equal(JSON.parse(row.metadata).log_cleaned, true);
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeInstallations')).length,
    1,
  );
});
test('unowned symlinks and unknown Task temporary files are preserved, never traversed', async (t) => {
  const f = await setup(t),
    op = await f.operation();
  const outside = path.join(f.root, 'outside');
  await fs.writeFile(outside, 'outside');
  await fs.unlink(
    path.join(f.dataRoot, `log/runtime/runtime-operation-${op}.log`),
  );
  await fs.symlink(
    outside,
    path.join(f.dataRoot, `log/runtime/runtime-operation-${op}.log`),
  );
  const p = await f.maintenance.preview({ kind: 'runtime', ids: [op] });
  assert.equal(p.count, 0);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  await file(f, 'cache/python/pip/safe', 'safe');
  await fs.symlink(outside, path.join(f.dataRoot, 'cache/python/pip/unsafe'));
  const storage = await f.maintenance.preview({ kind: 'storage' });
  await f.maintenance.clean({ preview_id: storage.preview_id });
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  assert.equal(
    (
      await fs.lstat(path.join(f.dataRoot, 'cache/python/pip/unsafe'))
    ).isSymbolicLink(),
    true,
  );
});
test('referenced run and unknown Task temporary materialization data remain intact', async (t) => {
  const f = await setup(t),
    referenced = await f.run();
  await f.run();
  await f.store.run(
    "INSERT INTO NotificationChannels(name,type) VALUES('history-test','WEBHOOK')",
  );
  await f.store.run(
    "INSERT INTO NotificationOutbox(event_type,task_id,task_run_id,channel_id,dedupe_key,message,status) VALUES('SUCCESS',?,?,1,'maintenance-ref','{}','SENT')",
    [f.task.task.id, referenced],
  );
  assert.equal(
    (await f.maintenance.preview({ kind: 'task', ids: [referenced] })).count,
    0,
  );
  assert.ok(
    await fs.stat(path.join(f.dataRoot, `log/task-runs/run-${referenced}.log`)),
  );
  const temporary = await f.run();
  await f.run();
  await file(
    f,
    `tmp/execution/run-${temporary}/attempt-1/unknown-user-file`,
    'retain',
  );
  assert.equal(
    (await f.maintenance.preview({ kind: 'task', ids: [temporary] })).count,
    0,
  );
  assert.equal(
    await fs.readFile(
      path.join(
        f.dataRoot,
        `tmp/execution/run-${temporary}/attempt-1/unknown-user-file`,
      ),
      'utf8',
    ),
    'retain',
  );
});
test('Runtime temp changed since preview is skipped and concurrent confirmation is idempotent', async (t) => {
  const f = await setup(t),
    id = await f.operation();
  await file(f, `tmp/runtime/python/operation-${id}/nested/source`, 'source');
  const preview = await f.maintenance.preview({ kind: 'runtime', ids: [id] });
  await file(f, `tmp/runtime/python/operation-${id}/nested/new-file`, 'retain');
  assert.equal(
    (await f.maintenance.clean({ preview_id: preview.preview_id })).deleted,
    0,
  );
  assert.equal(
    await fs.readFile(
      path.join(
        f.dataRoot,
        `tmp/runtime/python/operation-${id}/nested/new-file`,
      ),
      'utf8',
    ),
    'retain',
  );
  const next = await f.maintenance.preview({ kind: 'runtime', ids: [id] });
  const [a, b] = await Promise.all([
    f.maintenance.clean({ preview_id: next.preview_id }),
    f.maintenance.clean({ preview_id: next.preview_id }),
  ]);
  assert.equal(a.deleted, 1);
  assert.deepEqual(a, b);
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeOperations WHERE id=?', [id]))
      .length,
    0,
  );
});
test('automatic failure is summarized and remains retryable; permanent retention leaves historical records', async (t) => {
  let failing = true;
  const f = await setup(t, {
      fault: async (point) => {
        if (point === 'before-unlink' && failing)
          throw Error('controlled failure');
      },
    }),
    id = await f.operation();
  const failed = await f.maintenance.runAutomatic();
  assert.equal(
    failed.results.some((r) => r.errors.length > 0),
    true,
  );
  const status = await f.maintenance.getSettings();
  assert.equal(status.last_automatic_at, null);
  assert.equal(status.last_automatic_result.status, 'FAILED');
  assert.equal(
    status.last_automatic_result.error_code,
    'MAINTENANCE_DELETE_FAILED',
  );
  failing = false;
  await f.maintenance.runAutomatic();
  assert.equal(
    (await f.maintenance.getSettings()).last_automatic_result.status,
    'SUCCESS',
  );
  const next = await f.operation();
  await f.maintenance.saveSettings({
    runtime_days: null,
    task_days: null,
    cache_days: null,
  });
  // A fresh service at a later day reads the persisted permanent settings.
  const later = new StorageMaintenance(f.store, f.leases, {
    now: () => new Date('2030-06-03T12:00:00.000Z'),
  });
  await later.runAutomatic();
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeOperations WHERE id=?', [next]))
      .length,
    1,
  );
});
test('recovery-required terminal Runtime operations and active owner leases are never cleaned', async (t) => {
  const f = await setup(t),
    cleanup = await f.operation('FAILED'),
    owned = await f.operation('FAILED');
  await f.store.run(
    "UPDATE RuntimeOperations SET stage='CLEANUP_REQUIRED' WHERE id=?",
    [cleanup],
  );
  await file(
    f,
    `tmp/runtime/python/operation-${cleanup}/recover-me`,
    'preserve',
  );
  const blocked = await f.maintenance.preview({
    kind: 'runtime',
    ids: [cleanup],
  });
  assert.equal(blocked.count, 0);
  const preview = await f.maintenance.preview({
    kind: 'runtime',
    ids: [owned],
  });
  const lease = await RuntimeLease.acquire(
    new RuntimePathResolver(f.dataRoot),
    1,
  );
  try {
    assert.equal(
      (await f.maintenance.clean({ preview_id: preview.preview_id })).deleted,
      0,
    );
  } finally {
    await lease.release();
  }
  assert.equal(
    await fs.readFile(
      path.join(
        f.dataRoot,
        `tmp/runtime/python/operation-${cleanup}/recover-me`,
      ),
      'utf8',
    ),
    'preserve',
  );
  await assert.rejects(
    f.maintenance.preview({ kind: 'runtime', from: '2029-02-30T00:00:00Z' }),
    { error_code: 'MAINTENANCE_RANGE_INVALID' },
  );
});
