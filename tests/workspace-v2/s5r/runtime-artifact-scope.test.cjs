const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFixture } = require('../fixture.cjs');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');
const {
  VerifiedRuntimeArtifactStore,
} = require('../../../back/services/runtimeArtifacts');
const {
  bindRuntimeArtifacts,
  runtimeArtifactsFor,
} = require('../../../back/services/runtimeArtifactScope');
const {
  createRuntimeDomain,
} = require('../../../back/applicationV2/runtimeDomain');

// A signed-off test manifest authenticates no executable. These cases exercise
// configuration ownership, never assert that a synthetic artifact is runnable.
async function policy(f, name, dataRoot = f.dataRoot) {
  const root = path.join(f.root, name);
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(path.join(root, 'manifest'), { mode: 0o700 });
  const manifest = JSON.stringify({
    schema: 1,
    release_id: name,
    os: process.platform,
    architecture: process.arch,
    created_at: '2026-11-14T00:00:00Z',
    node: [],
    python: [],
    npm: [],
    artifacts: [
      {
        id: 'binding-test-only',
        provider: 'TEST',
        publisher: 'TEST',
        source_url: 'https://nodejs.org/binding-test-only',
        version: '1',
        os: 'any',
        architecture: 'any',
        format: 'binary',
        sha256: 'a'.repeat(64),
        size: 1,
        signature_status: 'SIGNATURE_NOT_AVAILABLE',
        acquisition: 'UPSTREAM_BYTES',
      },
    ],
  });
  const manifestPath = path.join(root, 'manifest', 'approved.json');
  const trustAnchorPath = path.join(root, 'anchor.json');
  await fs.writeFile(manifestPath, manifest, { mode: 0o600 });
  await fs.writeFile(
    trustAnchorPath,
    JSON.stringify({
      schema: 1,
      authority: 'binding-test-only',
      approved_manifest_sha256: [
        createHash('sha256').update(manifest).digest('hex'),
      ],
    }),
    { mode: 0o600 },
  );
  return VerifiedRuntimeArtifactStore.open(
    {
      mode: 'OFFLINE_VERIFIED',
      storeRoot: path.join(root, 'objects'),
      manifestPath,
      trustAnchorPath,
    },
    dataRoot,
  );
}

test('RUNTIME_POLICY is scoped to exact WorkspaceStore and cannot cross DATA roots', async (t) => {
  const a = await createFixture(t),
    b = await createFixture(t);
  const ap = await policy(a, 'a'),
    bp = await policy(b, 'b');
  const undoA = bindRuntimeArtifacts(a.store, ap),
    undoB = bindRuntimeArtifacts(b.store, bp);
  try {
    assert.equal(runtimeArtifactsFor(a.store), ap);
    assert.equal(runtimeArtifactsFor(b.store), bp);
    assert.throws(
      () => bindRuntimeArtifacts(a.store, bp),
      /RUNTIME_ARTIFACT_DOMAIN_MISMATCH/,
    );
  } finally {
    undoA();
    undoB();
  }
});
test('RUNTIME_POLICY rejects replacement and stale cleanup never erases a later policy', async (t) => {
  const f = await createFixture(t);
  const first = await policy(f, 'first'),
    next = await policy(f, 'next');
  const undo1 = bindRuntimeArtifacts(f.store, first),
    undo2 = bindRuntimeArtifacts(f.store, first);
  assert.throws(
    () => bindRuntimeArtifacts(f.store, next),
    /RUNTIME_ARTIFACT_DOMAIN_MISMATCH/,
  );
  undo1();
  assert.equal(runtimeArtifactsFor(f.store), first);
  undo2();
  assert.equal(runtimeArtifactsFor(f.store), undefined);
  const undo3 = bindRuntimeArtifacts(f.store, next);
  undo1();
  undo2();
  assert.equal(runtimeArtifactsFor(f.store), next);
  undo3();
});
test('RUNTIME_POLICY reopened same DATA does not inherit the old Store binding', async (t) => {
  const f = await createFixture(t),
    approved = await policy(f, 'reopen');
  const undo = bindRuntimeArtifacts(f.store, approved);
  const reopened = await WorkspaceStore.open(f.databasePath, f.dataRoot);
  try {
    assert.equal(runtimeArtifactsFor(reopened), undefined);
  } finally {
    await reopened.close();
    undo();
  }
});
test('RUNTIME_POLICY actual Runtime domain close unbinds only its own Store configuration', async (t) => {
  const f = await createFixture(t),
    approved = await policy(f, 'domain-close');
  const domain = await createRuntimeDomain(f, approved.options);
  assert.equal(runtimeArtifactsFor(f.store), domain.context.artifacts);
  await domain.close();
  assert.equal(runtimeArtifactsFor(f.store), undefined);
  await domain.close();
  assert.equal(runtimeArtifactsFor(f.store), undefined);
});
test('RUNTIME_POLICY failed conflicting Runtime domain factory preserves the previous binding', async (t) => {
  const f = await createFixture(t),
    approved = await policy(f, 'domain-conflict');
  const undo = bindRuntimeArtifacts(f.store, approved);
  try {
    await assert.rejects(
      createRuntimeDomain(f, approved.options),
      /RUNTIME_ARTIFACT_DOMAIN_MISMATCH/,
    );
    assert.equal(runtimeArtifactsFor(f.store), approved);
    await f.store.verifySchema();
  } finally {
    undo();
  }
});
module.exports = { policy };
