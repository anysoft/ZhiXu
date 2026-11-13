const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFixture, insertTaskSource } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const {
  WorkspaceExecutionPaths,
} = require('../../back/services/taskExecutionV2/paths');

async function materializationFixture(t, options = {}) {
  const f = await createFixture(t);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const row = await lifecycle.createLocal({
    name: 'S2 materialization',
    requestKey: 's2-materialization',
  });
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  await files.create(row.id, 'config.txt', 'original private user config\n');
  await files.create(
    row.id,
    'main.sh',
    options.script ?? 'printf "MAIN:%s\\n" "$HOOK_SECRET"; cat config.txt\n',
  );
  const task = await insertTaskSource(f.store, row.id, 'main.sh');
  await f.store.run("UPDATE TaskSources SET language='SHELL' WHERE task_id=?", [
    task,
  ]);
  const secret = 'S2_UNIQUE_CONFIG_SECRET';
  const checksum = createHash('sha256').update(secret).digest('hex');
  const dir = await f.roots.directory(
    'config-assets/asset-1/revisions/1',
    true,
  );
  await fs.writeFile(path.join(dir, 'content'), secret, { mode: 0o400 });
  await f.store.run(
    "INSERT INTO ConfigAssets(id,name,is_secret,createdAt,updatedAt) VALUES(1,'S2 config',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
  );
  await f.store.run(
    'INSERT INTO ConfigAssetRevisions(id,asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(1,1,1,?,?,?,CURRENT_TIMESTAMP)',
    [checksum, Buffer.byteLength(secret), 'asset-1/revisions/1/content'],
  );
  await f.store.run('UPDATE ConfigAssets SET current_revision_id=1 WHERE id=1');
  const revision = (
    await f.store.all(
      'SELECT id,asset_id,revision_number,checksum,size,storage_key FROM ConfigAssetRevisions WHERE id=1',
    )
  )[0];
  const root = f.roots.path(row);
  const paths = new WorkspaceExecutionPaths(f.dataRoot);
  const context = {
    identity: { taskId: task, taskDefinitionVersion: 1, taskRunId: 1 },
    source: {
      workspaceId: row.id,
      workspaceType: 'LOCAL',
      sourceGeneration: 1,
      contentRevision: (await f.store.workspace(row.id)).content_revision,
      inventoryHash: (await f.store.workspace(row.id)).content_inventory_hash,
      relativeEntrypoint: 'main.sh',
      absoluteEntrypoint: path.join(root, 'main.sh'),
      language: 'SHELL',
      cwd: root,
      cwdMode: 'WORKSPACE_ROOT',
      cwdRelativePath: null,
      checksum: createHash('sha256')
        .update(await fs.readFile(path.join(root, 'main.sh')))
        .digest('hex'),
      git: null,
    },
    runtime: { kind: 'SHELL', executable: '/bin/sh' },
    args: [],
    environmentSnapshot: {
      variables: { PATH: '/usr/bin:/bin' },
      unsetVariables: [],
      origins: {},
      secretNames: [],
      profile: null,
      metadata: {},
    },
    configSnapshot: [
      {
        asset_id: 1,
        revision_id: 1,
        revision,
        is_secret: true,
        asset_name: 'S2 config',
        source: 'WORKSPACE',
        binding: {
          id: 1,
          asset_id: 1,
          operation: 'ATTACH',
          target_base: 'WORKSPACE_ROOT',
          target_path: 'config.txt',
          materialization_mode: 'COPY',
          conflict_policy: 'BACKUP_AND_RESTORE',
          writable: false,
          enabled: true,
          version: 1,
        },
      },
    ],
    hookSnapshot: [],
    settings: {
      timeout_seconds: 5,
      max_attempts: 2,
      initial_delay_seconds: 0,
      backoff: 'FIXED',
      concurrency: 'ALLOW',
      notification: 'NONE',
    },
    workspace: {
      workspaceRoot: root,
      taskDir: root,
      cwd: root,
      resourceKey: paths.resourceKey(row.id),
    },
    secretValues: [],
  };
  if (options.node) {
    context.runtime.nodeModulesRoot = await f.roots.directory(
      'runtime/node/environments/env-1/builds/build-1/node_modules',
      true,
    );
    await fs.writeFile(
      path.join(context.runtime.nodeModulesRoot, 'fixture-module.js'),
      'module.exports = 1;',
      { mode: 0o600 },
    );
  }
  return { ...f, row: await f.store.workspace(row.id), files, context, secret };
}
module.exports = { materializationFixture };
