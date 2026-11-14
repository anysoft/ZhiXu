const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createReadinessProofFixture,
  sha,
} = require('./readiness-proof-fixture.cjs');
const {
  ManagedRuntimeAdapter,
} = require('../../../back/services/taskExecutionV2/runtime');
const { createFixture } = require('../fixture.cjs');

test('READINESS_PROOF lazy Store binding validates independent unit policy without executing synthetic bytes', async (t) => {
  const f = await createReadinessProofFixture(t);
  await f.gate();
  assert.equal(
    (await f.store.all('SELECT id FROM RuntimeInstallations')).length,
    0,
  );
});
test('READINESS_PROOF absent policy and explicit cross-DATA policy fail closed without filesystem repair', async (t) => {
  const unbound = await createFixture(t);
  const before = (await fs.readdir(unbound.dataRoot)).sort();
  await assert.rejects(
    new ManagedRuntimeAdapter(unbound.store).inspect('NODE', 1, 'JAVASCRIPT'),
    { error_code: 'RUNTIME_NOT_READY' },
  );
  assert.deepEqual((await fs.readdir(unbound.dataRoot)).sort(), before);
  const a = await createReadinessProofFixture(t),
    b = await createReadinessProofFixture(t);
  const cross = new ManagedRuntimeAdapter(a.store, b.policy);
  await assert.rejects(cross.inspect('NODE', 1, 'JAVASCRIPT'), {
    error_code: 'RUNTIME_NOT_READY',
  });
  const shell = await cross.inspect('SHELL', null, 'SHELL');
  assert.equal(shell.executable, '/bin/sh');
});
test('READINESS_PROOF rejects old READY-style metadata without trusted witness and does not repair it', async (t) => {
  const f = await createReadinessProofFixture(t);
  const marker = await f.adapter.node.marker('runtime', 1),
    before = await fs.readFile(marker);
  delete f.runtime.metadata.verified_inputs;
  await assert.rejects(f.gate(), { error_code: 'RUNTIME_NOT_READY' });
  assert.deepEqual(await fs.readFile(marker), before);
});
test('READINESS_PROOF rejects metadata self-declared trust and approved artifact mismatch', async (t) => {
  const f = await createReadinessProofFixture(t);
  f.runtime.metadata.verified_npm.sha256 = '0'.repeat(64);
  await assert.rejects(f.gate(), { error_code: 'RUNTIME_NOT_READY' });
});
test('READINESS_PROOF detects transitive npm mutation with unchanged CLI and version', async (t) => {
  const f = await createReadinessProofFixture(t);
  await f.gate();
  const cli = await fs.readFile(path.join(f.npmRoot, 'bin/npm-cli.js'));
  await fs.writeFile(
    path.join(f.npmRoot, 'node_modules/transitive/index.js'),
    'old vulnerable bundled dependency tree',
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.npmRoot, 'bin/npm-cli.js')),
    cli,
  );
  await assert.rejects(f.gate(), { error_code: 'RUNTIME_NOT_READY' });
});
test('READINESS_PROOF rejects forged npm CLI hashes even when DB and marker agree', async (t) => {
  const f = await createReadinessProofFixture(t);
  const changed = 'modified npm CLI';
  await fs.writeFile(path.join(f.npmRoot, 'bin/npm-cli.js'), changed);
  f.runtime.metadata.npm_cli_sha256 = f.tool.metadata.cli_sha256 = sha(changed);
  f.runtime.metadata.verified_inputs.npm_cli_sha256 = sha(changed);
  const marker = await f.adapter.node.marker('runtime', 1),
    owner = await f.adapter.node.readJson(marker);
  owner.verified_inputs = f.runtime.metadata.verified_inputs;
  await f.adapter.node.privateWrite(marker, JSON.stringify(owner));
  await assert.rejects(f.gate(), { error_code: 'RUNTIME_NOT_READY' });
});
test('READINESS_PROOF detects tsx package/CLI mutation beyond a major-version string', async (t) => {
  const f = await createReadinessProofFixture(t);
  await fs.writeFile(
    path.join(f.buildRoot, 'node_modules/tsx/dist/cli.mjs'),
    'tampered CLI',
  );
  await assert.rejects(f.gate(), { error_code: 'RUNTIME_NOT_READY' });
});
test('READINESS_PROOF checks both physical esbuild executables against approved rebuilt bytes', async (t) => {
  const f = await createReadinessProofFixture(t);
  await f.gate();
  await fs.writeFile(
    path.join(f.buildRoot, f.esbuildFiles[1]),
    'old Go esbuild bytes',
  );
  await assert.rejects(f.gate(), { error_code: 'RUNTIME_NOT_READY' });
});
test('READINESS_PROOF rejects mismatched filesystem witness and legacy PNPM without approved closure', async (t) => {
  const f = await createReadinessProofFixture(t);
  const marker = await f.adapter.node.marker('build', 1),
    owner = await f.adapter.node.readJson(marker);
  owner.verified_inputs.manifest_sha256 = '0'.repeat(64);
  await f.adapter.node.privateWrite(marker, JSON.stringify(owner));
  await assert.rejects(f.gate(), { error_code: 'RUNTIME_NOT_READY' });
  f.tool.manager_type = 'PNPM';
  await assert.rejects(f.gate(), { error_code: 'RUNTIME_NOT_READY' });
});
test('READINESS_PROOF Python binds approved source/definition/CA inputs to local installed witness', async (t) => {
  const f = await createReadinessProofFixture(t);
  await f.pythonGate();
  f.pythonRuntime.metadata.verified_inputs.definition_artifact_id =
    'self-declared-definition';
  await assert.rejects(f.pythonGate(), { error_code: 'RUNTIME_NOT_READY' });
});
test('READINESS_PROOF Python rejects SSL module and CA changes', async (t) => {
  const f = await createReadinessProofFixture(t);
  await f.pythonGate();
  await fs.writeFile(
    path.join(f.pythonRoot, f.pythonRuntime.metadata.ssl_module_relative),
    'old SSL module bytes',
  );
  await assert.rejects(f.pythonGate(), { error_code: 'RUNTIME_NOT_READY' });
  await fs.writeFile(
    path.join(f.pythonRoot, f.pythonRuntime.metadata.ssl_module_relative),
    'synthetic ssl module',
  );
  await fs.writeFile(
    path.join(f.pythonRoot, f.pythonRuntime.metadata.default_certfile_relative),
    'unapproved CA bytes',
  );
  await assert.rejects(f.pythonGate(), { error_code: 'RUNTIME_NOT_READY' });
});
test('READINESS_PROOF Python rejects old crypto versions and dynamic crypto linkage', async (t) => {
  const f = await createReadinessProofFixture(t);
  f.pythonRuntime.metadata.openssl_version = 'OpenSSL 1.1.1 legacy';
  f.pythonRuntime.metadata.verified_inputs.openssl_version =
    f.pythonRuntime.metadata.openssl_version;
  await assert.rejects(f.pythonGate(), { error_code: 'RUNTIME_NOT_READY' });
  f.pythonRuntime.metadata.openssl_version =
    'OpenSSL 3.5.9 SYNTHETIC_NOT_LOADED';
  f.pythonRuntime.metadata.verified_inputs.openssl_version =
    f.pythonRuntime.metadata.openssl_version;
  f.pythonRuntime.metadata.linked_library_names.ssl.push('libssl.so.3');
  await assert.rejects(f.pythonGate(), { error_code: 'RUNTIME_NOT_READY' });
});
test('READINESS_PROOF Python SQLite source identity and physical module cannot be metadata-only READY', async (t) => {
  const f = await createReadinessProofFixture(t);
  await f.pythonGate();
  f.pythonRuntime.metadata.sqlite_source_id = 'old source';
  f.pythonRuntime.metadata.verified_inputs.sqlite_source_id = 'old source';
  await assert.rejects(f.pythonGate(), { error_code: 'RUNTIME_NOT_READY' });
  f.pythonRuntime.metadata.sqlite_source_id =
    'SYNTHETIC_SQLITE_SOURCE_ID_NOT_LOADED';
  f.pythonRuntime.metadata.verified_inputs.sqlite_source_id =
    f.pythonRuntime.metadata.sqlite_source_id;
  await fs.writeFile(
    path.join(f.pythonRoot, f.pythonRuntime.metadata.sqlite_module_relative),
    'old OS-linked sqlite module',
  );
  await assert.rejects(f.pythonGate(), { error_code: 'RUNTIME_NOT_READY' });
});
test('READINESS_PROOF Python rejects vulnerable bundled wheels and old pip in a READY venv', async (t) => {
  const f = await createReadinessProofFixture(t);
  await f.pythonGate();
  const bundled = path.join(f.pythonRoot, 'lib/python3.13/ensurepip/_bundled');
  await fs.mkdir(bundled, { recursive: true, mode: 0o700 });
  const wheel = path.join(bundled, 'pip-26.2.1-py3-none-any.whl');
  await fs.writeFile(wheel, 'old unsafe wheel');
  await assert.rejects(f.pythonGate(), { error_code: 'RUNTIME_NOT_READY' });
  assert.equal(await fs.readFile(wheel, 'utf8'), 'old unsafe wheel');
  await fs.unlink(wheel);
  await f.pythonGate();
  await fs.writeFile(
    path.join(f.pythonVenv, f.pythonRuntime.metadata.pip_init_relative),
    'old venv pip init',
  );
  await assert.rejects(f.pythonGate(), { error_code: 'RUNTIME_NOT_READY' });
});
