const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createGitFixture, git } = require('./git-fixture.cjs');
for (const flag of ['assume-unchanged', 'skip-worktree'])
  test(
    'Git ' + flag + ' cannot hide user bytes from FF admission',
    async (t) => {
      const f = await createGitFixture(t);
      git(['update-index', '--' + flag, 'main.py'], f.workspaceRoot);
      await fs.writeFile(
        path.join(f.workspaceRoot, 'main.py'),
        'preserve hidden user bytes\n',
      );
      const pointer = (
        await fs.readFile(path.join(f.workspaceRoot, '.git'), 'utf8')
      )
        .trim()
        .slice(8);
      const index = path.join(path.resolve(f.workspaceRoot, pointer), 'index');
      const hash = async () =>
        createHash('sha256')
          .update(await fs.readFile(index))
          .digest('hex');
      const before = await hash(),
        head = git(['rev-parse', 'HEAD'], f.workspaceRoot);
      await f.commit({ 'main.py': 'print("remote replacement")\n' });
      const plan = await f.fetchPlan();
      assert.equal(plan.status, 'BLOCKED');
      assert.equal(plan.diagnostic, 'DIRTY_WORKTREE');
      await assert.rejects(f.apply(plan), { error_code: 'DIRTY_WORKTREE' });
      assert.equal(await hash(), before);
      assert.equal(git(['rev-parse', 'HEAD'], f.workspaceRoot), head);
      assert.equal(
        await fs.readFile(path.join(f.workspaceRoot, 'main.py'), 'utf8'),
        'preserve hidden user bytes\n',
      );
    },
  );
