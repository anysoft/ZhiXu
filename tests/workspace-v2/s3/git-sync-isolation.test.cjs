const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncFixture } = require('./sync-fixture.cjs');

async function enableDiscovery(f, workspaceId) {
  const policy = await f.discovery.policy(workspaceId);
  await f.discovery.savePolicy(workspaceId, {
    expected_version: policy.version,
    enabled: true,
    includes: ['**/*.sh'],
    excludes: [],
    languages: ['SHELL'],
  });
}
test('same real repository/ref publishes independent Workspace discovery, source snapshots and outbox identities', async (t) => {
  const f = await createSyncFixture(t, {
    caseId: 'S3-SYNC-ISOLATION',
    files: { 'main.sh': 'echo first\n' },
  });
  const second = await f.createWorkspace();
  await f.policies.save(second.id, {
    expected_version: 1,
    enabled: true,
    mode: 'MANUAL',
    schedule: null,
  });
  await enableDiscovery(f, f.row.id);
  await enableDiscovery(f, second.id);
  const firstBase = await f.sync.wait((await f.sync.submit(f.row.id)).id);
  const secondBase = await f.sync.wait((await f.sync.submit(second.id)).id);
  assert.equal(firstBase.status, 'SUCCESS', firstBase.error_code);
  assert.equal(secondBase.status, 'SUCCESS', secondBase.error_code);
  const canonical = await f.store.all(
    'SELECT t.id,t.workspace_id,t.discovery_key,s.relative_entrypoint FROM Tasks t JOIN TaskSources s ON s.task_id=t.id ORDER BY t.id',
  );
  assert.equal(canonical.length, 2);
  assert.notEqual(canonical[0].id, canonical[1].id);
  assert.equal(canonical[0].discovery_key, canonical[1].discovery_key);
  assert.notEqual(canonical[0].workspace_id, canonical[1].workspace_id);
  const oldSecond = await f.store.workspace(second.id);
  const oldSecondGit = (
    await f.store.all('SELECT * FROM GitWorkspaces WHERE workspace_id=?', [
      second.id,
    ])
  )[0];
  const target = await f.commit({
    'main.sh': 'echo second\n',
    'added.sh': 'echo added\n',
  });
  const firstUpdate = await f.sync.wait((await f.sync.submit(f.row.id)).id);
  assert.equal(firstUpdate.status, 'SUCCESS', firstUpdate.error_code);
  assert.deepEqual(await f.store.workspace(second.id), oldSecond);
  assert.deepEqual(
    (
      await f.store.all('SELECT * FROM GitWorkspaces WHERE workspace_id=?', [
        second.id,
      ])
    )[0],
    oldSecondGit,
  );
  assert.equal(
    (
      await f.store.all('SELECT COUNT(*) n FROM Tasks WHERE workspace_id=?', [
        second.id,
      ])
    )[0].n,
    1,
  );
  const secondUpdate = await f.sync.wait((await f.sync.submit(second.id)).id);
  assert.equal(secondUpdate.status, 'SUCCESS', secondUpdate.error_code);
  const outboxes = await f.store.all(
    'SELECT * FROM WorkspaceUpdateOutbox ORDER BY id',
  );
  assert.equal(outboxes.length, 4);
  assert.equal(new Set(outboxes.map((row) => row.sync_run_id)).size, 4);
  assert.equal(
    outboxes.filter(
      (row) => row.workspace_id === f.row.id && row.after_commit === target,
    ).length,
    1,
  );
  assert.equal(
    outboxes.filter(
      (row) => row.workspace_id === second.id && row.after_commit === target,
    ).length,
    1,
  );
  for (const id of [f.row.id, second.id]) {
    const sources = await f.store.all(
      'SELECT s.task_id,s.workspace_id,s.relative_entrypoint FROM TaskSources s WHERE workspace_id=? ORDER BY s.relative_entrypoint',
      [id],
    );
    assert.deepEqual(
      sources.map((row) => row.relative_entrypoint),
      ['added.sh', 'main.sh'],
    );
    assert.ok(sources.every((row) => row.workspace_id === id));
  }
  const firstTasks = await f.store.all(
    'SELECT id FROM Tasks WHERE workspace_id=?',
    [f.row.id],
  );
  const secondTasks = await f.store.all(
    'SELECT id FROM Tasks WHERE workspace_id=?',
    [second.id],
  );
  assert.equal(
    firstTasks.some((a) => secondTasks.some((b) => a.id === b.id)),
    false,
  );
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 0);
  await f.scenario.record('S3-SYNC-ISOLATION', {
    workspace_ids: [f.row.id, second.id],
    repository_id: f.repository.id,
    sync_run_ids: outboxes.map((row) => row.sync_run_id),
    outbox_ids: outboxes.map((row) => row.id),
    canonical_task_ids: [...firstTasks, ...secondTasks].map((row) => row.id),
    after_commit: target,
    task_runs: 0,
  });
});

for (const refType of ['tag', 'commit'])
  test(
    'fixed ' +
      refType +
      ' Sync establishes exactly one initial baseline and never follows moved refs',
    async (t) => {
      const f = await createSyncFixture(t, {
        caseId: 'S3-SYNC-PIN-' + refType,
        files: { 'main.sh': 'echo pinned\n' },
      });
      f.git(['tag', 'fixed-tag'], f.repository.source);
      await f.fetch();
      const row = await f.createWorkspace({
        refType,
        refName: refType === 'tag' ? 'fixed-tag' : f.repository.commit,
      });
      await f.policies.save(row.id, {
        expected_version: 1,
        enabled: true,
        mode: 'MANUAL',
        schedule: null,
      });
      await enableDiscovery(f, row.id);
      const initial = await f.sync.wait((await f.sync.submit(row.id)).id);
      assert.equal(initial.status, 'SUCCESS', initial.error_code);
      assert.equal(initial.initial, 1);
      assert.equal(initial.before_commit, f.repository.commit);
      assert.equal(initial.after_commit, f.repository.commit);
      assert.equal(initial.git_update_status, 'UNCHANGED');
      const original = await f.store.workspace(row.id);
      await f.commit({
        'main.sh': 'echo advanced\n',
        'should-not-discover.sh': 'echo not-pinned\n',
      });
      f.git(['tag', '--force', 'fixed-tag'], f.repository.source);
      const unchanged = await f.sync.wait((await f.sync.submit(row.id)).id);
      assert.equal(unchanged.status, 'NO_CHANGE', unchanged.error_code);
      assert.equal(unchanged.after_commit, f.repository.commit);
      const current = await f.store.workspace(row.id);
      assert.equal(current.content_revision, original.content_revision);
      assert.equal(
        current.content_inventory_hash,
        original.content_inventory_hash,
      );
      assert.equal(
        (
          await f.store.all(
            'SELECT COUNT(*) n FROM WorkspaceUpdateOutbox WHERE workspace_id=?',
            [row.id],
          )
        )[0].n,
        1,
      );
      assert.equal(
        (
          await f.store.all(
            'SELECT COUNT(*) n FROM Tasks WHERE workspace_id=?',
            [row.id],
          )
        )[0].n,
        1,
      );
      assert.equal(
        (await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
        0,
      );
      await f.scenario.record('S3-SYNC-PIN-' + refType, {
        workspace_id: row.id,
        initial_sync_id: initial.id,
        no_change_sync_id: unchanged.id,
        pinned_commit: f.repository.commit,
        outboxes: 1,
        canonical_tasks: 1,
        task_runs: 0,
      });
    },
  );
