const { createGitFixture, createLocalGitAccess } = require('./git-fixture.cjs');
const {
  WorkspaceGitAdapter,
} = require('../../../back/services/gitWorkspaceV2/git');
const {
  GitWorkspaceDiscovery,
} = require('../../../back/services/gitWorkspaceV2/discovery');
const {
  WorkspaceGitUpdateOutbox,
  WorkspaceGitUpdateTriggers,
} = require('../../../back/services/gitWorkspaceV2/outbox');
const {
  GitWorkspaceSyncService,
} = require('../../../back/services/gitWorkspaceV2/sync');
const {
  WorkspaceSyncScheduler,
} = require('../../../back/services/gitWorkspaceV2/scheduler');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
async function syncServices(f, options = {}) {
  const engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  const gitAdapter = new WorkspaceGitAdapter(f.store, f.roots, {
    accessResolver:
      f.accessResolver ?? (await createLocalGitAccess(f, f.repository)),
    fault: options.fault,
  });
  const discovery = new GitWorkspaceDiscovery(f.store, f.roots, f.leases);
  const outbox = new WorkspaceGitUpdateOutbox(
    f.store,
    f.roots,
    f.leases,
    engine,
    { fault: options.fault, ...options.outbox },
  );
  const sync = f.track(
    new GitWorkspaceSyncService(
      f.store,
      f.roots,
      f.leases,
      gitAdapter,
      discovery,
      outbox,
      options,
    ),
  );
  return {
    engine,
    gitAdapter,
    discovery,
    outbox,
    sync,
    policies: sync.policies,
    triggers: new WorkspaceGitUpdateTriggers(f.store, f.roots, f.leases),
    tasks: new TaskService(f.store, f.roots, f.leases),
    scheduler: new WorkspaceSyncScheduler(sync, options.scheduler),
  };
}
async function createSyncFixture(t, options = {}) {
  const f = await createGitFixture(t, options);
  Object.assign(f, await syncServices(f, options));
  await f.policies.save(f.row.id, {
    expected_version: 1,
    enabled: true,
    mode: 'MANUAL',
    schedule: null,
  });
  return f;
}
module.exports = { createSyncFixture, syncServices };
