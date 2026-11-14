// Physical Git source fixture only; application and schema are created by the real compiled App.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { releaseRoot } = require('./artifact-support.cjs');
const projectRoot = releaseRoot();
const schemaPath = path.join(
  projectRoot,
  'static/build/applicationV2/contracts/fresh-v2.sql',
);
function git(args, cwd) {
  return execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'S1.A Fixture',
      GIT_AUTHOR_EMAIL: 's1a@example.invalid',
      GIT_COMMITTER_NAME: 'S1.A Fixture',
      GIT_COMMITTER_EMAIL: 's1a@example.invalid',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function seedRepository(fixture, id = 1) {
  const source = path.join(fixture.root, 'remote-' + id);
  await fs.mkdir(source, { mode: 0o700 });
  git(['init', '--initial-branch=main'], source);
  await fs.writeFile(
    path.join(source, 'main.py'),
    'print("s1a-only-source")\n',
  );
  git(['add', 'main.py'], source);
  git(['commit', '-m', 'isolated fixture'], source);
  const commit = git(['rev-parse', 'HEAD'], source);
  await fs.mkdir(path.join(fixture.dataRoot, 'git'), {
    recursive: true,
    mode: 0o700,
  });
  const bare = path.join(fixture.dataRoot, 'git', 'repository-' + id + '.git');
  git(['clone', '--no-hardlinks', '--bare', source, bare], fixture.root);
  await fixture.store.run(
    "INSERT INTO Repositories(id,name,provider,remote_url,normalized_url,storage_path,storage_state,default_branch) VALUES(?,?,'github',?,?,?,'READY','main')",
    [
      id,
      'fixture-' + id,
      'https://example.invalid/repo-' + id + '.git',
      'https://example.invalid/repo-' + id + '.git',
      bare,
    ],
  );
  return { id, source, bare, commit };
}

module.exports = { projectRoot, schemaPath, git, seedRepository };
