const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { releaseArguments } = require(path.join(
  process.env.ZHIXU_S5_RELEASE_ROOT || path.resolve(__dirname, '../../..'),
  'scripts/release-v2/entrypoint.cjs',
));
const base = {
  ZHIXU_V2_DATA_ROOT: '/owned/data',
  ZHIXU_V2_BACKUP_ROOT: '/owned/backups',
  ZHIXU_V2_PUBLIC_ORIGIN: 'http://127.0.0.1:5600',
};
const artifacts = {
  ZHIXU_V2_RUNTIME_ARTIFACT_MODE: 'OFFLINE_VERIFIED',
  ZHIXU_V2_RUNTIME_ARTIFACT_STORE: '/trusted/store',
  ZHIXU_V2_RUNTIME_ARTIFACT_TRUST_ANCHOR: '/protected/anchor.json',
  ZHIXU_V2_RUNTIME_ARTIFACT_MANIFEST: '/transfer/package/manifest.json',
};
test('S5R default release entry keeps ordinary online initialization', () => {
  const result = releaseArguments(base, ['--initialize']);
  assert.equal(result.at(-1), '--initialize');
  assert.equal(result.includes('--runtime-artifact-mode'), false);
});
for (const mode of ['ONLINE_VERIFIED', 'OFFLINE_VERIFIED'])
  test(
    'S5R release entry explicitly forwards the complete ' +
      mode +
      ' artifact domain',
    () => {
      const result = releaseArguments(
        { ...base, ...artifacts, ZHIXU_V2_RUNTIME_ARTIFACT_MODE: mode },
        [],
      );
      assert.deepEqual(result.slice(-8), [
        '--runtime-artifact-mode',
        mode,
        '--runtime-artifact-store',
        artifacts.ZHIXU_V2_RUNTIME_ARTIFACT_STORE,
        '--runtime-artifact-trust-anchor',
        artifacts.ZHIXU_V2_RUNTIME_ARTIFACT_TRUST_ANCHOR,
        '--runtime-artifact-manifest',
        artifacts.ZHIXU_V2_RUNTIME_ARTIFACT_MANIFEST,
      ]);
    },
  );
test('S5R release entry rejects each partial artifact configuration', () => {
  for (const key of Object.keys(artifacts)) {
    const invalid = { ...base, ...artifacts };
    delete invalid[key];
    assert.throws(
      () => releaseArguments(invalid, []),
      /V2_RELEASE_RUNTIME_ARTIFACT_CONFIG_INVALID/,
    );
  }
});
test('S5R release entry rejects relative, noncanonical, root and empty artifact paths', () => {
  for (const key of Object.keys(artifacts).slice(1))
    for (const value of ['relative/store', '/trusted/../store', '/', ''])
      assert.throws(
        () => releaseArguments({ ...base, ...artifacts, [key]: value }, []),
        /V2_RELEASE_RUNTIME_ARTIFACT_CONFIG_INVALID/,
      );
});
test('S5R release entry rejects an implicit or unknown artifact mode', () => {
  for (const value of ['offline', 'HOST', '', undefined])
    assert.throws(
      () =>
        releaseArguments(
          { ...base, ...artifacts, ZHIXU_V2_RUNTIME_ARTIFACT_MODE: value },
          [],
        ),
      /V2_RELEASE_RUNTIME_ARTIFACT_CONFIG_INVALID/,
    );
});
test('S5R release entry preserves its limited process argument boundary', () => {
  assert.throws(
    () =>
      releaseArguments({ ...base, ...artifacts }, ['--data-root', '/unknown']),
    /V2_RELEASE_ARGUMENT_INVALID/,
  );
});
