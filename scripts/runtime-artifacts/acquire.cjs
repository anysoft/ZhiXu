'use strict';
// Run only in an administrator-controlled acquisition environment. This tool
// never reads a package-supplied manifest or manufactures trust during import.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { runtimeTreeDigest } = require('../release-v2/runtime-tree.cjs');
const NODE = '24.22.3',
  NPM = '11.21.2',
  PNPM = '10.34.9',
  TSX = '4.23.15',
  ESBUILD = '0.28.2';
const PYTHON = '3.13.15',
  PYENV = 'c293de3650a2d08ea36c5f6f0d55c5a3841b0c72';
const SOURCE = 'https://github.com/pyenv/pyenv.git';
const projectRoot = path.resolve(__dirname, '../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fetchBytes(url, maximum = 512 * 1024 * 1024, directory) {
  const u = new URL(url);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.search ||
    ![
      'nodejs.org',
      'registry.npmjs.org',
      'www.python.org',
      'github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
      'ftp.gnu.org',
      'curl.se',
      'zlib.net',
      'sqlite.org',
      'pypi.org',
      'files.pythonhosted.org',
    ].includes(u.hostname)
  )
    throw Error('ACQUISITION_SOURCE_NOT_CURATED:' + u.origin);
  // Match the production Provider's TLS-verified transport. -q is the first
  // option, so neither the host HOME nor a user curl configuration is read.
  if (!directory) throw Error('ACQUISITION_PRIVATE_DOWNLOAD_ROOT_REQUIRED');
  const file = path.join(directory, sha(Buffer.from(url)) + '.part'),
    observations = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await fs.lstat(file).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
    if (
      before &&
      (!before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > maximum)
    )
      throw Error('ACQUISITION_CACHE_PATH_INVALID');
    const r = spawnSync(
      '/usr/bin/curl',
      [
        '-q',
        '--http1.1',
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--max-redirs',
        '3',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--connect-timeout',
        '20',
        '--max-time',
        '180',
        '--max-filesize',
        String(maximum),
        '--continue-at',
        '-',
        '--output',
        file,
        url,
      ],
      {
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: '/dev/null',
          CURL_HOME: '/dev/null',
        },
        maxBuffer: 1024 * 1024,
        timeout: 190000,
      },
    );
    const after = await fs.lstat(file).catch(() => null);
    observations.push({
      attempt: attempt + 1,
      curl_exit_code: r.status,
      previous_bytes: before?.size ?? 0,
      bytes: after?.size ?? null,
      error: String(r.stderr || '').slice(-1000),
    });
    await fs.writeFile(
      file + '.transport.json',
      JSON.stringify(
        {
          source_url: url,
          bounded_attempts: 3,
          per_attempt_seconds: 180,
          tls_verification_disabled: false,
          observations,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    if (after && after.size > maximum) throw Error('ACQUISITION_SIZE_LIMIT');
    if (!r.error && r.status === 0 && after) return fs.readFile(file);
    if (
      ![18, 28, 56].includes(r.status) ||
      !after ||
      after.size <= (before?.size ?? 0)
    )
      throw Error(
        'ACQUISITION_HTTPS_FAILED:' + u.hostname + u.pathname + ':' + r.status,
      );
  }
  throw Error(
    'ACQUISITION_BOUNDED_DOWNLOAD_EXHAUSTED:' + u.hostname + u.pathname,
  );
}
function run(program, args, cwd, env, outputFile) {
  const r = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600000,
  });
  if (outputFile)
    require('node:fs').writeFileSync(
      outputFile,
      (r.stdout || '') + (r.stderr || ''),
      { mode: 0o600 },
    );
  if (r.error || r.status !== 0)
    throw Error(
      'ACQUISITION_COMMAND_FAILED:' +
        program +
        ':' +
        r.status +
        ':' +
        (r.stderr || '').slice(-2000),
    );
  return r.stdout;
}
async function record(c, bytes, entry) {
  const digest = sha(bytes),
    found = c.manifest.artifacts.find((a) => a.sha256 === digest);
  if (found) return found.id;
  const file = path.join(c.packageRoot, 'objects', digest);
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o400 });
  const result = {
    ...entry,
    os: entry.os || 'any',
    architecture: entry.architecture || 'any',
    sha256: digest,
    size: bytes.length,
    signature_status: entry.signature_status || 'SIGNATURE_NOT_VERIFIED',
  };
  c.manifest.artifacts.push(result);
  return result.id;
}
async function metadata(c, name, version) {
  const key = name + '@' + version;
  if (c.metadata.has(key)) return c.metadata.get(key);
  const url =
    'https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + version;
  const bytes = await fetchBytes(url, 8 * 1024 * 1024, c.downloads),
    value = JSON.parse(bytes);
  if (
    value.name !== name ||
    value.version !== version ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.dist?.integrity || '')
  )
    throw Error('REGISTRY_METADATA_INVALID:' + key);
  const tarball = await fetchBytes(value.dist.tarball, undefined, c.downloads);
  if (
    'sha512-' + createHash('sha512').update(tarball).digest('base64') !==
    value.dist.integrity
  )
    throw Error('REGISTRY_SRI_MISMATCH:' + key);
  const id = await record(c, tarball, {
    id: 'npm-' + name.replace(/[^a-zA-Z0-9._-]/g, '-') + '-' + version,
    provider: 'NPM_REGISTRY',
    publisher:
      'npm package ' +
      name +
      '; registry maintainers ' +
      (value.maintainers || [])
        .map((x) => x.name)
        .join(',')
        .slice(0, 300),
    source_url: value.dist.tarball,
    version,
    format: 'tar.gz',
    prefix: 'package',
    acquisition: 'UPSTREAM_BYTES',
    npm_name: name,
    npm_version: version,
    integrity: value.dist.integrity,
    provenance: {
      metadata_url: url,
      metadata_sha256: sha(bytes),
      source_verification: 'OFFICIAL_REGISTRY_HTTPS_AND_DIST_SHA512',
      registry_signatures_present:
        Array.isArray(value.dist.signatures) &&
        value.dist.signatures.length > 0,
      signatures_verified: false,
    },
  });
  const file = path.join(c.packageRoot, 'objects', sha(tarball));
  const extracted = path.join(
    c.work,
    'inspect-package-' + sha(Buffer.from(key)),
  );
  run(
    '/usr/bin/python3',
    [
      '-I',
      '-S',
      path.join(projectRoot, 'shell/runtime_artifact_archive.py'),
      'extract',
      file,
      'package',
      extracted,
    ],
    c.work,
    c.env,
  );
  const tree = await runtimeTreeDigest(extracted);
  const installed = JSON.parse(
    await fs.readFile(path.join(extracted, 'package.json'), 'utf8'),
  );
  if (installed.name !== name || installed.version !== version)
    throw Error('REGISTRY_ARCHIVE_IDENTITY_MISMATCH');
  const proof = c.manifest.artifacts.find((a) => a.id === id).provenance;
  Object.assign(proof, {
    tree_sha256: tree.sha256,
    tree_entry_count: tree.entry_count,
    tree_bytes: tree.bytes,
  });
  const cli =
    typeof installed.bin === 'string' ? installed.bin : installed.bin?.[name];
  if (cli) {
    const actual = await fs.realpath(path.resolve(extracted, cli));
    if (!actual.startsWith(extracted + path.sep))
      throw Error('REGISTRY_CLI_PATH_INVALID');
    Object.assign(proof, {
      cli_relative_path: cli,
      cli_sha256: sha(await fs.readFile(actual)),
    });
  }
  const result = { value, id, file, extracted };
  c.metadata.set(key, result);
  await fs.writeFile(
    path.join(
      c.work,
      'metadata-' +
        name.replace(/[^a-zA-Z0-9._-]/g, '-') +
        '-' +
        version +
        '.json',
    ),
    bytes,
    { mode: 0o600 },
  );
  return result;
}
function dependencyManifest(profile, manager = 'npm', version = NPM) {
  const dependencies = Object.create(null),
    devDependencies = Object.create(null);
  for (const dep of [...profile.dependencies].sort((a, b) =>
    a.name.localeCompare(b.name),
  ))
    (dep.type === 'DEV_DEPENDENCY' ? devDependencies : dependencies)[dep.name] =
      dep.specifier;
  return (
    JSON.stringify(
      {
        name: 'platform-environment',
        version: '0.0.0',
        private: true,
        packageManager: manager + '@' + version,
        dependencies,
        devDependencies,
      },
      null,
      2,
    ) + '\n'
  );
}
async function acquireNode(c) {
  const name = 'node-v' + NODE + '-' + c.os + '-' + c.arch + '.tar.xz';
  const checksums = await fetchBytes(
    'https://nodejs.org/dist/v' + NODE + '/SHASUMS256.txt',
    1024 * 1024,
    c.downloads,
  );
  const matches = checksums
    .toString()
    .split(/\r?\n/)
    .map((x) => x.match(/^([a-f0-9]{64})\s+\*?(.+)$/))
    .filter((x) => x && x[2] === name);
  if (matches.length !== 1) throw Error('OFFICIAL_NODE_CHECKSUM_MISSING');
  const url = 'https://nodejs.org/dist/v' + NODE + '/' + name,
    bytes = await sourceBytes(c, url, matches[0][1]);
  if (sha(bytes) !== matches[0][1])
    throw Error('OFFICIAL_NODE_CHECKSUM_MISMATCH');
  const id = await record(c, bytes, {
    id: 'node-' + NODE,
    provider: 'NODE_DISTRIBUTION',
    publisher: 'Node.js project (OpenJS Foundation)',
    source_url: url,
    version: NODE,
    os: c.os,
    architecture: c.arch,
    format: 'tar.xz',
    prefix: name.slice(0, -7),
    acquisition: 'UPSTREAM_BYTES',
    provenance: {
      checksum_source: 'https://nodejs.org/dist/v' + NODE + '/SHASUMS256.txt',
      checksum_file_sha256: sha(checksums),
      source_verification: 'OFFICIAL_PUBLISHER_HTTPS_SHA256',
      signatures_verified: false,
    },
  });
  const inspectedNode = path.join(c.work, 'inspect-official-node');
  run(
    '/usr/bin/python3',
    [
      '-I',
      '-S',
      path.join(projectRoot, 'shell/runtime_artifact_archive.py'),
      'extract',
      path.join(c.packageRoot, 'objects', sha(bytes)),
      name.slice(0, -7),
      inspectedNode,
    ],
    c.work,
    c.env,
  );
  c.manifest.artifacts.find((a) => a.id === id).provenance.executable_sha256 =
    sha(await fs.readFile(path.join(inspectedNode, 'bin/node')));
  const npm = await metadata(c, 'npm', NPM);
  await metadata(c, 'pnpm', PNPM);
  c.manifest.node.push({ version: NODE, archive: id, npm: npm.id });
  const staging = npm.extracted;
  c.npmCli = path.join(staging, 'bin/npm-cli.js');
  if (
    run(process.execPath, [c.npmCli, '--version'], c.work, c.env).trim() !== NPM
  )
    throw Error('TRUSTED_NPM_VERSION_INVALID');
}
async function sourceBytes(c, url, expected) {
  const name = path.posix.basename(new URL(url).pathname);
  let bytes;
  if (c.sourceCache) {
    const file = path.join(c.sourceCache, name),
      stat = await fs.lstat(file).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
        return null;
      });
    if (stat) {
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 512 * 1024 * 1024
      )
        throw Error('ACQUISITION_SOURCE_CACHE_INVALID');
      bytes = await fs.readFile(file);
    }
  }
  if (!bytes) bytes = await fetchBytes(url, undefined, c.downloads);
  if (sha(bytes) !== expected)
    throw Error('CURATED_PUBLISHER_SOURCE_CHECKSUM_MISMATCH:' + name);
  return bytes;
}
function inspectPipWheel(c, file) {
  const code = [
    'import zipfile,hashlib,json,sys,posixpath,stat',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' names=z.namelist()',
    ' if len(names)>20000 or len(names)!=len(set(names)):raise ValueError("wheel entries")',
    ' for i in z.infolist():',
    '  p=i.filename.rstrip("/")',
    '  if p.startswith("/") or "\\\\" in p or any(x in ("", ".", "..") for x in p.split("/")) or stat.S_ISLNK(i.external_attr>>16):raise ValueError("wheel path")',
    ' if z.testzip() is not None:raise ValueError("wheel crc")',
    ' print(json.dumps({"pip_init_sha256":hashlib.sha256(z.read("pip/__init__.py")).hexdigest(),"pip_vendor_manifest_sha256":hashlib.sha256(z.read("pip/_vendor/vendor.txt")).hexdigest()}))',
  ].join('\n');
  return JSON.parse(
    run('/usr/bin/python3', ['-I', '-S', '-c', code, file], c.work, c.env),
  );
}
async function acquisitionGit(c, applicationRoot, gitRoot) {
  const verifierFile = path.join(
    applicationRoot,
    'static/build/shared/nativeGitTools.js',
  );
  const verifierStat = await fs.lstat(verifierFile);
  if (
    !verifierStat.isFile() ||
    verifierStat.isSymbolicLink() ||
    verifierStat.nlink !== 1 ||
    verifierStat.mode & 0o022 ||
    ![0, process.getuid?.()].includes(verifierStat.uid)
  )
    throw Error('ACQUISITION_GIT_VERIFIER_UNPROTECTED');
  const verifierBytes = await fs.readFile(verifierFile);
  const { verifiedGitSshTools } = require(verifierFile);
  const tools = await verifiedGitSshTools(gitRoot);
  const manifestBytes = await fs.readFile(path.join(gitRoot, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const environment = {
    ...c.env,
    PATH: tools.binPath + ':' + c.env.PATH,
    GIT_EXEC_PATH: tools.execPath,
  };
  const version = run(tools.git, ['--version'], c.work, environment).trim();
  if (version !== 'git version ' + manifest.git_version)
    throw Error('ACQUISITION_GIT_VERSION_MISMATCH');
  c.gitTools = tools;
  c.gitEnvironment = environment;
  c.gitProof = {
    publisher: manifest.publisher,
    git_version: manifest.git_version,
    executable_sha256: manifest.files['bin/git'],
    native_tools_manifest_sha256: sha(manifestBytes),
    compiled_verifier_sha256: sha(verifierBytes),
    verifier: 'COMPILED_APPLICATION_VERIFIED_GIT_SSH_TOOLS',
    host_git_fallback: false,
  };
  await fs.writeFile(
    path.join(c.work, 'source-acquisition-git-tool.json'),
    JSON.stringify(c.gitProof, null, 2) + '\n',
    { mode: 0o600 },
  );
}
async function acquirePython(c) {
  if (!c.gitTools || !c.gitEnvironment)
    throw Error('VERIFIED_SOURCE_ACQUISITION_GIT_REQUIRED');
  const provider = path.join(c.work, 'pyenv-provider');
  await fs.mkdir(provider, { mode: 0o700 });
  const git = (args) =>
    run(
      c.gitTools.git,
      ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args],
      provider,
      c.gitEnvironment,
      path.join(c.work, 'pyenv-git-' + c.gitStep++ + '.log'),
    );
  git(['init', '--quiet', '--template=']);
  git(['fetch', '--depth=1', SOURCE, PYENV]);
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  if (
    git(['rev-parse', 'HEAD']).trim() !== PYENV ||
    git(['status', '--porcelain']).trim()
  )
    throw Error('PYENV_SOURCE_IDENTITY_INVALID');
  const archive = path.join(c.work, 'pyenv-provider.tar.gz');
  run(
    '/usr/bin/tar',
    ['-czf', archive, '-C', c.work, 'pyenv-provider'],
    c.work,
    { ...c.env, COPYFILE_DISABLE: '1' },
  );
  run(
    '/usr/bin/python3',
    [
      '-I',
      '-S',
      path.join(projectRoot, 'shell/runtime_artifact_archive.py'),
      'validate',
      archive,
      'pyenv-provider',
    ],
    c.work,
    c.env,
  );
  const providerId = await record(c, await fs.readFile(archive), {
    id: 'pyenv-source-' + PYENV,
    provider: 'PYENV',
    publisher:
      'pyenv community project; controlled source snapshot by ZhiXu acquisition',
    source_url: SOURCE,
    version: PYENV,
    format: 'tar.gz',
    prefix: 'pyenv-provider',
    acquisition: 'VERIFIED_SOURCE_SNAPSHOT',
    provenance: {
      git_commit: PYENV,
      source_verification: 'PINNED_UPSTREAM_GIT_COMMIT_AND_CLEAN_WORKTREE',
      git_signature_verified: false,
      source_acquisition_tool: c.gitProof,
    },
  });
  const originalDefinition = await fs.readFile(
    path.join(provider, 'plugins/python-build/share/python-build', PYTHON),
  );
  const pins = JSON.parse(
    await fs.readFile(path.join(__dirname, 'curated-python.json'), 'utf8'),
  );
  const definitionBytes = await fs.readFile(
    path.join(__dirname, pins.definition_file),
  );
  if (
    pins.python_version !== PYTHON ||
    pins.pyenv_revision !== PYENV ||
    sha(definitionBytes) !== pins.definition_sha256
  )
    throw Error('PYTHON_INDEPENDENT_DEFINITION_PIN_MISMATCH');
  const definition = definitionBytes.toString('utf8');
  const urls = [...definition.matchAll(/"(https:\/\/[^"#]+)#([a-f0-9]{64})"/g)];
  if (urls.length !== 6) throw Error('PYTHON_SOURCE_CLOSURE_REVIEW_REQUIRED');
  const sources = [];
  let openssl, zlib, sqlite;
  for (const [, original, expected] of urls) {
    const url = original.startsWith('https://ftpmirror.gnu.org/readline/')
      ? original.replace(
          'https://ftpmirror.gnu.org/readline/',
          'https://ftp.gnu.org/gnu/readline/',
        )
      : original;
    const bytes = await sourceBytes(c, url, expected);
    const sqliteSource = url.includes('sqlite.org');
    if (
      sqliteSource &&
      createHash('sha3-256').update(bytes).digest('hex') !==
        pins.sqlite.publisher_checksum
    )
      throw Error('SQLITE_PUBLISHER_SHA3_256_MISMATCH');
    const name = path.posix.basename(new URL(url).pathname),
      prefix = name.replace(/\.tar\.xz$|\.tar\.gz$|\.tgz$/, '');
    const python = url.startsWith('https://www.python.org/');
    const id = await record(c, bytes, {
      id: 'python-input-' + name.replace(/[^a-zA-Z0-9._-]/g, '-'),
      provider: 'PYENV_PYTHON_BUILD_SOURCE',
      publisher: python
        ? 'Python Software Foundation / CPython project'
        : url.includes('openssl')
        ? 'OpenSSL Project'
        : url.includes('zlib')
        ? 'zlib project'
        : url.includes('sqlite.org')
        ? pins.sqlite.publisher
        : 'GNU Readline project / Free Software Foundation',
      source_url: url,
      version: python
        ? PYTHON
        : url.includes('openssl')
        ? pins.openssl.version
        : url.includes('zlib')
        ? pins.zlib.version
        : url.includes('sqlite.org')
        ? pins.sqlite.version
        : prefix,
      format: name.endsWith('.xz') ? 'tar.xz' : 'tar.gz',
      prefix,
      acquisition: 'UPSTREAM_BYTES',
      ...(sqliteSource
        ? { signature_status: pins.sqlite.signature_status }
        : {}),
      provenance: {
        definition_git_commit: PYENV,
        definition_sha256: pins.definition_sha256,
        definition_source_url: original,
        source_verification: sqliteSource
          ? 'OFFICIAL_PUBLISHER_SHA3_256_AND_INDEPENDENT_REVIEWED_ARCHIVE_SHA256'
          : 'PUBLISHER_SHA256_IN_INDEPENDENT_REVIEWED_PROJECT_DEFINITION',
        signatures_verified: false,
        ...(sqliteSource
          ? {
              sqlite_source_id: pins.sqlite.sqlite_source_id,
              publisher_checksum_algorithm:
                pins.sqlite.publisher_checksum_algorithm,
              publisher_checksum: pins.sqlite.publisher_checksum,
              publisher_checksum_url: pins.sqlite.publisher_checksum_url,
            }
          : {}),
      },
    });
    if (url.includes('openssl')) openssl = id;
    if (url.includes('zlib')) zlib = id;
    if (url.includes('sqlite.org')) sqlite = id;
    sources.push({ artifact: id, cache_name: name });
  }
  if (!openssl || !zlib || !sqlite)
    throw Error('PYTHON_CRYPTO_CLOSURE_INCOMPLETE');
  const definitionId = await record(c, definitionBytes, {
    id: 'zhixu-python-definition-' + PYTHON,
    provider: 'ZHIXU_PYTHON_BUILD_DEFINITION',
    publisher: pins.publisher,
    source_url: 'https://github.com/anysoft/ZhiXu',
    version: PYTHON,
    format: 'text',
    acquisition: 'VERIFIED_SOURCE_SNAPSHOT',
    signature_status: 'SIGNATURE_NOT_AVAILABLE',
    provenance: {
      source_verification: 'INDEPENDENT_REPOSITORY_REVIEWED_DEFINITION_SHA256',
      definition_sha256: pins.definition_sha256,
      base_pyenv_commit: PYENV,
      base_pyenv_definition_sha256: sha(originalDefinition),
      crypto_linkage_policy:
        'STATIC_PIC_APPROVED_OPENSSL_AND_ZLIB_NO_HOST_CRYPTO_FALLBACK',
    },
  });
  const ca = await sourceBytes(
    c,
    pins.ca_bundle.source_url,
    pins.ca_bundle.sha256,
  );
  const caId = await record(c, ca, {
    id: 'mozilla-curl-ca-' + pins.ca_bundle.version,
    provider: 'EXPLICIT_MOZILLA_CA_BUNDLE',
    publisher: pins.ca_bundle.publisher,
    source_url: pins.ca_bundle.source_url,
    version: pins.ca_bundle.version,
    format: 'text',
    acquisition: 'UPSTREAM_BYTES',
    provenance: {
      source_verification: 'DATED_CURL_MOZILLA_EXPORT_AND_PUBLISHER_SHA256',
      publisher_checksum_url: pins.ca_bundle.publisher_checksum_url,
      trust_scope: pins.ca_bundle.trust_scope,
      license: pins.ca_bundle.license,
    },
  });
  const pipMetadataBytes = await fetchBytes(
    pins.pip.metadata_url,
    4 * 1024 * 1024,
    c.downloads,
  );
  const pipMetadata = JSON.parse(pipMetadataBytes);
  const pipRows = pipMetadata.urls?.filter(
    (row) =>
      row.filename === pins.pip.wheel_filename &&
      row.url === pins.pip.source_url &&
      row.digests?.sha256 === pins.pip.sha256,
  );
  if (
    pipMetadata.info?.name !== 'pip' ||
    pipMetadata.info?.version !== pins.pip.version ||
    pipRows?.length !== 1
  )
    throw Error('OFFICIAL_PYPI_PIP_METADATA_MISMATCH');
  const pipBytes = await sourceBytes(c, pins.pip.source_url, pins.pip.sha256);
  const pipInspect = path.join(c.work, pins.pip.wheel_filename);
  await fs.writeFile(pipInspect, pipBytes, { flag: 'wx', mode: 0o400 });
  const pipProof = inspectPipWheel(c, pipInspect);
  const pipId = await record(c, pipBytes, {
    id: 'pypi-pip-' + pins.pip.version,
    provider: 'PYPI_PIP_WHEEL',
    publisher: pins.pip.publisher,
    source_url: pins.pip.source_url,
    version: pins.pip.version,
    format: 'binary',
    acquisition: 'UPSTREAM_BYTES',
    signature_status: pins.pip.signature_status,
    provenance: {
      wheel_filename: pins.pip.wheel_filename,
      metadata_url: pins.pip.metadata_url,
      metadata_sha256: sha(pipMetadataBytes),
      source_verification:
        'OFFICIAL_PYPI_RELEASE_SHA256_AND_INDEPENDENT_CURATED_PIN',
      signatures_verified: false,
      ...pipProof,
    },
  });
  c.manifest.python.push({
    version: PYTHON,
    provider_revision: PYENV,
    provider_archive: providerId,
    definition: definitionId,
    openssl,
    zlib,
    sqlite,
    ca_bundle: caId,
    pip_wheel: pipId,
    sources,
  });
}
async function acquireNpm(c, profiles) {
  const pins = JSON.parse(
    await fs.readFile(path.join(__dirname, 'curated-esbuild.json'), 'utf8'),
  );
  const pin = pins.targets?.find(
    (x) => x.os === c.os && x.architecture === c.arch,
  );
  if (
    pins.version !== ESBUILD ||
    !pin ||
    !/^[a-f0-9]{40}$/.test(pins.source_commit) ||
    !/^go1\.26\.11$/.test(pins.go_version)
  )
    throw Error('ESBUILD_INDEPENDENT_CURATED_PIN_MISSING');
  const binary = await fs.readFile(c.esbuildBinary);
  if (sha(binary) !== pin.sha256)
    throw Error('ESBUILD_INDEPENDENT_CURATED_PIN_MISMATCH');
  const overlay = await record(c, binary, {
    id: 'zhixu-esbuild-' + ESBUILD + '-' + c.os + '-' + c.arch,
    provider: 'ZHIXU_VERIFIED_ESBUILD_REBUILD',
    publisher: 'ZhiXu project controlled rebuild of evanw/esbuild',
    source_url: 'https://github.com/evanw/esbuild',
    version: ESBUILD,
    os: c.os,
    architecture: c.arch,
    format: 'binary',
    acquisition: 'VERIFIED_REBUILD',
    signature_status: 'SIGNATURE_NOT_AVAILABLE',
    provenance: {
      ...pins,
      targets: undefined,
      target: pin,
      source_verification:
        'INDEPENDENT_REVIEWED_REBUILD_PINS_IN_ACQUISITION_TOOL',
      curated_pins_sha256: sha(
        await fs.readFile(path.join(__dirname, 'curated-esbuild.json')),
      ),
    },
  });
  for (let index = 0; index < profiles.length; index++) {
    const profile = profiles[index],
      root = path.join(c.work, 'npm-profile-' + index);
    await fs.mkdir(root, { mode: 0o700 });
    const text = dependencyManifest(profile);
    await fs.writeFile(path.join(root, 'package.json'), text, { mode: 0o600 });
    run(
      process.execPath,
      [
        c.npmCli,
        'install',
        '--package-lock-only',
        '--lockfile-version=3',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org/',
      ],
      root,
      c.env,
      path.join(c.work, 'npm-profile-' + index + '.log'),
    );
    const lockBytes = await fs.readFile(path.join(root, 'package-lock.json')),
      lock = JSON.parse(lockBytes);
    const packages = [];
    let hasEsbuild = false;
    for (const [location, row] of Object.entries(lock.packages)) {
      if (!location) continue;
      if (
        row.optional &&
        ((row.os && !row.os.includes(c.os)) ||
          (row.cpu && !row.cpu.includes(c.arch)))
      )
        continue;
      const name =
        row.name || location.slice(location.lastIndexOf('node_modules/') + 13);
      const p = await metadata(c, name, row.version);
      if (
        row.integrity !== p.value.dist.integrity ||
        row.resolved !== p.value.dist.tarball
      )
        throw Error('REGISTRY_LOCK_SOURCE_MISMATCH');
      if (name === 'esbuild') {
        if (row.version !== ESBUILD)
          throw Error('ESBUILD_LOCK_PATCH_REVIEW_REQUIRED');
        hasEsbuild = true;
      }
      if (!packages.includes(p.id)) packages.push(p.id);
    }
    const lockId = await record(c, lockBytes, {
      id: 'npm-lock-' + index,
      provider: 'NPM_LOCK_CLOSURE',
      publisher: 'ZhiXu trusted acquisition using verified npm ' + NPM,
      source_url: 'https://registry.npmjs.org/',
      version: NPM,
      os: c.os,
      architecture: c.arch,
      format: 'json',
      acquisition: 'VERIFIED_SOURCE_SNAPSHOT',
      signature_status: 'SIGNATURE_NOT_AVAILABLE',
      provenance: {
        package_json_sha256: sha(Buffer.from(text)),
        resolver_npm_version: NPM,
        source_verification:
          'FRESH_PRIVATE_NPM_RESOLUTION_AND_EVERY_TARGET_TARBALL_REGISTRY_SRI',
      },
    });
    c.manifest.npm.push({
      runtime_version: NODE,
      npm_version: NPM,
      package_json_sha256: sha(Buffer.from(text)),
      lockfile: lockId,
      packages,
      ...(hasEsbuild
        ? {
            esbuild: {
              artifact: overlay,
              package_name: '@esbuild/' + c.os + '-' + c.arch,
              version: ESBUILD,
            },
          }
        : {}),
    });
  }
}
async function acquirePnpm(c, profiles) {
  const { load } = require('js-yaml');
  const pnpm = c.metadata.get('pnpm@' + PNPM);
  if (!pnpm) throw Error('VERIFIED_PNPM_ARTIFACT_REQUIRED');
  const cli = path.join(pnpm.extracted, 'bin/pnpm.cjs');
  if (run(process.execPath, [cli, '--version'], c.work, c.env).trim() !== PNPM)
    throw Error('VERIFIED_PNPM_VERSION_INVALID');
  c.manifest.pnpm = [];
  for (let index = 0; index < profiles.length; index++) {
    const root = path.join(c.work, 'pnpm-profile-' + index);
    await fs.mkdir(root, { mode: 0o700 });
    const text = dependencyManifest(profiles[index], 'pnpm', PNPM);
    await fs.writeFile(path.join(root, 'package.json'), text, { mode: 0o600 });
    run(
      process.execPath,
      [
        cli,
        'install',
        '--lockfile-only',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--config.manage-package-manager-versions=false',
        '--config.registry=https://registry.npmjs.org/',
        '--reporter=append-only',
      ],
      root,
      c.env,
      path.join(c.work, 'pnpm-profile-' + index + '.log'),
    );
    const bytes = await fs.readFile(path.join(root, 'pnpm-lock.yaml')),
      lock = load(bytes.toString());
    if (String(lock?.lockfileVersion) !== '9.0')
      throw Error('PNPM_LOCK_FORMAT_REVIEW_REQUIRED');
    const packages = [];
    let hasEsbuild = false;
    for (const [key, row] of Object.entries(lock.packages || {})) {
      if (
        (row.os && !row.os.includes(c.os)) ||
        (row.cpu && !row.cpu.includes(c.arch))
      )
        continue;
      const at = key.lastIndexOf('@'),
        name = key.slice(0, at),
        version = key.slice(at + 1);
      if (at <= 0 || row.resolution?.tarball)
        throw Error('PNPM_LOCK_SOURCE_NOT_REGISTRY');
      const p = await metadata(c, name, version);
      if (row.resolution?.integrity !== p.value.dist.integrity)
        throw Error('PNPM_REGISTRY_LOCK_SRI_MISMATCH');
      if (name === 'esbuild') {
        if (version !== ESBUILD)
          throw Error('ESBUILD_LOCK_PATCH_REVIEW_REQUIRED');
        hasEsbuild = true;
      }
      if (!packages.includes(p.id)) packages.push(p.id);
    }
    const lockId = await record(c, bytes, {
      id: 'pnpm-lock-' + index,
      provider: 'PNPM_LOCK_CLOSURE',
      publisher: 'ZhiXu trusted acquisition using verified pnpm ' + PNPM,
      source_url: 'https://registry.npmjs.org/',
      version: PNPM,
      os: c.os,
      architecture: c.arch,
      format: 'text',
      acquisition: 'VERIFIED_SOURCE_SNAPSHOT',
      signature_status: 'SIGNATURE_NOT_AVAILABLE',
      provenance: {
        package_json_sha256: sha(Buffer.from(text)),
        resolver_pnpm_version: PNPM,
        source_verification:
          'FRESH_PRIVATE_PNPM_RESOLUTION_AND_EVERY_TARGET_TARBALL_REGISTRY_SRI',
        supported_mode: 'ONLINE_VERIFIED',
      },
    });
    const overlay = c.manifest.artifacts.find(
      (a) => a.provider === 'ZHIXU_VERIFIED_ESBUILD_REBUILD',
    );
    c.manifest.pnpm.push({
      runtime_version: NODE,
      pnpm_version: PNPM,
      toolchain: pnpm.id,
      package_json_sha256: sha(Buffer.from(text)),
      lockfile: lockId,
      packages,
      ...(hasEsbuild
        ? {
            esbuild: {
              artifact: overlay.id,
              package_name: '@esbuild/' + c.os + '-' + c.arch,
              version: ESBUILD,
            },
          }
        : {}),
    });
  }
}
async function main(args = process.argv.slice(2)) {
  const v = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    if (
      ![
        '--output-root',
        '--os',
        '--arch',
        '--esbuild-binary',
        '--profiles',
        '--components',
        '--source-cache',
        '--application-root',
        '--git-tools',
      ].includes(args[i]) ||
      v[args[i]] ||
      !args[i + 1]
    )
      throw Error('ACQUISITION_ARGUMENT_INVALID');
    v[args[i]] = args[i + 1];
  }
  if (
    !path.isAbsolute(v['--output-root'] || '') ||
    !['linux', 'darwin'].includes(v['--os']) ||
    !['x64', 'arm64'].includes(v['--arch']) ||
    !path.isAbsolute(v['--esbuild-binary'] || '')
  )
    throw Error('ACQUISITION_ARGUMENT_INVALID');
  if (v['--components'] && !['node', 'all'].includes(v['--components']))
    throw Error('ACQUISITION_ARGUMENT_INVALID');
  if (v['--source-cache'] && !path.isAbsolute(v['--source-cache']))
    throw Error('ACQUISITION_ARGUMENT_INVALID');
  for (const key of ['--application-root', '--git-tools'])
    if (v[key] && (!path.isAbsolute(v[key]) || path.resolve(v[key]) !== v[key]))
      throw Error('ACQUISITION_ARGUMENT_INVALID');
  const root = v['--output-root'];
  await fs.mkdir(root, { mode: 0o700 });
  const st = await fs.lstat(root);
  await fs.writeFile(
    path.join(root, '.acquisition-owner.json'),
    JSON.stringify({
      owner: 'zhixu-trusted-runtime-acquisition',
      nonce: randomUUID(),
      uid: process.getuid?.(),
      dev: st.dev,
      ino: st.ino,
    }) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  const work = path.join(root, 'work'),
    packageRoot = path.join(root, 'package'),
    home = path.join(work, 'home'),
    downloads = path.join(work, 'downloads');
  for (const p of [
    work,
    packageRoot,
    path.join(packageRoot, 'objects'),
    path.join(root, 'trust'),
    home,
    downloads,
  ])
    await fs.mkdir(p, { mode: 0o700 });
  const c = {
    work,
    downloads,
    packageRoot,
    os: v['--os'],
    arch: v['--arch'],
    esbuildBinary: v['--esbuild-binary'],
    metadata: new Map(),
    gitStep: 0,
    manifest: {
      schema: 1,
      release_id: 'zhixu-curated-' + NODE + '-' + v['--os'] + '-' + v['--arch'],
      os: v['--os'],
      architecture: v['--arch'],
      created_at: new Date().toISOString(),
      artifacts: [],
      node: [],
      python: [],
      npm: [],
    },
    env: {
      PATH:
        path.dirname(process.execPath) +
        ':/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
      HOME: home,
      TMPDIR: work,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'https',
      npm_config_userconfig: path.join(home, 'user.npmrc'),
      npm_config_globalconfig: path.join(home, 'global.npmrc'),
      npm_config_cache: path.join(work, 'npm-cache'),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    },
  };
  c.sourceCache = v['--source-cache'];
  await acquireNode(c);
  if (v['--components'] !== 'node') {
    const applicationRoot = v['--application-root'] ?? projectRoot;
    await acquisitionGit(
      c,
      applicationRoot,
      v['--git-tools'] ?? path.join(applicationRoot, 'bin/git-tools'),
    );
    await acquirePython(c);
  }
  const profiles = v['--profiles']
    ? JSON.parse(await fs.readFile(v['--profiles'], 'utf8'))
    : [
        { dependencies: [] },
        {
          dependencies: [
            { name: 'is-number', specifier: '7.0.0', type: 'DEPENDENCY' },
            { name: 'tsx', specifier: TSX, type: 'DEPENDENCY' },
          ],
        },
      ];
  await acquireNpm(c, profiles);
  await acquirePnpm(c, profiles);
  const manifestBytes = Buffer.from(JSON.stringify(c.manifest, null, 2) + '\n');
  await fs.writeFile(path.join(packageRoot, 'manifest.json'), manifestBytes, {
    mode: 0o400,
    flag: 'wx',
  });
  const anchor = {
    schema: 1,
    authority:
      'ZhiXu independently controlled curated acquisition; operator must review and protect this external allowlist',
    approved_manifest_sha256: [sha(manifestBytes)],
  };
  await fs.writeFile(
    path.join(root, 'trust/approved-manifests.json'),
    JSON.stringify(anchor, null, 2) + '\n',
    { mode: 0o400, flag: 'wx' },
  );
  await fs.writeFile(
    path.join(root, 'acquisition-receipt.json'),
    JSON.stringify(
      {
        status: 'ACQUIRED_AND_SOURCE_VERIFIED_NOT_A_RUNTIME_INSTALL',
        manifest_sha256: sha(manifestBytes),
        artifact_count: c.manifest.artifacts.length,
        artifact_bytes: c.manifest.artifacts.reduce((n, a) => n + a.size, 0),
        target: c.os + '-' + c.arch,
        acquisition_node: process.version,
        signatures_not_implicitly_verified: true,
        anchor_transport_requires_independent_administrator_control: true,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      status: 'ACQUIRED_AND_SOURCE_VERIFIED',
      manifest_sha256: sha(manifestBytes),
      artifact_count: c.manifest.artifacts.length,
    }) + '\n',
  );
}
if (require.main === module)
  main().catch((error) => {
    process.stderr.write(String(error.stack || error) + '\n');
    process.exitCode = 1;
  });
module.exports = { main, dependencyManifest };
