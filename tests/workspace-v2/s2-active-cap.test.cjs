const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
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
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');

async function createActiveCapFixture(t) {
  const f = await createFixture(t);
  const secondStore = f.track(
    await WorkspaceStore.open(f.databasePath, f.dataRoot),
  );
  const engines = [
    f.track(new TaskExecutionService(f.store, f.roots, f.leases)),
    f.track(new TaskExecutionService(secondStore, f.roots, f.leases)),
  ];
  const gate = path.join(f.root, 'actual-children');
  await fs.mkdir(gate, { mode: 0o700 });
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  const tasks = new TaskService(f.store, f.roots, f.leases);
  const runs = [];
  for (let index = 0; index < 10; index++) {
    const workspace = await lifecycle.createLocal({
      name: 'active cap ' + index,
      requestKey: 'active-cap-' + index,
    });
    await files.create(
      workspace.id,
      'main.sh',
      'printf "%s\\n" "$$" > "$1/started-$2"\nprintf "ACTUAL_ACTIVE_CHILD_%s\\n" "$2"\nwhile [ ! -f "$1/release" ]; do sleep .02; done\nprintf "ACTUAL_ACTIVE_FINISHED_%s\\n" "$2"\n',
    );
    const task = await tasks.create({
      name: 'active cap ' + index,
      arguments: [gate, String(index)],
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: workspace.id,
        relative_entrypoint: 'main.sh',
        language: 'SHELL',
        cwd_mode: 'WORKSPACE_ROOT',
        cwd_relative_path: null,
      },
      execution: { concurrency: 'ALLOW', timeout_seconds: 60 },
    });
    runs.push(
      await engines[index % 2].submit(task.task.id, {
        submissionKey: 'actual-cap-' + index,
      }),
    );
  }
  return { ...f, engines, gate, runs };
}

test('two independent candidate controllers enforce the global eight-active cap before admitting later real Workspace children', async (t) => {
  const f = await createActiveCapFixture(t);
  const terminal = new Set([
    'SUCCESS',
    'FAILED',
    'TIMEOUT',
    'CANCELLED',
    'INTERRUPTED',
    'SKIPPED',
    'RECOVERY_REQUIRED',
  ]);
  let maximum = 0;
  try {
    const deadline = Date.now() + 30000;
    while (true) {
      await Promise.all(f.engines.map((engine) => engine.tick()));
      const active = (
        await f.store.all(
          "SELECT COUNT(*) n FROM TaskRuns WHERE status IN ('RESOLVING','RUNNING')",
        )
      )[0].n;
      assert.ok(
        active <= 8,
        'durable cross-controller claims must never exceed eight',
      );
      maximum = Math.max(maximum, active);
      const started = (await fs.readdir(f.gate)).filter((name) =>
        name.startsWith('started-'),
      );
      assert.ok(
        started.length <= 8,
        'a ninth real child must remain queued while eight are held',
      );
      if (started.length === 8) break;
      assert.ok(
        Date.now() < deadline,
        'eight actual Workspace children must become active',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(maximum, 8);
    for (let pass = 0; pass < 3; pass++) {
      await Promise.all(f.engines.map((engine) => engine.tick()));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        (
          await f.store.all(
            "SELECT COUNT(*) n FROM TaskRuns WHERE status IN ('RESOLVING','RUNNING')",
          )
        )[0].n,
        8,
      );
      assert.equal(
        (await fs.readdir(f.gate)).filter((name) => name.startsWith('started-'))
          .length,
        8,
      );
    }
    const queued = await f.store.all(
      "SELECT * FROM TaskRuns WHERE status='QUEUED'",
    );
    assert.equal(queued.length, 2);
    for (const run of queued)
      assert.equal((await f.engines[0].attempts(run.id)).length, 0);
    for (const name of (await fs.readdir(f.gate)).filter((name) =>
      name.startsWith('started-'),
    )) {
      const pid = Number(
        (await fs.readFile(path.join(f.gate, name), 'utf8')).trim(),
      );
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.doesNotThrow(
        () => process.kill(pid, 0),
        'each held marker represents a live actual child',
      );
    }
    await fs.writeFile(
      path.join(f.gate, 'release'),
      'release actual children',
      { mode: 0o600 },
    );
    const finishedBy = Date.now() + 30000;
    while (true) {
      await Promise.all(f.engines.map((engine) => engine.tick()));
      const rows = await f.store.all('SELECT * FROM TaskRuns ORDER BY id');
      assert.ok(
        rows.filter((run) => ['RESOLVING', 'RUNNING'].includes(run.status))
          .length <= 8,
      );
      if (rows.every((run) => terminal.has(run.status))) {
        for (const run of rows) {
          assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
          const attempts = await f.engines[0].attempts(run.id);
          assert.equal(attempts.length, 1);
          assert.equal(attempts[0].exit_code, 0);
          assert.equal(JSON.parse(run.result).cleanupResult, 'SUCCESS');
          assert.equal(run.owner_token, null);
          assert.equal(run.active_workspace_id, null);
          const logs = await f.engines[0].logs(run.id);
          assert.equal(logs.match(/ACTUAL_ACTIVE_CHILD_/g)?.length, 1);
          assert.match(logs, /ACTUAL_ACTIVE_FINISHED_/);
        }
        break;
      }
      assert.ok(
        Date.now() < finishedBy,
        'all accepted durable tickets must finish once capacity is released',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      (await fs.readdir(f.gate)).filter((name) => name.startsWith('started-'))
        .length,
      10,
    );
    assert.equal(
      (await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
      10,
    );
    assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
    process.stdout.write(
      JSON.stringify({
        s2_active_cap: 8,
        actual_workspaces: 10,
        controllers: 2,
        independent_sqlite_connections: true,
        maximum_active: maximum,
        final_successes: 10,
      }) + '\n',
    );
  } finally {
    await fs
      .writeFile(path.join(f.gate, 'release'), 'test cleanup', { mode: 0o600 })
      .catch(() => {});
    await Promise.all(f.engines.map((engine) => engine.close()));
  }
});
