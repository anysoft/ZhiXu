const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { randomUUID } = require('node:crypto');
const {
  createS3Fixture,
  seedRepository,
  git,
  assertOwnedInstance,
} = require('./fixture.cjs');
const {
  WorkspaceGitAdapter,
} = require('../../../back/services/gitWorkspaceV2/git');
const {
  WorkspaceLifecycleService,
} = require('../../../back/services/workspaceV2/lifecycle');

// This constructor capability is deliberately absent from production defaults.
// It permits only the exact canonical remote allocated under this owned case.
async function createLocalGitAccess(instance, repository) {
  const expected = path.join(instance.root, 'remote-' + repository.id);
  const initial = await fs.lstat(expected);
  return async (row) => {
    await assertOwnedInstance(instance.root);
    let actual;
    try {
      actual = fileURLToPath(row.remote_url);
    } catch {
      throw Error('INVALID_REMOTE');
    }
    const now = await fs.lstat(expected);
    if (
      actual !== expected ||
      (await fs.realpath(expected)) !== expected ||
      !now.isDirectory() ||
      now.isSymbolicLink() ||
      now.dev !== initial.dev ||
      now.ino !== initial.ino ||
      now.mode & 0o077 ||
      (process.getuid && now.uid !== process.getuid())
    )
      throw Error('INVALID_REMOTE');
    return {
      remote: row.remote_url,
      directory: expected,
      secrets: [],
      cleanup: async () => {},
      env: {
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    };
  };
}

async function createGitFixture(t, options = {}) {
  const scenario = await createS3Fixture(t, {
    caseId: options.caseId || 's3-git-' + randomUUID(),
  });
  const instance = await scenario.createInstance('A');
  const repository = await seedRepository(instance);
  const write = async (files, at = repository.source) => {
    for (const [name, content] of Object.entries(files)) {
      if (
        name.startsWith('/') ||
        name
          .split('/')
          .some((part) => !part || ['.', '..', '.git'].includes(part))
      )
        throw Error('UNSAFE_TEST_PATH');
      if (content === null) await fs.rm(path.join(at, name), { force: true });
      else {
        await fs.mkdir(path.dirname(path.join(at, name)), {
          recursive: true,
          mode: 0o700,
        });
        await fs.writeFile(path.join(at, name), content);
      }
    }
  };
  if (options.files) {
    await write(options.files);
    git(['add', '--all'], repository.source);
    git(['commit', '-m', 'actual S3 initial source'], repository.source);
  }
  repository.commit = git(['rev-parse', 'HEAD'], repository.source);
  const remote = pathToFileURL(repository.source).href;
  await instance.store.run(
    'UPDATE Repositories SET remote_url=?,normalized_url=? WHERE id=?',
    [remote, remote, repository.id],
  );
  const accessResolver = await createLocalGitAccess(instance, repository);
  const gitAdapter = new WorkspaceGitAdapter(instance.store, instance.roots, {
    accessResolver,
  });
  const lifecycle = new WorkspaceLifecycleService(
    instance.store,
    instance.roots,
    instance.leases,
  );
  const fetch = () =>
    instance.leases.withRepository(repository.id, 'S3_FETCH_TEST', (lease) =>
      gitAdapter.fetch(repository.id, lease),
    );
  await fetch();
  const createWorkspace = async (input = {}) =>
    lifecycle.createGit({
      name: 'actual S3 checkout ' + randomUUID(),
      requestKey: randomUUID(),
      repositoryId: repository.id,
      refType: input.refType || 'branch',
      refName: input.refName || 'main',
    });
  const row =
    options.createWorkspace === false ? null : await createWorkspace(options);
  const withLeases = (workspaceId, action) =>
    instance.leases.withRepository(repository.id, 'S3_PLAN_TEST', (repoLease) =>
      instance.leases.withWorkspace(workspaceId, 'S3_PLAN_TEST', (wsLease) =>
        action(repoLease, wsLease),
      ),
    );
  const plan = (workspaceId = row.id) =>
    withLeases(workspaceId, (repo, ws) =>
      gitAdapter.plan(workspaceId, repo, ws),
    );
  const fetchPlan = async (workspaceId = row.id) => {
    await fetch();
    return plan(workspaceId);
  };
  const apply = (selected, callbacks = {}) =>
    withLeases(selected.workspaceId, (repo, ws) =>
      gitAdapter.apply(selected, repo, ws, callbacks),
    );
  const commit = async (files, message = 'actual remote update') => {
    await write(files);
    git(['add', '--all'], repository.source);
    git(['commit', '-m', message], repository.source);
    return git(['rev-parse', 'HEAD'], repository.source);
  };
  return {
    ...instance,
    instance,
    scenario,
    repository,
    remote,
    row,
    lifecycle,
    gitAdapter,
    accessResolver,
    root: instance.root,
    workspaceRoot: row && instance.roots.path(row),
    write,
    fetch,
    createWorkspace,
    withLeases,
    plan,
    fetchPlan,
    apply,
    commit,
    git,
  };
}
module.exports = { createGitFixture, createLocalGitAccess, git };
