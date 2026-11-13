const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFixture } = require('./fixture.cjs');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
function gate() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

test('archive waits for real active FILE_MUTATION then closes admission and preserves committed bytes', async (t) => {
  const f = await createFixture(t);
  const archiveAdmitted = gate(),
    continueArchive = gate();
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases, {
    fault: async (phase) => {
      if (phase === 'ARCHIVE_ADMISSION_CLOSED') {
        archiveAdmitted.release();
        await continueArchive.promise;
      }
    },
  });
  const row = await lifecycle.createLocal({
    name: 'active file archive',
    requestKey: 'active-file-create',
  });
  const filePrepared = gate(),
    continueFile = gate();
  const files = new WorkspaceFileService(f.store, f.roots, f.leases, {
    fault: async (phase) => {
      if (phase === 'FILE_PREPARED') {
        filePrepared.release();
        await continueFile.promise;
      }
    },
  });
  const mutation = files.create(
    row.id,
    'main.py',
    'print("committed before archive")\n',
  );
  await filePrepared.promise;
  let archiveSettled = false;
  const archiving = lifecycle
    .archive(row.id, row.version, {
      requestKey: 'active-file-archive',
      drainTimeoutMs: 5000,
    })
    .finally(() => {
      archiveSettled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(archiveSettled, false);
  assert.deepEqual(
    (
      await f.store.all(
        "SELECT operation_type FROM WorkspaceOperations WHERE workspace_id=? AND status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED')",
        [row.id],
      )
    ).map((op) => op.operation_type),
    ['FILE_MUTATION'],
  );
  continueFile.release();
  await mutation;
  await archiveAdmitted.promise;
  await assert.rejects(
    new WorkspaceFileService(f.store, f.roots, f.leases).create(
      row.id,
      'late.py',
      'denied',
    ),
    { error_code: 'WORKSPACE_BUSY' },
  );
  continueArchive.release();
  const after = await archiving;
  assert.equal(after.lifecycle_state, 'ARCHIVED');
  assert.equal(
    await fs.readFile(path.join(f.roots.path(after), 'main.py'), 'utf8'),
    'print("committed before archive")\n',
  );
  await assert.rejects(fs.lstat(path.join(f.roots.path(after), 'late.py')), {
    code: 'ENOENT',
  });
});

test('pre-admission file mutation wait obeys one deadline and retains the actual owner on timeout', async (t) => {
  const f = await createFixture(t);
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  const row = await lifecycle.createLocal({
    name: 'bounded active file',
    requestKey: 'bounded-file-create',
  });
  const prepared = gate(),
    continueFile = gate();
  const files = new WorkspaceFileService(f.store, f.roots, f.leases, {
    fault: async (phase) => {
      if (phase === 'FILE_PREPARED') {
        prepared.release();
        await continueFile.promise;
      }
    },
  });
  const mutation = files.create(row.id, 'main.py', 'still owned');
  await prepared.promise;
  await assert.rejects(
    lifecycle.archive(row.id, row.version, {
      requestKey: 'bounded-file-archive',
      drainTimeoutMs: 70,
    }),
    { error_code: 'WORKSPACE_BUSY' },
  );
  assert.equal((await f.store.workspace(row.id)).lifecycle_state, 'READY');
  assert.equal(
    (
      await f.store.all(
        "SELECT id FROM WorkspaceOperations WHERE workspace_id=? AND operation_type='ARCHIVE'",
        [row.id],
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await f.store.all(
        "SELECT status FROM WorkspaceOperations WHERE workspace_id=? AND operation_type='FILE_MUTATION'",
        [row.id],
      )
    )[0].status,
    'RUNNING',
  );
  continueFile.release();
  await mutation;
  assert.equal(
    (
      await lifecycle.archive(row.id, row.version, {
        requestKey: 'bounded-file-next',
      })
    ).lifecycle_state,
    'ARCHIVED',
  );
});
