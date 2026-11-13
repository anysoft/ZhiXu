const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createFixture, insertTaskSource } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const {
  WorkspaceLeaseService,
} = require('../../back/services/workspaceV2/lease');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');
const { scanWorkspace } = require('../../back/services/workspaceV2/inventory');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function source(t, options = {}) {
  const f = await createFixture(t);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const row = await lifecycle.createLocal({
    name: 'isolated storage',
    requestKey: 'storage-create',
  });
  return {
    ...f,
    row,
    lifecycle,
    files: new WorkspaceFileService(f.store, f.roots, f.leases, options),
  };
}
function worker(f, mode, argument) {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      path.join(__dirname, 'storage-worker.cjs'),
      mode,
      f.dataRoot,
      String(f.row.id),
      argument,
    ],
    { cwd: f.projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let error = '';
  child.stderr.on('data', (data) => {
    error += data.toString();
  });
  return { child, exited: once(child, 'exit'), error: () => error };
}
async function waitUntil(action, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await action()) return;
    await pause(15);
  }
  throw Error('TEST_CONDITION_TIMEOUT');
}

test('durable file CRUD preserves CAS, BOM/CRLF/mode and hashes actual inventory', async (t) => {
  const f = await source(t);
  const id = f.row.id;
  await f.files.createDirectory(id, 'code');
  let value = await f.files.create(id, 'code/main.py', '\uFEFFone\r\ntwo\r\n');
  // Creation normalizes LF, while an existing CRLF source keeps its exact style.
  const target = path.join(f.roots.path(f.row), 'code/main.py');
  await fs.writeFile(target, '\uFEFFone\r\ntwo\r\n');
  await fs.chmod(target, 0o751);
  value = await f.files.read(id, 'code/main.py');
  assert.equal(value.bom, true);
  assert.equal(value.eol, 'CRLF');
  const priorRevision = (await f.store.workspace(id)).content_revision;
  value = await f.files.save(id, 'code/main.py', 'new\ntext\n', value.hash);
  assert.equal(await fs.readFile(target, 'utf8'), '\uFEFFnew\r\ntext\r\n');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o751);
  assert.equal(
    (await f.store.workspace(id)).content_revision,
    priorRevision + 1,
  );
  await assert.rejects(
    f.files.save(id, 'code/main.py', 'stale', '0'.repeat(64)),
    { error_code: 'WORKSPACE_FILE_CONFLICT' },
  );
  assert.equal((await f.store.workspace(id)).lifecycle_state, 'READY');
  value = await f.files.save(id, 'code/main.py', 'current\ntext\n', value.hash);
  await f.files.create(id, 'collision.py', 'kept');
  await assert.rejects(
    f.files.rename(id, 'code/main.py', 'collision.py', value.hash),
    { error_code: 'WORKSPACE_DESTINATION_EXISTS' },
  );
  assert.equal(
    await fs.readFile(path.join(f.roots.path(f.row), 'collision.py'), 'utf8'),
    'kept',
  );
  const renamed = await f.files.rename(
    id,
    'code/main.py',
    'code/renamed.py',
    value.hash,
  );
  assert.equal(renamed.path, 'code/renamed.py');
  const tree = await f.files.tree(id, 'code');
  assert.deepEqual(
    tree.items.map((item) => item.path),
    ['code/renamed.py'],
  );
  await f.files.remove(id, 'code/renamed.py', value.hash);
  const directory = (await f.files.tree(id)).items.find(
    (item) => item.path === 'code',
  );
  await f.files.remove(id, 'code', directory.identity);
  const row = await f.store.workspace(id);
  const inventory = await f.leases.withWorkspace(id, 'VERIFY', () =>
    scanWorkspace(f.roots.path(row), 'LOCAL'),
  );
  assert.equal(inventory.hash, row.content_inventory_hash);
  assert.equal(inventory.fileCount, 1);
  assert.deepEqual(
    inventory.entries.map((entry) => entry.path),
    ['collision.py'],
  );
});

test('text, source, entry, depth and search budgets are independently enforced', async (t) => {
  const f = await source(t, {
    limits: {
      editTextMaxBytes: 8,
      maxWorkspaceBytes: 16,
      maxWorkspaceEntries: 3,
      maxDirectoryDepth: 2,
      searchMaxEntries: 2,
      searchMaxBytes: 4,
      searchMaxFileBytes: 4,
      searchMaxMatches: 1,
    },
  });
  const id = f.row.id;
  await assert.rejects(f.files.create(id, 'large.txt', '123456789'), {
    error_code: 'WORKSPACE_FILE_TOO_LARGE',
  });
  await f.files.create(id, 'a.txt', 'hit\n');
  await f.files.create(id, 'b.txt', 'hit\n');
  await f.files.create(id, 'c.txt', '12345678');
  await assert.rejects(f.files.create(id, 'd.txt', ''), {
    error_code: 'WORKSPACE_QUOTA_EXCEEDED',
  });
  await assert.rejects(f.files.create(id, 'too/deep/path', ''), {
    error_code: 'WORKSPACE_QUOTA_EXCEEDED',
  });
  const result = await f.files.search(id, 'hit', true);
  assert.equal(result.truncated, true);
  assert.equal(result.items.length, 1);
  assert.ok(result.scanned <= 2);
  assert.ok(result.bytes <= 4);
  const sourceLimit = new WorkspaceFileService(f.store, f.roots, f.leases, {
    limits: { maxSourceFileBytes: 4 },
  });
  await assert.rejects(sourceLimit.read(id, 'c.txt'), {
    error_code: 'WORKSPACE_FILE_TOO_LARGE',
  });
  assert.equal(
    (
      await f.store.all(
        "SELECT COUNT(*) count FROM WorkspaceOperations WHERE operation_type='FILE_MUTATION' AND status='RECOVERY_REQUIRED'",
      )
    )[0].count,
    0,
  );
});

test('referenced entry and its parent cannot be renamed or deleted', async (t) => {
  const f = await source(t);
  const id = f.row.id;
  await f.files.createDirectory(id, 'code');
  const file = await f.files.create(id, 'code/main.py', 'print(1)');
  const directory = (await f.files.tree(id)).items.find(
    (item) => item.path === 'code',
  );
  await insertTaskSource(f.store, id, 'code/main.py');
  await assert.rejects(f.files.remove(id, 'code/main.py', file.hash), {
    error_code: 'WORKSPACE_FILE_REFERENCED',
  });
  await assert.rejects(
    f.files.rename(id, 'code', 'elsewhere', directory.identity),
    { error_code: 'WORKSPACE_FILE_REFERENCED' },
  );
  await assert.rejects(f.files.remove(id, 'code', directory.identity), {
    error_code: 'WORKSPACE_FILE_REFERENCED',
  });
});

test('unsafe names, links and special inodes fail closed without reading external bytes', async (t) => {
  const f = await source(t);
  const id = f.row.id;
  const root = f.roots.path(f.row);
  for (const relative of [
    '../escape',
    '/tmp/escape',
    'a\\b',
    '%2e%2e/escape',
    '%252e%252e/escape',
    '.git/config',
    '.platform-workspace-user',
    'a\u0000b',
  ])
    await assert.rejects(
      Promise.resolve().then(() => f.files.read(id, relative)),
      (error) => /^WORKSPACE_PATH_/.test(error.error_code),
    );
  const outside = path.join(f.root, 'outside');
  await fs.writeFile(outside, 'private-outside');
  await fs.symlink(outside, path.join(root, 'link'));
  await assert.rejects(f.files.tree(id), {
    error_code: 'WORKSPACE_PATH_FORBIDDEN',
  });
  await fs.unlink(path.join(root, 'link'));
  await fs.link(outside, path.join(root, 'hardlink'));
  await assert.rejects(f.files.read(id, 'hardlink'), {
    error_code: 'WORKSPACE_PATH_FORBIDDEN',
  });
  await fs.unlink(path.join(root, 'hardlink'));
  execFileSync('mkfifo', [path.join(root, 'fifo')]);
  await assert.rejects(f.files.tree(id), {
    error_code: 'WORKSPACE_PATH_FORBIDDEN',
  });
  await fs.unlink(path.join(root, 'fifo'));
  execFileSync('/usr/bin/python3', [
    '-I',
    '-S',
    '-c',
    'import os,socket,sys;os.chdir(sys.argv[1]);s=socket.socket(socket.AF_UNIX);s.bind("socket");s.close()',
    root,
  ]);
  await assert.rejects(f.files.tree(id), {
    error_code: 'WORKSPACE_PATH_FORBIDDEN',
  });
  await fs.unlink(path.join(root, 'socket'));
  await fs.mkdir(path.join(root, '.platform-workspace-unknown'), {
    mode: 0o700,
  });
  await assert.rejects(f.files.tree(id), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
  assert.equal(await fs.readFile(outside, 'utf8'), 'private-outside');
});

test('root replacement and residual configuration or binding journals block source access', async (t) => {
  const f = await source(t);
  const root = f.roots.path(f.row);
  await f.files.create(f.row.id, 'main.py', 'source');
  await fs.rename(root, root + '-original');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.copyFile(
    path.join(root + '-original', '.platform-workspace-owner.json'),
    path.join(root, '.platform-workspace-owner.json'),
  );
  await fs.chmod(path.join(root, '.platform-workspace-owner.json'), 0o600);
  await assert.rejects(f.files.tree(f.row.id), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
  await fs.rmdir(root).catch(async () => {
    await fs.rm(root, { recursive: true });
  });
  await fs.rename(root + '-original', root);
  const residual = await f.roots.directory(
    'tmp/config-materialization/unknown-nested',
    true,
  );
  await fs.writeFile(path.join(residual, 'secret-journal.json'), '{}', {
    mode: 0o600,
  });
  await assert.rejects(f.files.read(f.row.id, 'main.py'), {
    error_code: 'WORKSPACE_RECOVERY_REQUIRED',
  });
});

test('Workspace EX is shared across service instances and backup waits for admission lifetime', async (t) => {
  const f = await source(t);
  let entered, release;
  const held = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const holding = f.leases.withWorkspace(f.row.id, 'HELD', async (lease) => {
    await lease.assertHeld();
    entered();
    await gate;
  });
  await held;
  const second = new WorkspaceLeaseService(
    f.dataRoot,
    new PlatformBackupBarrier(f.controlRoot),
  );
  assert.equal((await second.probeWorkspace(f.row.id)).busy, true);
  await second.withWorkspace(f.row.id + 1, 'INDEPENDENT', async () => {});
  let snapshotted = false;
  const snapshot = f.barrier.snapshot(
    async () => true,
    async () => {
      snapshotted = true;
    },
    2000,
  );
  t.after(async () => {
    release();
    await holding.catch(() => {});
    await snapshot.catch(() => {});
  });
  await waitUntil(async () => (await f.barrier.state())?.phase === 'QUIESCING');
  assert.equal(snapshotted, false);
  await assert.rejects(second.probeWorkspace(f.row.id + 1), {
    error_code: 'PLATFORM_BACKUP_IN_PROGRESS',
  });
  release();
  await holding;
  await snapshot;
  assert.equal(snapshotted, true);
  assert.equal((await second.probeWorkspace(f.row.id)).busy, false);
});

for (const phase of [
  'FILE_INTENT_DURABLE',
  'FILE_PREPARED',
  'FILE_APPLIED',
  'FILE_COMMITTED',
])
  test(`real SIGKILL at ${phase} recovers one complete source image`, async (t) => {
    const f = await source(t);
    const old = 'O'.repeat(1024 * 1024) + '\n';
    await f.files.create(f.row.id, 'atomic.txt', old);
    const process = worker(f, 'save', phase);
    const [code, signal] = await process.exited;
    assert.equal(signal, 'SIGKILL', process.error());
    assert.equal(code, null);
    await f.store.close();
    const reopened = f.track(
      await WorkspaceStore.open(f.databasePath, f.dataRoot),
    );
    const files = new WorkspaceFileService(reopened, f.roots, f.leases);
    const bytes = await fs.readFile(
      path.join(f.roots.path(f.row), 'atomic.txt'),
    );
    const expected = ['FILE_INTENT_DURABLE', 'FILE_PREPARED'].includes(phase)
      ? old
      : 'N'.repeat(1024 * 1024) + '\n';
    assert.equal(hash(bytes), hash(expected));
    await files.recover(f.row.id);
    assert.equal(
      (await files.read(f.row.id, 'atomic.txt')).hash,
      hash(expected),
    );
    const row = await reopened.workspace(f.row.id);
    assert.equal(row.lifecycle_state, 'READY');
    assert.equal(
      row.content_inventory_hash,
      (await scanWorkspace(f.roots.path(row), 'LOCAL')).hash,
    );
    const active = await reopened.all(
      "SELECT id FROM WorkspaceOperations WHERE workspace_id=? AND status IN ('RUNNING','RECOVERY_REQUIRED')",
      [f.row.id],
    );
    assert.equal(active.length, 0);
  });

test('SIGKILL during native atomic save preserves bytes and retains unproven temporary files', async (t) => {
  const f = await source(t);
  const old = 'O'.repeat(1024 * 1024) + '\n';
  await f.files.create(f.row.id, 'atomic.txt', old);
  const process = worker(f, 'mid-save', 'watch');
  const [code, signal] = await process.exited;
  assert.equal(signal, 'SIGKILL', process.error());
  assert.equal(code, null);
  const root = f.roots.path(f.row);
  const actual = await fs.readFile(path.join(root, 'atomic.txt'));
  assert.ok(
    [hash(old), hash('N'.repeat(1024 * 1024) + '\n')].includes(hash(actual)),
  );
  const unknown = (await fs.readdir(root)).filter(
    (name) =>
      name.startsWith('.platform-workspace-') &&
      name !== '.platform-workspace-owner.json',
  );
  if (unknown.length) {
    await assert.rejects(f.files.recover(f.row.id), {
      error_code: 'WORKSPACE_RECOVERY_REQUIRED',
    });
    for (const name of unknown) await fs.lstat(path.join(root, name));
    await assert.rejects(f.files.read(f.row.id, 'atomic.txt'), {
      error_code: 'WORKSPACE_RECOVERY_REQUIRED',
    });
  } else await f.files.recover(f.row.id);
});

test('inherited FD prevents a second Workspace lock while child survives controller SIGKILL', async (t) => {
  const f = await source(t);
  const ready = path.join(f.root, 'child-ready.json');
  const process = worker(f, 'fd', ready);
  t.after(() => {
    if (process.child.exitCode === null) process.child.kill('SIGKILL');
  });
  await waitUntil(async () => !!(await fs.stat(ready).catch(() => null)));
  const child = JSON.parse(await fs.readFile(ready, 'utf8'));
  const exited = process.exited;
  process.child.kill('SIGKILL');
  await exited;
  assert.doesNotThrow(() => global.process.kill(child.pid, 0));
  assert.equal((await f.leases.probeWorkspace(f.row.id)).busy, true);
  await waitUntil(
    async () => !(await f.leases.probeWorkspace(f.row.id)).busy,
    7000,
  );
});
