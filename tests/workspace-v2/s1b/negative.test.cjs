const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  s1bSecurityFixture,
  backup,
  digest,
  fs,
  path,
  git,
} = require('./security-fixture.cjs');
const {
  WorkspaceRestoreService,
} = require('../../../back/services/workspaceV2/restore');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');

async function rejected(f, operation, codes) {
  let observed;
  await assert.rejects(operation, (error) => {
    const code = error.error_code || error.code;
    assert.ok(codes.includes(code), String(code));
    assert.equal(String(error.stack || error).includes(f.secret), false);
    observed = code;
    return true;
  });
  return observed;
}

async function notComplete(f) {
  const stage = await new WorkspaceRestoreService(f.backupB).status();
  assert.notEqual(stage?.stage, 'COMPLETE');
  return stage?.stage || 'NO_JOURNAL';
}

for (const mode of [
  'insufficient-free-space',
  'backup-quota',
  'injected-backup-enospc',
  'injected-restore-enospc',
]) {
  test(
    'S1B capacity failure ' +
      mode +
      ' preserves original source and destination without false READY',
    async (t) => {
      const f = await s1bSecurityFixture(t, mode);
      let code,
        stage = 'NO_JOURNAL';
      if (mode === 'insufficient-free-space') {
        const original = fs.statfs;
        try {
          fs.statfs = async () => ({ bavail: 0, bsize: 4096 });
          code = await rejected(f, f.backupA.create(), [
            'DISK_BUDGET_EXCEEDED',
          ]);
        } finally {
          fs.statfs = original;
        }
      } else if (mode === 'backup-quota') {
        code = await rejected(
          f,
          backup(f.A, { limits: { backupSnapshotBytes: 1 } }).create(),
          ['BACKUP_QUOTA_EXCEEDED'],
        );
      } else if (mode === 'injected-backup-enospc') {
        code = await rejected(
          f,
          backup(f.A, {
            fault: async (phase) => {
              if (phase === 'backup-after-copy')
                throw Object.assign(Error('qualified write failure'), {
                  code: 'ENOSPC',
                });
            },
          }).create(),
          ['DISK_BUDGET_EXCEEDED'],
        );
      } else {
        const portable = await f.portable();
        const imported = await f.backupB.importPortable(
          portable.archive,
          Buffer.from(portable.passphrase),
        );
        const restore = new WorkspaceRestoreService(f.backupB, {
          fault: async (phase) => {
            if (phase === 'restore-after-copy')
              throw Object.assign(Error('qualified write failure'), {
                code: 'ENOSPC',
              });
          },
        });
        code = await rejected(f, restore.restore(imported.id, 'imports'), [
          'DISK_BUDGET_EXCEEDED',
        ]);
        stage = await notComplete(f);
        assert.equal(stage, 'PREPARING');
      }
      await f.assertSourceUnchanged();
      await f.assertDestinationUnchanged();
      if (mode !== 'injected-restore-enospc') {
        assert.deepEqual(
          await fs.readdir(path.join(f.A.backupRoot, 'snapshots')),
          [],
        );
        for (const name of await fs.readdir(
          path.join(f.A.backupRoot, '.staging'),
        ))
          await assert.rejects(
            fs.lstat(path.join(f.A.backupRoot, '.staging', name, 'READY')),
            { code: 'ENOENT' },
          );
      }
      await f.record(mode, {
        status: 'PASS',
        input: mode,
        expected: 'fail closed and preserve both sources',
        actual: {
          error_code: code,
          restore_stage: stage,
          source_unchanged: true,
          destination_unchanged: true,
        },
        injection: mode.includes('injected')
          ? 'explicit coordinator fault checkpoint carrying ENOSPC errno; not a physically full volume'
          : mode === 'insufficient-free-space'
          ? 'zero-available statfs capacity observation'
          : 'lowered enforced snapshot byte budget',
        assertions: [
          'no READY snapshot on failed backup',
          'no COMPLETE restore on failed copy',
          'no secret in errors',
          'original A/B bytes preserved',
        ],
      });
    },
  );
}

test('S1B manifest corruption and missing copied source reject restore before touching the original destination', async (t) => {
  const f = await s1bSecurityFixture(t, 'manifest-source-corruption');
  const portable = await f.portable();
  const imported = await f.backupB.importPortable(
    portable.archive,
    Buffer.from(portable.passphrase),
  );
  const file = path.join(imported.root, 'manifest.json');
  const before = await fs.readFile(file);
  const value = JSON.parse(before);
  value.workspaces[0].source_generation++;
  await fs.writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600 });
  const manifestCode = await rejected(
    f,
    new WorkspaceRestoreService(f.backupB).restore(imported.id, 'imports'),
    ['BACKUP_SOURCE_INCOMPLETE'],
  );
  await f.assertDestinationUnchanged();
  await notComplete(f);
  await fs.writeFile(file, before, { mode: 0o600 });
  const source = path.join(imported.root, 'data', f.row.root_key, 'main.sh');
  await fs.unlink(source);
  const sourceCode = await rejected(
    f,
    new WorkspaceRestoreService(f.backupB).restore(imported.id, 'imports'),
    ['BACKUP_SOURCE_INCOMPLETE'],
  );
  await assert.rejects(fs.lstat(source), { code: 'ENOENT' });
  await f.assertSourceUnchanged();
  await f.assertDestinationUnchanged();
  await notComplete(f);
  await f.record('manifest-source-corruption', {
    status: 'PASS',
    input: ['source_generation manifest tamper', 'copied entrypoint removed'],
    expected: 'reject before candidate publication',
    actual: {
      manifest_error: manifestCode,
      missing_source_error: sourceCode,
      destination_unchanged: true,
      source_not_recreated: true,
    },
    assertions: [
      'no false COMPLETE',
      'no user source overwrite',
      'no source fetched from A as fallback',
    ],
  });
});

test('S1B authenticated portable archive rejects wrong key, header, salt, ciphertext, tag and truncation without extraction or secret disclosure', async (t) => {
  const f = await s1bSecurityFixture(t, 'archive-authentication');
  const portable = await f.portable();
  const original = await fs.readFile(portable.archive);
  const outcomes = [];
  for (const mode of [
    'wrong-key',
    'header',
    'authenticated-header',
    'ciphertext',
    'tag',
    'truncated',
  ]) {
    await t.test(mode, async () => {
      let bytes = Buffer.from(original);
      if (mode === 'header') bytes[0] ^= 1;
      if (mode === 'authenticated-header') bytes[24] ^= 1;
      if (mode === 'ciphertext') bytes[64] ^= 1;
      if (mode === 'tag') bytes[bytes.length - 1] ^= 1;
      if (mode === 'truncated')
        bytes = bytes.subarray(0, Math.floor(bytes.length / 2));
      const file = path.join(f.transferRoot, mode + '.encrypted');
      await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      const key = Buffer.from(
        mode === 'wrong-key' ? 'wrong-' + randomUUID() : portable.passphrase,
      );
      const code = await rejected(f, f.backupB.importPortable(file, key), [
        'BACKUP_AUTHENTICATION_FAILED',
      ]);
      assert.ok(key.every((byte) => byte === 0));
      assert.deepEqual(
        await fs.readdir(path.join(f.B.backupRoot, 'imports')),
        [],
      );
      await f.assertDestinationUnchanged();
      assert.equal(bytes.includes(Buffer.from(f.secret)), false);
      outcomes.push({
        mode,
        error_code: code,
        bytes: bytes.length,
        sha256: digest(bytes),
        no_extraction: true,
        key_zeroed: true,
      });
    });
  }
  assert.equal(await f.hashFile(portable.archive), portable.archiveHash);
  await f.assertSourceUnchanged();
  await f.record('archive-authentication', {
    status: 'PASS',
    input: 'six independent corruptions of owned authenticated portable export',
    expected: 'authentication failure with no imported plaintext tree',
    actual: outcomes,
    assertions: [
      'original archive unchanged',
      'plaintext secret absent from ciphertext',
      'destination source unchanged',
      'passphrase buffers cleared',
      'no secret in error output',
    ],
  });
});

test('S1B missing live source blocks Backup and Task readiness without recreating an entrypoint', async (t) => {
  const f = await s1bSecurityFixture(t, 'missing-live-source');
  const entry = path.join(f.A.roots.path(f.row), 'main.sh');
  await fs.unlink(entry);
  const code = await rejected(f, f.backupA.create(), [
    'BACKUP_SOURCE_INCOMPLETE',
  ]);
  const readiness = await new TaskService(
    f.A.store,
    f.A.roots,
    f.A.leases,
  ).readiness(f.task.task.id);
  assert.notEqual(readiness.status, 'READY');
  const execution = f.A.track(
    new TaskExecutionService(f.A.store, f.A.roots, f.A.leases),
  );
  const submitted = await execution.submit(f.task.task.id, {
    submissionKey: 'missing-source-must-not-run',
  });
  const blocked = await execution.wait(submitted.id);
  assert.equal(blocked.status, 'RECOVERY_REQUIRED');
  assert.equal(blocked.error_code, 'SOURCE_MISSING');
  assert.equal((await execution.attempts(blocked.id)).length, 0);
  await execution.close();
  await assert.rejects(fs.lstat(entry), { code: 'ENOENT' });
  assert.equal(
    await fs.readFile(path.join(f.A.roots.path(f.row), 'helper.txt'), 'utf8'),
    f.helper,
  );
  assert.equal(
    (await f.A.store.all('SELECT COUNT(*) n FROM TaskRunAttempts'))[0].n,
    1,
  );
  await f.record('missing-live-source', {
    status: 'PASS',
    expected: 'not ready and no new execution',
    actual: {
      backup_error: code,
      task_readiness: readiness.status,
      historical_attempt_count: 1,
      blocked_run_status: blocked.status,
      blocked_run_error: blocked.error_code,
      blocked_run_attempt_count: 0,
      source_absent: true,
    },
    assertions: [
      'missing source remains absent',
      'helper unchanged',
      'no new Attempt',
      'no false READY backup',
    ],
  });
});

for (const mode of ['missing-git-object', 'invalid-git-admin']) {
  test(
    'S1B ' +
      mode +
      ' fails Git Backup closed without reset, reclone or deletion',
    async (t) => {
      const f = await s1bSecurityFixture(t, mode, { gitWorkspace: true });
      const root = f.A.roots.path(f.gitRow);
      let changed;
      if (mode === 'missing-git-object') {
        const head = git(['rev-parse', 'HEAD'], root);
        changed = path.join(
          f.repository.bare,
          'objects',
          head.slice(0, 2),
          head.slice(2),
        );
        await fs.unlink(changed);
      } else {
        const pointer = (await fs.readFile(path.join(root, '.git'), 'utf8'))
          .trim()
          .slice(8);
        changed = path.join(path.resolve(root, pointer), 'HEAD');
        await fs.writeFile(changed, 'ref: refs/heads/unknown-user-branch\n', {
          mode: 0o600,
        });
      }
      const code = await rejected(f, f.backupA.create(), [
        'BACKUP_SOURCE_INCOMPLETE',
        'BACKUP_RECOVERY_REQUIRED',
        'WORKSPACE_RECOVERY_REQUIRED',
      ]);
      if (mode === 'missing-git-object')
        await assert.rejects(fs.lstat(changed), { code: 'ENOENT' });
      else
        assert.equal(
          await fs.readFile(changed, 'utf8'),
          'ref: refs/heads/unknown-user-branch\n',
        );
      assert.equal(
        await fs.readFile(path.join(root, 'untracked.txt'), 'utf8'),
        'unique untracked bytes',
      );
      await f.assertSourceUnchanged();
      await f.assertDestinationUnchanged();
      assert.deepEqual(
        await fs.readdir(path.join(f.A.backupRoot, 'snapshots')),
        [],
      );
      await f.record(mode, {
        status: 'PASS',
        input: mode,
        expected: 'Git identity/object failure without destructive repair',
        actual: {
          error_code: code,
          untracked_bytes_preserved: true,
          corruption_not_silently_repaired: true,
        },
        assertions: [
          'no force reset/reclone',
          'no READY snapshot',
          'unknown branch metadata preserved',
          'LOCAL source and destination unchanged',
        ],
      });
    },
  );
}

for (const mode of [
  'unknown-destination',
  'root-symlink-replacement',
  'owner-marker-mismatch',
]) {
  test(
    'S1B ' +
      mode +
      ' cannot overwrite or delete existing destination/user source',
    async (t) => {
      const f = await s1bSecurityFixture(t, mode);
      const portable = await f.portable();
      const imported = await f.backupB.importPortable(
        portable.archive,
        Buffer.from(portable.passphrase),
      );
      let unknown, displaced;
      if (mode === 'unknown-destination') {
        unknown = path.join(f.B.dataRoot, 'unknown-user-directory');
        await fs.mkdir(unknown, { mode: 0o700 });
        await fs.writeFile(
          path.join(unknown, 'retain-me'),
          'UNKNOWN_USER_BYTES',
          { mode: 0o600 },
        );
      } else if (mode === 'owner-marker-mismatch') {
        const marker = path.join(
          f.B.roots.path(f.bRow),
          '.platform-workspace-owner.json',
        );
        const value = JSON.parse(await fs.readFile(marker, 'utf8'));
        value.owner_token = randomUUID();
        await fs.writeFile(marker, JSON.stringify(value), { mode: 0o600 });
      } else {
        unknown = path.join(f.B.root, 'unknown-user-source');
        await fs.mkdir(unknown, { mode: 0o700 });
        await fs.writeFile(
          path.join(unknown, 'retain-me'),
          'UNKNOWN_USER_BYTES',
          { mode: 0o600 },
        );
        displaced = path.join(f.B.root, 'owned-displaced-data');
        await fs.rename(f.B.dataRoot, displaced);
        await fs.symlink(unknown, f.B.dataRoot);
      }
      const code = await rejected(
        f,
        new WorkspaceRestoreService(f.backupB).restore(imported.id, 'imports'),
        [
          'WORKSPACE_RECOVERY_REQUIRED',
          'BACKUP_SOURCE_INCOMPLETE',
          'BACKUP_FILE_INVALID',
          'WORKSPACE_PATH_FORBIDDEN',
        ],
      );
      if (unknown)
        assert.equal(
          await fs.readFile(path.join(unknown, 'retain-me'), 'utf8'),
          'UNKNOWN_USER_BYTES',
        );
      if (mode === 'root-symlink-replacement') {
        assert.ok((await fs.lstat(f.B.dataRoot)).isSymbolicLink());
        assert.equal(await fs.readlink(f.B.dataRoot), unknown);
        await fs.unlink(f.B.dataRoot);
        await fs.rename(displaced, f.B.dataRoot);
      }
      await f.assertDestinationUnchanged();
      await f.assertSourceUnchanged();
      await notComplete(f);
      await f.record(mode, {
        status: 'PASS',
        input: mode,
        expected: 'reject before replacing owned or unknown root',
        actual: {
          error_code: code,
          original_destination_bytes_preserved: true,
          unknown_source_retained: !!unknown,
        },
        assertions: [
          'no unknown directory deletion',
          'no user source overwrite',
          'no false COMPLETE',
          'source A unchanged',
          'no secret in errors',
        ],
      });
    },
  );
}
