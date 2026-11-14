const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createOfflineFixture,
  writeFixture,
  spawnImporter,
} = require('./s5r-offline-fixture.cjs');

test('S5R offline import accepts an independently approved synthetic package, publishes a complete receipt and preserves source bytes', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open();
  const receipt = await s.importPackage(f.packageRoot);
  assert.equal(receipt.status, 'VERIFIED_COMPLETE');
  assert.equal(receipt.manifest_sha256, s.manifestSha256);
  const target = await s.resolve('test-package', {});
  assert.deepEqual(
    await fs.readFile(target),
    await fs.readFile(
      path.join(f.packageRoot, 'objects', f.manifest.artifacts[0].sha256),
    ),
  );
  assert.equal(
    s.provenance('test-package').trust_method,
    'INDEPENDENT_PREAPPROVED_MANIFEST_SHA256',
  );
});
test('S5R offline import rejects tampered bytes before a complete receipt exists', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open();
  await fs.appendFile(
    path.join(f.packageRoot, 'objects', f.manifest.artifacts[0].sha256),
    'tampered',
  );
  await assert.rejects(s.importPackage(f.packageRoot), {
    error_code: 'RUNTIME_ARTIFACT_CHECKSUM_MISMATCH',
  });
  await assert.rejects(s.resolve('test-package', {}), {
    error_code: 'RUNTIME_ARTIFACT_OFFLINE_MISSING',
  });
});
test('S5R offline import rejects a wrong declared SHA256 even in an approved test manifest', async (t) => {
  const f = await createOfflineFixture(t),
    a = f.manifest.artifacts[0],
    old = a.sha256;
  a.sha256 = 'f'.repeat(64);
  await fs.rename(
    path.join(f.packageRoot, 'objects', old),
    path.join(f.packageRoot, 'objects', a.sha256),
  );
  await writeFixture(f);
  await assert.rejects((await f.open()).importPackage(f.packageRoot), {
    error_code: 'RUNTIME_ARTIFACT_CHECKSUM_MISMATCH',
  });
});
for (const field of ['os', 'architecture'])
  test('S5R offline import rejects wrong target ' + field, async (t) => {
    const f = await createOfflineFixture(t);
    f.manifest[field] =
      field === 'os'
        ? process.platform === 'linux'
          ? 'darwin'
          : 'linux'
        : process.arch === 'x64'
        ? 'arm64'
        : 'x64';
    await writeFixture(f);
    await assert.rejects(f.open(), {
      error_code: 'RUNTIME_ARTIFACT_MANIFEST_INVALID',
    });
  });
test('S5R offline provider lookup rejects wrong exact version without fallback', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open();
  assert.throws(() => s.nodeDistribution('24.22.2'), {
    error_code: 'RUNTIME_ARTIFACT_VERSION_UNAVAILABLE',
  });
});
test('S5R offline import rejects missing dependency bytes', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open();
  await fs.unlink(
    path.join(f.packageRoot, 'objects', f.manifest.artifacts[0].sha256),
  );
  await assert.rejects(s.importPackage(f.packageRoot), {
    error_code: 'RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE',
  });
});
test('S5R offline import rejects an untrusted manifest although its own artifacts match it', async (t) => {
  const f = await createOfflineFixture(t);
  f.manifest.release_id = 'attacker-self-consistent-package';
  await writeFixture(f, false);
  await assert.rejects(f.open(), { error_code: 'RUNTIME_ARTIFACT_UNTRUSTED' });
});
test('S5R offline import rejects manifest and configured release mismatch', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open();
  f.manifest.created_at = '2026-11-13T00:00:00Z';
  await writeFixture(f, false);
  await assert.rejects(s.importPackage(f.packageRoot), {
    error_code: 'RUNTIME_ARTIFACT_UNTRUSTED',
  });
});
for (const archive of ['traversal', 'symlink', 'link-ancestor', 'link-chain'])
  test(
    'S5R offline import rejects authenticated archive ' + archive + ' escape',
    async (t) => {
      const f = await createOfflineFixture(t, { archive }),
        s = await f.open();
      await assert.rejects(s.importPackage(f.packageRoot), {
        error_code: 'RUNTIME_ARTIFACT_ARCHIVE_INVALID',
      });
      await assert.rejects(fs.stat(path.join(f.root, 'escaped')), {
        code: 'ENOENT',
      });
      await assert.rejects(s.resolve('test-package', {}), {
        error_code: 'RUNTIME_ARTIFACT_OFFLINE_MISSING',
      });
    },
  );
test('S5R approved directory links are created after extraction without writing through a link', async (t) => {
  const { spawnSync } = require('node:child_process');
  const f = await createOfflineFixture(t, { archive: 'directory-link' }),
    s = await f.open();
  await s.importPackage(f.packageRoot);
  const input = await s.resolve('test-package', {}),
    destination = path.join(f.root, 'extracted');
  const helper = path.resolve(
    __dirname,
    '../../shell/runtime_artifact_archive.py',
  );
  const result = spawnSync(
    '/usr/bin/python3',
    ['-I', '-S', helper, 'extract', input, 'package', destination],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok((await fs.lstat(path.join(destination, 'link'))).isSymbolicLink());
  assert.equal(
    await fs.realpath(path.join(destination, 'link')),
    path.join(destination, 'dir'),
  );
  assert.equal(
    await fs.readFile(path.join(destination, 'link/data.txt'), 'utf8'),
    'safe',
  );
});
test('S5R offline import rejects truncated bytes', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open(),
    file = path.join(f.packageRoot, 'objects', f.manifest.artifacts[0].sha256);
  await fs.truncate(file, 16);
  await assert.rejects(s.importPackage(f.packageRoot), {
    error_code: 'RUNTIME_ARTIFACT_CHECKSUM_MISMATCH',
  });
});
test('S5R concurrent import is rejected by a real inherited FD lock and completes after the holder drains', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open(),
    worker = await spawnImporter(f);
  t.after(() => {
    if (worker.child.exitCode === null && worker.child.signalCode === null)
      worker.child.kill('SIGKILL');
  });
  await assert.rejects(s.importPackage(f.packageRoot), {
    error_code: 'RUNTIME_ARTIFACT_IMPORT_BUSY',
  });
  worker.child.stdin.end('continue');
  assert.deepEqual(await worker.completed, { code: 0, signal: null });
  assert.ok(await s.resolve('test-package', {}));
});
test('S5R SIGKILL interrupted import cannot publish readiness and its real FD is released for an independent retry', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open(),
    worker = await spawnImporter(f);
  worker.child.kill('SIGKILL');
  assert.deepEqual(await worker.completed, { code: null, signal: 'SIGKILL' });
  await assert.rejects(s.resolve('test-package', {}), {
    error_code: 'RUNTIME_ARTIFACT_OFFLINE_MISSING',
  });
  const retried = await f.open();
  assert.equal(
    (await retried.importPackage(f.packageRoot)).status,
    'VERIFIED_COMPLETE',
  );
  assert.ok(await retried.resolve('test-package', {}));
});
test('S5R offline import rejects a symlink object without following it', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open(),
    file = path.join(f.packageRoot, 'objects', f.manifest.artifacts[0].sha256);
  await fs.rename(file, path.join(f.root, 'outside.tgz'));
  await fs.symlink(path.join(f.root, 'outside.tgz'), file);
  await assert.rejects(s.importPackage(f.packageRoot), {
    error_code: 'RUNTIME_ARTIFACT_PATH_INVALID',
  });
});
test('S5R offline trust anchor cannot reside in the imported package', async (t) => {
  const f = await createOfflineFixture(t);
  const bad = {
    ...f.options,
    trustAnchorPath: path.join(f.packageRoot, 'trust.json'),
  };
  await fs.copyFile(f.options.trustAnchorPath, bad.trustAnchorPath);
  await assert.rejects(f.Store.open(bad, f.dataRoot), {
    error_code: 'RUNTIME_ARTIFACT_TRUST_NOT_INDEPENDENT',
  });
});
test('S5R offline trust anchor writable by other users is refused', async (t) => {
  const f = await createOfflineFixture(t);
  await fs.chmod(f.options.trustAnchorPath, 0o666);
  await assert.rejects(f.open(), {
    error_code: 'RUNTIME_ARTIFACT_TRUST_UNPROTECTED',
  });
});
test('S5R offline trust anchor in a writable unprotected directory is refused', async (t) => {
  const f = await createOfflineFixture(t);
  await fs.chmod(path.dirname(f.options.trustAnchorPath), 0o777);
  await assert.rejects(f.open(), {
    error_code: 'RUNTIME_ARTIFACT_TRUST_UNPROTECTED',
  });
});
test('S5R offline store refuses an unknown nonempty root', async (t) => {
  const f = await createOfflineFixture(t);
  await fs.mkdir(f.options.storeRoot, { mode: 0o700 });
  await fs.writeFile(
    path.join(f.options.storeRoot, 'unknown-user-data'),
    'preserve',
  );
  await assert.rejects(f.open(), {
    error_code: 'RUNTIME_ARTIFACT_STORE_INVALID',
  });
  assert.equal(
    await fs.readFile(
      path.join(f.options.storeRoot, 'unknown-user-data'),
      'utf8',
    ),
    'preserve',
  );
});
test('S5R offline artifacts must be separated from the DataRoot', async (t) => {
  const f = await createOfflineFixture(t);
  await assert.rejects(
    f.Store.open(
      { ...f.options, storeRoot: path.join(f.dataRoot, 'artifacts') },
      f.dataRoot,
    ),
    { error_code: 'RUNTIME_ARTIFACT_DOMAIN_MISMATCH' },
  );
});
test('S5R offline store refuses a symlink root', async (t) => {
  const f = await createOfflineFixture(t);
  await fs.mkdir(path.join(f.root, 'outside-store'), { mode: 0o700 });
  await fs.symlink(path.join(f.root, 'outside-store'), f.options.storeRoot);
  await assert.rejects(f.open(), {
    error_code: 'RUNTIME_ARTIFACT_PATH_INVALID',
  });
});
test('S5R runtime artifact resolution is isolated to the current asynchronous application domain', async (t) => {
  const a = await createOfflineFixture(t),
    b = await createOfflineFixture(t),
    s = await a.open();
  await a.scope.withRuntimeDomain({ artifacts: s }, async () => {
    assert.equal(a.Store.current(a.dataRoot), s);
    assert.throws(() => a.Store.current(b.dataRoot), {
      error_code: 'RUNTIME_ARTIFACT_DOMAIN_MISMATCH',
    });
  });
  assert.equal(a.Store.current(a.dataRoot), undefined);
});
test('S5R offline import rejects extra unlisted input objects', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open();
  await fs.writeFile(
    path.join(f.packageRoot, 'objects', 'unlisted'),
    'untrusted',
  );
  await assert.rejects(s.importPackage(f.packageRoot), {
    error_code: 'RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE',
  });
});
test('S5R offline resolve rechecks stored bytes instead of trusting a prior receipt', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open();
  await s.importPackage(f.packageRoot);
  const file = s.objectPath(s.artifact('test-package'));
  await fs.chmod(file, 0o600);
  await fs.appendFile(file, 'changed');
  await assert.rejects(s.resolve('test-package', {}), {
    error_code: 'RUNTIME_ARTIFACT_CHECKSUM_MISMATCH',
  });
});
for (const suffix of ['.platform-control', '-backups'])
  test(
    'S5R artifact inputs cannot overlap the platform-owned ' +
      suffix +
      ' domain',
    async (t) => {
      const f = await createOfflineFixture(t);
      await assert.rejects(
        f.Store.open(
          {
            ...f.options,
            storeRoot: path.join(f.dataRoot + suffix, 'artifacts'),
          },
          f.dataRoot,
        ),
        { error_code: 'RUNTIME_ARTIFACT_DOMAIN_MISMATCH' },
      );
      await assert.rejects(
        f.Store.open(
          {
            ...f.options,
            manifestPath: path.join(f.dataRoot + suffix, 'manifest.json'),
          },
          f.dataRoot,
        ),
        { error_code: 'RUNTIME_ARTIFACT_DOMAIN_MISMATCH' },
      );
      await assert.rejects(
        f.Store.open(
          {
            ...f.options,
            trustAnchorPath: path.join(f.dataRoot + suffix, 'anchor.json'),
          },
          f.dataRoot,
        ),
        { error_code: 'RUNTIME_ARTIFACT_DOMAIN_MISMATCH' },
      );
    },
  );
test('S5R artifact inputs cannot overlap an explicitly excluded custom backup domain', async (t) => {
  const f = await createOfflineFixture(t),
    excluded = path.join(f.root, 'custom-backup');
  await assert.rejects(
    f.Store.open(
      {
        ...f.options,
        excludedRoots: [excluded],
        storeRoot: path.join(excluded, 'artifacts'),
      },
      f.dataRoot,
    ),
    { error_code: 'RUNTIME_ARTIFACT_DOMAIN_MISMATCH' },
  );
});
test('S5R approved artifact URLs still reject authentication query strings', async (t) => {
  const f = await createOfflineFixture(t);
  f.manifest.artifacts[0].source_url += '?credential=synthetic-test-only';
  await writeFixture(f);
  await assert.rejects(f.open(), {
    error_code: 'RUNTIME_ARTIFACT_SOURCE_INVALID',
  });
});
test('S5R opened policy is immutable and uses the official target catalog token', async (t) => {
  const f = await createOfflineFixture(t),
    s = await f.open();
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.options));
  assert.ok(Object.isFrozen(s.manifest));
  assert.ok(Object.isFrozen(s.manifest.artifacts[0]));
  assert.deepEqual(s.nodeCatalog()[0].files, [
    process.platform === 'darwin'
      ? 'osx-' + process.arch + '-tar'
      : process.platform + '-' + process.arch,
  ]);
  assert.equal(
    Reflect.set(s.manifest.artifacts[0], 'sha256', '0'.repeat(64)),
    false,
  );
});
test('S5R a symlink DataRoot cannot disguise overlap with the artifact store', async (t) => {
  const f = await createOfflineFixture(t),
    alias = path.join(f.root, 'data-alias');
  await fs.symlink(f.root, alias);
  await assert.rejects(f.Store.open(f.options, alias), {
    error_code: 'RUNTIME_ARTIFACT_PATH_INVALID',
  });
  await assert.rejects(fs.lstat(f.options.storeRoot), { code: 'ENOENT' });
});
test('S5R an excluded backup symlink is refused before any store publication', async (t) => {
  const f = await createOfflineFixture(t),
    alias = path.join(f.root, 'backup-alias');
  await fs.symlink(f.root, alias);
  await assert.rejects(
    f.Store.open({ ...f.options, excludedRoots: [alias] }, f.dataRoot),
    { error_code: 'RUNTIME_ARTIFACT_PATH_INVALID' },
  );
  await assert.rejects(fs.lstat(f.options.storeRoot), { code: 'ENOENT' });
});
