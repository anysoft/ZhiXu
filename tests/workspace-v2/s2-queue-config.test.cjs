const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  { createHash } = require('node:crypto');
const { createFixture } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  WorkspaceEnvironmentService,
} = require('../../back/services/taskExecutionV2/environment');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');
const {
  TaskResourceResolver,
} = require('../../back/services/taskExecutionV2/resources');
async function setup(t) {
  const f = await createFixture(t);
  f.files = new WorkspaceFileService(f.store, f.roots, f.leases);
  f.tasks = new TaskService(f.store, f.roots, f.leases);
  f.env = new WorkspaceEnvironmentService(f.store, f.roots, f.leases);
  f.execution = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  f.row = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'config queue', requestKey: 'config-queue' });
  await f.files.create(f.row.id, 'secret.txt', 'original user config');
  await f.store.run(
    "INSERT INTO ConfigAssets(id,name,is_secret,createdAt,updatedAt) VALUES(1,'s2-secret',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  );
  await revision(f, 1, 'S2_UNIQUE_PRIVATE_CONFIG');
  await f.env.saveWorkspaceConfig(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    {
      asset_id: 1,
      revision_id: null,
      operation: 'ATTACH',
      target_base: 'WORKSPACE_ROOT',
      target_path: 'secret.txt',
      materialization_mode: 'COPY',
      conflict_policy: 'BACKUP_AND_RESTORE',
      writable: false,
      enabled: true,
    },
  );
  return f;
}
async function revision(f, n, content) {
  const directory = await f.roots.directory(
    'config-assets/asset-1/revisions/' + n,
    true,
  );
  await fs.writeFile(path.join(directory, 'content'), content, { mode: 0o600 });
  await f.store.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO ConfigAssetRevisions(id,asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,1,?,?,?,?,CURRENT_TIMESTAMP)',
      [
        n,
        n,
        createHash('sha256').update(content).digest('hex'),
        Buffer.byteLength(content),
        'asset-1/revisions/' + n + '/content',
      ],
    );
    await tx.run(
      'UPDATE ConfigAssets SET current_revision_id=?,version=version+1 WHERE id=1',
      [n],
    );
  });
}
async function task(f, name, script, args = [], execution = {}) {
  await f.files.create(f.row.id, name + '.sh', script);
  return f.tasks.create({
    name,
    arguments: args,
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: f.row.id,
      relative_entrypoint: name + '.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution: { concurrency: 'ALLOW', ...execution },
  });
}
async function poll(f, fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await f.execution.tick();
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('ACTUAL_CONFIG_EXECUTION_TIMEOUT');
}
async function final(f, run, status) {
  const row = await f.execution.wait(run.id, 30000);
  assert.equal(
    row.status,
    status,
    JSON.stringify({
      status: row.status,
      error: row.error_code,
      result: row.result,
    }),
  );
  assert.equal(
    await fs.readFile(path.join(f.roots.path(f.row), 'secret.txt'), 'utf8'),
    'original user config',
  );
  assert.equal(
    (await f.execution.logs(run.id)).includes('S2_UNIQUE_PRIVATE_CONFIG'),
    false,
  );
  return row;
}

test('S2 Config current revision changed while queued is SOURCE_SUPERSEDED with zero injection or Attempt', async (t) => {
  const f = await setup(t);
  const a = await task(f, 'never', 'printf "MUST_NOT_EXECUTE\\n"\n');
  const run = await f.execution.submit(a.task.id);
  await revision(f, 2, 'S2_NEW_PRIVATE_CONFIG');
  const row = await final(f, run, 'SKIPPED');
  assert.equal(row.error_code, 'SOURCE_SUPERSEDED');
  assert.equal((await f.execution.attempts(run.id)).length, 0);
  assert.equal(await f.execution.logs(run.id), '');
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 1);
});

test('S2 effective Config metadata and binding creation reject a real over-budget candidate before materialization', async (t) => {
  const f = await setup(t);
  const a = await task(f, 'config-limit', 'true\n');
  await f.store.run(
    `WITH RECURSIVE many(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM many WHERE n<20000)
   INSERT INTO WorkspaceConfigBindings(workspace_id,asset_id,revision_id,operation,target_base,target_path)
   SELECT ?,1,1,'ATTACH','WORKSPACE_ROOT','bounded-'||n FROM many`,
    [f.row.id],
  );
  const count = (
    await f.store.all('SELECT COUNT(*) n FROM WorkspaceConfigBindings')
  )[0].n;
  assert.equal(count, 20001);
  const resources = new TaskResourceResolver(f.store, f.roots, f.leases);
  await assert.rejects(resources.definition(a.task.id), {
    error_code: 'WORKSPACE_QUOTA_EXCEEDED',
  });
  await assert.rejects(
    f.env.saveWorkspaceConfig(
      f.row.id,
      (
        await f.store.workspace(f.row.id)
      ).version,
      {
        asset_id: 1,
        revision_id: 1,
        operation: 'ATTACH',
        target_base: 'WORKSPACE_ROOT',
        target_path: 'one-more',
        materialization_mode: 'COPY',
        conflict_policy: 'FAIL_IF_EXISTS',
        writable: false,
        enabled: true,
      },
    ),
    { error_code: 'WORKSPACE_QUOTA_EXCEEDED' },
  );
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM WorkspaceConfigBindings'))[0].n,
    count,
  );
  assert.equal(
    await fs.readFile(path.join(f.roots.path(f.row), 'secret.txt'), 'utf8'),
    'original user config',
  );
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 0);
});

test('S2 real active cancellation kills child ownership and restores secret Config before releasing Workspace', async (t) => {
  const f = await setup(t);
  const pidFile = path.join(f.root, 'child.pid');
  const a = await task(
    f,
    'cancel',
    'cat secret.txt\nprintf "\\nCANCEL_CHILD_READY\\n"\nsleep 10 &\nchild=$!\nprintf "%s\\n" "$child" > "$1"\nwait "$child"\n',
    [pidFile],
  );
  const run = await f.execution.submit(a.task.id);
  await poll(
    f,
    async () =>
      (await f.execution.logs(run.id)).includes('CANCEL_CHILD_READY') &&
      !!(await fs.lstat(pidFile).catch(() => null)),
  );
  await assert.rejects(f.files.read(f.row.id, 'secret.txt'), {
    error_code: 'WORKSPACE_BUSY',
  });
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  await f.execution.cancel(run.id);
  await final(f, run, 'CANCELLED');
  assert.equal((await f.execution.attempts(run.id))[0].status, 'CANCELLED');
  let alive = true;
  for (let n = 0; n < 100 && alive; n++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 20));
    } catch (e) {
      if (e.code === 'ESRCH') alive = false;
      else throw e;
    }
  }
  assert.equal(alive, false, 'owned background child must be gone');
  assert.equal((await f.store.workspace(f.row.id)).lifecycle_state, 'READY');
  assert.equal(
    JSON.stringify(
      await f.store.all(
        'SELECT admission_snapshot,source_snapshot,snapshot_metadata,result FROM TaskRuns',
      ),
    ).includes('S2_UNIQUE_PRIVATE_CONFIG'),
    false,
  );
});

test('S2 real timeout and retry preserve Attempt history, pinned Config and original user bytes', async (t) => {
  const f = await setup(t);
  const counter = path.join(f.root, 'retry-count');
  const timed = await task(
    f,
    'timeout',
    'cat secret.txt\nprintf "\\nTIMEOUT_ACTIVE\\n"\nsleep 10\n',
    [],
    { timeout_seconds: 1 },
  );
  const retry = await task(
    f,
    'retry',
    'cat secret.txt\nprintf "\\n"\nn=$(cat "$1" 2>/dev/null || printf 0)\nn=$((n + 1))\nprintf "%s" "$n" > "$1"\nif [ "$n" -lt 2 ]; then exit 9; fi\nprintf "RETRY_SUCCEEDED\\n"\n',
    [counter],
    { max_attempts: 2, initial_delay_seconds: 0, timeout_seconds: 5 },
  );
  const timeoutRun = await f.execution.submit(timed.task.id);
  await final(f, timeoutRun, 'TIMEOUT');
  assert.equal(
    (await f.execution.attempts(timeoutRun.id))[0].status,
    'TIMEOUT',
  );
  const retryRun = await f.execution.submit(retry.task.id);
  const row = await final(f, retryRun, 'SUCCESS');
  assert.equal(row.attempt_count, 2);
  assert.deepEqual(
    (await f.execution.attempts(retryRun.id)).map((a) => a.status),
    ['FAILED', 'SUCCESS'],
  );
  assert.equal(await fs.readFile(counter, 'utf8'), '2');
  assert.match(await f.execution.logs(retryRun.id), /RETRY_SUCCEEDED/);
  assert.equal((await f.store.all('PRAGMA foreign_key_check')).length, 0);
});
