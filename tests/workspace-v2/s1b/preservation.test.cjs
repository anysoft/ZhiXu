const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { createS1BFixture } = require('./fixture.cjs');
const { seedRepository, git } = require('../fixture.cjs');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');
const {
  WorkspaceLifecycleService,
} = require('../../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../../back/services/workspaceV2/files');
const {
  WorkspaceBackupService,
} = require('../../../back/services/workspaceV2/backup');
const {
  WorkspaceRestoreService,
} = require('../../../back/services/workspaceV2/restore');
const {
  WorkspaceReclaimService,
} = require('../../../back/services/workspaceV2/reclaim');
const {
  WorkspacePreservationService,
} = require('../../../back/services/workspaceV2/preservation');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');

function preservationServices(instance) {
  const backup = new WorkspaceBackupService(
    instance.store,
    instance.roots,
    instance.leases,
    instance.backupRoot,
  );
  const preservation = new WorkspacePreservationService(backup);
  return {
    lifecycle: new WorkspaceLifecycleService(
      instance.store,
      instance.roots,
      instance.leases,
    ),
    files: new WorkspaceFileService(
      instance.store,
      instance.roots,
      instance.leases,
    ),
    tasks: new TaskService(instance.store, instance.roots, instance.leases),
    engine: instance.track(
      new TaskExecutionService(instance.store, instance.roots, instance.leases),
    ),
    backup,
    preservation,
    reclaim: new WorkspaceReclaimService(
      instance.store,
      instance.roots,
      instance.leases,
      preservation,
    ),
  };
}

async function withPreservationGitLease(
  instance,
  repositoryId,
  workspaceId,
  action,
) {
  return instance.leases.withRepository(
    repositoryId,
    'S1B_PRESERVATION_GIT',
    () =>
      instance.leases.withWorkspace(
        workspaceId,
        'S1B_PRESERVATION_GIT',
        action,
      ),
  );
}

for (const type of ['LOCAL', 'GIT']) {
  test(`S1B preserved ${type} assets survive real history, reclaim, encrypted transfer and complete A destruction without reviving the tombstone`, async (t) => {
    const started = Date.now();
    const caseId = 'S1B-PRESERVATION-' + type;
    const h = await createS1BFixture(t, { caseId });
    const a = await h.createInstance('instance-A');
    const s = preservationServices(a);
    const repo = type === 'GIT' ? await seedRepository(a) : null;
    let row =
      type === 'GIT'
        ? await s.lifecycle.createGit({
            name: 'preserved Git',
            requestKey: caseId,
            repositoryId: repo.id,
            refType: 'branch',
            refName: 'main',
          })
        : await s.lifecycle.createLocal({
            name: 'unique LOCAL source',
            requestKey: caseId,
          });
    await s.files.createDirectory(row.id, 'scripts');
    const script = 'printf "REAL_S1B_PRESERVATION_CHILD\\n"\n';
    await s.files.create(row.id, 'scripts/main.sh', script);
    await s.files.create(
      row.id,
      'unique.txt',
      'unique nonempty source ' + randomBytes(24).toString('hex'),
    );
    const task = await s.tasks.create({
      name: 'real preserved ' + type,
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: row.id,
        relative_entrypoint: 'scripts/main.sh',
        language: 'SHELL',
        cwd_mode: 'WORKSPACE_ROOT',
        cwd_relative_path: null,
      },
    });
    const run = await s.engine.wait(
      (
        await s.engine.submit(task.task.id, {
          submissionKey: caseId + '-real-history',
        })
      ).id,
    );
    assert.equal(run.status, 'SUCCESS', JSON.stringify(run));
    assert.equal(run.attempt_count, 1);
    const attempts = await s.engine.attempts(run.id);
    assert.equal(attempts[0].status, 'SUCCESS');
    const log = await s.engine.logs(run.id);
    assert.match(log, /REAL_S1B_PRESERVATION_CHILD/);
    await s.engine.close();
    let gitEvidence = null;
    if (repo) {
      const root = a.roots.path(row);
      await withPreservationGitLease(a, repo.id, row.id, async () => {
        git(['add', 'scripts/main.sh', 'unique.txt'], root);
        git(
          [
            'commit',
            '-m',
            'S1B unique local commit absent from original remote',
          ],
          root,
        );
      });
      const uniqueHead = git(['rev-parse', 'HEAD'], root);
      assert.notEqual(uniqueHead, repo.commit);
      assert.throws(() => git(['cat-file', '-e', uniqueHead], repo.source));
      let current = await s.files.read(row.id, 'unique.txt');
      await s.files.save(
        row.id,
        'unique.txt',
        'staged unique source\n',
        current.hash,
      );
      await withPreservationGitLease(a, repo.id, row.id, async () =>
        git(['add', 'unique.txt'], root),
      );
      current = await s.files.read(row.id, 'unique.txt');
      await s.files.save(
        row.id,
        'unique.txt',
        'dirty bytes after staging\n',
        current.hash,
      );
      await s.files.create(row.id, 'untracked.txt', 'untracked unique asset\n');
      const gitRow = await s.lifecycle.git.get(row.id);
      const verified = await withPreservationGitLease(
        a,
        repo.id,
        row.id,
        async (lease) =>
          s.lifecycle.git.verify(await a.store.workspace(row.id), lease),
      );
      const admin = path.join(
        a.dataRoot,
        'git',
        `repository-${repo.id}.git`,
        'worktrees',
        verified.git_admin_key,
      );
      const index = await fs.readFile(path.join(admin, 'index'));
      gitEvidence = {
        uniqueHead,
        privateBranch: gitRow.private_branch,
        indexHash: createHash('sha256').update(index).digest('hex'),
        index,
        porcelain: git(
          [
            '--no-optional-locks',
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
          ],
          root,
        ),
        gitRow,
      };
      assert.match(gitEvidence.porcelain, /MM unique.txt/);
      assert.match(gitEvidence.porcelain, /\?\? untracked.txt/);
    }
    row = await a.store.workspace(row.id);
    const sourceHash = row.content_inventory_hash;
    const sourceBackup = await s.backup.create();
    const sourceSnapshot = await s.backup.snapshot(sourceBackup);
    const sourceEntry = sourceSnapshot.manifest.workspaces.find(
      (entry) => entry.workspace_id === row.id,
    );
    assert.equal(sourceEntry.source_references[0].task_id, task.task.id);
    if (gitEvidence) assert.equal(sourceEntry.git.head, gitEvidence.uniqueHead);
    await assert.rejects(
      s.reclaim.requestDelete(row.id, row.version, {
        requestKey: caseId + '-referenced',
        snapshotId: sourceBackup,
      }),
      { error_code: 'WORKSPACE_REFERENCED' },
    );
    assert.equal((await a.store.workspace(row.id)).storage_state, 'PRESENT');
    await s.tasks.remove(task.task.id, task.task.version);
    row = await a.store.workspace(row.id);
    const reclaimed = await s.reclaim.remove(row.id, row.version, {
      requestKey: caseId + '-reclaim',
      snapshotId: sourceBackup,
    });
    assert.equal(reclaimed.lifecycle_state, 'TOMBSTONED');
    assert.equal(reclaimed.storage_state, 'RECLAIMED');
    await assert.rejects(fs.lstat(a.roots.path(reclaimed)), { code: 'ENOENT' });
    const historical = (
      await a.store.all('SELECT * FROM TaskRuns WHERE id=?', [run.id])
    )[0];
    assert.equal(historical.workspace_id, row.id);
    assert.equal(historical.task_id, null);
    assert.equal(historical.source_snapshot, run.source_snapshot);
    assert.equal((await s.preservation.usage()).active_holds, 1);
    await assert.rejects(s.backup.delete(sourceBackup), {
      error_code: 'WORKSPACE_PRESERVATION_REQUIRED',
    });
    const tombstoneBackup = await s.backup.create();
    const finalSnapshot = await s.backup.snapshot(tombstoneBackup);
    assert.equal(
      finalSnapshot.manifest.workspaces[0].storage_state,
      'RECLAIMED',
    );
    assert.equal(
      finalSnapshot.manifest.preserved_snapshots[0].backup_id,
      sourceBackup,
    );
    const passphrase = h.registerSecret(randomBytes(32).toString('hex'));
    const encrypted = await s.backup.exportPortable(
      tombstoneBackup,
      Buffer.from(passphrase),
    );
    const archivePath = path.join(h.transferRoot, caseId + '.encrypted');
    await fs.copyFile(encrypted, archivePath);
    await fs.chmod(archivePath, 0o600);
    const archiveHash = await h.hashFile(archivePath);
    const manifestHash = createHash('sha256')
      .update(JSON.stringify(finalSnapshot.manifest))
      .digest('hex');
    await h.safeDestroy(a, { archivePath });
    for (const removed of [
      a.dataRoot,
      a.controlRoot,
      a.backupRoot,
      ...(repo ? [repo.source] : []),
    ])
      await assert.rejects(fs.lstat(removed), { code: 'ENOENT' });
    const b = await h.createInstance('instance-B');
    assert.notEqual(b.dataRoot, a.dataRoot);
    const importer = new WorkspaceBackupService(
      b.store,
      b.roots,
      b.leases,
      b.backupRoot,
    );
    const imported = await importer.importPortable(
      archivePath,
      Buffer.from(passphrase),
    );
    await b.useStore(
      await new WorkspaceRestoreService(importer).restore(
        imported.id,
        'imports',
      ),
    );
    const after = await b.store.workspace(row.id);
    assert.equal(after.lifecycle_state, 'TOMBSTONED');
    assert.equal(after.storage_state, 'RECLAIMED');
    assert.equal(after.content_inventory_hash, sourceHash);
    await assert.rejects(fs.lstat(b.roots.path(after)), { code: 'ENOENT' });
    const restoredHistory = (
      await b.store.all('SELECT * FROM TaskRuns WHERE id=?', [run.id])
    )[0];
    assert.equal(restoredHistory.status, 'SUCCESS');
    assert.equal(restoredHistory.task_id, null);
    assert.equal(restoredHistory.workspace_id, row.id);
    assert.equal(restoredHistory.source_snapshot, historical.source_snapshot);
    assert.equal(
      restoredHistory.admission_snapshot,
      historical.admission_snapshot,
    );
    assert.deepEqual(
      await b.store.all(
        'SELECT * FROM TaskRunAttempts WHERE task_run_id=? ORDER BY id',
        [run.id],
      ),
      attempts,
    );
    const bServices = preservationServices(b);
    assert.equal(await bServices.engine.logs(run.id), log);
    await assert.rejects(bServices.tasks.get(task.task.id), {
      error_code: 'TASK_NOT_FOUND',
    });
    const retained = await bServices.backup.snapshot(sourceBackup);
    const heldEntry = retained.manifest.workspaces.find(
      (entry) => entry.workspace_id === row.id,
    );
    const heldRoot = path.join(retained.root, 'data', row.root_key);
    assert.equal(
      await fs.readFile(path.join(heldRoot, 'scripts/main.sh'), 'utf8'),
      script,
    );
    assert.equal(heldEntry.content_inventory_hash, sourceHash);
    const heldStore = await WorkspaceStore.open(
      path.join(retained.root, 'data/db/database.sqlite'),
      path.join(retained.root, 'data'),
      { readOnly: true },
    );
    try {
      assert.equal(
        (
          await heldStore.all('SELECT id FROM Tasks WHERE id=?', [task.task.id])
        )[0].id,
        task.task.id,
      );
      assert.equal(
        (
          await heldStore.all(
            'SELECT workspace_id FROM TaskSources WHERE task_id=?',
            [task.task.id],
          )
        )[0].workspace_id,
        row.id,
      );
      assert.equal(
        (
          await heldStore.all('SELECT status FROM TaskRuns WHERE id=?', [
            run.id,
          ])
        )[0].status,
        'SUCCESS',
      );
    } finally {
      await heldStore.close();
    }
    if (gitEvidence) {
      const heldAdmin = path.join(
        retained.root,
        'data',
        heldEntry.git.storage_key,
        'worktrees',
        heldEntry.git.git_admin_key,
      );
      assert.equal(
        git(
          [
            '--git-dir',
            heldAdmin,
            '--work-tree',
            heldRoot,
            'rev-parse',
            'HEAD',
          ],
          b.root,
        ),
        gitEvidence.uniqueHead,
      );
      assert.equal(heldEntry.git.private_branch, gitEvidence.privateBranch);
      assert.deepEqual(
        await fs.readFile(path.join(heldAdmin, 'index')),
        gitEvidence.index,
      );
      assert.equal(
        await fs.readFile(path.join(heldRoot, 'unique.txt'), 'utf8'),
        'dirty bytes after staging\n',
      );
      assert.equal(
        await fs.readFile(path.join(heldRoot, 'untracked.txt'), 'utf8'),
        'untracked unique asset\n',
      );
      assert.equal(
        git(
          [
            '--no-optional-locks',
            '--git-dir',
            heldAdmin,
            '--work-tree',
            heldRoot,
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
          ],
          b.root,
        ),
        gitEvidence.porcelain,
      );
    }
    await assert.rejects(bServices.backup.delete(sourceBackup), {
      error_code: 'WORKSPACE_PRESERVATION_REQUIRED',
    });
    assert.equal((await bServices.preservation.usage()).active_holds, 1);
    assert.deepEqual(await b.store.all('PRAGMA foreign_key_check'), []);
    await h.record(caseId, {
      status: 'PASS',
      input: { workspaceType: type, realTaskAndHistoricalRun: true },
      expected:
        'held source and history recover independently while tombstone remains non-executable and GC stays blocked',
      actual:
        'TOMBSTONED/RECLAIMED identity, held source/index/history and active preservation hold recovered in B after A destruction',
      exit_code: 0,
      duration_ms: Date.now() - started,
      assertions: [
        'real Runner SUCCESS and durable Attempt',
        'TaskSource prevents reclamation until explicit Task deletion',
        'exact READY snapshot installs preservation hold',
        'held snapshot deletion rejected in A and B',
        'encrypted archive is independent of destroyed A data/runtime/control/catalog/remote',
        'original history and immutable source snapshot retained',
        'B root remains absent for reclaimed Workspace',
        ...(gitEvidence
          ? [
              'unique local HEAD absent from original remote recovered',
              'staged index bytes, dirty and untracked bytes retained',
            ]
          : ['nonempty unique LOCAL source retained']),
      ],
      workspaceId: row.id,
      taskId: task.task.id,
      runId: run.id,
      attemptIds: attempts.map((attempt) => attempt.id),
      sourceHash,
      sourceBackup,
      tombstoneBackup,
      manifestHash,
      archiveHash,
      logHash: createHash('sha256').update(log).digest('hex'),
      lifecycle: after.lifecycle_state,
      storage: after.storage_state,
      heldSnapshotGcBlocked: true,
      originalInstanceDestroyed: true,
      git: gitEvidence
        ? {
            head: gitEvidence.uniqueHead,
            privateBranch: gitEvidence.privateBranch,
            indexHash: gitEvidence.indexHash,
            dirtyAndUntrackedRestored: true,
          }
        : null,
    });
  });
}
