const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  WorkspaceAttemptRunner,
} = require('../../back/services/taskExecutionV2/runner');
const {
  WorkspaceMaterialization,
} = require('../../back/services/taskExecutionV2/materialization');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const { materializationFixture } = require('./s2-materialization-fixture.cjs');

const hook = (id, phase, command) => ({
  id,
  task_id: 1,
  name: phase,
  phase,
  command,
  cwd_base: 'TASK_CWD',
  position: id,
  timeout_seconds: 3,
  failure_policy: 'FAIL_EXECUTION',
  enabled: true,
  version: 1,
});

test('real RunnerV2 and hook lifecycle use Workspace config, mask generated secrets, and restore original bytes', async (t) => {
  const f = await materializationFixture(t);
  const dynamic = 'S2_UNIQUE_HOOK_GENERATED_SECRET';
  f.context.hookSnapshot = [
    hook(
      1,
      'BEFORE',
      'printf \'{"environment":{"set":{"HOOK_SECRET":"' +
        dynamic +
        '"},"secret":["HOOK_SECRET"]}}\' > "$PLATFORM_HOOK_OUTPUT"; printf "BEFORE:%s\\n" "' +
        dynamic +
        '"',
    ),
    hook(2, 'AFTER_SUCCESS', 'printf "AFTER_SUCCESS\\n"'),
    hook(3, 'FINALLY', 'printf "FINALLY\\n"'),
  ];
  let log = '';
  const runner = new WorkspaceAttemptRunner(f.store, f.roots);
  const result = await f.leases.withWorkspace(
    f.row.id,
    'S2_ACTUAL_RUNNER',
    (lease) =>
      runner.run(f.context, 1, lease, [], async (text) => {
        log += text;
      }),
  );
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.exitCode, 0);
  assert.equal(log.includes(f.secret), false);
  assert.equal(log.includes(dynamic), false);
  assert.match(log, /BEFORE:\*{8}/);
  assert.match(log, /MAIN:\*{8}/);
  assert.ok(log.indexOf('[BEFORE]') < log.indexOf('[MAIN]'));
  assert.ok(log.indexOf('AFTER_SUCCESS') < log.indexOf('FINALLY'));
  assert.equal(
    await fs.readFile(
      path.join(f.context.workspace.workspaceRoot, 'config.txt'),
      'utf8',
    ),
    'original private user config\n',
  );
  assert.deepEqual(
    await fs.readdir(path.join(f.dataRoot, 'tmp/config-materialization')),
    [],
  );
  assert.equal(
    (await f.files.read(f.row.id, 'config.txt')).content,
    'original private user config\n',
  );
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  await backup.validateRoot(
    (
      await backup.snapshot(await backup.create())
    ).root,
  );
});

test('actual task failure, timeout, cancellation and before-hook failure retain cleanup and retry semantics', async (t) => {
  for (const kind of ['failure', 'timeout', 'cancel', 'hook']) {
    await t.test(kind, async (t) => {
      const f = await materializationFixture(t, {
        script:
          kind === 'failure'
            ? 'printf "FAILED\\n"; exit 7'
            : 'printf "STARTED\\n"; sleep 10',
      });
      if (kind === 'timeout') f.context.settings.timeout_seconds = 1;
      if (kind === 'hook')
        f.context.hookSnapshot = [
          hook(1, 'BEFORE', 'exit 6'),
          hook(2, 'FINALLY', 'printf "FINALLY\\n"'),
        ];
      let log = '';
      const runner = new WorkspaceAttemptRunner(f.store, f.roots);
      const result = await f.leases.withWorkspace(
        f.row.id,
        'S2_FAILURE',
        (lease) =>
          runner.run(f.context, 1, lease, [], async (text) => {
            log += text;
            if (kind === 'cancel' && text.includes('STARTED')) runner.cancel();
          }),
      );
      assert.equal(
        result.status,
        kind === 'timeout'
          ? 'TIMEOUT'
          : kind === 'cancel'
          ? 'CANCELLED'
          : 'FAILED',
      );
      assert.equal(result.cleanupResult, 'SUCCESS');
      assert.equal(runner.retry(result, f.context), kind !== 'cancel');
      assert.equal(
        await fs.readFile(
          path.join(f.context.workspace.workspaceRoot, 'config.txt'),
          'utf8',
        ),
        'original private user config\n',
      );
      if (kind === 'hook') {
        assert.equal(log.includes('STARTED'), false);
        assert.match(log, /FINALLY/);
      }
    });
  }
});

test('TASK_CWD config anchor uses custom CWD while hook task directory stays at the entrypoint directory', async (t) => {
  const f = await materializationFixture(t);
  await f.files.createDirectory(f.row.id, 'scripts');
  await f.files.createDirectory(f.row.id, 'run');
  await f.files.create(
    f.row.id,
    'scripts/entry.sh',
    'printf "DIR:%s\\n" "$PLATFORM_TASK_DIR"; pwd; cat custom.txt',
  );
  await f.files.create(f.row.id, 'run/custom.txt', 'custom original');
  const root = f.context.workspace.workspaceRoot;
  f.context.source.absoluteEntrypoint = path.join(root, 'scripts/entry.sh');
  f.context.source.relativeEntrypoint = 'scripts/entry.sh';
  f.context.source.cwd = path.join(root, 'run');
  f.context.source.cwdMode = 'CUSTOM_RELATIVE';
  f.context.source.cwdRelativePath = 'run';
  f.context.workspace.taskDir = path.join(root, 'scripts');
  f.context.workspace.cwd = path.join(root, 'run');
  f.context.configSnapshot[0].binding.target_base = 'TASK_CWD';
  f.context.configSnapshot[0].binding.target_path = 'custom.txt';
  const runner = new WorkspaceAttemptRunner(f.store, f.roots);
  let log = '';
  const result = await f.leases.withWorkspace(
    f.row.id,
    'S2_CUSTOM_CWD',
    (lease) =>
      runner.run(f.context, 1, lease, [], async (text) => {
        log += text;
      }),
  );
  assert.equal(result.status, 'SUCCESS');
  assert.match(log, /DIR:.*\/scripts/);
  assert.match(log, /\/run/);
  assert.equal(log.includes(f.secret), false);
  assert.equal(
    await fs.readFile(path.join(root, 'run/custom.txt'), 'utf8'),
    'custom original',
  );
  await assert.rejects(fs.lstat(path.join(root, 'scripts/custom.txt')), {
    code: 'ENOENT',
  });
});

test('Node temporary binding shares Workspace resource key, blocks editor/backup, and never removes a replacement directory', async (t) => {
  const f = await materializationFixture(t, { node: true });
  const service = new WorkspaceMaterialization(f.store, f.roots);
  await f.leases.withWorkspace(f.row.id, 'S2_NODE_BINDING', async (lease) => {
    const materialized = await service.prepare(f.context, lease);
    const modules = path.join(
      f.context.workspace.workspaceRoot,
      'node_modules',
    );
    assert.equal(await fs.readlink(modules), f.context.runtime.nodeModulesRoot);
    const journal = path.join(
      f.dataRoot,
      'tmp/execution/node-bindings',
      `workspace-${f.row.id}.json`,
    );
    assert.equal((await fs.stat(journal)).isFile(), true);
    await assert.rejects(f.files.read(f.row.id, 'config.txt'), {
      error_code: 'WORKSPACE_BUSY',
    });
    const backup = new WorkspaceBackupService(
      f.store,
      f.roots,
      f.leases,
      f.backupRoot,
    );
    await assert.rejects(backup.create(50));
    await fs.unlink(modules);
    await fs.mkdir(modules, { mode: 0o700 });
    await fs.writeFile(path.join(modules, 'unknown-user-file'), 'must remain');
    await assert.rejects(materialized.cleanup(), {
      error_code: 'WORKSPACE_RECOVERY_REQUIRED',
    });
    assert.equal(
      await fs.readFile(path.join(modules, 'unknown-user-file'), 'utf8'),
      'must remain',
    );
    assert.equal(
      await fs.readFile(
        path.join(f.context.workspace.workspaceRoot, 'config.txt'),
        'utf8',
      ),
      'original private user config\n',
    );
  });
});

test('preparation exceptions reconcile durable Node/Config intents instead of leaving falsely completed work', async (t) => {
  for (const phase of [
    'NODE_JOURNAL_DURABLE',
    'CONFIG_JOURNAL_DURABLE',
    'DURING_CLEANUP',
  ]) {
    const f = await materializationFixture(t, { node: true });
    const runner = new WorkspaceAttemptRunner(f.store, f.roots, {
      fault: async (current) => {
        if (current === phase) throw Error('injected preparation interruption');
      },
    });
    const result = await f.leases.withWorkspace(
      f.row.id,
      'S2_PREPARATION_FAILURE',
      (lease) => runner.run(f.context, 1, lease, [], async () => {}),
    );
    assert.equal(
      result.status,
      phase === 'CONFIG_JOURNAL_DURABLE' ? 'RECOVERY_REQUIRED' : 'FAILED',
      JSON.stringify({ phase, result }),
    );
    assert.equal(
      result.cleanupResult,
      phase === 'CONFIG_JOURNAL_DURABLE' ? 'RECOVERY_REQUIRED' : 'SUCCESS',
    );
    assert.equal(
      await fs.readFile(
        path.join(f.context.workspace.workspaceRoot, 'config.txt'),
        'utf8',
      ),
      'original private user config\n',
    );
    await assert.rejects(
      fs.lstat(path.join(f.context.workspace.workspaceRoot, 'node_modules')),
      { code: 'ENOENT' },
    );
    assert.deepEqual(
      await fs.readdir(path.join(f.dataRoot, 'tmp/config-materialization')),
      [],
    );
    assert.deepEqual(
      await fs.readdir(path.join(f.dataRoot, 'tmp/execution/node-bindings')),
      [],
    );
  }
});

test('candidate hook supervisor and main discard loader variables and untrusted PATH from definitions or BEFORE output', async (t) => {
  const f = await materializationFixture(t, {
    script:
      'test -z "$NODE_OPTIONS" && test -z "$PYTHONPATH" && test -z "$BASH_ENV" && printf "CLEAN_MAIN\\n"',
  });
  const marker = path.join(f.root, 'loader-should-not-execute');
  const loader = path.join(f.root, 'malicious-loader.sh');
  await fs.writeFile(loader, 'touch "' + marker + '"');
  f.context.environmentSnapshot.variables = {
    PATH: f.root,
    BASH_ENV: loader,
    ENV: loader,
    PYTHONSTARTUP: loader,
    PYTHONPATH: f.root,
    NODE_OPTIONS: '--require=' + loader,
    LD_PRELOAD: loader,
    DYLD_INSERT_LIBRARIES: loader,
  };
  f.context.hookSnapshot = [
    hook(
      1,
      'BEFORE',
      'test -z "$NODE_OPTIONS" && test -z "$PYTHONPATH" && test -z "$BASH_ENV" && printf \'{"environment":{"set":{"NODE_OPTIONS":"--require=evil","PYTHONPATH":"evil","BASH_ENV":"evil"}}}\' > "$PLATFORM_HOOK_OUTPUT"',
    ),
    hook(
      2,
      'AFTER_SUCCESS',
      'test -z "$NODE_OPTIONS" && test -z "$PYTHONPATH" && test -z "$BASH_ENV" && printf "CLEAN_HOOK\\n"',
    ),
  ];
  let log = '';
  const runner = new WorkspaceAttemptRunner(f.store, f.roots);
  const result = await f.leases.withWorkspace(f.row.id, 'S2_LOADERS', (lease) =>
    runner.run(f.context, 1, lease, [], async (text) => {
      log += text;
    }),
  );
  assert.equal(result.status, 'SUCCESS');
  assert.match(log, /CLEAN_MAIN/);
  assert.match(log, /CLEAN_HOOK/);
  await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });
});

test('materialization capacity preflight refuses before source, Node link or owner-journal publication', async (t) => {
  const f = await materializationFixture(t, { node: true });
  const service = new WorkspaceMaterialization(f.store, f.roots);
  const originalStatfs = fs.statfs;
  try {
    fs.statfs = async () => ({ bavail: 0, bsize: 4096 });
    await f.leases.withWorkspace(f.row.id, 'S2_DISK_BUDGET', async (lease) => {
      await assert.rejects(service.prepare(f.context, lease), {
        error_code: 'DISK_BUDGET_EXCEEDED',
      });
    });
  } finally {
    fs.statfs = originalStatfs;
  }
  assert.equal(
    await fs.readFile(
      path.join(f.context.workspace.workspaceRoot, 'config.txt'),
      'utf8',
    ),
    'original private user config\n',
  );
  await assert.rejects(
    fs.lstat(path.join(f.context.workspace.workspaceRoot, 'node_modules')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.lstat(path.join(f.dataRoot, 'tmp/execution/workspace-owners')),
    { code: 'ENOENT' },
  );
});

test('durable owner proof rejects a newly owned replacement root before restoring any old config bytes', async (t) => {
  const f = await materializationFixture(t, { node: true });
  const service = new WorkspaceMaterialization(f.store, f.roots);
  await f.leases.withWorkspace(
    f.row.id,
    'S2_STALE_ROOT_PROOF',
    async (lease) => {
      await service.prepare(f.context, lease);
      const canonical = f.roots.path(f.row),
        prior = canonical + '-prior';
      await fs.rename(canonical, prior);
      await fs.mkdir(canonical, { mode: 0o700 });
      const marker = JSON.parse(
        await fs.readFile(
          path.join(prior, '.platform-workspace-owner.json'),
          'utf8',
        ),
      );
      const replacement = await fs.lstat(canonical);
      marker.dev = replacement.dev;
      marker.ino = replacement.ino;
      await fs.writeFile(
        path.join(canonical, '.platform-workspace-owner.json'),
        JSON.stringify(marker),
        { mode: 0o600 },
      );
      await fs.writeFile(
        path.join(canonical, 'unknown-user-file'),
        'must survive',
      );
      await f.store.run(
        'UPDATE Workspaces SET root_device=?,root_inode=? WHERE id=?',
        [replacement.dev, replacement.ino, f.row.id],
      );
      const newRow = await f.store.workspace(f.row.id);
      await f.roots.requireOwned(newRow);
      await assert.rejects(service.recover(newRow, lease), {
        error_code: 'WORKSPACE_RECOVERY_REQUIRED',
      });
      await assert.rejects(fs.lstat(path.join(canonical, 'config.txt')), {
        code: 'ENOENT',
      });
      assert.equal(
        await fs.readFile(path.join(canonical, 'unknown-user-file'), 'utf8'),
        'must survive',
      );
      assert.equal(
        await fs.readFile(path.join(prior, 'config.txt'), 'utf8'),
        f.secret,
      );
      const owner = path.join(
        f.dataRoot,
        'tmp/execution/workspace-owners',
        `workspace-${f.row.id}.json`,
      );
      assert.equal((await fs.stat(owner)).isFile(), true);
    },
  );
});

test('materialization rejects plans whose recovery journal would exceed the existing one-MiB reader bound', async (t) => {
  const f = await materializationFixture(t, { node: true });
  const item = f.context.configSnapshot[0];
  f.context.configSnapshot = Array.from({ length: 6000 }, (_, index) => ({
    ...item,
    binding: {
      ...item.binding,
      id: index + 1,
      target_path: 'new-config-' + index,
    },
  }));
  const service = new WorkspaceMaterialization(f.store, f.roots);
  await f.leases.withWorkspace(f.row.id, 'S2_JOURNAL_BUDGET', async (lease) => {
    await assert.rejects(service.prepare(f.context, lease), {
      error_code: 'WORKSPACE_QUOTA_EXCEEDED',
    });
  });
  assert.equal(
    await fs.readFile(
      path.join(f.context.workspace.workspaceRoot, 'config.txt'),
      'utf8',
    ),
    'original private user config\n',
  );
  await assert.rejects(
    fs.lstat(path.join(f.context.workspace.workspaceRoot, 'node_modules')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.lstat(path.join(f.dataRoot, 'tmp/execution/workspace-owners')),
    { code: 'ENOENT' },
  );
});

test('unknown Node journal staging bytes remain protected by the owner proof after known source cleanup', async (t) => {
  const f = await materializationFixture(t, { node: true });
  const service = new WorkspaceMaterialization(f.store, f.roots);
  await f.leases.withWorkspace(
    f.row.id,
    'S2_UNKNOWN_NODE_TEMP',
    async (lease) => {
      const prepared = await service.prepare(f.context, lease);
      const unknown = path.join(
        f.dataRoot,
        'tmp/execution/node-bindings',
        `workspace-${f.row.id}.json.tmp-${'a'.repeat(20)}`,
      );
      await fs.writeFile(unknown, 'unproven staged journal bytes', {
        mode: 0o600,
      });
      await assert.rejects(prepared.cleanup(), {
        error_code: 'WORKSPACE_RECOVERY_REQUIRED',
      });
      assert.equal(
        await fs.readFile(unknown, 'utf8'),
        'unproven staged journal bytes',
      );
      assert.equal(
        await fs.readFile(
          path.join(f.context.workspace.workspaceRoot, 'config.txt'),
          'utf8',
        ),
        'original private user config\n',
      );
      assert.equal(
        (
          await fs.stat(
            path.join(
              f.dataRoot,
              'tmp/execution/workspace-owners',
              `workspace-${f.row.id}.json`,
            ),
          )
        ).isFile(),
        true,
      );
      await assert.rejects(
        service.recover(await f.store.workspace(f.row.id), lease),
        { error_code: 'WORKSPACE_RECOVERY_REQUIRED' },
      );
    },
  );
});
