// Internal S1.A fixtures: every database/root is newly allocated and isolated.
// Candidate Task/Run rows below test references only; they never simulate a Runner.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { WorkspaceStore } = require('../../back/services/workspaceV2/store');
const { PlatformBackupBarrier } = require('../../back/services/backup/barrier');

const projectRoot = path.resolve(__dirname, '../..');
const schemaPath = path.join(
  projectRoot,
  'docs/architecture/v2/contracts/fresh-v2.sql',
);

async function createDatabase(dataRoot) {
  await fs.mkdir(path.join(dataRoot, 'db'), { recursive: true, mode: 0o700 });
  await fs.chmod(dataRoot, 0o700);
  await fs.chmod(path.join(dataRoot, 'db'), 0o700);
  const databasePath = path.join(dataRoot, 'db/database.sqlite');
  execFileSync(
    'python3',
    [
      '-I',
      '-S',
      '-c',
      'import sqlite3,sys,os\np=sys.argv[1]\nf=os.open(p,os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)\nos.close(f)\nd=sqlite3.connect(p)\nd.executescript(open(sys.argv[2],encoding="utf-8").read())\nd.close()\n',
      databasePath,
      schemaPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return databasePath;
}

async function createFixture(t, options = {}) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, 'zhixu-s1a-'));
  await fs.chmod(root, 0o700);
  const dataRoot = path.join(root, 'data');
  const backupRoot = path.join(root, 'backups');
  const databasePath = await createDatabase(dataRoot);
  const store = await WorkspaceStore.open(databasePath, dataRoot);
  await fs.mkdir(dataRoot + '.platform-control', { mode: 0o700 });
  const barrier = new PlatformBackupBarrier(dataRoot + '.platform-control');
  const {
    WorkspaceRootResolver,
  } = require('../../back/services/workspaceV2/roots');
  const {
    WorkspaceLeaseService,
  } = require('../../back/services/workspaceV2/lease');
  const roots = new WorkspaceRootResolver(dataRoot);
  const leases = new WorkspaceLeaseService(dataRoot, barrier);
  const resources = [];
  const fixture = {
    root,
    dataRoot,
    backupRoot,
    controlRoot: dataRoot + '.platform-control',
    databasePath,
    dbPath: databasePath,
    schemaPath,
    projectRoot,
    store,
    roots,
    leases,
    barrier,
    options,
    track(resource) {
      resources.push(resource);
      return resource;
    },
  };
  if (t)
    t.after(async () => {
      for (const resource of resources.reverse()) {
        if (typeof resource.close === 'function')
          await resource.close().catch(() => {});
      }
      await store.close().catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    });
  return fixture;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'S1.A Fixture',
      GIT_AUTHOR_EMAIL: 's1a@example.invalid',
      GIT_COMMITTER_NAME: 'S1.A Fixture',
      GIT_COMMITTER_EMAIL: 's1a@example.invalid',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function seedRepository(fixture, id = 1) {
  const source = path.join(fixture.root, 'remote-' + id);
  await fs.mkdir(source, { mode: 0o700 });
  git(['init', '--initial-branch=main'], source);
  await fs.writeFile(
    path.join(source, 'main.py'),
    'print("s1a-only-source")\n',
  );
  git(['add', 'main.py'], source);
  git(['commit', '-m', 'isolated fixture'], source);
  const commit = git(['rev-parse', 'HEAD'], source);
  await fs.mkdir(path.join(fixture.dataRoot, 'git'), { mode: 0o700 });
  const bare = path.join(fixture.dataRoot, 'git', 'repository-' + id + '.git');
  git(['clone', '--no-hardlinks', '--bare', source, bare], fixture.root);
  await fixture.store.run(
    "INSERT INTO Repositories(id,name,provider,remote_url,normalized_url,storage_path,storage_state,default_branch) VALUES(?,?,'github',?,?,?,'READY','main')",
    [
      id,
      'fixture-' + id,
      'https://example.invalid/repo-' + id + '.git',
      'https://example.invalid/repo-' + id + '.git',
      bare,
    ],
  );
  return { id, source, bare, commit };
}

async function insertTaskSource(store, workspaceId, entry = 'main.py') {
  return store.transaction(async (tx) => {
    const result = await tx.run(
      "INSERT INTO Tasks(workspace_id,name,origin) VALUES(?,'reference fixture','MANUAL')",
      [workspaceId],
    );
    await tx.run(
      "INSERT INTO TaskSources(task_id,workspace_id,relative_entrypoint,language) VALUES(?,?,?,'PYTHON')",
      [result.lastID, workspaceId, entry],
    );
    await tx.run('INSERT INTO TaskExecutionSettings(task_id) VALUES(?)', [
      result.lastID,
    ]);
    return result.lastID;
  });
}

async function insertHistoricalRunForReferenceTest(store, taskId, workspaceId) {
  const ws = await store.workspace(workspaceId);
  const task = (
    await store.all('SELECT version FROM Tasks WHERE id=?', [taskId])
  )[0];
  const global = (
    await store.all(
      'SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1',
    )
  )[0];
  const now = new Date().toISOString();
  const result = await store.run(
    `INSERT INTO TaskRuns(task_id,workspace_id,expected_workspace_version,expected_global_env_version,
     expected_task_definition_version,expected_source_generation,expected_content_revision,
     expected_inventory_hash,admission_snapshot,trigger_type,status,submitted_at,finished_at,
     log_identity,concurrency_policy,queue_deadline_at,next_eligible_at)
     VALUES(?,?,?,?,?,?,?,?,?,'MANUAL','SKIPPED',?,?,?,'ALLOW',?,?)`,
    [
      taskId,
      workspaceId,
      ws.version,
      global.version,
      task.version,
      ws.source_generation,
      ws.content_revision,
      ws.content_inventory_hash,
      JSON.stringify({ workspace_id: workspaceId, workspace_type: ws.type }),
      now,
      now,
      'reference-only-' + randomUUID(),
      now,
      now,
    ],
  );
  return result.lastID;
}

module.exports = {
  createFixture,
  createDatabase,
  seedRepository,
  git,
  insertTaskSource,
  insertHistoricalRunForReferenceTest,
  projectRoot,
  schemaPath,
};
