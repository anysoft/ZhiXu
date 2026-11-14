// Synthetic proof-gate unit data, never a Provider receipt or runnable Runtime.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFixture } = require('../fixture.cjs');
const {
  ManagedRuntimeAdapter,
} = require('../../../back/services/taskExecutionV2/runtime');
const {
  VerifiedRuntimeArtifactStore,
} = require('../../../back/services/runtimeArtifacts');
const {
  bindRuntimeArtifacts,
} = require('../../../back/services/runtimeArtifactScope');
const {
  runtimeTreeDigest,
} = require('../../../scripts/release-v2/runtime-tree.cjs');
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function createReadinessProofFixture(t) {
  const f = await createFixture(t),
    adapter = new ManagedRuntimeAdapter(f.store);
  const runtimeRoot = await adapter.node.create('runtime', 1);
  const buildRoot = await adapter.node.create('build', 1, 1);
  const write = async (root, relative, bytes, mode = 0o600) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, bytes, { mode });
    return file;
  };
  const nodeBytes = 'SYNTHETIC_NOT_EXECUTABLE_RUNTIME\n';
  const npmCli = 'SYNTHETIC_NPM_NOT_EXECUTED\n',
    tsxCli = 'SYNTHETIC_TSX_NOT_EXECUTED\n';
  const npmRoot = path.join(runtimeRoot, 'lib/node_modules/npm');
  await write(runtimeRoot, 'bin/node', nodeBytes, 0o700);
  await write(
    npmRoot,
    'package.json',
    JSON.stringify({
      name: 'npm',
      version: '11.21.2',
      bin: { npm: 'bin/npm-cli.js' },
    }),
  );
  await write(npmRoot, 'bin/npm-cli.js', npmCli);
  await write(
    npmRoot,
    'node_modules/transitive/index.js',
    'approved transitive bytes',
  );
  await write(
    buildRoot,
    'node_modules/tsx/package.json',
    JSON.stringify({ name: 'tsx', version: '4.23.15', bin: './dist/cli.mjs' }),
  );
  await write(buildRoot, 'node_modules/tsx/dist/cli.mjs', tsxCli);
  const esbuildBytes = 'SYNTHETIC_ESBUILD_NOT_EXECUTED\n';
  const esbuildPackage = '@esbuild/' + process.platform + '-' + process.arch;
  const esbuildFiles = [
    'node_modules/' + esbuildPackage + '/bin/esbuild',
    'node_modules/esbuild/bin/esbuild',
  ];
  for (const relative of esbuildFiles)
    await write(buildRoot, relative, esbuildBytes, 0o700);
  await write(
    buildRoot,
    'node_modules/esbuild/package.json',
    JSON.stringify({ name: 'esbuild', version: '0.28.2' }),
  );
  await write(
    buildRoot,
    'node_modules/' + esbuildPackage + '/package.json',
    JSON.stringify({ name: esbuildPackage, version: '0.28.2' }),
  );
  const npmTree = await runtimeTreeDigest(npmRoot),
    tsxTree = await runtimeTreeDigest(path.join(buildRoot, 'node_modules/tsx'));
  const packageJson = JSON.stringify({
    private: true,
    dependencies: { tsx: '4.23.15' },
  });
  const lockBytes = JSON.stringify({
    lockfileVersion: 3,
    SYNTHETIC_UNIT_ONLY: true,
  });
  await write(buildRoot, 'package.json', packageJson);
  await write(buildRoot, 'package-lock.json', lockBytes);
  const artifact = (id, fields) => ({
    id,
    provider: 'SYNTHETIC_PROOF_UNIT_ONLY',
    publisher: 'TEST_NOT_A_RUNTIME',
    source_url: 'https://nodejs.org/synthetic-proof-unit/' + id,
    version: '1.0.0',
    os: 'any',
    architecture: 'any',
    format: 'binary',
    sha256: sha(id),
    size: 1,
    signature_status: 'SIGNATURE_NOT_AVAILABLE',
    acquisition: 'UPSTREAM_BYTES',
    ...fields,
  });
  const artifacts = [
    artifact('node', {
      version: '24.22.3',
      provenance: { executable_sha256: sha(nodeBytes) },
    }),
    artifact('npm', {
      version: '11.21.2',
      npm_name: 'npm',
      npm_version: '11.21.2',
      provenance: {
        cli_relative_path: 'bin/npm-cli.js',
        cli_sha256: sha(npmCli),
        tree_sha256: npmTree.sha256,
        tree_entry_count: npmTree.entry_count,
      },
    }),
    artifact('lock', {
      format: 'json',
      sha256: sha(lockBytes),
      size: Buffer.byteLength(lockBytes),
    }),
    artifact('tsx', {
      version: '4.23.15',
      npm_name: 'tsx',
      npm_version: '4.23.15',
      provenance: {
        cli_relative_path: './dist/cli.mjs',
        cli_sha256: sha(tsxCli),
        tree_sha256: tsxTree.sha256,
        tree_entry_count: tsxTree.entry_count,
      },
    }),
    artifact('esbuild', {
      version: '0.28.2',
      acquisition: 'VERIFIED_REBUILD',
      sha256: sha(esbuildBytes),
      size: Buffer.byteLength(esbuildBytes),
      provenance: { go_version: 'go1.26.11', SYNTHETIC_UNIT_ONLY: true },
    }),
    artifact('pyenv', { version: 'a'.repeat(40) }),
    artifact('definition', {}),
    artifact('python-source', { version: '3.13.15' }),
    artifact('openssl-source', { version: '3.5.9' }),
    artifact('zlib-source', { version: '1.4' }),
    artifact('sqlite-source', {
      version: '3.54.1',
      provenance: { sqlite_source_id: 'SYNTHETIC_SQLITE_SOURCE_ID_NOT_LOADED' },
    }),
    artifact('pip-wheel', {
      version: '26.3',
      sha256: sha('synthetic approved pip wheel'),
      size: Buffer.byteLength('synthetic approved pip wheel'),
      provenance: {
        wheel_filename: 'pip-26.3-py3-none-any.whl',
        pip_init_sha256: sha('synthetic approved pip init'),
        pip_vendor_manifest_sha256: sha('synthetic approved vendor manifest'),
      },
    }),
    artifact('ca', {
      sha256: sha('synthetic approved CA bytes'),
      size: Buffer.byteLength('synthetic approved CA bytes'),
    }),
  ];
  const manifest = JSON.stringify({
    schema: 1,
    release_id: 'SYNTHETIC_PROOF_UNIT_NOT_INSTALLATION',
    os: process.platform,
    architecture: process.arch,
    created_at: '2026-11-14T00:00:00Z',
    artifacts,
    node: [{ version: '24.22.3', archive: 'node', npm: 'npm' }],
    python: [
      {
        version: '3.13.15',
        provider_revision: 'a'.repeat(40),
        provider_archive: 'pyenv',
        definition: 'definition',
        openssl: 'openssl-source',
        zlib: 'zlib-source',
        ca_bundle: 'ca',
        sqlite: 'sqlite-source',
        pip_wheel: 'pip-wheel',
        sources: [
          { artifact: 'python-source', cache_name: 'python.tar.xz' },
          { artifact: 'openssl-source', cache_name: 'openssl.tar.gz' },
          { artifact: 'zlib-source', cache_name: 'zlib.tar.gz' },
          { artifact: 'sqlite-source', cache_name: 'sqlite.tar.gz' },
        ],
      },
    ],
    npm: [
      {
        runtime_version: '24.22.3',
        npm_version: '11.21.2',
        package_json_sha256: sha(packageJson),
        lockfile: 'lock',
        packages: ['tsx'],
        esbuild: {
          artifact: 'esbuild',
          package_name: esbuildPackage,
          version: '0.28.2',
        },
      },
    ],
  });
  const trusted = path.join(f.root, 'trusted');
  await fs.mkdir(path.join(trusted, 'manifest'), {
    recursive: true,
    mode: 0o700,
  });
  const manifestPath = await write(trusted, 'manifest/approved.json', manifest);
  const trustAnchorPath = await write(
    trusted,
    'anchor.json',
    JSON.stringify({
      schema: 1,
      authority: 'SYNTHETIC_PROOF_UNIT_ONLY',
      approved_manifest_sha256: [sha(manifest)],
    }),
  );
  const policy = await VerifiedRuntimeArtifactStore.open(
    {
      mode: 'OFFLINE_VERIFIED',
      storeRoot: path.join(trusted, 'store'),
      manifestPath,
      trustAnchorPath,
    },
    f.dataRoot,
  );
  const runtimeInputs = {
    schema: 1,
    kind: 'NODE_RUNTIME',
    manifest_sha256: policy.manifestSha256,
    trust_anchor_sha256: policy.trustAnchorSha256,
    archive_artifact_id: 'node',
    npm_artifact_id: 'npm',
    executable_sha256: sha(nodeBytes),
    npm_cli_sha256: sha(npmCli),
    npm_tree_sha256: npmTree.sha256,
  };
  const buildInputs = {
    schema: 1,
    kind: 'NODE_BUILD',
    manifest_sha256: policy.manifestSha256,
    trust_anchor_sha256: policy.trustAnchorSha256,
    lock_artifact_id: 'lock',
    lock_artifact_sha256: sha(lockBytes),
    tsx_artifact_id: 'tsx',
    tsx_cli_relative_path: './dist/cli.mjs',
    tsx_cli_sha256: sha(tsxCli),
    tsx_tree_sha256: tsxTree.sha256,
    esbuild_artifact_id: 'esbuild',
    esbuild_sha256: sha(esbuildBytes),
    esbuild_package: esbuildPackage,
    esbuild_publisher: policy.artifact('esbuild').publisher,
    esbuild_build_provenance: policy.artifact('esbuild').provenance,
  };
  for (const [kind, value] of [
    ['runtime', runtimeInputs],
    ['build', buildInputs],
  ]) {
    const marker = await adapter.node.marker(kind, 1);
    const owner = await adapter.node.readJson(marker);
    await adapter.node.privateWrite(
      marker,
      JSON.stringify({ ...owner, verified_inputs: value }),
    );
  }
  const runtime = {
    id: 1,
    version: '24.22.3',
    metadata: {
      executable_sha256: sha(nodeBytes),
      npm_cli_sha256: sha(npmCli),
      npm_version: '11.21.2',
      verified_artifact: policy.provenance('node'),
      verified_npm: policy.provenance('npm'),
      verified_inputs: runtimeInputs,
    },
  };
  const tool = {
    id: 1,
    manager_type: 'NPM',
    version: '11.21.2',
    metadata: { cli_sha256: sha(npmCli) },
  };
  const build = {
    id: 1,
    package_json: packageJson,
    lock_hash: sha(lockBytes),
    metadata: { verified_artifacts: buildInputs },
  };
  const undo = bindRuntimeArtifacts(f.store, policy);
  t.after(undo);
  const pythonRoot = path.join(
    f.dataRoot,
    'runtime/python/pyenv/versions/3.13.15',
  );
  const pythonMetadata = {
    executable_sha256: sha('synthetic Python executable'),
    openssl_version: 'OpenSSL 3.5.9 SYNTHETIC_NOT_LOADED',
    zlib_version: '1.4',
    sqlite_version: '3.54.1',
    sqlite_source_id: 'SYNTHETIC_SQLITE_SOURCE_ID_NOT_LOADED',
    sqlite_module_sha256: sha('synthetic sqlite module'),
    pip_version: '26.3',
    pip_init_relative: 'lib/python3.13/site-packages/pip/__init__.py',
    pip_vendor_manifest_relative:
      'lib/python3.13/site-packages/pip/_vendor/vendor.txt',
    pip_wheel_relative: 'pip-wheels/pip-26.3-py3-none-any.whl',
    linked_library_names: {
      ssl: ['libc.so.6'],
      hashlib: ['libc.so.6'],
      zlib: ['libc.so.6'],
      sqlite: ['libc.so.6'],
    },
    ssl_module_relative: 'lib/python3.13/lib-dynload/_ssl.synthetic.so',
    hashlib_module_relative: 'lib/python3.13/lib-dynload/_hashlib.synthetic.so',
    zlib_module_relative: 'lib/python3.13/lib-dynload/zlib.synthetic.so',
    sqlite_module_relative: 'lib/python3.13/lib-dynload/_sqlite3.synthetic.so',
    default_certfile_relative: 'openssl/ssl/cert.pem',
    verified_provider: policy.provenance('pyenv'),
    verified_sources: [
      'python-source',
      'openssl-source',
      'zlib-source',
      'sqlite-source',
    ].map((id) => policy.provenance(id)),
  };
  const pythonInputs = {
    schema: 1,
    kind: 'PYTHON_RUNTIME',
    manifest_sha256: policy.manifestSha256,
    trust_anchor_sha256: policy.trustAnchorSha256,
    provider_artifact_id: 'pyenv',
    definition_artifact_id: 'definition',
    source_artifact_ids: [
      'python-source',
      'openssl-source',
      'zlib-source',
      'sqlite-source',
    ],
    ca_bundle_artifact_id: 'ca',
    sqlite_artifact_id: 'sqlite-source',
    sqlite_module_sha256: pythonMetadata.sqlite_module_sha256,
    sqlite_version: pythonMetadata.sqlite_version,
    sqlite_source_id: pythonMetadata.sqlite_source_id,
    pip_artifact_id: 'pip-wheel',
    pip_wheel_sha256: policy.artifact('pip-wheel').sha256,
    pip_init_sha256: policy.artifact('pip-wheel').provenance.pip_init_sha256,
    pip_vendor_manifest_sha256:
      policy.artifact('pip-wheel').provenance.pip_vendor_manifest_sha256,
    pip_version: '26.3',
    executable_sha256: pythonMetadata.executable_sha256,
    ssl_module_sha256: sha('synthetic ssl module'),
    hashlib_module_sha256: sha('synthetic hashlib module'),
    zlib_module_sha256: sha('synthetic zlib module'),
    openssl_version: pythonMetadata.openssl_version,
    zlib_version: '1.4',
    ca_bundle_sha256: policy.artifact('ca').sha256,
  };
  for (const [relative, bytes] of [
    [pythonMetadata.ssl_module_relative, 'synthetic ssl module'],
    [pythonMetadata.hashlib_module_relative, 'synthetic hashlib module'],
    [pythonMetadata.zlib_module_relative, 'synthetic zlib module'],
    [pythonMetadata.sqlite_module_relative, 'synthetic sqlite module'],
    [pythonMetadata.pip_init_relative, 'synthetic approved pip init'],
    [
      pythonMetadata.pip_vendor_manifest_relative,
      'synthetic approved vendor manifest',
    ],
    [pythonMetadata.pip_wheel_relative, 'synthetic approved pip wheel'],
    [pythonMetadata.default_certfile_relative, 'synthetic approved CA bytes'],
  ])
    await write(pythonRoot, relative, bytes);
  pythonMetadata.verified_inputs = pythonInputs;
  const pythonVenv = path.join(f.dataRoot, 'proof-only-venv');
  await write(
    pythonVenv,
    pythonMetadata.pip_init_relative,
    'synthetic approved pip init',
  );
  await write(
    pythonVenv,
    pythonMetadata.pip_vendor_manifest_relative,
    'synthetic approved vendor manifest',
  );
  const pythonMarker = await adapter.paths.ownership(2);
  await adapter.paths.privateWrite(
    pythonMarker,
    JSON.stringify({ verified_inputs: pythonInputs }),
  );
  const pythonRuntime = { id: 2, version: '3.13.15', metadata: pythonMetadata };
  return {
    ...f,
    adapter,
    policy,
    runtime,
    tool,
    build,
    npmRoot,
    runtimeRoot,
    buildRoot,
    esbuildFiles,
    gate: () =>
      adapter.inspectNodeArtifacts(
        runtime,
        tool,
        build,
        runtimeRoot,
        buildRoot,
        'TYPESCRIPT',
      ),
    pythonRuntime,
    pythonRoot,
    pythonMarker,
    pythonVenv,
    pythonGate: () =>
      adapter.inspectPythonArtifacts(
        pythonRuntime,
        { provider_revision: 'a'.repeat(40) },
        pythonRoot,
        pythonVenv,
      ),
  };
}
module.exports = { createReadinessProofFixture, sha };
