const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createGitFixture, git } = require('./git-fixture.cjs');
const {
  WorkspaceGitAdapter,
} = require('../../../back/services/gitWorkspaceV2/git');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function bytesProof(f, row = f.row) {
  const root = f.roots.path(row),
    pointer = (await fs.readFile(path.join(root, '.git'), 'utf8'))
      .trim()
      .slice(8);
  return {
    head: git(['rev-parse', 'HEAD'], root),
    index: hash(
      await fs.readFile(path.join(path.resolve(root, pointer), 'index')),
    ),
    main: await fs.readFile(path.join(root, 'main.py'), 'utf8'),
  };
}

test('actual branch fetch is bare-only; FF applies only selected Workspace; NO_CHANGE is physical', async (t) => {
  const f = await createGitFixture(t);
  const second = await f.createWorkspace();
  const initial = await bytesProof(f),
    untouched = await bytesProof(f, second);
  assert.equal((await f.plan()).status, 'NO_CHANGE');
  const target = await f.commit({
    'main.py': 'print("real fast-forward")\n',
    'nested/new.sh': 'printf real\n',
  });
  const plan = await f.fetchPlan();
  assert.equal(plan.status, 'FF_READY');
  assert.equal(plan.target, target);
  assert.deepEqual(await bytesProof(f), initial);
  const actual = await f.apply(plan);
  assert.equal(actual.head, target);
  assert.equal(actual.inventory.hash, actual.proof.inventoryHash);
  assert.deepEqual(await bytesProof(f, second), untouched);
  assert.equal((await f.plan()).status, 'NO_CHANGE');
  assert.equal(
    (await f.store.all('SELECT COUNT(*) AS n FROM TaskRuns'))[0].n,
    0,
  );
  await f.scenario.record('real-branch-ff', {
    before: initial.head,
    after: target,
    secondWorkspaceUntouched: true,
    taskRuns: 0,
  });
});

for (const kind of ['dirty', 'staged', 'untracked', 'ignored'])
  test(
    'preserves actual ' + kind + ' bytes/index and blocks update',
    async (t) => {
      const f = await createGitFixture(
        t,
        kind === 'ignored'
          ? { files: { '.gitignore': 'collision.txt\n' } }
          : {},
      );
      if (kind === 'dirty' || kind === 'staged') {
        await fs.writeFile(
          path.join(f.workspaceRoot, 'main.py'),
          'local user bytes\n',
        );
        if (kind === 'staged') git(['add', 'main.py'], f.workspaceRoot);
      } else
        await fs.writeFile(
          path.join(f.workspaceRoot, 'collision.txt'),
          'untracked user bytes\n',
        );
      const before = await bytesProof(f);
      await f.commit({
        'main.py': 'print("remote next")\n',
        'collision.txt': 'remote collision\n',
      });
      if (kind === 'ignored') {
        git(['add', '--force', 'collision.txt'], f.repository.source);
        git(
          ['commit', '-m', 'track remote collision despite ignore'],
          f.repository.source,
        );
      }
      const plan = await f.fetchPlan();
      assert.equal(plan.status, 'BLOCKED');
      assert.equal(
        plan.diagnostic,
        kind === 'dirty'
          ? 'DIRTY_WORKTREE'
          : kind === 'staged'
          ? 'STAGED_CHANGES'
          : 'UNTRACKED_COLLISION',
      );
      await assert.rejects(f.apply(plan), { error_code: plan.diagnostic });
      assert.deepEqual(await bytesProof(f), before);
      if (kind === 'untracked' || kind === 'ignored')
        assert.equal(
          await fs.readFile(
            path.join(f.workspaceRoot, 'collision.txt'),
            'utf8',
          ),
          'untracked user bytes\n',
        );
    },
  );

test('actual local-only and diverged commits remain untouched with distinct diagnostics', async (t) => {
  const f = await createGitFixture(t);
  await fs.writeFile(
    path.join(f.workspaceRoot, 'local.txt'),
    'owned local commit\n',
  );
  git(['add', 'local.txt'], f.workspaceRoot);
  git(['commit', '-m', 'unique local commit'], f.workspaceRoot);
  const before = await bytesProof(f);
  const localOnly = await f.plan();
  assert.equal(localOnly.diagnostic, 'LOCAL_ONLY_COMMITS');
  await f.commit({ 'remote.txt': 'independent remote commit\n' });
  const diverged = await f.fetchPlan();
  assert.equal(diverged.diagnostic, 'DIVERGED');
  await assert.rejects(f.apply(diverged), { error_code: 'DIVERGED' });
  assert.deepEqual(await bytesProof(f), before);
  assert.equal(
    await fs.readFile(path.join(f.workspaceRoot, 'local.txt'), 'utf8'),
    'owned local commit\n',
  );
});

test('tag and commit Workspaces stay pinned when branch and remote tag advance', async (t) => {
  const f = await createGitFixture(t, { createWorkspace: false });
  git(['tag', 'stable'], f.repository.source);
  await f.fetch();
  const tag = await f.createWorkspace({ refType: 'tag', refName: 'stable' });
  const commit = await f.createWorkspace({
    refType: 'commit',
    refName: f.repository.commit,
  });
  const before = await bytesProof(f, tag),
    pin = await bytesProof(f, commit);
  await f.commit({ 'main.py': 'print("new branch and tag")\n' });
  git(['tag', '--force', 'stable'], f.repository.source);
  await f.fetch();
  assert.equal((await f.plan(tag.id)).status, 'NO_CHANGE');
  assert.equal((await f.plan(commit.id)).status, 'NO_CHANGE');
  assert.deepEqual(await bytesProof(f, tag), before);
  assert.deepEqual(await bytesProof(f, commit), pin);
});

test('unsafe target symlink and reserved owner path are rejected before mutation', async (t) => {
  const f = await createGitFixture(t),
    before = await bytesProof(f);
  await fs.symlink(
    '/etc/passwd',
    path.join(f.repository.source, 'external-link'),
  );
  git(['add', 'external-link'], f.repository.source);
  git(['commit', '-m', 'unsafe target'], f.repository.source);
  await f.fetch();
  await assert.rejects(f.plan(), { error_code: 'UNSAFE_TARGET_TREE' });
  assert.deepEqual(await bytesProof(f), before);
  assert.equal(
    await fs
      .lstat(path.join(f.workspaceRoot, 'external-link'))
      .catch((e) => e.code),
    'ENOENT',
  );
});

test('missing commit object and invalid admin produce safe distinct errors', async (t) => {
  const f = await createGitFixture(t),
    before = await bytesProof(f);
  const target = await f.commit({
    'main.py': 'print("missing object target")\n',
  });
  await f.fetch();
  const object = path.join(
    f.repository.bare,
    'objects',
    target.slice(0, 2),
    target.slice(2),
  );
  const content = await fs.readFile(object);
  await fs.unlink(object);
  await assert.rejects(f.plan(), { error_code: 'MISSING_OBJECT' });
  await fs.writeFile(object, content);
  await fs.chmod(object, 0o444);
  const pointer = await fs.readFile(path.join(f.workspaceRoot, '.git'));
  await fs.writeFile(
    path.join(f.workspaceRoot, '.git'),
    'gitdir: /tmp/unowned-admin\n',
  );
  await assert.rejects(f.plan(), { error_code: 'INVALID_GIT_ADMIN' });
  await fs.writeFile(path.join(f.workspaceRoot, '.git'), pointer);
  assert.deepEqual(await bytesProof(f), before);
});

test('default access rejects local URL and unsafe credential/config paths without leaking values', async (t) => {
  const f = await createGitFixture(t);
  const adapter = new WorkspaceGitAdapter(f.store, f.roots);
  await assert.rejects(
    f.leases.withRepository(f.repository.id, 'NO_LOCAL_DEFAULT', (lease) =>
      adapter.fetch(f.repository.id, lease),
    ),
    { error_code: 'INVALID_REMOTE' },
  );
  const secret = 'private-' + require('node:crypto').randomUUID();
  f.scenario.registerSecret(secret);
  git(
    ['config', 'http.extraheader', 'Authorization: ' + secret],
    f.repository.bare,
  );
  await assert.rejects(
    f.fetch(),
    (error) =>
      error.error_code === 'INVALID_GIT_ADMIN' &&
      !String(error).includes(secret),
  );
});
