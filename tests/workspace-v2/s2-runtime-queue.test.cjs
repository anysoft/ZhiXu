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

async function createRuntimeQueueFixture(f, kind) {
  const token = randomUUID();
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const workspace = await lifecycle.createLocal({
    name: 'runtime queue ' + token,
    requestKey: token,
  });
  const files = new WorkspaceFileService(f.store, f.roots, f.leases);
  const resources = new WorkspaceEnvironmentService(f.store, f.roots, f.leases);
  const id =
    kind === 'PYTHON'
      ? f.managed.pythonEnvironment.id
      : f.managed.nodeEnvironment.id;
  const service = kind === 'PYTHON' ? f.managed.python : f.managed.node;
  const marker = path.join(f.root, 'forbidden-runtime-queue-child-' + token);
  const entry = kind === 'PYTHON' ? 'main.py' : 'main.cjs';
  const code =
    kind === 'PYTHON'
      ? "import pathlib,sys\npathlib.Path(sys.argv[1]).write_text('UNEXPECTED_CHILD')\n"
      : "require('node:fs').writeFileSync(process.argv[2],'UNEXPECTED_CHILD');\n";
  await files.create(workspace.id, entry, code);
  await files.create(
    workspace.id,
    'settings.json',
    'ORIGINAL_RUNTIME_QUEUE_CONFIG',
  );
  const secret = 'MUST_NOT_INJECT_RUNTIME_QUEUE_' + token;
  const asset = (
    await f.store.run(
      'INSERT INTO ConfigAssets(name,is_secret,createdAt,updatedAt) VALUES(?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
      ['runtime queue ' + token],
    )
  ).lastID;
  const key = `asset-${asset}/revisions/1/content`;
  const content = path.join(f.dataRoot, 'config-assets', key);
  await fs.mkdir(path.dirname(content), { recursive: true, mode: 0o700 });
  await fs.writeFile(content, secret, { flag: 'wx', mode: 0o600 });
  const revision = (
    await f.store.run(
      'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,1,?,?,?,CURRENT_TIMESTAMP)',
      [
        asset,
        createHash('sha256').update(secret).digest('hex'),
        Buffer.byteLength(secret),
        key,
      ],
    )
  ).lastID;
  await f.store.run(
    'UPDATE ConfigAssets SET current_revision_id=? WHERE id=?',
    [revision, asset],
  );
  await resources.setRuntimeDefault(
    workspace.id,
    (
      await f.store.workspace(workspace.id)
    ).version,
    kind,
    id,
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
      target_base: 'WORKSPACE_ROOT',
      target_path: 'settings.json',
      materialization_mode: 'COPY',
      conflict_policy: 'BACKUP_AND_RESTORE',
      writable: false,
      enabled: true,
    },
  );
  const task = await new TaskService(f.store, f.roots, f.leases).create({
    name: 'runtime queue ' + token,
    arguments: [marker],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: workspace.id,
      relative_entrypoint: entry,
      language: kind === 'PYTHON' ? 'PYTHON' : 'JAVASCRIPT',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution: { concurrency: 'ALLOW', timeout_seconds: 10 },
  });
  return { workspace, service, id, marker, entry, code, task };
}

test('queued actual managed Runtime Build and Revision promotions skip old tickets without source or Config injection', async (t) => {
  const f = await createManagedRuntimeFixture(t);
  const execution = f.track(
    new TaskExecutionService(f.store, f.roots, f.leases),
  );
  for (const kind of ['PYTHON', 'NODE']) {
    const c = await createRuntimeQueueFixture(f, kind);
    for (const change of ['BUILD', 'REVISION'])
      await t.test(
        kind +
          ' queued ' +
          change +
          ' promotion is RESOURCE_CHANGED with zero Attempts',
        async () => {
          const current = await c.service.environment(c.id);
          const before = await f.store.workspace(c.workspace.id);
          const submitted = await execution.submit(c.task.task.id);
          const frozen = JSON.parse(submitted.admission_snapshot);
          const previous =
            frozen.effective_resource_versions[
              kind === 'PYTHON' ? 'python' : 'node'
            ];
          assert.equal(previous.build_id, current.current_build_id);
          if (change === 'REVISION') {
            if (kind === 'PYTHON')
              await c.service.revise(c.id, {
                expected_version: current.version,
                runtime_id: current.runtime_id,
                requirements: [],
              });
            else {
              const revision = await c.service.revision(
                current.current_revision_id,
              );
              await c.service.definition(
                {
                  name: current.name,
                  description: current.description,
                  expected_version: current.version,
                  runtime_id: current.runtime_id,
                  toolchain_id: current.toolchain_id,
                  dependencies: revision.dependencies,
                  production_only: current.production_only,
                  install_scripts_policy: current.install_scripts_policy,
                },
                c.id,
              );
            }
          }
          const ready = await c.service.environment(c.id);
          const requested = await f.managed.operations.request(
            kind + '_ENV_' + (change === 'BUILD' ? 'REBUILD' : 'BUILD'),
            {
              timeout_seconds: 120,
              [kind === 'PYTHON' ? 'environment' : 'node']: {
                environment_id: c.id,
                expected_version: ready.version,
              },
            },
          );
          const operation = await f.managed.operations.wait(requested.id);
          assert.equal(operation.status, 'SUCCESS', JSON.stringify(operation));
          const promoted = await c.service.environment(c.id);
          assert.notEqual(promoted.current_build_id, previous.build_id);
          if (change === 'REVISION')
            assert.notEqual(promoted.current_revision_id, previous.revision_id);
          const run = await execution.wait(submitted.id, 30000);
          assert.equal(run.status, 'SKIPPED', JSON.stringify(run));
          assert.equal(run.error_code, 'SOURCE_SUPERSEDED');
          assert.equal(run.attempt_count, 0);
          assert.equal(run.source_snapshot, null);
          assert.equal(run.admission_snapshot, submitted.admission_snapshot);
          assert.equal((await execution.attempts(run.id)).length, 0);
          assert.equal(await execution.logs(run.id), '');
          const events = await execution.events(run.id);
          assert.equal(
            JSON.parse(
              events.find((event) => event.type === 'SOURCE_SUPERSEDED')
                .metadata,
            ).reason,
            'RESOURCE_CHANGED',
          );
          assert.ok(events.some((event) => event.type === 'RUN_SKIPPED'));
          assert.equal(
            (
              await f.store.all(
                'SELECT id FROM TaskRuns WHERE task_id=? AND submission_key=?',
                [c.task.task.id, submitted.submission_key],
              )
            ).length,
            1,
          );
          const root = f.roots.path(c.workspace);
          assert.equal(
            await fs.readFile(path.join(root, c.entry), 'utf8'),
            c.code,
          );
          assert.equal(
            await fs.readFile(path.join(root, 'settings.json'), 'utf8'),
            'ORIGINAL_RUNTIME_QUEUE_CONFIG',
          );
          await assert.rejects(fs.lstat(c.marker), { code: 'ENOENT' });
          await assert.rejects(fs.lstat(path.join(root, 'node_modules')), {
            code: 'ENOENT',
          });
          const after = await f.store.workspace(c.workspace.id);
          assert.equal(after.content_revision, before.content_revision);
          assert.equal(
            after.content_inventory_hash,
            before.content_inventory_hash,
          );
          process.stdout.write(
            JSON.stringify({
              s2_runtime_queue: kind,
              change,
              run_id: run.id,
              old_build: previous.build_id,
              promoted_build: promoted.current_build_id,
              old_revision: previous.revision_id,
              promoted_revision: promoted.current_revision_id,
              status: run.status,
              reason: 'RESOURCE_CHANGED',
              attempt_count: 0,
            }) + '\n',
          );
        },
      );
  }
  await t.test(
    'actual managed Workspace defaults can be explicitly detached after archive',
    async () => {
      const lifecycle = new WorkspaceLifecycleService(
        f.store,
        f.roots,
        f.leases,
      );
      const resources = new WorkspaceEnvironmentService(
        f.store,
        f.roots,
        f.leases,
      );
      const token = randomUUID();
      const workspace = await lifecycle.createLocal({
        name: 'archive managed defaults ' + token,
        requestKey: token,
      });
      for (const [kind, id] of [
        ['PYTHON', f.managed.pythonEnvironment.id],
        ['NODE', f.managed.nodeEnvironment.id],
      ]) {
        await resources.setRuntimeDefault(
          workspace.id,
          (
            await f.store.workspace(workspace.id)
          ).version,
          kind,
          id,
        );
      }
      assert.equal(
        (
          await f.store.all(
            'SELECT id FROM WorkspaceRuntimeDefaults WHERE workspace_id=?',
            [workspace.id],
          )
        ).length,
        2,
      );
      await lifecycle.archive(
        workspace.id,
        (
          await f.store.workspace(workspace.id)
        ).version,
        { requestKey: 'archive-' + token },
      );
      for (const kind of ['PYTHON', 'NODE'])
        await resources.setRuntimeDefault(
          workspace.id,
          (
            await f.store.workspace(workspace.id)
          ).version,
          kind,
          null,
        );
      assert.equal(
        (await f.store.workspace(workspace.id)).lifecycle_state,
        'ARCHIVED',
      );
      assert.deepEqual(
        await f.store.all(
          'SELECT * FROM WorkspaceRuntimeDefaults WHERE workspace_id=?',
          [workspace.id],
        ),
        [],
      );
    },
  );
  assert.deepEqual(await f.store.all('PRAGMA foreign_key_check'), []);
});
