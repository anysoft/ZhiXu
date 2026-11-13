const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createS4Fixture, assertOwnedInstance } = require('./fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');
const { createV2Services } = require('../../../back/applicationV2/container');
const {
  readWorkspaceRestoreJournal,
} = require('../../../back/services/workspaceV2/restore');
const {
  privateJson,
  syncDirectory,
} = require('../../../back/services/backup/files');

async function startupTerminalRestoreQualification(t, caseId) {
  const h = await createS4Fixture(t, { caseId });
  const instance = await h.createInstance('restored');
  const services = createV2Services(instance.store, instance.backupRoot);
  const workspace = await services.lifecycle.createLocal({
    name: 'Genuine completed restore source',
    requestKey: randomUUID(),
  });
  const content = 'retained completed restore source ' + randomUUID() + '\n';
  await services.files.create(workspace.id, 'unique.sh', content);
  const snapshotId = await services.backup.create(30000);
  const restored = await services.restore.restore(snapshotId);
  await instance.useStore(restored);
  const journal = await readWorkspaceRestoreJournal(services.backup.paths);
  assert.equal(journal.stage, 'COMPLETE');
  assert.ok(journal.candidate_identity);
  assert.deepEqual(
    (({ dev, ino }) => ({ dev, ino }))(await fs.lstat(instance.dataRoot)),
    journal.candidate_identity,
  );
  assert.deepEqual(
    (({ dev, ino }) => ({ dev, ino }))(await fs.lstat(journal.old_root)),
    journal.old_identity,
  );
  const relativeSource = path.relative(
    instance.dataRoot,
    path.join(services.roots.path(await restored.workspace(workspace.id)), 'unique.sh'),
  );
  await instance.close();
  const options = {
    dataRoot: instance.dataRoot,
    backupRoot: instance.backupRoot,
    projectRoot: h.projectRoot,
    port: 0,
    background: false,
  };
  return { h, instance, workspace, content, journal, relativeSource, options };
}

async function pendingAfterComplete(f) {
  const marker = path.join(f.instance.controlRoot, 'barrier.json');
  // Reconstruct only the durable marker left by death after COMPLETE fsync and
  // before clearBarrier unlink. The COMPLETE journal itself is genuinely
  // produced by the real S1 restore; this is not an extra SIGKILL qualification.
  await privateJson(marker, {
    version: 1,
    id: f.journal.operation_id,
    phase: 'RESTORE_PENDING',
  });
  return marker;
}

test('S4 actual startup clears a matching COMPLETE restore barrier and retains the published root', { timeout: 180000 }, async (t) => {
  const f = await startupTerminalRestoreQualification(t, 's4-terminal-restore-cleanup');
  const marker = await pendingAfterComplete(f);
  const journalFile = path.join(f.instance.controlRoot, 'workspace-restore-journal.json');
  const journalHash = await f.h.hashFile(journalFile);
  const app = await V2Application.launch(f.options);
  t.after(() => app.close());
  assert.equal(app.ready, true);
  assert.equal(app.localWrites, true);
  const source = await app.services.files.read(f.workspace.id, 'unique.sh');
  assert.equal(source.content, f.content);
  assert.deepEqual(
    (({ dev, ino }) => ({ dev, ino }))(await fs.lstat(f.instance.dataRoot)),
    f.journal.candidate_identity,
  );
  await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });
  assert.equal(await f.h.hashFile(journalFile), journalHash);
  assert.equal((await app.services.store.all('SELECT id FROM Workspaces')).length, 1);
  await f.h.record('S4-TERMINAL-RESTORE-CLEANUP', {
    status: 'PASS',
    genuine_complete_restore: true,
    old_quarantine_preserved: true,
    fault_window: 'COMPLETE_JOURNAL_FSYNC_BEFORE_MATCHING_BARRIER_UNLINK',
    fault_method: 'explicit private matching barrier marker reconstruction',
    additional_sigkill_count: 0,
    actual_application_startup: true,
    ready: app.ready,
    local_write_admission: app.localWrites,
    barrier_removed: true,
    published_root_identity_unchanged: true,
    journal_sha256: journalHash,
    source_sha256: await f.h.hashFile(path.join(f.instance.dataRoot, f.relativeSource)),
  });
});

test('S4 actual startup rejects an unrelated owned root behind a COMPLETE restore journal without changing it', { timeout: 180000 }, async (t) => {
  const f = await startupTerminalRestoreQualification(t, 's4-terminal-restore-identity');
  const app = await V2Application.launch(f.options);
  assert.equal(app.ready, true);
  assert.equal((await app.services.files.read(f.workspace.id, 'unique.sh')).content, f.content);
  await app.close();

  const replacement = await f.h.createInstance('replacement');
  const replacementServices = createV2Services(replacement.store, replacement.backupRoot);
  const replacementWorkspace = await replacementServices.lifecycle.createLocal({
    name: 'Unrelated genuinely created replacement',
    requestKey: randomUUID(),
  });
  await replacementServices.files.create(
    replacementWorkspace.id,
    'replacement.sh',
    'distinct owned replacement source ' + randomUUID() + '\n',
  );
  const replacementRelativeSource = path.relative(
    replacement.dataRoot,
    path.join(replacementServices.roots.path(await replacement.store.workspace(replacementWorkspace.id)), 'replacement.sh'),
  );
  await replacement.close();
  await assertOwnedInstance(f.instance.root);
  await assertOwnedInstance(replacement.root);
  const preservedRoot = path.join(f.instance.root, 'preserved-published-root');
  const originalIdentity = await fs.lstat(f.instance.dataRoot);
  assert.deepEqual(
    { dev: originalIdentity.dev, ino: originalIdentity.ino },
    f.journal.candidate_identity,
  );
  await fs.rename(f.instance.dataRoot, preservedRoot);
  await fs.rename(replacement.dataRoot, f.instance.dataRoot);
  await syncDirectory(f.instance.root);
  await syncDirectory(replacement.root);
  const marker = await pendingAfterComplete(f);
  const journalFile = path.join(f.instance.controlRoot, 'workspace-restore-journal.json');
  const files = [
    path.join(f.instance.dataRoot, 'db/database.sqlite'),
    path.join(f.instance.dataRoot, replacementRelativeSource),
    path.join(preservedRoot, 'db/database.sqlite'),
    path.join(preservedRoot, f.relativeSource),
    journalFile,
    marker,
    path.join(f.journal.old_root, 'db/database.sqlite'),
  ];
  const before = await Promise.all(files.map((file) => f.h.hashFile(file)));
  const replacementIdentity = await fs.lstat(f.instance.dataRoot);
  assert.notEqual(replacementIdentity.ino, f.journal.candidate_identity.ino);
  await assert.rejects(V2Application.launch(f.options), (error) => {
    assert.equal(error.error_code, 'STARTUP_REJECTED');
    assert.equal(error.reason, 'RESTORE_PUBLISHED_ROOT_IDENTITY_MISMATCH');
    return true;
  });
  assert.deepEqual(await Promise.all(files.map((file) => f.h.hashFile(file))), before);
  assert.deepEqual(
    (({ dev, ino }) => ({ dev, ino }))(await fs.lstat(f.instance.dataRoot)),
    { dev: replacementIdentity.dev, ino: replacementIdentity.ino },
  );
  assert.equal((await fs.readdir(f.instance.dataRoot)).includes('db'), true);
  assert.equal((await fs.readdir(preservedRoot)).includes('db'), true);
  await f.h.record('S4-TERMINAL-RESTORE-IDENTITY-REJECTION', {
    status: 'PASS',
    genuine_complete_restore: true,
    actual_application_previously_started_and_closed: true,
    distinct_replacement_created_by_real_frozen_services: true,
    original_published_root_preserved_by_rename: true,
    old_quarantine_preserved: true,
    expected_error: 'STARTUP_REJECTED',
    expected_reason: 'RESTORE_PUBLISHED_ROOT_IDENTITY_MISMATCH',
    replacement_database_sha256: before[0],
    replacement_source_sha256: before[1],
    original_database_sha256: before[2],
    original_source_sha256: before[3],
    journal_sha256: before[4],
    pending_barrier_sha256: before[5],
    old_quarantine_database_sha256: before[6],
    all_before_after_hashes_equal: true,
    pending_barrier_not_cleared: true,
    unrelated_root_not_adopted: true,
  });
});
