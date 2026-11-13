const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSyncFixture } = require('./sync-fixture.cjs');

const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
async function indexFile(f) {
  const pointer = (
    await fs.readFile(path.join(f.workspaceRoot, '.git'), 'utf8')
  )
    .trim()
    .slice(8);
  return path.join(path.resolve(f.workspaceRoot, pointer), 'index');
}
test('full Sync forces trusted stat checks and preserves hidden same-size/restored-mtime user edit', async (t) => {
  const f = await createSyncFixture(t, {
    caseId: 'S3-STAT-CACHE-PRESERVATION',
    files: { 'main.py': 'print("BASE")\n' },
  });
  const baseline = await f.sync.wait((await f.sync.submit(f.row.id)).id);
  assert.equal(baseline.status, 'SUCCESS', baseline.error_code);
  f.git(['config', 'core.trustctime', 'false'], f.repository.bare);
  f.git(['config', 'core.checkStat', 'minimal'], f.repository.bare);
  f.git(['config', 'core.ignoreStat', 'false'], f.repository.bare);
  // Refresh a real non-racy index. Otherwise Git's same-second racy-stat
  // protection can mask the weakening-configuration bug in the test itself.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  f.git(['update-index', '--refresh', '--force-write-index'], f.workspaceRoot);
  const file = path.join(f.workspaceRoot, 'main.py'),
    stat = await fs.stat(file);
  await fs.writeFile(file, 'print("USER")\n');
  await fs.utimes(file, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  // The unmodified repository config demonstrably hides this actual edit.
  assert.doesNotThrow(() =>
    f.git(
      ['--no-optional-locks', 'diff', '--quiet', '--', 'main.py'],
      f.workspaceRoot,
    ),
  );
  const index = await indexFile(f),
    beforeIndex = await hash(index),
    before = await f.store.workspace(f.row.id);
  const target = await f.commit({ 'main.py': 'print("NEXT")\n' });
  const run = await f.sync.wait((await f.sync.submit(f.row.id)).id);
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.error_code, 'DIRTY_WORKTREE');
  assert.equal(
    f.git(['rev-parse', 'HEAD'], f.workspaceRoot),
    baseline.after_commit,
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'print("USER")\n');
  assert.equal(await hash(index), beforeIndex);
  assert.equal(
    (await f.store.workspace(f.row.id)).content_inventory_hash,
    before.content_inventory_hash,
  );
  assert.equal(
    f.git(['config', '--get', 'core.trustctime'], f.repository.bare),
    'false',
  );
  assert.equal(
    f.git(['config', '--get', 'core.checkStat'], f.repository.bare),
    'minimal',
  );
  assert.equal(
    (await f.store.all('SELECT COUNT(*) n FROM WorkspaceUpdateOutbox'))[0].n,
    1,
  );
  assert.equal((await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n, 0);
  await f.scenario.record('S3-STAT-CACHE-PRESERVATION', {
    sync_run_id: run.id,
    before_commit: baseline.after_commit,
    rejected_target_commit: target,
    weak_config_diff_clean: true,
    final_status: run.status,
    error_code: run.error_code,
    user_bytes_preserved: true,
    exact_index_preserved: true,
    repository_config_preserved: true,
    outboxes: 1,
  });
});

for (const [kind, names] of [
  ['file-case', ['Case.sh', 'case.sh']],
  ['directory-case', ['Directory/first.sh', 'directory/second.sh']],
  ['file-directory-case', ['Path.sh', 'path.sh/child.sh']],
  ['unicode-normalization', ['Caf\u00e9.sh', 'Cafe\u0301.sh']],
])
  test(
    'full Sync rejects actual Git ' +
      kind +
      ' aliases before any checkout or publication',
    async (t) => {
      const f = await createSyncFixture(t, {
        caseId: 'S3-TARGET-ALIAS-' + kind,
      });
      const baseline = await f.sync.wait((await f.sync.submit(f.row.id)).id);
      assert.equal(baseline.status, 'SUCCESS', baseline.error_code);
      const index = await indexFile(f),
        owner = path.join(f.workspaceRoot, '.platform-workspace-owner.json');
      const before = {
        index: await hash(index),
        owner: await hash(owner),
        main: await hash(path.join(f.workspaceRoot, 'main.py')),
        inventory: (await f.store.workspace(f.row.id)).content_inventory_hash,
      };
      const blobs = [];
      for (let number = 0; number < 2; number++) {
        const file = path.join(f.root, 'owned-blob-' + number);
        await fs.writeFile(file, 'echo distinct-' + number + '\n');
        blobs.push(f.git(['hash-object', '-w', file], f.repository.source));
        f.git(
          [
            '-c',
            'core.ignorecase=false',
            '-c',
            'core.precomposeunicode=false',
            'update-index',
            '--add',
            '--cacheinfo',
            '100644',
            blobs[number],
            names[number],
          ],
          f.repository.source,
        );
      }
      f.git(
        ['commit', '-m', 'actual ambiguous Git target ' + kind],
        f.repository.source,
      );
      const targetNames = f
        .git(
          ['ls-tree', '-r', '--name-only', '-z', 'HEAD'],
          f.repository.source,
        )
        .split('\0');
      assert.ok(names.every((name) => targetNames.includes(name)));
      const target = f.git(['rev-parse', 'HEAD'], f.repository.source);
      const run = await f.sync.wait((await f.sync.submit(f.row.id)).id);
      assert.equal(run.status, 'FAILED');
      assert.equal(run.error_code, 'UNSAFE_TARGET_TREE');
      assert.equal(run.after_commit, null);
      assert.equal(
        (await f.store.workspace(f.row.id)).lifecycle_state,
        'READY',
      );
      assert.equal(
        f.git(['rev-parse', 'HEAD'], f.workspaceRoot),
        baseline.after_commit,
      );
      assert.deepEqual(
        {
          index: await hash(index),
          owner: await hash(owner),
          main: await hash(path.join(f.workspaceRoot, 'main.py')),
          inventory: (await f.store.workspace(f.row.id)).content_inventory_hash,
        },
        before,
      );
      assert.equal(
        (await f.store.all('SELECT COUNT(*) n FROM WorkspaceUpdateOutbox'))[0]
          .n,
        1,
      );
      assert.equal(
        (await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
        0,
      );
      await f.scenario.record('S3-TARGET-ALIAS-' + kind, {
        sync_run_id: run.id,
        before_commit: baseline.after_commit,
        rejected_target_commit: target,
        actual_git_tree_has_both_aliases: true,
        final_status: run.status,
        error_code: run.error_code,
        user_source_preserved: true,
        exact_index_preserved: true,
        owner_preserved: true,
        outboxes: 1,
      });
    },
  );
