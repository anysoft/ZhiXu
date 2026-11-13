const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createFixture } = require('./fixture.cjs');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
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

const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const hook = (phase, command, timeout = 5) => ({
  name: 'qualified ' + phase,
  phase,
  command,
  cwd_base: 'TASK_CWD',
  position: 0,
  timeout_seconds: timeout,
  failure_policy: 'FAIL_EXECUTION',
  enabled: true,
});

async function hookFixture(t, code, hooks, execution = {}) {
  const f = await createFixture(t);
  const row = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({
    name: 'actual hook lifecycle',
    requestKey: 'hook-lifecycle',
  });
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  await files.create(row.id, 'main.sh', code);
  await files.create(row.id, 'config.txt', 'ORIGINAL_HOOK_USER_CONFIG');
  const tasks = new TaskService(f.store, f.roots, f.leases);
  let definition = await tasks.create({
    name: 'actual hook task',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: row.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution: {
      concurrency: 'ALLOW',
      max_attempts: 1,
      timeout_seconds: 10,
      ...execution,
    },
  });
  const environment = new WorkspaceEnvironmentService(
    f.store,
    f.roots,
    f.leases,
  );
  definition = await environment.replaceHooks(
    definition.task.id,
    definition.task.version,
    hooks(f),
  );
  const secret = 'S2_HOOK_CONFIG_SECRET_' + path.basename(f.root);
  const asset = (
    await f.store.run(
      'INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES(?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
      ['hook secret'],
    )
  ).lastID;
  const key = `asset-${asset}/revisions/1/content`;
  const directory = await f.roots.directory(
    path.dirname('config-assets/' + key),
    true,
  );
  await fs.writeFile(path.join(directory, 'content'), secret, {
    mode: 0o400,
    flag: 'wx',
  });
  const revision = (
    await f.store.run(
      'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,size,checksum,storage_key,createdAt) VALUES(?,1,?,?,?,CURRENT_TIMESTAMP)',
      [
        asset,
        Buffer.byteLength(secret),
        createHash('sha256').update(secret).digest('hex'),
        key,
      ],
    )
  ).lastID;
  await f.store.run(
    'UPDATE ConfigAssets SET current_revision_id=? WHERE id=?',
    [revision, asset],
  );
  await environment.saveWorkspaceConfig(
    row.id,
    (
      await f.store.workspace(row.id)
    ).version,
    {
      asset_id: asset,
      revision_id: revision,
      operation: 'ATTACH',
      target_base: 'TASK_CWD',
      target_path: 'config.txt',
      materialization_mode: 'COPY',
      conflict_policy: 'BACKUP_AND_RESTORE',
      writable: false,
      enabled: true,
    },
  );
  const engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  return { ...f, row, files, definition, engine, secret };
}

async function waitFor(check, deadline = 15000) {
  const until = Date.now() + deadline;
  while (true) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= until) throw Error('ACTUAL_HOOK_PROOF_DEADLINE');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function liveHook(f) {
  return (
    'cat config.txt; printf "\\n"; printf "%s\\n" "$$" > ' +
    quote(path.join(f.root, 'hook-pids')) +
    '; sleep 30 & child=$!; printf "%s\\n" "$child" >> ' +
    quote(path.join(f.root, 'hook-pids')) +
    '; wait "$child"'
  );
}

async function hookPids(f) {
  return waitFor(async () => {
    const text = await fs
      .readFile(path.join(f.root, 'hook-pids'), 'utf8')
      .catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
    const pids = text.trim().split(/\s+/).map(Number);
    return pids.length === 2 &&
      pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)
      ? pids
      : null;
  });
}

function assertHookDead(pids) {
  for (const pid of pids)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const groups = new Set(pids.map(String));
  const live = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([group, status]) => groups.has(group) && !status.startsWith('Z'));
  assert.deepEqual(live, []);
}

async function assertRestored(f, run, expected) {
  assert.equal(run.status, expected, JSON.stringify(run));
  assert.equal(run.active_workspace_id, null);
  assert.equal(run.owner_token, null);
  assert.equal(
    await fs.readFile(path.join(f.roots.path(f.row), 'config.txt'), 'utf8'),
    'ORIGINAL_HOOK_USER_CONFIG',
  );
  const log = await f.engine.logs(run.id);
  assert.equal(log.includes(f.secret), false);
  for (const relative of [
    'tmp/config-materialization',
    'tmp/execution/node-bindings',
    'tmp/execution/workspace-owners',
  ])
    assert.deepEqual(
      await fs.readdir(path.join(f.dataRoot, relative)).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }),
      [],
    );
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 1);
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
  return log;
}

test('actual engine main failure executes AFTER_FAILURE then FINALLY with secret Config restored', async (t) => {
  const f = await hookFixture(
    t,
    'cat config.txt; printf "\\nMAIN_FAILURE\\n"; exit 9',
    () => [
      hook('BEFORE', 'printf "BEFORE_OK\\n"'),
      hook('AFTER_FAILURE', 'cat config.txt; printf "\\nAFTER_FAILURE_OK\\n"'),
      hook('AFTER_SUCCESS', 'printf "WRONG_SUCCESS\\n"'),
      hook('FINALLY', 'printf "FINALLY_OK\\n"'),
    ],
  );
  const queued = await f.engine.submit(f.definition.task.id);
  const run = await f.engine.wait(queued.id);
  const log = await assertRestored(f, run, 'FAILED');
  assert.ok(log.indexOf('MAIN_FAILURE') < log.indexOf('AFTER_FAILURE_OK'));
  assert.ok(log.indexOf('AFTER_FAILURE_OK') < log.indexOf('FINALLY_OK'));
  assert.doesNotMatch(log, /WRONG_SUCCESS/);
  const result = JSON.parse((await f.engine.attempts(run.id))[0].result);
  assert.equal(result.exitCode, 9);
  assert.deepEqual(
    result.hookResults.map((entry) => entry.phase),
    ['BEFORE', 'AFTER_FAILURE', 'FINALLY'],
  );
});

test('actual engine retry starts every BEFORE from pinned ENV and repeats failure/success/finally lifecycle', async (t) => {
  const f = await hookFixture(
    t,
    'printf "MAIN_ATTEMPT_%s:%s\\n" "$PLATFORM_TASK_ATTEMPT" "$HOOK_TRANSIENT"; cat config.txt; printf "\\n"; if [ "$PLATFORM_TASK_ATTEMPT" = 1 ]; then exit 8; fi',
    () => [
      hook(
        'BEFORE',
        'test -z "${HOOK_TRANSIENT+x}" || exit 29; printf \'{"environment":{"set":{"HOOK_TRANSIENT":"derived"}}}\' > "$PLATFORM_HOOK_OUTPUT"; printf "BEFORE_ATTEMPT_%s\\n" "$PLATFORM_TASK_ATTEMPT"',
      ),
      hook(
        'AFTER_FAILURE',
        'printf "AFTER_FAILURE_ATTEMPT_%s\\n" "$PLATFORM_TASK_ATTEMPT"',
      ),
      hook(
        'AFTER_SUCCESS',
        'printf "AFTER_SUCCESS_ATTEMPT_%s\\n" "$PLATFORM_TASK_ATTEMPT"',
      ),
      hook(
        'FINALLY',
        'printf "FINALLY_ATTEMPT_%s\\n" "$PLATFORM_TASK_ATTEMPT"',
      ),
    ],
    { max_attempts: 2, initial_delay_seconds: 0 },
  );
  const queued = await f.engine.submit(f.definition.task.id);
  const run = await f.engine.wait(queued.id);
  const log = await assertRestored(f, run, 'SUCCESS');
  const attempts = await f.engine.attempts(run.id);
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ['FAILED', 'SUCCESS'],
  );
  assert.deepEqual(
    attempts.map((attempt) =>
      JSON.parse(attempt.result).hookResults.map((entry) => entry.phase),
    ),
    [
      ['BEFORE', 'AFTER_FAILURE', 'FINALLY'],
      ['BEFORE', 'AFTER_SUCCESS', 'FINALLY'],
    ],
  );
  for (const mark of [
    'MAIN_ATTEMPT_1:derived',
    'MAIN_ATTEMPT_2:derived',
    'BEFORE_ATTEMPT_1',
    'BEFORE_ATTEMPT_2',
    'FINALLY_ATTEMPT_1',
    'FINALLY_ATTEMPT_2',
  ])
    assert.ok(log.includes(mark), mark);
  assert.equal(run.admission_snapshot, queued.admission_snapshot);
});

for (const operation of ['TIMEOUT', 'CANCELLED']) {
  test(
    'actual engine active BEFORE Hook ' +
      operation +
      ' stops child/descendant and restores original Config',
    async (t) => {
      const f = await hookFixture(t, 'printf "MAIN_MUST_NOT_START\\n"', (f) => [
        hook('BEFORE', liveHook(f), operation === 'TIMEOUT' ? 1 : 30),
        hook('AFTER_FAILURE', 'printf "AFTER_FAILURE_OK\\n"'),
        hook('FINALLY', 'printf "FINALLY_OK\\n"'),
      ]);
      const queued = await f.engine.submit(f.definition.task.id);
      const pending = f.engine.wait(queued.id, 30000);
      const pids = await hookPids(f);
      for (const pid of pids) process.kill(pid, 0);
      if (operation === 'CANCELLED') await f.engine.cancel(queued.id);
      const run = await pending;
      const log = await assertRestored(f, run, operation);
      assertHookDead(pids);
      assert.doesNotMatch(log, /MAIN_MUST_NOT_START/);
      const result = JSON.parse((await f.engine.attempts(run.id))[0].result);
      assert.equal(result.primaryError.phase, 'BEFORE');
      assert.deepEqual(
        result.hookResults.map((entry) => entry.phase),
        ['BEFORE', 'AFTER_FAILURE', 'FINALLY'],
      );
      assert.equal(
        result.hookResults[0].reason,
        operation === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED',
      );
      if (operation === 'TIMEOUT') {
        assert.match(log, /AFTER_FAILURE_OK/);
        assert.match(log, /FINALLY_OK/);
      } else {
        // The retained cancellation intent also reaches later active Hook
        // supervisors. Lifecycle phases run in order, while a cancelled Run
        // does not promise that their shell bodies finish successfully.
        assert.match(log, /\[AFTER_FAILURE\]/);
        assert.match(log, /\[FINALLY\]/);
        process.stdout.write(
          JSON.stringify({ s2_cancel_hook_results: result.hookResults }) + '\n',
        );
        for (const entry of result.hookResults.slice(1))
          assert.ok(
            entry.reason === 'SUCCESS' ||
              entry.reason === 'CANCELLED' ||
              (entry.reason === 'EXIT_NONZERO' && entry.signal === 'SIGTERM'),
            JSON.stringify(entry),
          );
      }
    },
  );
}

function controller(t, f, run, operation) {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 's2-hook-crash-worker.cjs'),
      f.dataRoot,
      String(run.id),
      operation,
    ],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  return { child, done, output: () => output };
}

for (const phase of ['BEFORE', 'FINALLY']) {
  test(
    'actual engine SIGKILL during live ' +
      phase +
      ' Hook retains ownership until fresh-process recovery',
    async (t) => {
      const f = await hookFixture(
        t,
        'printf "main\\n" >> ' +
          quote('main-executed') +
          '; cat config.txt; printf "\\nMAIN_DONE\\n"',
        (f) => [hook(phase, liveHook(f), 30)],
      );
      const queued = await f.engine.submit(f.definition.task.id, {
        submissionKey: 'hook-crash-' + phase,
      });
      await f.engine.close();
      await f.store.close();
      const active = controller(t, f, queued, 'RUN');
      const pids = await hookPids(f);
      for (const pid of pids) process.kill(pid, 0);
      await assert.rejects(
        f.leases.withWorkspace(f.row.id, 'HOOK_COMPETITOR', async () => {}),
        { error_code: 'WORKSPACE_BUSY' },
      );
      active.child.kill('SIGKILL');
      assert.equal((await active.done).signal, 'SIGKILL', active.output());
      const recovery = controller(t, f, queued, 'RECOVER');
      assert.equal((await recovery.done).code, 0, recovery.output());
      f.store = f.track(await WorkspaceStore.open(f.databasePath, f.dataRoot));
      f.engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
      const run = await f.engine.get(queued.id);
      await assertRestored(f, run, 'INTERRUPTED');
      assert.equal(run.admission_snapshot, queued.admission_snapshot);
      assert.deepEqual(
        (await f.engine.attempts(run.id)).map((attempt) => attempt.status),
        ['INTERRUPTED'],
      );
      assertHookDead(pids);
      const main = await fs
        .readFile(path.join(f.roots.path(f.row), 'main-executed'), 'utf8')
        .catch((error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
      assert.equal(main, phase === 'FINALLY' ? 'main\n' : '');
    },
  );
}
