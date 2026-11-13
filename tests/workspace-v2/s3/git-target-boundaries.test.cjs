const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createGitFixture, git } = require('./git-fixture.cjs');
for (const kind of ['owner', 'encoded-path', 'quota'])
  test(
    'actual target ' +
      kind +
      ' is rejected before checkout preserves ownership/index/source',
    async (t) => {
      const f = await createGitFixture(t, { caseId: 'S3-TARGET-' + kind });
      const pointer = (
        await fs.readFile(path.join(f.workspaceRoot, '.git'), 'utf8')
      )
        .trim()
        .slice(8);
      const index = path.join(path.resolve(f.workspaceRoot, pointer), 'index');
      const hash = async (file) =>
        createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex');
      const owner = path.join(
        f.workspaceRoot,
        '.platform-workspace-owner.json',
      );
      const before = {
        head: git(['rev-parse', 'HEAD'], f.workspaceRoot),
        index: await hash(index),
        owner: await hash(owner),
        main: await hash(path.join(f.workspaceRoot, 'main.py')),
      };
      const target =
        kind === 'owner'
          ? '.platform-workspace-owner.json'
          : kind === 'encoded-path'
          ? 'literal%2e%2e.txt'
          : 'oversized.bin';
      await f.commit({
        [target]:
          kind === 'quota'
            ? Buffer.alloc(64 * 1024 * 1024 + 1, 0x5a)
            : 'remote user source\n',
      });
      await f.fetch();
      await assert.rejects(f.plan(), {
        error_code:
          kind === 'quota' ? 'WORKSPACE_FILE_TOO_LARGE' : 'UNSAFE_TARGET_TREE',
      });
      assert.deepEqual(
        {
          head: git(['rev-parse', 'HEAD'], f.workspaceRoot),
          index: await hash(index),
          owner: await hash(owner),
          main: await hash(path.join(f.workspaceRoot, 'main.py')),
        },
        before,
      );
      if (kind !== 'owner')
        assert.equal(
          await fs
            .lstat(path.join(f.workspaceRoot, target))
            .catch((error) => error.code),
          'ENOENT',
        );
      await f.scenario.record('S3-TARGET-' + kind, {
        before_commit: before.head,
        rejection:
          kind === 'quota' ? 'WORKSPACE_FILE_TOO_LARGE' : 'UNSAFE_TARGET_TREE',
        ownership_preserved: true,
        index_preserved: true,
        source_preserved: true,
      });
    },
  );
