const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createSyncFixture, syncServices } = require('./sync-fixture.cjs');
const { createLocalGitAccess } = require('./git-fixture.cjs');
const { seedRepository } = require('../fixture.cjs');

test(
  'busy Repository queue head cannot starve independent real Repository with active cap1',
  { timeout: 180000 },
  async (t) => {
    const f = await createSyncFixture(t, {
      caseId: 'S3-REPOSITORY-QUEUE-FAIRNESS',
      maxActive: 1,
    });
    const baseA = await f.sync.wait((await f.sync.submit(f.row.id)).id);
    assert.equal(baseA.status, 'SUCCESS', baseA.error_code);
    const repoB = await seedRepository(f.instance, 2),
      remoteB = pathToFileURL(repoB.source).href;
    await f.store.run(
      'UPDATE Repositories SET remote_url=?,normalized_url=? WHERE id=?',
      [remoteB, remoteB, 2],
    );
    const accessB = await createLocalGitAccess(f.instance, repoB),
      accessA = f.accessResolver;
    const services = await syncServices(
      {
        ...f,
        accessResolver: (row) => (row.id === 1 ? accessA(row) : accessB(row)),
      },
      { maxActive: 1 },
    );
    await f.leases.withRepository(2, 'FAIRNESS_INITIAL_FETCH', (lease) =>
      services.gitAdapter.fetch(2, lease),
    );
    const rowB = await f.lifecycle.createGit({
      name: 'fair independent repository',
      requestKey: randomUUID(),
      repositoryId: 2,
      refType: 'branch',
      refName: 'main',
    });
    await services.policies.save(rowB.id, {
      expected_version: 1,
      enabled: true,
      mode: 'MANUAL',
      schedule: null,
    });
    const baseB = await services.sync.wait(
      (
        await services.sync.submit(rowB.id)
      ).id,
    );
    assert.equal(baseB.status, 'SUCCESS', baseB.error_code);
    const beforeA = await f.store.workspace(f.row.id),
      beforeGitA = (
        await f.store.all('SELECT * FROM GitWorkspaces WHERE workspace_id=?', [
          f.row.id,
        ])
      )[0];
    const beforeBytesA = await fs.readFile(
      path.join(f.workspaceRoot, 'main.py'),
    );
    const targetA = await f.commit({
      'main.py': 'print("repository A next")\n',
    });
    await fs.writeFile(
      path.join(repoB.source, 'main.py'),
      'print("repository B next")\n',
    );
    f.git(['add', 'main.py'], repoB.source);
    f.git(['commit', '-m', 'independent actual remote advance'], repoB.source);
    const targetB = f.git(['rev-parse', 'HEAD'], repoB.source);
    const owner = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        path.join(__dirname, 'git-repository-hold-worker.cjs'),
        f.root,
        '1',
      ],
      { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    t.after(() => {
      if (owner.exitCode === null && owner.signalCode === null)
        owner.kill('SIGKILL');
    });
    const held = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('EXTERNAL_REAL_REPOSITORY_FD_TIMEOUT')),
        20000,
      );
      owner.on('message', (message) => {
        if (message.failure) {
          clearTimeout(timer);
          reject(Error(message.failure));
        }
        if (message.held) {
          clearTimeout(timer);
          resolve(message);
        }
      });
      owner.once('exit', () => {
        clearTimeout(timer);
        reject(Error('EXTERNAL_OWNER_EXITED_EARLY'));
      });
    });
    assert.notEqual(held.pid, process.pid);
    assert.ok(held.realLeaseFdCount > 0);
    await assert.rejects(
      f.leases.withRepository(1, 'EXTERNAL_LOCK_PROBE', async () => {}),
      { error_code: 'WORKSPACE_BUSY' },
    );
    const older = await services.sync.submit(f.row.id),
      newer = await services.sync.submit(rowB.id);
    assert.ok(older.id < newer.id);
    const independent = await services.sync.wait(newer.id, 45000);
    assert.equal(independent.status, 'SUCCESS', independent.error_code);
    assert.equal(independent.after_commit, targetB);
    assert.equal(owner.exitCode, null);
    assert.equal(owner.signalCode, null);
    const stillWaiting = await services.sync.get(older.id);
    assert.equal(stillWaiting.status, 'QUEUED');
    assert.equal(stillWaiting.owner_token, null);
    assert.deepEqual(await f.store.workspace(f.row.id), beforeA);
    assert.deepEqual(
      (
        await f.store.all('SELECT * FROM GitWorkspaces WHERE workspace_id=?', [
          f.row.id,
        ])
      )[0],
      beforeGitA,
    );
    assert.deepEqual(
      await fs.readFile(path.join(f.workspaceRoot, 'main.py')),
      beforeBytesA,
    );
    assert.equal(
      f.git(['rev-parse', 'HEAD'], f.workspaceRoot),
      baseA.after_commit,
    );
    assert.equal(
      (
        await f.store.all(
          'SELECT COUNT(*) n FROM WorkspaceUpdateOutbox WHERE workspace_id=?',
          [f.row.id],
        )
      )[0].n,
      1,
    );
    const exit = once(owner, 'exit');
    owner.send({ release: true });
    const [code, signal] = await exit;
    assert.equal(code, 0);
    assert.equal(signal, null);
    const later = await services.sync.wait(older.id, 45000);
    assert.equal(later.status, 'SUCCESS', later.error_code);
    assert.equal(later.after_commit, targetA);
    assert.equal(
      (
        await f.store.all(
          'SELECT COUNT(*) n FROM WorkspaceUpdateOutbox WHERE workspace_id=?',
          [f.row.id],
        )
      )[0].n,
      2,
    );
    assert.equal(
      (await f.store.all('SELECT COUNT(*) n FROM TaskRuns'))[0].n,
      0,
    );
    await f.scenario.record('S3-REPOSITORY-QUEUE-FAIRNESS', {
      external_repository_owner_pid: held.pid,
      contended_repository_id: 1,
      independent_repository_id: 2,
      max_active: 1,
      older_sync_id: older.id,
      independent_sync_id: newer.id,
      independent_success_before_owner_release: true,
      older_source_preserved_until_release: true,
      older_later_succeeded: true,
      task_runs: 0,
    });
  },
);
