const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createGitFixture, git } = require('./git-fixture.cjs');

test('two real branches share bare objects while Workspace refs ignore repository default branch', async (t) => {
  const f = await createGitFixture(t);
  git(['switch', '-c', 'development'], f.repository.source);
  const devHead = await f.commit({ 'main.py': 'print("development only")\n' });
  await f.fetch();
  const dev = await f.createWorkspace({ refName: 'development' });
  git(['switch', 'main'], f.repository.source);
  const mainHead = await f.commit({ 'main.py': 'print("main only")\n' });
  await f.store.run(
    "UPDATE Repositories SET default_branch='development' WHERE id=?",
    [f.repository.id],
  );
  const plan = await f.fetchPlan();
  assert.equal(plan.refName, 'main');
  assert.equal(plan.target, mainHead);
  assert.equal(plan.status, 'FF_READY');
  assert.equal((await f.plan(dev.id)).target, devHead);
  assert.equal((await f.plan(dev.id)).status, 'NO_CHANGE');
  await f.apply(plan);
  assert.equal(git(['rev-parse', 'HEAD'], f.roots.path(dev)), devHead);
  assert.equal(
    await fs.readFile(path.join(f.roots.path(dev), 'main.py'), 'utf8'),
    'print("development only")\n',
  );
});

test('missing branch and invalid ref metadata are distinct safe diagnostics with unchanged bytes', async (t) => {
  const f = await createGitFixture(t),
    before = await fs.readFile(path.join(f.workspaceRoot, 'main.py'));
  const head = git(['rev-parse', 'HEAD'], f.workspaceRoot);
  git(['switch', '-c', 'replacement'], f.repository.source);
  git(['branch', '-D', 'main'], f.repository.source);
  await f.fetch();
  await assert.rejects(f.plan(), { error_code: 'REF_NOT_FOUND' });
  // Validate actual Git syntax at the read-only boundary, without changing the
  // frozen immutable Workspace binding just to manufacture invalid metadata.
  await assert.rejects(
    f.leases.withRepository(f.repository.id, 'INVALID_REF_TEST', (lease) =>
      f.gitAdapter.verifyRef(f.repository.id, 'branch', 'invalid.lock', lease),
    ),
    { error_code: 'INVALID_REF' },
  );
  await assert.rejects(
    f.leases.withRepository(
      f.repository.id,
      'REVISION_EXPRESSION_TEST',
      (lease) =>
        f.gitAdapter.verifyRef(f.repository.id, 'branch', 'main~1', lease),
    ),
    { error_code: 'INVALID_REF' },
  );
  assert.equal(git(['rev-parse', 'HEAD'], f.workspaceRoot), head);
  assert.deepEqual(
    await fs.readFile(path.join(f.workspaceRoot, 'main.py')),
    before,
  );
});
