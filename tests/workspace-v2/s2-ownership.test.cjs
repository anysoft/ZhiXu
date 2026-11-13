const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createOwnershipFixture(t) {
  const f = await createFixture(t);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const workspace = await lifecycle.createLocal({
    name: 'ownership boundary',
    requestKey: 'ownership-boundary',
  });
  await new WorkspaceFileService(f.store, f.roots, f.leases).create(
    workspace.id,
    'main.sh',
    'printf "REAL_OWNERSHIP_CHILD_STARTED\\n"\nsleep 30\nprintf "UNEXPECTED_CHILD_FINISH\\n"\n',
  );
  const task = await new TaskService(f.store, f.roots, f.leases).create({
    name: 'ownership boundary',
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: workspace.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution: { concurrency: 'ALLOW', timeout_seconds: 40 },
  });
  const service = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  const run = await service.submit(task.task.id);
  let entered, release;
  const acquired = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const originalOwner = service.paths.owner.bind(service.paths);
  let ownerCalls = 0;
  // Hold the real acquired EX owner FD before its asynchronous API returns.
  // This exercises the admission boundary without replacing the Runner/lease.
  service.paths.owner = async (id) => {
    ownerCalls++;
    const owner = await originalOwner(id);
    if (ownerCalls === 1) {
      entered();
      await gate;
    }
    return owner;
  };
  t.after(() => release());
  await service.tick();
  await acquired;
  return {
    ...f,
    service,
    run,
    workspace,
    release,
    ownerCalls: () => ownerCalls,
  };
}

test('S2 repeated dispatch preserves the real pending owner and close waits for its cancellation', async (t) => {
  const f = await createOwnershipFixture(t);
  try {
    for (let i = 0; i < 3; i++) {
      await f.service.tick();
      await pause(20);
    }
    assert.equal(
      f.ownerCalls(),
      1,
      'the same QUEUED run must retain its existing local owner',
    );
    assert.equal((await f.service.get(f.run.id)).status, 'QUEUED');
    let closed = false;
    const closing = f.service.close().then(() => {
      closed = true;
    });
    await pause(50);
    assert.equal(
      closed,
      false,
      'close must await the owner whose acquisition has not returned',
    );
    f.release();
    await closing;
    const terminal = await f.service.get(f.run.id);
    assert.equal(terminal.status, 'CANCELLED');
    assert.equal(terminal.active_workspace_id, null);
    assert.equal(terminal.owner_token, null);
    assert.doesNotMatch(
      await f.service.logs(f.run.id),
      /REAL_OWNERSHIP_CHILD_STARTED/,
    );
    assert.equal((await f.leases.probeWorkspace(f.workspace.id)).busy, false);
  } finally {
    f.release();
  }
});

test('S2 delayed real owner admits exactly one real child and close cancels and awaits cleanup', async (t) => {
  const f = await createOwnershipFixture(t);
  try {
    for (let i = 0; i < 3; i++) {
      await f.service.tick();
      await pause(20);
    }
    assert.equal(f.ownerCalls(), 1);
    f.release();
    const deadline = Date.now() + 15000;
    while (
      !(await f.service.logs(f.run.id)).includes('REAL_OWNERSHIP_CHILD_STARTED')
    ) {
      assert.ok(Date.now() < deadline, 'actual managed Shell child must start');
      await f.service.tick();
      await pause(20);
    }
    assert.equal((await f.service.attempts(f.run.id)).length, 1);
    await f.service.close();
    const terminal = await f.service.get(f.run.id);
    assert.equal(terminal.status, 'CANCELLED');
    assert.equal(JSON.parse(terminal.result).cleanupResult, 'SUCCESS');
    assert.equal(terminal.active_workspace_id, null);
    assert.equal(terminal.owner_token, null);
    const attempts = await f.service.attempts(f.run.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'CANCELLED');
    const logs = await f.service.logs(f.run.id);
    assert.equal(logs.match(/REAL_OWNERSHIP_CHILD_STARTED/g)?.length, 1);
    assert.doesNotMatch(logs, /UNEXPECTED_CHILD_FINISH/);
    assert.equal((await f.leases.probeWorkspace(f.workspace.id)).busy, false);
  } finally {
    f.release();
  }
});

test('S2 recovery ignores a stale resolving candidate after its real owner safely requeues it', async (t) => {
  const f = await createOwnershipFixture(t);
  let releaseWorkspace, releaseBeforeLease, releaseRecovery;
  let held, recovering;
  try {
    let workspaceEntered;
    const workspaceReady = new Promise((resolve) => {
      workspaceEntered = resolve;
    });
    const workspaceGate = new Promise((resolve) => {
      releaseWorkspace = resolve;
    });
    held = f.leases.withWorkspace(
      f.workspace.id,
      'S2_REAL_REQUEUE_CONTENTION',
      async () => {
        workspaceEntered();
        await workspaceGate;
      },
    );
    await workspaceReady;
    let beforeLeaseEntered;
    const beforeLeaseReady = new Promise((resolve) => {
      beforeLeaseEntered = resolve;
    });
    const beforeLeaseGate = new Promise((resolve) => {
      releaseBeforeLease = resolve;
    });
    f.service.options.fault = async (point) => {
      if (point === 'BEFORE_LEASE') {
        beforeLeaseEntered();
        await beforeLeaseGate;
      }
    };
    f.release();
    await beforeLeaseReady;
    assert.equal((await f.service.get(f.run.id)).status, 'RESOLVING');
    const second = f.track(
      new TaskExecutionService(f.store, f.roots, f.leases),
    );
    const acquireOwner = second.paths.owner.bind(second.paths);
    let recoveryEntered;
    const recoveryReady = new Promise((resolve) => {
      recoveryEntered = resolve;
    });
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    second.paths.owner = async (id) => {
      recoveryEntered();
      await recoveryGate;
      return acquireOwner(id);
    };
    recovering = second.recover();
    await recoveryReady;
    // A different coordinator read RESOLVING, while the actual owner now
    // encounters the held Workspace FD and safely returns the ticket to QUEUED.
    releaseBeforeLease();
    const deadline = Date.now() + 10000;
    while ((await f.service.get(f.run.id)).status !== 'QUEUED') {
      assert.ok(
        Date.now() < deadline,
        'the actual owner must requeue after TRY busy',
      );
      await pause(10);
    }
    releaseWorkspace();
    await held;
    releaseRecovery();
    await recovering;
    const queued = await second.get(f.run.id);
    assert.equal(queued.status, 'QUEUED');
    assert.equal(queued.owner_token, null);
    assert.equal(queued.active_workspace_id, null);
    assert.equal((await second.attempts(f.run.id)).length, 0);
    await second.cancel(f.run.id);
  } finally {
    f.release();
    releaseBeforeLease?.();
    releaseWorkspace?.();
    releaseRecovery?.();
    await held?.catch(() => {});
    await recovering?.catch(() => {});
  }
});
