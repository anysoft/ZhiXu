// An explicit diagnostic continuation may reopen only this run's private,
// marker-verified instance. It never imports assets, receipts or database rows.
const path = require('node:path');
const assert = require('node:assert/strict');
const { assertOwnedInstance } = require('../s1b/fixture.cjs');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../../back/services/workspaceV2/lease');
const {
  PlatformBackupBarrier,
} = require('../../../back/services/backup/barrier');

async function openOwnedRuntimeInstance(scenario) {
  const root = path.join(scenario.root, 'instance-A');
  const owner = await assertOwnedInstance(root);
  assert.equal(owner.caseRoot, scenario.root);
  const dataRoot = path.join(root, 'data');
  const store = await WorkspaceStore.open(
    path.join(dataRoot, 'db/database.sqlite'),
    dataRoot,
  );
  const barrier = new PlatformBackupBarrier(dataRoot + '.platform-control');
  const resources = [];
  let closed = false;
  return {
    root,
    dataRoot,
    store,
    barrier,
    roots: new WorkspaceRootResolver(dataRoot),
    leases: new WorkspaceLeaseService(dataRoot, barrier),
    track(resource) {
      resources.push(resource);
      return resource;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const resource of resources.reverse()) await resource.close();
      await store.close();
    },
  };
}
module.exports = { openOwnedRuntimeInstance };
