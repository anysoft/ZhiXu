const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const {
  createFixture,
  seedRepository,
  git,
} = require('../workspace-v2/fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../back/services/workspaceV2/backup');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const { V2Application } = require('../../back/applicationV2/application');
const {
  createRemoteStorage,
} = require('../../back/services/backup/remoteStorage');
const { remoteBackupKey } = require('../../back/services/backup/remoteKeys');
const { startS3, startWebdav } = require('./servers.cjs');

const projectRoot = path.resolve(__dirname, '../..');
async function cli(args) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ZHIXU_V2_DATA_ROOT;
  delete env.ZHIXU_V2_BACKUP_ROOT;
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, 'static/build/backupCliV2.js'), ...args],
    {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (v) => {
    stdout += v;
  });
  child.stderr.on('data', (v) => {
    stderr += v;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    const output = (code === 0 ? stdout : stderr).trim().split('\n').at(-1);
    return { code, body: JSON.parse(output), text: stdout + stderr };
  } finally {
    clearTimeout(timer);
  }
}

for (const [name, start] of [
  ['S3', startS3],
  ['WebDAV', startWebdav],
]) {
  test(`compiled CLI downloads ${name} FULL backup without old SQLite or backup volume and restores after Git remote removal`, async (t) => {
    const server = await start();
    t.after(() => server.close());
    const f = await createFixture(t);
    const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
    const files = new WorkspaceFileService(f.store, f.roots, f.leases);
    const local = await lifecycle.createLocal({
      name: 'Remote disaster local',
      requestKey: randomUUID(),
    });
    await files.create(local.id, 'main.sh', 'echo remote-disaster-task\n');
    const task = await new TaskService(f.store, f.roots, f.leases).create({
      name: 'Remote disaster task',
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: local.id,
        relative_entrypoint: 'main.sh',
        language: 'SHELL',
        cwd_mode: 'WORKSPACE_ROOT',
        cwd_relative_path: null,
      },
    });
    const repository = await seedRepository(f);
    const workspace = await lifecycle.createGit({
      name: 'Remote disaster Git',
      requestKey: randomUUID(),
      repositoryId: repository.id,
      refType: 'branch',
      refName: 'main',
    });
    const commit = git(['rev-parse', 'HEAD'], f.roots.path(workspace));
    await files.create(workspace.id, 'private.txt', 'local saved changes\n');
    await f.store.run(
      "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('remoteRecoveryFixture',?,?,?)",
      [
        JSON.stringify({ value: 'original-private-setting' }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const backup = new WorkspaceBackupService(
      f.store,
      f.roots,
      f.leases,
      f.backupRoot,
    );
    const id = await backup.create(1000, 'FULL');
    const { manifest } = await backup.snapshot(id);
    const passphrase = 'external-recovery-key-for-' + name;
    const portable = await backup.exportPortable(id, Buffer.from(passphrase));
    const storage = createRemoteStorage(server.target);
    const key = remoteBackupKey(manifest, 'MANUAL');
    try {
      await storage.upload(key, portable);
    } finally {
      storage.close();
    }
    const config = path.join(f.root, 'remote-config.json');
    // This external configuration and independent recovery key survive outside the lost volumes.
    const external = { ...server.target };
    delete external.id;
    delete external.name;
    delete external.enabled;
    await fs.writeFile(config, JSON.stringify(external), { mode: 0o600 });
    await f.store.close();
    await fs.rm(f.dataRoot, { recursive: true });
    await fs.rm(f.backupRoot, { recursive: true });
    await fs.rm(repository.source, { recursive: true });
    const listed = await cli(['remote', 'list', '--config', config]);
    assert.equal(listed.code, 0, listed.text);
    assert.equal(listed.body.data.objects[0].backup_id, id);
    const downloaded = path.join(f.root, 'recovery.encrypted');
    const result = await cli([
      'remote',
      'download',
      id,
      '--config',
      config,
      '--output',
      downloaded,
    ]);
    assert.equal(result.code, 0, result.text);
    assert.match(result.body.data.integrity, /NOT_RESTORE_VERIFIED/);
    await assert.rejects(fs.access(f.databasePath));
    await assert.rejects(fs.access(f.backupRoot));
    assert.equal(
      (await fs.readFile(downloaded)).subarray(0, 8).toString(),
      'PLATBKP1',
    );
    const overwrite = await cli([
      'remote',
      'download',
      id,
      '--config',
      config,
      '--output',
      downloaded,
    ]);
    assert.notEqual(overwrite.code, 0);
    const passfile = path.join(f.root, 'recovery.key');
    await fs.writeFile(passfile, 'wrong-passphrase', { mode: 0o600 });
    const newData = path.join(f.root, 'fresh-data'),
      newBackups = path.join(f.root, 'fresh-backups');
    const restore = [
      '--data-root',
      newData,
      '--backup-root',
      newBackups,
      'restore',
      '--file',
      downloaded,
      '--passphrase-file',
      passfile,
    ];
    const wrong = await cli(restore);
    assert.notEqual(wrong.code, 0);
    assert.equal(wrong.body.error_code, 'BACKUP_AUTHENTICATION_FAILED');
    await assert.rejects(fs.access(path.join(newData, 'db/database.sqlite')));
    await fs.writeFile(passfile, passphrase, { mode: 0o600 });
    const damaged = path.join(f.root, 'damaged.encrypted');
    const bytes = await fs.readFile(downloaded);
    bytes[bytes.length - 24] ^= 0x80;
    await fs.writeFile(damaged, bytes, { mode: 0o600 });
    const corrupt = await cli([
      '--data-root',
      path.join(f.root, 'corrupt-target'),
      '--backup-root',
      path.join(f.root, 'corrupt-backups'),
      'restore',
      '--file',
      damaged,
      '--passphrase-file',
      passfile,
    ]);
    assert.notEqual(corrupt.code, 0);
    const restored = await cli(restore);
    assert.equal(restored.code, 0, restored.text);
    const app = f.track(
      await V2Application.launch({
        dataRoot: newData,
        backupRoot: newBackups,
        projectRoot,
        port: 0,
        background: false,
      }),
    );
    assert.equal((await fetch(app.origin + '/api/system')).status, 200);
    const store = app.services.store;
    assert.equal(
      (await store.all('SELECT name FROM Tasks WHERE id=?', [task.task.id]))[0]
        .name,
      'Remote disaster task',
    );
    assert.equal(
      JSON.parse(
        (
          await store.all(
            "SELECT info FROM Auths WHERE type='remoteRecoveryFixture'",
          )
        )[0].info,
      ).value,
      'original-private-setting',
    );
    const restoredLocal = await store.workspace(local.id);
    assert.equal(
      await fs.readFile(
        path.join(
          (
            await app.services.roots.requireOwned(restoredLocal)
          ).root,
          'main.sh',
        ),
        'utf8',
      ),
      'echo remote-disaster-task\n',
    );
    const restoredGit = await store.workspace(workspace.id),
      gitRoot = (await app.services.roots.requireOwned(restoredGit)).root;
    assert.equal(git(['rev-parse', 'HEAD'], gitRoot), commit);
    assert.equal(
      await fs.readFile(path.join(gitRoot, 'private.txt'), 'utf8'),
      'local saved changes\n',
    );
    assert.deepEqual(await store.all('PRAGMA foreign_key_check'), []);
    for (const output of [
      listed,
      result,
      overwrite,
      wrong,
      corrupt,
      restored,
    ]) {
      for (const secret of [
        passphrase,
        'test-secret',
        'test-password',
        'original-private-setting',
      ])
        assert.equal(
          output.text.includes(secret),
          false,
          'CLI never prints credentials, passphrase or private data',
        );
    }
  });
}

test('remote CLI validates command options without a business data root', async () => {
  for (const args of [
    ['remote', 'list'],
    ['remote', 'download', 'id', '--config', '/missing'],
    ['remote', 'list', '--config', '/missing', '--output', '/tmp/no'],
  ]) {
    const result = await cli(args);
    assert.notEqual(result.code, 0);
    assert.equal(result.body.error_code, 'BACKUP_CLI_ARGUMENT_INVALID');
  }
});
