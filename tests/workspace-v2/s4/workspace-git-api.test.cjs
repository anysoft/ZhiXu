const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSyncFixture } = require('../s3/sync-fixture.cjs');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
const {
  WorkspaceLifecycleService,
} = require('../../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceReclaimService,
} = require('../../../back/services/workspaceV2/reclaim');
const {
  WorkspacePreservationService,
} = require('../../../back/services/workspaceV2/preservation');
const {
  WorkspaceBackupService,
} = require('../../../back/services/workspaceV2/backup');
const {
  WorkspaceRestoreService,
} = require('../../../back/services/workspaceV2/restore');
const {
  workspaceApiRoutes,
} = require('../../../back/applicationV2/workspaceApi');
const { gitApiRoutes } = require('../../../back/applicationV2/gitApi');
const {
  CandidateGitResources,
  repositoryApiRoutes,
} = require('../../../back/applicationV2/repositoryResources');
async function setup(t, options = {}) {
  const f = await createSyncFixture(t, {
    files: { 'main.sh': '#!/bin/sh\nprintf "actual"\n' },
    caseId: 's4-workspace-git-' + randomUUID(),
    ...options,
  });
  const backup = new WorkspaceBackupService(
    f.store,
    f.roots,
    f.leases,
    f.backupRoot,
  );
  const s = {
    store: f.store,
    roots: f.roots,
    leases: f.leases,
    lifecycle: f.lifecycle,
    files: new WorkspaceFileService(f.store, f.roots, f.leases),
    reclaim: new WorkspaceReclaimService(
      f.store,
      f.roots,
      f.leases,
      new WorkspacePreservationService(backup),
    ),
    backup,
    restore: new WorkspaceRestoreService(backup),
    git: f.gitAdapter,
    discovery: f.discovery,
    sync: f.sync,
  };
  const resources = new CandidateGitResources(s, {
    accessResolver: f.accessResolver,
  });
  const routes = {
    ...workspaceApiRoutes(s),
    ...gitApiRoutes(s, resources),
    ...repositoryApiRoutes(s, resources),
  };
  const call = async (
    route,
    body = {},
    params = { id: String(f.row.id) },
    query = {},
    key,
  ) =>
    routes[route]({
      body,
      params,
      query,
      idempotencyKey: key,
      principal: {
        kind: 'PANEL_OWNER',
        username: 'fixture',
        platform: 'desktop',
      },
    });
  return { f, s, call, resources };
}
test('S4 Local files: exact DTO snapshots, hash CAS, signed directory identity, archive read and write gate', async (t) => {
  const { f, call } = await setup(t);
  const key = randomUUID(),
    created = await call(
      'POST /workspaces',
      { type: 'LOCAL', name: 'local editor' },
      {},
      {},
      key,
    ),
    id = String(created.workspace.id),
    params = { id };
  assert.equal(created.operation.type, 'CREATE');
  assert.equal(created.operation.status, 'SUCCEEDED');
  const again = await call(
    'POST /workspaces',
    { type: 'LOCAL', name: 'local editor' },
    {},
    {},
    key,
  );
  assert.equal(again.workspace.id, Number(id));
  await assert.rejects(
    call('POST /workspaces', { type: 'LOCAL', name: 'other' }, {}, {}, key),
    (e) => e.error_code === 'IDEMPOTENCY_KEY_CONFLICT',
  );
  await call(
    'POST /workspaces/:id/files',
    { path: 'main.sh', content: 'old\n', must_not_exist: true },
    params,
  );
  const before = await call('GET /workspaces/:id/files', {}, params, {
    path: 'main.sh',
  });
  assert.equal(before.kind, 'FILE');
  assert.equal(before.content, 'old\n');
  assert.equal(before.content_revision, 2);
  assert.deepEqual(
    Object.keys(before).sort(),
    [
      'content',
      'content_revision',
      'hash',
      'identity_token',
      'kind',
      'path',
      'size_bytes',
      'source_generation',
    ].sort(),
  );
  await call(
    'PUT /workspaces/:id/files',
    { path: 'main.sh', content: 'new\n', expected_hash: before.hash },
    params,
  );
  await assert.rejects(
    call(
      'PUT /workspaces/:id/files',
      { path: 'main.sh', content: 'clobber', expected_hash: before.hash },
      params,
    ),
    (e) => e.error_code === 'WORKSPACE_FILE_CONFLICT',
  );
  await call(
    'POST /workspaces/:id/directories',
    { path: 'folder', must_not_exist: true },
    params,
  );
  const tree = await call('GET /workspaces/:id/tree', {}, params, {}),
    directory = tree.entries.find((entry) => entry.path === 'folder');
  assert.equal(directory.kind, 'DIRECTORY');
  assert.equal(directory.hash, null);
  await assert.rejects(
    call(
      'POST /workspaces/:id/rename',
      {
        path: 'folder',
        destination: 'bad',
        kind: 'DIRECTORY',
        expected_identity: directory.identity_token + 'x',
      },
      params,
    ),
    (e) => e.error_code === 'WORKSPACE_FILE_CONFLICT',
  );
  await call(
    'POST /workspaces/:id/rename',
    {
      path: 'folder',
      destination: 'renamed',
      kind: 'DIRECTORY',
      expected_identity: directory.identity_token,
    },
    params,
  );
  await assert.rejects(
    call(
      'POST /workspaces/:id/files',
      { path: '../outside', content: 'x', must_not_exist: true },
      params,
    ),
  );
  await assert.rejects(
    call(
      'PATCH /workspaces/:id',
      { name: 'bad', expected_version: '1' },
      params,
    ),
    (e) => e.error_code === 'INVALID_REQUEST',
  );
  const row = await f.store.workspace(Number(id));
  const archived = await call(
    'POST /workspaces/:id/archive',
    { expected_version: row.version },
    params,
    {},
    randomUUID(),
  );
  assert.equal(archived.workspace.lifecycle_state, 'ARCHIVED');
  assert.equal(archived.workspace.capabilities.read_files, true);
  assert.equal(
    (await call('GET /workspaces/:id/files', {}, params, { path: 'main.sh' }))
      .content,
    'new\n',
  );
  await assert.rejects(
    call(
      'POST /workspaces/:id/files',
      { path: 'blocked', content: 'x', must_not_exist: true },
      params,
    ),
    (e) => e.error_code === 'WORKSPACE_ARCHIVED',
  );
  const renamed = await call(
    'PATCH /workspaces/:id',
    { name: 'archived name', expected_version: archived.workspace.version },
    params,
  );
  assert.equal(renamed.name, 'archived name');
  f.scenario.record('s4-local-file-dto-cas', {
    workspace_id: Number(id),
    assertions: [
      'same-lease revision',
      'signed identity',
      'CAS stale unchanged',
      'archive read/write gate',
    ],
  });
});
test('S4 Git initial Sync/Discovery policy is durable, atomic and part of creation idempotency', async (t) => {
  const { f, call } = await setup(t),
    key = randomUUID();
  const request = {
    type: 'GIT',
    name: 'initial policy',
    git: {
      repository_id: f.repository.id,
      ref_type: 'branch',
      ref_name: 'main',
    },
    sync_policy: { enabled: true, mode: 'MANUAL', schedule: null },
    discovery: {
      enabled: true,
      includes: ['**/*.sh'],
      excludes: [],
      languages: ['SHELL'],
    },
  };
  const created = await call('POST /workspaces', request, {}, {}, key),
    params = { id: String(created.workspace.id) };
  assert.equal(
    (await call('GET /workspaces/:id/sync-policy', {}, params)).enabled,
    true,
  );
  assert.equal(
    (await call('GET /workspaces/:id/discovery', {}, params)).enabled,
    true,
  );
  assert.equal(
    (await call('POST /workspaces', request, {}, {}, key)).workspace.id,
    created.workspace.id,
  );
  await assert.rejects(
    call(
      'POST /workspaces',
      {
        ...request,
        sync_policy: { enabled: false, mode: 'MANUAL', schedule: null },
      },
      {},
      {},
      key,
    ),
    (e) => e.error_code === 'IDEMPOTENCY_KEY_CONFLICT',
  );
  const preview = await call(
    'POST /workspaces/:id/discovery/preview',
    {
      expected_version: created.workspace.version,
      expected_content_revision: created.workspace.content_revision,
    },
    params,
  );
  assert.ok(
    preview.actions.some(
      (action) => action.path === 'main.sh' && action.action === 'CREATE',
    ),
  );
  const applied = await call(
    'POST /workspaces/:id/discovery/apply',
    {
      preview_token: preview.preview_token,
      expected_version: created.workspace.version,
    },
    params,
  );
  assert.equal(applied.created, 1);
  const discoveryKey = preview.actions.find(
    (action) => action.path === 'main.sh',
  ).discovery_key;
  const suppression = await call(
    'POST /workspaces/:id/discovery/suppressions',
    { discovery_key: discoveryKey, expected_policy_version: 1 },
    params,
  );
  assert.match(suppression.created_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(
    (await call('GET /workspaces/:id/discovery/suppressions', {}, params))
      .total,
    1,
  );
  assert.equal(
    await call(
      'DELETE /workspaces/:id/discovery/suppressions/:discoveryKey',
      { expected_version: 1 },
      { ...params, discoveryKey },
    ),
    null,
  );
  const defaultCreated = await call(
    'POST /workspaces',
    {
      type: 'GIT',
      name: 'default positive policy versions',
      git: {
        repository_id: f.repository.id,
        ref_type: 'branch',
        ref_name: 'main',
      },
    },
    {},
    {},
    randomUUID(),
  );
  const defaultParams = { id: String(defaultCreated.workspace.id) };
  assert.equal(
    (await call('GET /workspaces/:id/discovery', {}, defaultParams)).version,
    1,
  );
  assert.equal(
    (await call('GET /workspaces/:id/sync-policy', {}, defaultParams)).version,
    1,
  );
  const saved = await call(
    'PUT /workspaces/:id/discovery',
    {
      expected_version: 1,
      enabled: false,
      includes: ['**/*'],
      excludes: [],
      languages: ['SHELL'],
    },
    defaultParams,
  );
  assert.equal(saved.version, 2);
  f.scenario.record('s4-initial-policy-transaction', {
    workspace_id: created.workspace.id,
    assertions: [
      'policies READY atomic',
      'same-key stable identity',
      'changed initial policy conflicts',
      'real discovery task created',
    ],
  });
});
test('S4 actual Git Workbench stages, unstages, commits, pushes through real FD leases and keeps CAS', async (t) => {
  const { f, call } = await setup(t);
  await call('POST /workspaces/:id/files', {
    path: 'new.txt',
    content: 'actual git edit\n',
    must_not_exist: true,
  });
  const row = await f.store.workspace(f.row.id),
    expected = row.content_revision;
  const before = await call('GET /workspaces/:id/git/status');
  assert.ok(before.changed_files.some((entry) => entry.path === 'new.txt'));
  assert.ok(!JSON.stringify(before).includes('.platform-workspace'));
  await assert.rejects(
    call('POST /workspaces/:id/git/stage', {
      paths: ['new.txt'],
      expected_content_revision: expected - 1,
    }),
    (e) => e.error_code === 'WORKSPACE_VERSION_CONFLICT',
  );
  const staged = await call('POST /workspaces/:id/git/stage', {
    paths: ['new.txt'],
    expected_content_revision: expected,
  });
  assert.equal(staged.status.staged, 1);
  const unstaged = await call('POST /workspaces/:id/git/unstage', {
    paths: ['new.txt'],
    expected_content_revision: expected,
  });
  assert.equal(unstaged.status.staged, 0);
  await call('POST /workspaces/:id/git/stage', {
    paths: ['new.txt'],
    expected_content_revision: expected,
  });
  const author = await call('PUT /system/git-identity', {
    name: 'S4 Fixture',
    email: 's4@example.invalid',
    expected_version: 1,
  });
  assert.equal(author.version, 2);
  await assert.rejects(
    call('PUT /system/git-identity', {
      name: 'Other',
      email: 'other@example.invalid',
      expected_version: 1,
    }),
    (e) => e.error_code === 'WORKSPACE_VERSION_CONFLICT',
  );
  const committed = await call('POST /workspaces/:id/git/commit', {
    message: 'actual S4 UI commit',
    expected_content_revision: expected,
  });
  assert.equal(committed.status.clean, true);
  assert.equal(
    f.git(['show', 'HEAD:new.txt'], f.workspaceRoot),
    'actual git edit',
  );
  await assert.rejects(
    call('POST /workspaces/:id/git/push', {
      remote_branch: 's4-output',
      expected_content_revision: expected,
    }),
    (e) => e.error_code === 'GIT_WRITE_REQUIRED',
  );
  const credential = await call(
    'POST /git-credentials',
    {
      name: 'actual write capability',
      provider: 'generic',
      auth_type: 'anonymous',
      capability: 'WRITE',
    },
    {},
  );
  await f.store.run(
    'UPDATE Repositories SET default_credential_id=? WHERE id=?',
    [credential.id, f.repository.id],
  );
  const pushed = await call('POST /workspaces/:id/git/push', {
    remote_branch: 's4-output',
    expected_content_revision: expected,
  });
  assert.equal(pushed.head, committed.head);
  assert.equal(
    f.git(['rev-parse', 'refs/heads/s4-output'], f.repository.source),
    committed.head,
  );
  assert.equal(
    (await f.store.all('SELECT COUNT(*) count FROM WorkspaceSyncRuns'))[0]
      .count,
    0,
  );
  assert.equal(
    (await f.store.all('SELECT COUNT(*) count FROM TaskRuns'))[0].count,
    0,
  );
  f.scenario.record('s4-real-git-workbench', {
    workspace_id: f.row.id,
    commit: committed.head,
    assertions: [
      'actual staged/unstaged index',
      'actual commit object',
      'actual push remote ref',
      'no SyncRun/TaskRun',
    ],
  });
});
test('S4 Sync DTO/preview and child scoping use real domain', async (t) => {
  const { f, call } = await setup(t),
    row = await f.store.workspace(f.row.id),
    policy = await f.policies.get(f.row.id);
  const preview = await call('POST /workspaces/:id/sync/preview', {
    expected_version: row.version,
    expected_policy_version: policy.version,
  });
  assert.equal(preview.readiness, 'READY');
  assert.equal(
    (await f.store.all('SELECT COUNT(*) count FROM WorkspaceSyncRuns'))[0]
      .count,
    0,
  );
  const submitted = await call(
    'POST /workspaces/:id/sync',
    { expected_version: row.version, expected_policy_version: policy.version },
    undefined,
    {},
    randomUUID(),
  );
  const done = await f.sync.wait(submitted.id);
  assert.equal(done.status, 'SUCCESS');
  const dto = await call(
    'GET /workspaces/:id/sync-runs/:syncRunId',
    {},
    { id: String(f.row.id), syncRunId: String(done.id) },
  );
  assert.equal(dto.initial, true);
  assert.ok(!('owner_token' in dto));
  assert.ok(!('source_snapshot' in dto));
  await assert.rejects(
    call(
      'GET /workspaces/:id/sync-runs/:syncRunId',
      {},
      { id: '999999', syncRunId: String(done.id) },
    ),
    (e) => e.error_code === 'SYNC_RUN_NOT_FOUND',
  );
  const log = await call(
    'GET /workspaces/:id/sync-runs/:syncRunId/log',
    {},
    { id: String(f.row.id), syncRunId: String(done.id) },
  );
  assert.equal(log.complete, true);
  assert.match(log.text, /SUCCESS/);
  const history = await call('GET /workspaces/:id/sync-history');
  assert.equal(history.total, 1);
  f.scenario.record('s4-real-sync-route-domain', {
    workspace_id: f.row.id,
    sync_run_id: done.id,
    assertions: [
      'preview no run',
      'actual initial sync',
      'child scope404',
      'safe DTO diagnostic log',
    ],
  });
});
test('S4 retained Repo/Credential DTOs reject secret readback, execution defaults and public file transport', async (t) => {
  const { f, call } = await setup(t);
  const secret = 's4-credential-' + randomUUID();
  f.scenario.registerSecret(secret);
  const credential = await call(
    'POST /git-credentials',
    {
      name: 'secret metadata',
      provider: 'generic',
      auth_type: 'https_token',
      token: secret,
      capability: 'READ',
      status: 'enabled',
    },
    {},
  );
  assert.equal(credential.has_secret, true);
  assert.ok(!JSON.stringify(credential).includes(secret));
  assert.ok(!('secret' in credential));
  const repos = await call('GET /repositories', {}, {});
  assert.ok(Array.isArray(repos));
  assert.ok(!('storage_path' in repos[0]));
  assert.ok(!('default_env_profile_id' in repos[0]));
  await assert.rejects(
    call(
      'POST /repositories',
      { remote_url: 'file:///etc/passwd', name: 'forbidden' },
      {},
    ),
    (e) => e.error_code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    call(
      'POST /repositories',
      {
        remote_url: 'https://example.invalid/test.git',
        default_env_profile_id: 1,
      },
      {},
    ),
    (e) => e.error_code === 'INVALID_REQUEST',
  );
  const created = await call(
    'POST /repositories',
    {
      remote_url: 'https://example.invalid/test.git',
      name: 'metadata repo',
      default_credential_id: credential.id,
    },
    {},
  );
  await assert.rejects(
    call('DELETE /git-credentials/:id', {}, { id: String(credential.id) }),
    (e) => e.error_code === 'WORKSPACE_REFERENCED',
  );
  await call('DELETE /repositories/:id', {}, { id: String(created.id) });
  await call('DELETE /git-credentials/:id', {}, { id: String(credential.id) });
  await assert.rejects(
    call(
      'PUT /repositories',
      { id: f.repository.id, remote_url: 'https://example.invalid/other.git' },
      {},
    ),
    (e) => e.error_code === 'WORKSPACE_REFERENCED',
  );
  f.scenario.record('s4-repository-credential-safe-dto', {
    assertions: [
      'secret withheld',
      'public file URL rejected',
      'execution defaults rejected',
      'referenced credential protected',
      'source change protected',
    ],
  });
});
test('S4 recovery alias durably resumes genuine interrupted creation, replays terminal before CAS and rejects changed requests', async (t) => {
  const { f, s, call } = await setup(t);
  let fired = false;
  const interrupted = new WorkspaceLifecycleService(
    f.store,
    f.roots,
    f.leases,
    {
      fault: async (point) => {
        if (point === 'CREATE_ROOT_PUBLISHED' && !fired) {
          fired = true;
          throw Error('controlled interruption');
        }
      },
    },
  );
  const createKey = randomUUID();
  await assert.rejects(
    interrupted.createLocal({
      name: 'actual interrupted create',
      requestKey: createKey,
    }),
  );
  const op = (
      await f.store.all(
        'SELECT * FROM WorkspaceOperations WHERE request_key=?',
        [createKey],
      )
    )[0],
    row = await f.store.workspace(op.workspace_id),
    params = { id: String(row.id) };
  assert.equal(row.lifecycle_state, 'RECOVERY_REQUIRED');
  const recoveryKey = randomUUID(),
    result = await call(
      'POST /workspaces/:id/recover',
      { expected_version: row.version },
      params,
      {},
      recoveryKey,
    );
  assert.equal(result.workspace.lifecycle_state, 'READY');
  assert.equal(result.operation.id, op.id);
  assert.equal(result.operation.type, 'CREATE');
  const alias = JSON.parse(
    (
      await f.store.all(
        'SELECT root_marker FROM WorkspaceOperations WHERE id=?',
        [op.id],
      )
    )[0].root_marker,
  ).recovery_requests[0];
  assert.equal(alias.workspace_id, row.id);
  assert.equal(alias.source_generation, row.source_generation);
  assert.equal(alias.operation_id, op.id);
  const replay = await call(
    'POST /workspaces/:id/recover',
    { expected_version: row.version },
    params,
    {},
    recoveryKey,
  );
  assert.equal(replay.operation.id, op.id);
  await assert.rejects(
    call(
      'POST /workspaces/:id/recover',
      { expected_version: row.version + 1 },
      params,
      {},
      recoveryKey,
    ),
    (e) => e.error_code === 'IDEMPOTENCY_KEY_CONFLICT',
  );
  await assert.rejects(
    call(
      'POST /workspaces/:id/recover',
      { expected_version: row.version },
      { id: String(f.row.id) },
      {},
      recoveryKey,
    ),
    (e) => e.error_code === 'IDEMPOTENCY_KEY_CONFLICT',
  );
  const count = (
    await f.store.all(
      'SELECT COUNT(*) count FROM WorkspaceOperations WHERE workspace_id=?',
      [row.id],
    )
  )[0].count;
  assert.equal(count, 1);
  const priorMarker = (
    await f.store.all(
      'SELECT root_marker FROM WorkspaceOperations WHERE id=?',
      [op.id],
    )
  )[0].root_marker;
  const corrupt = JSON.parse(priorMarker);
  corrupt.recovery_requests[0].source_generation += 1;
  await f.store.run('UPDATE WorkspaceOperations SET root_marker=? WHERE id=?', [
    JSON.stringify(corrupt),
    op.id,
  ]);
  await assert.rejects(
    call(
      'POST /workspaces/:id/recover',
      { expected_version: row.version },
      params,
      {},
      recoveryKey,
    ),
    (error) => error.error_code === 'SOURCE_SUPERSEDED',
  );
  await f.store.run('UPDATE WorkspaceOperations SET root_marker=? WHERE id=?', [
    priorMarker,
    op.id,
  ]);
  const fs = require('node:fs/promises'),
    original = s.roots.path(await f.store.workspace(row.id)),
    held = path.join(f.root, 'held-recovery-root-' + row.id);
  await fs.rename(original, held);
  await fs.mkdir(original, { mode: 0o700 });
  await fs.writeFile(
    path.join(original, 'unknown.txt'),
    'unknown root preserved',
    { mode: 0o600 },
  );
  await assert.rejects(
    call(
      'POST /workspaces/:id/recover',
      { expected_version: row.version },
      params,
      {},
      recoveryKey,
    ),
    (error) => error.error_code === 'WORKSPACE_RECOVERY_REQUIRED',
  );
  assert.equal(
    await fs.readFile(path.join(original, 'unknown.txt'), 'utf8'),
    'unknown root preserved',
  );
  f.scenario.record('s4-recover-existing-operation-alias', {
    workspace_id: row.id,
    operation_id: op.id,
    assertions: [
      'real root-published interruption',
      'durable alias',
      'terminal replay before CAS',
      'no duplicate operation',
      'changed body/owner conflict',
    ],
  });
});
test('S4 fresh bare initialize/fetch/refs/prune and verified unreferenced delete use actual owned Git objects', async (t) => {
  const { f, s } = await setup(t);
  const resources = new CandidateGitResources(s, {
    accessResolver: f.accessResolver,
    normalizeRemote: async (remote) => {
      assert.equal(remote, f.remote);
      await f.accessResolver({ remote_url: remote });
      return {
        remote_url: remote,
        normalized_url: 'owned-secondary-' + f.repository.id,
        provider: 'generic',
        host: 'fixture.invalid',
        path: 'actual',
        owner: '',
        repository_name: 'actual',
      };
    },
  });
  const row = await resources.saveRepository({
    name: 'fresh bare',
    remote_url: f.remote,
  });
  const initialized = await resources.initialize(row.id);
  assert.equal(initialized.storage_state, 'READY');
  const refs = await resources.refs(row.id);
  assert.ok(refs.some((ref) => ref.name === 'main' && ref.type === 'branch'));
  const bare = path.join(f.dataRoot, 'git', `repository-${row.id}.git`);
  assert.equal(
    f.git(['--git-dir', bare, 'cat-file', '-t', f.repository.commit]),
    'commit',
  );
  await resources.fetch(row.id);
  await resources.prune(row.id);
  const externalWorktree = path.join(
    f.root,
    'actual-unregistered-worktree-' + row.id,
  );
  f.git(
    [
      '--git-dir',
      bare,
      'worktree',
      'add',
      '--detach',
      externalWorktree,
      'refs/remotes/origin/main',
    ],
    f.root,
  );
  await assert.rejects(
    resources.removeRepository(row.id),
    (error) => error.error_code === 'WORKSPACE_REFERENCED',
  );
  assert.equal(
    await require('node:fs/promises').readFile(
      path.join(externalWorktree, 'main.sh'),
      'utf8',
    ),
    '#!/bin/sh\nprintf "actual"\n',
  );
  f.git(['--git-dir', bare, 'worktree', 'remove', externalWorktree], f.root);
  await resources.removeRepository(row.id);
  await assert.rejects(
    require('node:fs/promises').lstat(bare),
    (e) => e.code === 'ENOENT',
  );
  assert.equal(
    (
      await f.store.all('SELECT COUNT(*) count FROM Repositories WHERE id=?', [
        row.id,
      ])
    )[0].count,
    0,
  );
  assert.equal(
    (await f.store.all('SELECT COUNT(*) count FROM WorkspaceSyncRuns'))[0]
      .count,
    0,
  );
  assert.equal(
    (await f.store.all('SELECT COUNT(*) count FROM TaskRuns'))[0].count,
    0,
  );
  f.scenario.record('s4-repository-actual-bare-lifecycle', {
    repository_id: row.id,
    assertions: [
      'new bare initialized',
      'actual remote fetched',
      'refs and commit object verified',
      'prune only shared refs',
      'verified bare deleted',
      'no Workspace/Task side effects',
    ],
  });
});

test('S4 persisted Git identity survives actual full backup and source replacement restore', async (t) => {
  const { f, s, call } = await setup(t);
  await call('PUT /system/git-identity', {
    name: 'Preserved S4 Author',
    email: 'preserved@example.invalid',
    expected_version: 1,
  });
  const snapshot = await s.backup.create();
  await call('PUT /system/git-identity', {
    name: 'Later Author',
    email: 'later@example.invalid',
    expected_version: 2,
  });
  await f.sync.close();
  await f.engine.close();
  const restored = await s.restore.restore(snapshot);
  f.instance.useStore(restored);
  f.store = restored;
  const value = JSON.parse(
    await require('node:fs/promises').readFile(
      path.join(f.dataRoot, 'config/git-identity.json'),
      'utf8',
    ),
  );
  assert.deepEqual(value, {
    name: 'Preserved S4 Author',
    email: 'preserved@example.invalid',
    version: 2,
  });
  f.scenario.record('s4-git-identity-actual-backup-restore', {
    snapshot_id: snapshot,
    assertions: [
      'actual full snapshot',
      'actual root replacement restore',
      'Git identity version and metadata preserved',
    ],
  });
});

test('S4 API negative gates expose safe blocking Discovery diagnostics and reject directory kind bypass and stale published revision', async (t) => {
  const { f, s, call } = await setup(t, {
    files: {
      'main.sh':
        '# name: duplicate\n# name: again\n# cron: definitely invalid\nprintf bad\n',
    },
  });
  await f.discovery.savePolicy(f.row.id, {
    expected_version: 0,
    enabled: true,
    includes: ['**/*.sh'],
    excludes: [],
    languages: ['SHELL'],
  });
  const row = await f.store.workspace(f.row.id);
  await assert.rejects(
    call('POST /workspaces/:id/discovery/preview', {
      expected_version: row.version,
      expected_content_revision: row.content_revision,
    }),
    (error) => {
      assert.equal(error.error_code, 'DISCOVERY_RECONCILIATION_FAILED');
      assert.equal(error.status, 409);
      assert.ok(
        error.details.diagnostics.some(
          (item) =>
            item.code === 'DISCOVERY_METADATA_INVALID' &&
            item.path === 'main.sh' &&
            item.blocking,
        ),
      );
      assert.ok(!JSON.stringify(error.details).includes(f.dataRoot));
      return true;
    },
  );
  assert.equal(
    (await f.store.all('SELECT COUNT(*) count FROM Tasks'))[0].count,
    0,
  );
  await call('POST /workspaces/:id/directories', {
    path: 'typed-folder',
    must_not_exist: true,
  });
  const tree = await call('GET /workspaces/:id/tree');
  const token = tree.entries.find(
    (entry) => entry.path === 'typed-folder',
  ).identity_token;
  const rawIdentity = JSON.parse(
    Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
  )[3];
  await assert.rejects(
    call('POST /workspaces/:id/rename', {
      path: 'typed-folder',
      destination: 'bad-bypass',
      kind: 'FILE',
      expected_hash: rawIdentity,
    }),
    (error) => error.error_code === 'INVALID_REQUEST',
  );
  await require('node:fs/promises').writeFile(
    path.join(f.workspaceRoot, 'main.sh'),
    'changed outside published API\n',
  );
  await assert.rejects(
    call('GET /workspaces/:id/files', {}, undefined, { path: 'main.sh' }),
    (error) => error.error_code === 'WORKSPACE_VERSION_CONFLICT',
  );
  assert.equal(
    (await f.store.workspace(f.row.id)).content_revision,
    row.content_revision + 1,
  );
  f.scenario.record('s4-safe-discovery-and-file-type-negative', {
    workspace_id: f.row.id,
    assertions: [
      'safe fixed diagnostic reason and relative path',
      'no task created',
      'directory kind checked under mutation lease',
      'unpublished source revision rejected',
    ],
  });
});
