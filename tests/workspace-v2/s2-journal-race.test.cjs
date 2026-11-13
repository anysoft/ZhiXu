const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { createFixture } = require('./fixture.cjs');
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
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');

test('S2 actual cleanup between journal listing and owner lookup never fences an unrelated Workspace; surviving orphan proof remains blocked', async (t) => {
  const f = await createFixture(t),
    life = new WorkspaceLifecycleService(f.store, f.roots, f.leases),
    files = new WorkspaceFileService(f.store, f.roots, f.leases),
    tasks = new TaskService(f.store, f.roots, f.leases),
    engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  const a = await life.createLocal({
      name: 'cleanup owner',
      requestKey: 'cleanup-owner',
    }),
    b = await life.createLocal({
      name: 'independent reader',
      requestKey: 'independent-reader',
    }),
    release = path.join(f.root, 'release-real-child');
  await files.create(
    a.id,
    'owner.sh',
    'printf "REAL_CHILD_OWNED\\n"\nwhile [ ! -f "$1" ]; do sleep 0.02; done\n',
  );
  await files.create(b.id, 'reader.sh', 'printf "INDEPENDENT_REAL_CHILD\\n"\n');
  const input = (row, name) => ({
    name,
    arguments: row.id === a.id ? [release] : [],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: row.id,
      relative_entrypoint: name + '.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution: { concurrency: 'ALLOW' },
  });
  const first = await tasks.create(input(a, 'owner'));
  const run = await engine.submit(first.task.id);
  const deadline = Date.now() + 15000;
  while (!(await engine.logs(run.id)).includes('REAL_CHILD_OWNED')) {
    assert.ok(Date.now() < deadline);
    await engine.tick();
    await new Promise((r) => setTimeout(r, 20));
  }
  const base = path.join(f.dataRoot, 'tmp/execution/workspace-owners'),
    ownerName = `workspace-${a.id}.json`;
  assert.ok((await fs.readdir(base)).includes(ownerName));
  const original = fs.readdir;
  let captured = false;
  fs.readdir = async function (filename, ...args) {
    const result = await original.call(fs, filename, ...args);
    if (
      !captured &&
      filename === base &&
      Array.isArray(result) &&
      result.includes(ownerName)
    ) {
      captured = true;
      await fs.writeFile(release, 'release actual candidate Runner', {
        mode: 0o600,
      });
      assert.equal((await engine.wait(run.id, 15000)).status, 'SUCCESS');
      assert.equal(
        await fs.lstat(path.join(base, ownerName)).catch(() => null),
        null,
      );
    }
    return result;
  };
  let second;
  try {
    second = await tasks.create(input(b, 'reader'));
  } finally {
    fs.readdir = original;
    await fs.writeFile(release, 'released', { mode: 0o600 });
  }
  assert.equal(
    captured,
    true,
    'must return an actually stale canonical owner filename',
  );
  assert.equal((await f.store.workspace(b.id)).lifecycle_state, 'READY');
  const secondRun = await engine.submit(second.task.id);
  assert.equal((await engine.wait(secondRun.id, 15000)).status, 'SUCCESS');
  assert.match(await engine.logs(secondRun.id), /INDEPENDENT_REAL_CHILD/);
  const orphan = path.join(base, ownerName);
  await fs.writeFile(orphan, '{}', { mode: 0o600 });
  await assert.rejects(files.read(b.id, 'reader.sh'), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
  assert.equal(await fs.readFile(orphan, 'utf8'), '{}');
  await assert.rejects(
    new WorkspaceBackupService(f.store, f.roots, f.leases, f.backupRoot).create(
      50,
    ),
    { error_code: 'BACKUP_RECOVERY_REQUIRED' },
  );
  assert.equal((await f.store.workspace(b.id)).lifecycle_state, 'READY');
  assert.equal(
    await fs.readFile(path.join(f.roots.path(b), 'reader.sh'), 'utf8'),
    'printf "INDEPENDENT_REAL_CHILD\\n"\n',
  );
});
