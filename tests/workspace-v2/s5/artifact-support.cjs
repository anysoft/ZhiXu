// S5 reads only explicit compiled candidate artifacts. No source/module-loader substitution.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const sha256 = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
let initialIdentity;
function releaseRoot() {
  if (![22, 24].includes(Number(process.versions.node.split('.')[0])))
    throw Error('S5_SUPPORTED_APPLICATION_NODE_REQUIRED');
  if (
    process.env.ZHIXU_S5_NODE_BIN &&
    fs.realpathSync(process.env.ZHIXU_S5_NODE_BIN) !==
      fs.realpathSync(process.execPath)
  )
    throw Error('S5_APPLICATION_NODE_IDENTITY_MISMATCH');
  const value = process.env.ZHIXU_S5_RELEASE_ROOT;
  if (
    !value ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    fs.realpathSync(value) !== value
  )
    throw Error('S5_EXPLICIT_CANONICAL_RELEASE_ROOT_REQUIRED');
  const packageFile = path.join(value, 'package.json');
  if (JSON.parse(fs.readFileSync(packageFile)).name !== '@anysoft/zhixu')
    throw Error('S5_RELEASE_PACKAGE_IDENTITY_INVALID');
  if (!/^[a-f0-9]{40}$/.test(process.env.ZHIXU_S5_CANDIDATE_SHA || ''))
    throw Error('S5_CANDIDATE_GIT_SHA_REQUIRED');
  return value;
}
function assetManifest(directory) {
  const rows = [];
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name),
        info = fs.lstatSync(file);
      if (info.isSymbolicLink()) throw Error('S5_ARTIFACT_SYMLINK_FORBIDDEN');
      if (info.isDirectory()) visit(file);
      else {
        if (!info.isFile() || info.nlink !== 1)
          throw Error('S5_ARTIFACT_NOT_REGULAR');
        const bytes = fs.readFileSync(file);
        rows.push({
          path: path.relative(directory, file).split(path.sep).join('/'),
          bytes: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
  }
  visit(directory);
  return {
    files: rows,
    file_count: rows.length,
    bytes: rows.reduce((n, row) => n + row.bytes, 0),
    sha256: sha256(JSON.stringify(rows)),
  };
}
function candidateIdentity() {
  const root = releaseRoot();
  const backend = assetManifest(path.join(root, 'static/build'));
  const frontend = assetManifest(path.join(root, 'static/dist-v2'));
  for (const [key, actual] of [
    ['ZHIXU_S5_BACKEND_MANIFEST_SHA256', backend.sha256],
    ['ZHIXU_S5_FRONTEND_MANIFEST_SHA256', frontend.sha256],
  ])
    if (process.env[key] && process.env[key] !== actual)
      throw Error('S5_EXPECTED_ARTIFACT_HASH_MISMATCH');
  const identity = {
    candidate_git_sha: process.env.ZHIXU_S5_CANDIDATE_SHA,
    backend_manifest_sha256: backend.sha256,
    frontend_manifest_sha256: frontend.sha256,
    backend_file_count: backend.file_count,
    frontend_file_count: frontend.file_count,
    application_node: process.version,
    application_node_sha256: sha256(fs.readFileSync(process.execPath)),
    platform: process.platform,
    architecture: process.arch,
    kernel: os.release(),
    execution_environment: process.env.ZHIXU_S5_EXECUTION_KIND || 'UNDECLARED',
    compiled_application: true,
    source_modules_loaded_as_application: false,
  };
  if (
    initialIdentity &&
    JSON.stringify(identity) !== JSON.stringify(initialIdentity)
  )
    throw Error('S5_ARTIFACT_CHANGED_DURING_QUALIFICATION');
  initialIdentity ??= identity;
  return identity;
}
function artifactModule(moduleName) {
  if (
    !/^[A-Za-z0-9_/-]+$/.test(moduleName) ||
    moduleName.split('/').includes('..')
  )
    throw Error('S5_INVALID_ARTIFACT_MODULE');
  const root = releaseRoot();
  // Keep any accidental v9 global default inaccessible before application imports.
  process.env.QL_DIR = root;
  process.env.QL_DATA_DIR = '/dev/null';
  process.env.JWT_SECRET ??= crypto.randomBytes(64).toString('hex');
  const base = path.join(root, 'static/build');
  const file = path.join(base, moduleName + '.js');
  if (!fs.realpathSync(file).startsWith(base + path.sep))
    throw Error('S5_ARTIFACT_MODULE_ESCAPE');
  return require(file);
}
function git(args, directory) {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function createS5Fixture(t, { caseId = 'S5-CASE' } = {}) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(caseId)) throw Error('S5_INVALID_CASE_ID');
  const identity = candidateIdentity();
  const root = await fsp.mkdtemp(
    path.join(await fsp.realpath(os.tmpdir()), 's5-'),
  );
  await fsp.chmod(root, 0o700);
  const info = await fsp.lstat(root);
  const marker = {
    version: 1,
    purpose: 'S5_CANDIDATE_TEST',
    root,
    dev: info.dev,
    ino: info.ino,
    token: crypto.randomUUID(),
    case_id: caseId,
  };
  await fsp.writeFile(
    path.join(root, '.s5-case-owner.json'),
    JSON.stringify(marker),
    { mode: 0o600, flag: 'wx' },
  );
  const evidenceRoot = path.join(root, 'evidence');
  await fsp.mkdir(evidenceRoot, { mode: 0o700 });
  const secrets = [],
    instances = [];
  let sequence = 0;
  function redact(value) {
    if (typeof value === 'string') {
      for (const secret of secrets)
        value = value.split(secret).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, redact(entry)]),
      );
    return value;
  }
  const scenario = {
    root,
    evidenceRoot,
    projectRoot: releaseRoot(),
    identity,
    registerSecret(value) {
      if (typeof value === 'string' && value) secrets.push(value);
    },
    async record(id, details = {}) {
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(id))
        throw Error('S5_INVALID_EVIDENCE_ID');
      const proof = {
        case_id: id,
        recorded_at: new Date().toISOString(),
        status: 'OBSERVED',
        ...redact(details),
        candidate: identity,
      };
      const file = path.join(
        evidenceRoot,
        String(++sequence).padStart(3, '0') + '-' + id + '.json',
      );
      await fsp.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      return { file, evidence_sha256: sha256(await fsp.readFile(file)) };
    },
    async createInstance(name) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(name))
        throw Error('S5_INVALID_INSTANCE_NAME');
      const instanceRoot = path.join(root, 'instance-' + name);
      await fsp.mkdir(instanceRoot, { mode: 0o700 });
      const st = await fsp.lstat(instanceRoot);
      await fsp.writeFile(
        path.join(instanceRoot, '.s5-instance-owner.json'),
        JSON.stringify({
          version: 1,
          root: instanceRoot,
          caseRoot: root,
          dev: st.dev,
          ino: st.ino,
          token: crypto.randomUUID(),
        }),
        { mode: 0o600, flag: 'wx' },
      );
      const instance = {
        root: instanceRoot,
        dataRoot: path.join(instanceRoot, 'data'),
        backupRoot: path.join(instanceRoot, 'backups'),
        controlRoot: path.join(instanceRoot, 'data.platform-control'),
        projectRoot: releaseRoot(),
        async close() {},
      };
      instances.push(instance);
      // Deliberately do not create a database, model, schema, Runtime row or READY receipt.
      return instance;
    },
    async close() {
      for (const instance of instances) await instance.close();
    },
  };
  process.stdout.write('S5 retained scenario: ' + root + '\n');
  await scenario.record('S5-CANDIDATE-IDENTITY', {
    status: 'IDENTIFIED',
    case_id: caseId,
    artifact_root_identity_sha256: sha256(
      JSON.stringify({
        dev: fs.statSync(releaseRoot()).dev,
        ino: fs.statSync(releaseRoot()).ino,
      }),
    ),
  });
  if (t) t.after(() => scenario.close());
  return scenario;
}
async function assertOwnedInstance(root) {
  const st = await fsp.lstat(root);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.mode & 0o077 ||
    st.uid !== process.getuid() ||
    (await fsp.realpath(root)) !== root
  )
    throw Error('S5_INSTANCE_NOT_OWNED');
  const file = path.join(root, '.s5-instance-owner.json'),
    markerStat = await fsp.lstat(file);
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.nlink !== 1 ||
    markerStat.uid !== process.getuid()
  )
    throw Error('S5_INSTANCE_MARKER_INVALID');
  const marker = JSON.parse(await fsp.readFile(file));
  if (
    marker.root !== root ||
    marker.dev !== st.dev ||
    marker.ino !== st.ino ||
    marker.caseRoot !== path.dirname(root)
  )
    throw Error('S5_INSTANCE_IDENTITY_MISMATCH');
  const parent = await fsp.lstat(marker.caseRoot);
  const proof = JSON.parse(
    await fsp.readFile(path.join(marker.caseRoot, '.s5-case-owner.json')),
  );
  if (
    proof.root !== marker.caseRoot ||
    proof.dev !== parent.dev ||
    proof.ino !== parent.ino ||
    proof.purpose !== 'S5_CANDIDATE_TEST'
  )
    throw Error('S5_CASE_IDENTITY_MISMATCH');
  return marker;
}
async function startArtifactCli(
  scenario,
  dataRoot,
  initialize = false,
  extra = [],
) {
  const root = releaseRoot();
  const startupStarted = process.hrtime.bigint();
  const child = spawn(
    process.execPath,
    [
      path.join(root, 'static/build/appV2.js'),
      '--data-root',
      dataRoot,
      '--port',
      '0',
      ...(initialize ? ['--initialize'] : []),
      ...extra,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        QL_DATA_DIR: path.join(scenario.root, 'forbidden-v9-root'),
        JWT_SECRET: 'unused-private-candidate-legacy-guard',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let partial = '',
    resolved = false,
    startupDuration;
  const safeErrors = [];
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(Error('S5_CLI_STARTUP_DEADLINE'));
    }, 90000);
    child.stdout.on('data', (bytes) => {
      partial += bytes.toString();
      for (;;) {
        const boundary = partial.indexOf('\n');
        if (boundary < 0) break;
        const line = partial.slice(0, boundary);
        partial = partial.slice(boundary + 1);
        try {
          const row = JSON.parse(line);
          if (row.event === 'V2_HTTP_READY' && !resolved) {
            startupDuration =
              Number(process.hrtime.bigint() - startupStarted) / 1e6;
            clearTimeout(timer);
            resolved = true;
            resolve(row);
          }
        } catch {}
      }
    });
    child.stderr.on('data', (bytes) => {
      for (const line of bytes.toString().split('\n'))
        try {
          const row = JSON.parse(line);
          if (row.event === 'V2_STARTUP_FAILED') safeErrors.push(row);
        } catch {}
    });
    child.once('exit', (code, signal) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(
          Object.assign(Error('S5_CLI_STARTUP_REJECTED'), {
            safeErrors,
            code,
            signal,
          }),
        );
      }
    });
  });
  return {
    child,
    info,
    exited,
    startup_duration_ms: startupDuration,
    origin: 'http://127.0.0.1:' + info.port,
    async stop(signal = 'SIGTERM') {
      child.kill(signal);
      let timeout;
      try {
        return await Promise.race([
          exited,
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              child.kill('SIGKILL');
              reject(Error('S5_CLI_SHUTDOWN_DEADLINE'));
            }, 30000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
module.exports = {
  releaseRoot,
  candidateIdentity,
  assetManifest,
  artifactModule,
  createS5Fixture,
  assertOwnedInstance,
  git,
  startArtifactCli,
  sha256,
};
