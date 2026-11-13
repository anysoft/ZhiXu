const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
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

async function asset(f, name, content) {
  const id = (
    await f.store.run(
      'INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES(?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
      [name],
    )
  ).lastID;
  const add = async (bytes) => {
    const number = (
      await f.store.all(
        'SELECT COALESCE(MAX(revision_number),0)+1 n FROM ConfigAssetRevisions WHERE asset_id=?',
        [id],
      )
    )[0].n;
    const key = `asset-${id}/revisions/${number}/content`;
    const directory = await f.roots.directory(
      path.dirname('config-assets/' + key),
      true,
    );
    await fs.writeFile(path.join(directory, 'content'), bytes, {
      mode: 0o400,
      flag: 'wx',
    });
    const revision = (
      await f.store.run(
        'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)',
        [
          id,
          number,
          createHash('sha256').update(bytes).digest('hex'),
          Buffer.byteLength(bytes),
          key,
        ],
      )
    ).lastID;
    await f.store.run(
      'UPDATE ConfigAssets SET current_revision_id=?,version=version+1 WHERE id=?',
      [revision, id],
    );
    return revision;
  };
  return { id, revision: await add(content), add };
}
async function fixture(t) {
  const f = await createFixture(t);
  const row = await new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
  ).createLocal({ name: 'effective configs', requestKey: 'config-task' });
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  await files.createDirectory(row.id, 'scripts');
  await files.createDirectory(row.id, 'custom');
  await files.create(row.id, 'custom/config.txt', 'ORIGINAL_CONFIG');
  await files.create(
    row.id,
    'scripts/main.sh',
    'test "$(cat config.txt)" = "$EXPECTED" || exit 29; if [ "$SYMLINK_EXPECTED" = yes ]; then test -L config.txt || exit 28; fi; printf "CONFIG_OK\\n"',
  );
  const tasks = new TaskService(f.store, f.roots, f.leases);
  const definition = await tasks.create({
    name: 'effective task',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: row.id,
      relative_entrypoint: 'scripts/main.sh',
      language: 'SHELL',
      cwd_mode: 'CUSTOM_RELATIVE',
      cwd_relative_path: 'custom',
    },
    execution: { max_attempts: 1, timeout_seconds: 5, concurrency: 'ALLOW' },
  });
  return {
    ...f,
    row,
    files,
    tasks,
    definition,
    env: new WorkspaceEnvironmentService(f.store, f.roots, f.leases),
    engine: f.track(new TaskExecutionService(f.store, f.roots, f.leases)),
  };
}
const binding = (asset, revision) => ({
  asset_id: asset,
  revision_id: revision,
  operation: 'ATTACH',
  target_base: 'TASK_CWD',
  target_path: 'config.txt',
  materialization_mode: 'COPY',
  conflict_policy: 'BACKUP_AND_RESTORE',
  writable: false,
  enabled: true,
});

for (const mode of ['MASK', 'ATTACH', 'SYMLINK']) {
  test(
    'real candidate Task ' +
      mode +
      ' overrides Workspace config while retaining original CWD bytes and revision pin',
    async (t) => {
      const f = await fixture(t);
      const workspace = await asset(
        f,
        'workspace secret',
        'WORKSPACE_CONFIG_SECRET',
      );
      await f.env.saveWorkspaceConfig(
        f.row.id,
        (
          await f.store.workspace(f.row.id)
        ).version,
        binding(workspace.id, workspace.revision),
      );
      let expected = 'ORIGINAL_CONFIG';
      let taskAsset;
      if (mode !== 'MASK') {
        taskAsset = await asset(f, 'task secret', 'PINNED_TASK_CONFIG_SECRET');
        expected = 'PINNED_TASK_CONFIG_SECRET';
      }
      await f.env.saveTaskConfig(
        f.definition.task.id,
        (
          await f.tasks.get(f.definition.task.id)
        ).task.version,
        mode === 'MASK'
          ? { ...binding(null, null), operation: 'MASK' }
          : {
              ...binding(taskAsset.id, taskAsset.revision),
              materialization_mode: mode === 'SYMLINK' ? 'SYMLINK' : 'COPY',
            },
      );
      if (taskAsset)
        await taskAsset.add('NEWEST_TASK_CONFIG_MUST_NOT_REPLACE_PIN');
      await f.env.replaceTaskVariables(
        f.definition.task.id,
        (
          await f.tasks.get(f.definition.task.id)
        ).task.version,
        [
          {
            name: 'EXPECTED',
            operation: 'SET',
            status: 'enabled',
            is_secret: true,
            value: expected,
          },
          {
            name: 'SYMLINK_EXPECTED',
            operation: 'SET',
            status: 'enabled',
            is_secret: false,
            value: mode === 'SYMLINK' ? 'yes' : 'no',
          },
        ],
      );
      const queued = await f.engine.submit(f.definition.task.id);
      const result = await f.engine.wait(queued.id);
      assert.equal(
        result.status,
        'SUCCESS',
        JSON.stringify({ code: result.error_code, result: result.result }),
      );
      const attempts = await f.engine.attempts(queued.id);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, 'SUCCESS');
      const log = await f.engine.logs(queued.id);
      assert.match(log, /CONFIG_OK/);
      assert.equal(log.includes('CONFIG_SECRET'), false);
      assert.equal(
        await fs.readFile(
          path.join(f.roots.path(f.row), 'custom/config.txt'),
          'utf8',
        ),
        'ORIGINAL_CONFIG',
      );
      const source = JSON.parse(result.source_snapshot);
      const revisions = source.effective_resource_versions.config_revisions;
      assert.deepEqual(
        revisions.map((v) => v.revision_id),
        mode === 'MASK' ? [] : [taskAsset.revision],
      );
      assert.equal(
        (await f.files.read(f.row.id, 'custom/config.txt')).content,
        'ORIGINAL_CONFIG',
      );
    },
  );
}

test('candidate engine rejects Config over the entrypoint before any Attempt and preserves unique executable bytes', async (t) => {
  const f = await fixture(t);
  const replacement = await asset(
    f,
    'entrypoint forbidden config',
    'SECRET_MUST_NEVER_EXECUTE',
  );
  await f.env.saveWorkspaceConfig(
    f.row.id,
    (
      await f.store.workspace(f.row.id)
    ).version,
    {
      ...binding(replacement.id, replacement.revision),
      target_base: 'WORKSPACE_ROOT',
      target_path: 'scripts/main.sh',
    },
  );
  const entry = path.join(f.roots.path(f.row), 'scripts/main.sh');
  const before = await fs.readFile(entry);
  const queued = await f.engine.submit(f.definition.task.id);
  const result = await f.engine.wait(queued.id);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error_code, 'CONFIG_TARGET_CONFLICT');
  assert.equal((await f.engine.attempts(queued.id)).length, 0);
  assert.deepEqual(await fs.readFile(entry), before);
  assert.equal(
    (await f.engine.logs(queued.id)).includes('SECRET_MUST_NEVER_EXECUTE'),
    false,
  );
});
