const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createManagedRuntimeFixture } = require('./s2-runtime-fixture.cjs');
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

test('actual managed Node JS and TS execute concurrently in different Workspaces with separate secret Config and temporary bindings', async (t) => {
  const f = await createManagedRuntimeFixture(t);
  const token = randomUUID().slice(0, 8);
  const gate = path.join(f.root, 's2-node-overlap-' + token);
  await fs.mkdir(gate, { mode: 0o700 });
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  const tasks = new TaskService(f.store, f.roots, f.leases);
  const resources = new WorkspaceEnvironmentService(f.store, f.roots, f.leases);
  const execution = f.track(
    new TaskExecutionService(f.store, f.roots, f.leases),
  );
  const cases = [];
  for (const [tag, language, extension] of [
    ['A', 'JAVASCRIPT', 'cjs'],
    ['B', 'TYPESCRIPT', 'ts'],
  ]) {
    const workspace = await lifecycle.createLocal({
      name: 'Node overlap ' + tag + token,
      requestKey: 'node-overlap-' + tag + token,
    });
    const secret = 'S2_NODE_CONFIG_SECRET_' + tag + token;
    const asset = (
      await f.store.run(
        'INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES(?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        ['parallel secret ' + tag + token],
      )
    ).lastID;
    const storage = `asset-${asset}/revisions/1/content`;
    const configFile = path.join(f.dataRoot, 'config-assets', storage);
    await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(configFile, secret, { mode: 0o600, flag: 'wx' });
    const revision = (
      await f.store.run(
        'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,1,?,?,?,CURRENT_TIMESTAMP)',
        [
          asset,
          createHash('sha256').update(secret).digest('hex'),
          Buffer.byteLength(secret),
          storage,
        ],
      )
    ).lastID;
    await f.store.run(
      'UPDATE ConfigAssets SET current_revision_id=? WHERE id=?',
      [revision, asset],
    );
    await resources.saveWorkspaceConfig(
      workspace.id,
      (
        await f.store.workspace(workspace.id)
      ).version,
      {
        asset_id: asset,
        revision_id: revision,
        operation: 'ATTACH',
        target_base: 'TASK_CWD',
        target_path: 'settings.json',
        materialization_mode: 'COPY',
        conflict_policy: 'BACKUP_AND_RESTORE',
        writable: false,
        enabled: true,
      },
    );
    const head =
      language === 'JAVASCRIPT'
        ? "const fs=require('node:fs'),path=require('node:path'); const n=require('is-number');"
        : "import fs from 'node:fs'; import path from 'node:path'; import n from 'is-number'; const typed: number=42;";
    const program = `${head}\nconst gate=process.argv[2],tag=process.argv[3];console.log('NODE_STARTED_'+tag,n(42),fs.readFileSync('settings.json','utf8'));fs.writeFileSync(path.join(gate,'started-'+tag),'actual runner');(async()=>{const end=Date.now()+8000;while(!['A','B'].every(x=>fs.existsSync(path.join(gate,'started-'+x)))){if(Date.now()>end)process.exit(91);await new Promise(r=>setTimeout(r,20));}console.log('BOTH_ACTUAL_NODE_TASKS_RUNNING',tag);await new Promise(r=>setTimeout(r,150));})().catch(()=>process.exit(92));\n`;
    await files.create(workspace.id, 'check.' + extension, program);
    await files.create(workspace.id, 'settings.json', 'original-' + tag);
    const definition = await tasks.create({
      name: 'parallel managed ' + tag + token,
      arguments: [gate, tag],
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: workspace.id,
        relative_entrypoint: 'check.' + extension,
        language,
        cwd_mode: 'WORKSPACE_ROOT',
        cwd_relative_path: null,
      },
      runtime: {
        kind: 'NODE',
        node_environment_id: f.managed.nodeEnvironment.id,
        python_environment_id: null,
      },
      execution: { timeout_seconds: 15 },
    });
    cases.push({ tag, workspace, secret, taskId: definition.task.id });
  }
  const runs = [];
  for (const item of cases)
    runs.push(
      await execution.submit(item.taskId, {
        submissionKey: 'parallel-node-' + item.tag + token,
      }),
    );
  const completed = await Promise.all(
    runs.map((run) => execution.wait(run.id, 30000)),
  );
  for (let i = 0; i < completed.length; i++) {
    assert.equal(completed[i].status, 'SUCCESS', JSON.stringify(completed[i]));
    const log = await execution.logs(completed[i].id);
    assert.ok(log.includes('BOTH_ACTUAL_NODE_TASKS_RUNNING'));
    for (const item of cases) assert.equal(log.includes(item.secret), false);
    const root = f.roots.path(cases[i].workspace);
    assert.equal(
      await fs.readFile(path.join(root, 'settings.json'), 'utf8'),
      'original-' + cases[i].tag,
    );
    await assert.rejects(fs.lstat(path.join(root, 'node_modules')), {
      code: 'ENOENT',
    });
    const attempts = await execution.attempts(completed[i].id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].exit_code, 0);
  }
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
});
