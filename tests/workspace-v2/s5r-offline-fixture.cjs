const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const load = require('../../test/helpers/load-security-module.cjs');
const projectRoot = path.resolve(__dirname, '../..');
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function loadModules(dataRoot) {
  const cache = new Map();
  const config = { rootPath: projectRoot, dataPath: dataRoot };
  const mocks = { '../config': { __esModule: true, default: config } };
  const module = (file) => load(path.join(projectRoot, file), mocks, cache);
  return {
    Store: module('back/services/runtimeArtifacts.ts')
      .VerifiedRuntimeArtifactStore,
    scope: module('back/services/runtimeDomainScope.ts'),
    module,
  };
}
async function makeArchive(file, kind = 'valid') {
  const code = [
    'import io,sys,tarfile',
    'name,kind=sys.argv[1:]',
    'with tarfile.open(name,"w:gz") as out:',
    ' m=tarfile.TarInfo("package/ok.txt");m.size=8;out.addfile(m,io.BytesIO(b"verified"))',
    ' if kind=="traversal":',
    '  m=tarfile.TarInfo("package/../escaped");m.size=3;out.addfile(m,io.BytesIO(b"bad"))',
    ' if kind=="symlink":',
    '  m=tarfile.TarInfo("package/link");m.type=tarfile.SYMTYPE;m.linkname="../../escaped";out.addfile(m)',
    ' if kind in ("directory-link","link-ancestor","link-chain"):',
    '  m=tarfile.TarInfo("package/dir");m.type=tarfile.DIRTYPE;out.addfile(m)',
    '  m=tarfile.TarInfo("package/dir/data.txt");m.size=4;out.addfile(m,io.BytesIO(b"safe"))',
    '  m=tarfile.TarInfo("package/link");m.type=tarfile.SYMTYPE;m.linkname="dir";out.addfile(m)',
    ' if kind=="link-ancestor":',
    '  m=tarfile.TarInfo("package/link/written.txt");m.size=3;out.addfile(m,io.BytesIO(b"bad"))',
    ' if kind=="link-chain":',
    '  m=tarfile.TarInfo("package/chain");m.type=tarfile.SYMTYPE;m.linkname="link";out.addfile(m)',
  ].join('\n');
  const result = spawnSync(
    '/usr/bin/python3',
    ['-I', '-S', '-c', code, file, kind],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw Error(result.stderr);
}
async function writeFixture(f, approve = true) {
  const bytes = Buffer.from(JSON.stringify(f.manifest, null, 2) + '\n');
  await fs.writeFile(f.options.manifestPath, bytes, { mode: 0o600 });
  if (approve)
    await fs.writeFile(
      f.options.trustAnchorPath,
      JSON.stringify({
        schema: 1,
        authority: 'S5R_SYNTHETIC_SECURITY_TEST_ONLY_NOT_RUNTIME_PROVENANCE',
        approved_manifest_sha256: [sha256(bytes)],
      }) + '\n',
      { mode: 0o600 },
    );
}
async function createOfflineFixture(t, options = {}) {
  const parent = process.env.ZHIXU_S5R_EVIDENCE_ROOT || os.tmpdir();
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(parent, 's5r-offline-'));
  const dataRoot = path.join(root, 'data'),
    packageRoot = path.join(root, 'package');
  for (const p of [
    dataRoot,
    packageRoot,
    path.join(packageRoot, 'objects'),
    path.join(root, 'trust'),
  ])
    await fs.mkdir(p, { mode: 0o700 });
  const temporary = path.join(root, 'input.tgz');
  await makeArchive(temporary, options.archive);
  const bytes = await fs.readFile(temporary),
    digest = sha256(bytes);
  await fs.rename(temporary, path.join(packageRoot, 'objects', digest));
  const manifest = {
    schema: 1,
    release_id: 'synthetic-security-test',
    os: process.platform,
    architecture: process.arch,
    created_at: '2026-11-14T00:00:00.000Z',
    artifacts: [
      {
        id: 'test-package',
        provider: 'SYNTHETIC_TEST_ONLY',
        publisher: 'synthetic test fixture',
        source_url:
          'https://registry.npmjs.org/s5r-synthetic/-/s5r-synthetic-1.0.0.tgz',
        version: '1.0.0',
        os: 'any',
        architecture: 'any',
        format: 'tar.gz',
        prefix: 'package',
        sha256: digest,
        size: bytes.length,
        signature_status: 'SIGNATURE_NOT_AVAILABLE',
        acquisition: 'UPSTREAM_BYTES',
      },
    ],
    node: [
      { version: '24.22.3', archive: 'test-package', npm: 'test-package' },
    ],
    python: [],
    npm: [],
  };
  const f = {
    root,
    dataRoot,
    packageRoot,
    manifest,
    options: {
      mode: 'OFFLINE_VERIFIED',
      storeRoot: path.join(root, 'artifact-store'),
      trustAnchorPath: path.join(root, 'trust', 'allowlist.json'),
      manifestPath: path.join(packageRoot, 'manifest.json'),
    },
  };
  const st = await fs.lstat(root);
  await fs.writeFile(
    path.join(root, '.test-owner.json'),
    JSON.stringify({
      stage: 'S5R',
      nonce: randomUUID(),
      uid: process.getuid?.(),
      dev: st.dev,
      ino: st.ino,
      test: t?.name || 'child',
    }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await writeFixture(f);
  Object.assign(f, loadModules(dataRoot));
  f.open = () => f.Store.open(f.options, dataRoot);
  return f;
}
async function spawnImporter(f) {
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, 's5r-offline-import-worker.cjs'),
      JSON.stringify({
        options: f.options,
        dataRoot: f.dataRoot,
        packageRoot: f.packageRoot,
      }),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b;
  });
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const completed = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error('IMPORT_CHECKPOINT_NOT_REACHED:' + stderr)),
      10000,
    );
    child.stdout.on('data', () => {
      if (stdout.includes('VERIFIED_SOURCE')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!stdout.includes('VERIFIED_SOURCE'))
        reject(Error('IMPORT_CHILD_EXIT:' + code + ':' + stderr));
    });
  });
  await ready;
  return { child, completed, output: () => ({ stdout, stderr }) };
}
module.exports = {
  createOfflineFixture,
  writeFixture,
  sha256,
  loadModules,
  spawnImporter,
  projectRoot,
};
