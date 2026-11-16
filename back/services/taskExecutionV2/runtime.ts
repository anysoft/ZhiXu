import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type { ExecutionContext } from '../../shared/execution';
import type { RuntimeInstallation, RuntimeProvider } from '../../data/runtime';
import type {
  PythonEnvironmentBuild,
  PythonEnvironment,
} from '../../data/pythonEnvironment';
import type {
  NodeEnvironment,
  NodeEnvironmentBuild,
  NodePackageManagerToolchain,
} from '../../data/nodeEnvironment';
import RuntimePathResolver from '../runtimePaths';
import PythonEnvironmentPathResolver from '../pythonEnvironmentPaths';
import NodePathResolver, { nodeHash } from '../nodePaths';
import { RuntimeLease } from '../runtimeProcess';
import { openRegular } from '../backup/files';
import { WorkspaceStore } from '../workspaceV2/store';
import { fail, positiveId } from '../workspaceV2/errors';
import { VerifiedRuntimeArtifactStore } from '../runtimeArtifacts';
import { runtimeArtifactsFor } from '../runtimeArtifactScope';
import { runtimeTreeDigest } from '../runtimeTreeWitness';

export interface PhysicalRuntimeSelection {
  kind: 'PYTHON' | 'NODE' | 'SHELL';
  environmentId: number | null;
}
export type ManagedRuntimeSnapshot = ExecutionContext['runtime'] & {
  providerId?: number;
  providerRevision?: string;
  runtimeVersion?: string;
  environmentVersion?: number;
  toolchainVersion?: string;
};
type JsonRow<T> = Omit<T, 'metadata'> & { metadata: unknown };
function metadata(value: unknown): Record<string, unknown> {
  let decoded = value;
  if (typeof value === 'string') {
    try {
      decoded = JSON.parse(value);
    } catch {
      fail('RUNTIME_NOT_READY');
    }
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    fail('RUNTIME_NOT_READY');
  return decoded as Record<string, unknown>;
}
function array<T>(value: unknown): T[] {
  let decoded = value;
  if (typeof value === 'string') {
    try {
      decoded = JSON.parse(value);
    } catch {
      fail('RUNTIME_NOT_READY');
    }
  }
  if (!Array.isArray(decoded)) fail('RUNTIME_NOT_READY');
  return decoded as T[];
}

/** Explicit fresh-v2 database, real managed paths and original runtime lease inodes. */
export class ManagedRuntimeAdapter {
  readonly paths: RuntimePathResolver;
  readonly python: PythonEnvironmentPathResolver;
  readonly node: NodePathResolver;
  constructor(
    readonly store: WorkspaceStore,
    private readonly approvedArtifacts?: VerifiedRuntimeArtifactStore,
  ) {
    this.paths = new RuntimePathResolver(store.dataRoot);
    this.python = new PythonEnvironmentPathResolver(this.paths);
    this.node = new NodePathResolver(store.dataRoot);
  }

  private artifactPolicy() {
    // Services are constructed before the Runtime domain is opened. Resolve
    // immutable boot configuration lazily for this exact database owner.
    const bound = runtimeArtifactsFor(this.store);
    if (bound && this.approvedArtifacts && bound !== this.approvedArtifacts)
      fail('RUNTIME_NOT_READY');
    const artifacts = this.approvedArtifacts ?? bound;
    // No explicit policy means standard online installation, with managed path,
    // ownership, executable and build checks still enforced below.
    if (!artifacts) return undefined;
    if (
      !(artifacts instanceof VerifiedRuntimeArtifactStore) ||
      !Object.isFrozen(artifacts) ||
      artifacts.dataRoot !== this.store.dataRoot
    )
      fail('RUNTIME_NOT_READY');
    return artifacts;
  }

  private approvedProvenance(
    artifacts: VerifiedRuntimeArtifactStore,
    value: unknown,
    id: string,
  ) {
    const proof = metadata(value),
      approved = artifacts.artifact(id);
    if (
      proof.manifest_sha256 !== artifacts.manifestSha256 ||
      proof.trust_anchor_sha256 !== artifacts.trustAnchorSha256 ||
      proof.trust_method !== 'INDEPENDENT_PREAPPROVED_MANIFEST_SHA256' ||
      !['ONLINE_VERIFIED', 'OFFLINE_VERIFIED'].includes(String(proof.mode)) ||
      typeof proof.verified_at !== 'string' ||
      !Number.isFinite(Date.parse(proof.verified_at))
    )
      fail('RUNTIME_NOT_READY');
    for (const [key, expected] of Object.entries(approved))
      if (!isDeepStrictEqual(proof[key], expected)) fail('RUNTIME_NOT_READY');
    return approved;
  }

  private async verifiedInputs(
    file: string,
    expected: Record<string, unknown>,
  ) {
    const handle = await openRegular(file, false);
    try {
      const before = await handle.stat();
      if (
        before.nlink !== 1 ||
        before.size > 1024 * 1024 ||
        before.mode & 0o077 ||
        (process.getuid && before.uid !== process.getuid())
      )
        fail('RUNTIME_NOT_READY');
      const owner = metadata(JSON.parse(await handle.readFile('utf8')));
      const after = await handle.stat(),
        named = await fs.lstat(file);
      for (const current of [after, named])
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.nlink !== 1 ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs ||
          current.ctimeMs !== before.ctimeMs
        )
          fail('RUNTIME_NOT_READY');
      if (!isDeepStrictEqual(owner.verified_inputs, expected))
        fail('RUNTIME_NOT_READY');
    } finally {
      await handle.close();
    }
  }

  private async inspectNodeArtifacts(
    runtime: JsonRow<RuntimeInstallation> & {
      metadata: Record<string, unknown>;
    },
    tool: JsonRow<NodePackageManagerToolchain> & {
      metadata: Record<string, unknown>;
    },
    build: NodeEnvironmentBuild,
    runtimeRoot: string,
    buildRoot: string,
    language?: string,
  ) {
    const artifacts = this.artifactPolicy();
    if (!artifacts) return;
    const approved = artifacts.nodeDistribution(runtime.version);
    const archive = this.approvedProvenance(
      artifacts,
      runtime.metadata.verified_artifact,
      approved.archive,
    );
    const npm = this.approvedProvenance(
      artifacts,
      runtime.metadata.verified_npm,
      approved.npm,
    );
    const nodeProof = metadata(archive.provenance),
      npmProof = metadata(npm.provenance);
    if (
      npm.npm_name !== 'npm' ||
      runtime.metadata.npm_version !== npm.npm_version ||
      npmProof.cli_relative_path !== 'bin/npm-cli.js'
    )
      fail('RUNTIME_NOT_READY');
    for (const checksum of [
      nodeProof.executable_sha256,
      npmProof.cli_sha256,
      npmProof.tree_sha256,
    ])
      if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum))
        fail('RUNTIME_NOT_READY');
    if (
      runtime.metadata.executable_sha256 !== nodeProof.executable_sha256 ||
      runtime.metadata.npm_cli_sha256 !== npmProof.cli_sha256
    )
      fail('RUNTIME_NOT_READY');
    const npmRoot = path.join(runtimeRoot, 'lib/node_modules/npm');
    const npmManifest = JSON.parse(
      await this.node.text(runtimeRoot, 'lib/node_modules/npm/package.json'),
    );
    const npmTree = await runtimeTreeDigest(npmRoot);
    if (
      npmManifest.name !== 'npm' ||
      npmManifest.version !== npm.npm_version ||
      npmTree.sha256 !== npmProof.tree_sha256 ||
      npmTree.entry_count !== npmProof.tree_entry_count
    )
      fail('RUNTIME_NOT_READY');
    const runtimeInputs = {
      schema: 1,
      kind: 'NODE_RUNTIME',
      manifest_sha256: artifacts.manifestSha256,
      trust_anchor_sha256: artifacts.trustAnchorSha256,
      archive_artifact_id: approved.archive,
      npm_artifact_id: approved.npm,
      executable_sha256: nodeProof.executable_sha256,
      npm_cli_sha256: npmProof.cli_sha256,
      npm_tree_sha256: npmProof.tree_sha256,
    };
    if (!isDeepStrictEqual(runtime.metadata.verified_inputs, runtimeInputs))
      fail('RUNTIME_NOT_READY');
    await this.verifiedInputs(
      await this.node.marker('runtime', runtime.id),
      runtimeInputs,
    );

    let closure: Awaited<
      | ReturnType<VerifiedRuntimeArtifactStore['npmClosure']>
      | ReturnType<VerifiedRuntimeArtifactStore['pnpmClosure']>
    >;
    if (tool.manager_type === 'NPM') {
      if (
        tool.version !== npm.npm_version ||
        tool.metadata.cli_sha256 !== npmProof.cli_sha256
      )
        fail('RUNTIME_NOT_READY');
      closure = await artifacts.npmClosure(
        build.package_json,
        runtime.version,
        tool.version,
      );
    } else if (tool.manager_type === 'PNPM') {
      if (artifacts.options.mode !== 'ONLINE_VERIFIED')
        fail('RUNTIME_NOT_READY');
      const approvedClosure = await artifacts.pnpmClosure(
        build.package_json,
        runtime.version,
        tool.version,
      );
      const pnpm = this.approvedProvenance(
        artifacts,
        tool.metadata.verified_artifact,
        approvedClosure.toolchain,
      );
      const proof = metadata(pnpm.provenance),
        toolRoot = await this.node.assertOwned('toolchain', tool.id);
      const packageRoot = await artifacts.packageRoot(toolRoot, 'pnpm');
      const pkg = JSON.parse(await this.node.text(packageRoot, 'package.json'));
      const tree = await runtimeTreeDigest(packageRoot);
      if (
        pnpm.npm_name !== 'pnpm' ||
        pnpm.npm_version !== tool.version ||
        proof.cli_relative_path !== 'bin/pnpm.cjs' ||
        pkg.name !== 'pnpm' ||
        pkg.version !== tool.version ||
        tool.metadata.cli_sha256 !== proof.cli_sha256 ||
        (await this.digest(
          await this.node.file(packageRoot, 'bin/pnpm.cjs'),
        )) !== proof.cli_sha256 ||
        tree.sha256 !== proof.tree_sha256 ||
        tree.entry_count !== proof.tree_entry_count
      )
        fail('RUNTIME_NOT_READY');
      const toolInputs = {
        schema: 1,
        kind: 'NODE_TOOLCHAIN',
        manifest_sha256: artifacts.manifestSha256,
        trust_anchor_sha256: artifacts.trustAnchorSha256,
        tool_artifact_id: pnpm.id,
        cli_sha256: proof.cli_sha256,
        tree_sha256: proof.tree_sha256,
      };
      if (!isDeepStrictEqual(tool.metadata.verified_inputs, toolInputs))
        fail('RUNTIME_NOT_READY');
      await this.verifiedInputs(
        await this.node.marker('toolchain', tool.id),
        toolInputs,
      );
      closure = approvedClosure;
    } else fail('RUNTIME_NOT_READY');
    const lock = artifacts.artifact(closure.lockfile);
    if (build.lock_hash !== lock.sha256) fail('RUNTIME_NOT_READY');
    const inputs: Record<string, unknown> = {
      schema: 1,
      kind: 'NODE_BUILD',
      manifest_sha256: artifacts.manifestSha256,
      trust_anchor_sha256: artifacts.trustAnchorSha256,
      lock_artifact_id: closure.lockfile,
      lock_artifact_sha256: lock.sha256,
    };
    const tsxArtifacts = closure.packages
      .map((id) => artifacts.artifact(id))
      .filter((a) => a.npm_name === 'tsx');
    if (
      tsxArtifacts.length > 1 ||
      (language === 'TYPESCRIPT' && tsxArtifacts.length !== 1)
    )
      fail('RUNTIME_NOT_READY');
    if (tsxArtifacts.length) {
      const tsx = tsxArtifacts[0],
        proof = metadata(tsx.provenance);
      if (
        typeof proof.cli_relative_path !== 'string' ||
        !['dist/cli.mjs', './dist/cli.mjs'].includes(proof.cli_relative_path) ||
        typeof proof.cli_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(proof.cli_sha256) ||
        typeof proof.tree_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(proof.tree_sha256)
      )
        fail('RUNTIME_NOT_READY');
      const tsxRoot = await artifacts.packageRoot(buildRoot, 'tsx'),
        tree = await runtimeTreeDigest(tsxRoot);
      const packageJson = JSON.parse(
        await this.node.text(tsxRoot, 'package.json'),
      );
      const declaredCli =
        typeof packageJson.bin === 'string'
          ? packageJson.bin
          : packageJson.bin?.tsx;
      if (
        packageJson.name !== 'tsx' ||
        packageJson.version !== tsx.npm_version ||
        declaredCli !== proof.cli_relative_path ||
        tree.sha256 !== proof.tree_sha256 ||
        tree.entry_count !== proof.tree_entry_count ||
        (await this.digest(await this.node.file(tsxRoot, 'dist/cli.mjs'))) !==
          proof.cli_sha256
      )
        fail('RUNTIME_NOT_READY');
      Object.assign(inputs, {
        tsx_artifact_id: tsx.id,
        tsx_cli_relative_path: proof.cli_relative_path,
        tsx_cli_sha256: proof.cli_sha256,
        tsx_tree_sha256: proof.tree_sha256,
      });
    }
    if (closure.esbuild) {
      const esbuild = artifacts.artifact(closure.esbuild.artifact);
      if (
        esbuild.format !== 'binary' ||
        esbuild.acquisition !== 'VERIFIED_REBUILD' ||
        !esbuild.provenance ||
        esbuild.version !== closure.esbuild.version ||
        closure.esbuild.package_name !==
          '@esbuild/' + process.platform + '-' + process.arch
      )
        fail('RUNTIME_NOT_READY');
      const fromRoot = tsxArtifacts.length
        ? await artifacts.packageRoot(buildRoot, 'tsx')
        : buildRoot;
      const esbuildRoot = await artifacts.packageRoot(
        buildRoot,
        'esbuild',
        fromRoot,
      );
      const binaryRoot = await artifacts.packageRoot(
        buildRoot,
        closure.esbuild.package_name,
        esbuildRoot,
      );
      for (const root of [binaryRoot, esbuildRoot])
        await this.executable(
          await this.node.file(root, 'bin/esbuild'),
          esbuild.sha256,
        );
      Object.assign(inputs, {
        esbuild_artifact_id: esbuild.id,
        esbuild_sha256: esbuild.sha256,
        esbuild_package: closure.esbuild.package_name,
        esbuild_publisher: esbuild.publisher,
        esbuild_build_provenance: esbuild.provenance,
      });
    }
    if (!isDeepStrictEqual(build.metadata.verified_artifacts, inputs))
      fail('RUNTIME_NOT_READY');
    await this.verifiedInputs(
      await this.node.marker('build', build.id),
      inputs,
    );
  }

  private async inspectPythonArtifacts(
    runtime: JsonRow<RuntimeInstallation> & {
      metadata: Record<string, unknown>;
    },
    provider: RuntimeProvider,
    root: string,
    venv: string,
  ) {
    const artifacts = this.artifactPolicy();
    if (!artifacts) return;
    const revision = provider.provider_revision;
    if (typeof revision !== 'string') fail('RUNTIME_NOT_READY');
    const rows = artifacts.manifest.python.filter(
      (p) => p.version === runtime.version && p.provider_revision === revision,
    );
    if (rows.length !== 1) fail('RUNTIME_NOT_READY');
    const approved = rows[0] as (typeof rows)[number] & {
      definition: string;
      openssl: string;
      zlib: string;
      ca_bundle: string;
      sqlite: string;
      pip_wheel: string;
    };
    for (const id of [
      approved.definition,
      approved.openssl,
      approved.zlib,
      approved.ca_bundle,
      approved.sqlite,
      approved.pip_wheel,
    ])
      if (typeof id !== 'string') fail('RUNTIME_NOT_READY');
    const providerArtifact = artifacts.pythonProvider(revision);
    this.approvedProvenance(
      artifacts,
      runtime.metadata.verified_provider,
      providerArtifact,
    );
    const sources = artifacts.pythonSources(runtime.version, revision);
    const proofs = array<unknown>(runtime.metadata.verified_sources);
    if (proofs.length !== sources.length) fail('RUNTIME_NOT_READY');
    sources.forEach((source, i) =>
      this.approvedProvenance(artifacts, proofs[i], source.artifact),
    );
    const inputs = metadata(runtime.metadata.verified_inputs);
    const pip = artifacts.artifact(approved.pip_wheel),
      pipProof = metadata(pip.provenance);
    const expected: Record<string, unknown> = {
      schema: 1,
      kind: 'PYTHON_RUNTIME',
      manifest_sha256: artifacts.manifestSha256,
      trust_anchor_sha256: artifacts.trustAnchorSha256,
      provider_artifact_id: providerArtifact,
      definition_artifact_id: approved.definition,
      source_artifact_ids: sources.map((s) => s.artifact),
      ca_bundle_artifact_id: approved.ca_bundle,
      sqlite_artifact_id: approved.sqlite,
      pip_artifact_id: pip.id,
      pip_wheel_sha256: pip.sha256,
      pip_init_sha256: pipProof.pip_init_sha256,
      pip_vendor_manifest_sha256: pipProof.pip_vendor_manifest_sha256,
      pip_version: pip.version,
      executable_sha256: runtime.metadata.executable_sha256,
      ssl_module_sha256: inputs.ssl_module_sha256,
      hashlib_module_sha256: inputs.hashlib_module_sha256,
      zlib_module_sha256: inputs.zlib_module_sha256,
      sqlite_module_sha256: inputs.sqlite_module_sha256,
      sqlite_version: artifacts.artifact(approved.sqlite).version,
      sqlite_source_id: metadata(artifacts.artifact(approved.sqlite).provenance)
        .sqlite_source_id,
      openssl_version: inputs.openssl_version,
      zlib_version: inputs.zlib_version,
      ca_bundle_sha256: artifacts.artifact(approved.ca_bundle).sha256,
    };
    if (!isDeepStrictEqual(inputs, expected)) fail('RUNTIME_NOT_READY');
    const opensslVersion = String(inputs.openssl_version).match(
      /^OpenSSL (\d+\.\d+\.\d+)(?:\s|$)/,
    )?.[1];
    const approvedOpenSslVersion = artifacts
      .artifact(approved.openssl)
      .version.match(/(?:^|[^0-9])(\d+\.\d+\.\d+)(?:$|[^0-9])/u)?.[1];
    const approvedZlibVersion = artifacts
      .artifact(approved.zlib)
      .version.replace(/^zlib-/, '');
    if (
      !opensslVersion ||
      opensslVersion !== approvedOpenSslVersion ||
      inputs.zlib_version !== approvedZlibVersion ||
      runtime.metadata.openssl_version !== inputs.openssl_version ||
      runtime.metadata.zlib_version !== inputs.zlib_version ||
      runtime.metadata.sqlite_version !== expected.sqlite_version ||
      runtime.metadata.sqlite_source_id !== expected.sqlite_source_id ||
      runtime.metadata.sqlite_module_sha256 !== inputs.sqlite_module_sha256 ||
      typeof expected.sqlite_source_id !== 'string' ||
      !expected.sqlite_source_id ||
      runtime.metadata.pip_version !== pip.version
    )
      fail('RUNTIME_NOT_READY');
    for (const checksum of [
      pipProof.pip_init_sha256,
      pipProof.pip_vendor_manifest_sha256,
    ])
      if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum))
        fail('RUNTIME_NOT_READY');
    const lib = 'lib/python' + runtime.version.split('.').slice(0, 2).join('.');
    const pipInit = lib + '/site-packages/pip/__init__.py';
    const pipVendor = lib + '/site-packages/pip/_vendor/vendor.txt';
    const wheel = 'pip-wheels/' + pipProof.wheel_filename;
    if (
      typeof pipProof.wheel_filename !== 'string' ||
      !/^[a-zA-Z0-9._-]+\.whl$/.test(pipProof.wheel_filename) ||
      runtime.metadata.pip_init_relative !== pipInit ||
      runtime.metadata.pip_vendor_manifest_relative !== pipVendor ||
      runtime.metadata.pip_wheel_relative !== wheel
    )
      fail('RUNTIME_NOT_READY');
    for (const [relative, checksum] of [
      [pipInit, pipProof.pip_init_sha256],
      [pipVendor, pipProof.pip_vendor_manifest_sha256],
      [wheel, pip.sha256],
    ] as const)
      if (
        (await this.digest(await this.node.file(root, relative))) !== checksum
      )
        fail('RUNTIME_NOT_READY');
    // A repaired base Runtime must not bless an older READY venv's bundled pip.
    for (const [relative, checksum] of [
      [pipInit, pipProof.pip_init_sha256],
      [pipVendor, pipProof.pip_vendor_manifest_sha256],
    ] as const)
      if (
        (await this.digest(await this.node.file(venv, relative))) !== checksum
      )
        fail('RUNTIME_NOT_READY');
    const bundled = path.join(root, lib, 'ensurepip/_bundled');
    const oldWheels = await (async () => {
      try {
        await this.existing(
          path.relative(this.store.dataRoot, bundled).split(path.sep).join('/'),
        );
        return await fs.readdir(bundled, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return [];
      }
    })();
    for (const entry of oldWheels)
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        /\.whl$/i.test(entry.name)
      )
        fail('RUNTIME_NOT_READY');
    const linked = metadata(runtime.metadata.linked_library_names);
    for (const name of ['ssl', 'hashlib', 'zlib', 'sqlite']) {
      const libraries = linked[name];
      if (
        !Array.isArray(libraries) ||
        !libraries.length ||
        libraries.some(
          (library) =>
            typeof library !== 'string' ||
            path.basename(library) !== library ||
            /[\\\0]/.test(library) ||
            /^lib(?:ssl|crypto|sqlite3)(?:[.-]|$)|^libz(?:[.-]|$)/i.test(
              library,
            ),
        )
      )
        fail('RUNTIME_NOT_READY');
    }
    for (const [field, checksum, prefix] of [
      ['ssl_module_relative', 'ssl_module_sha256', '_ssl.'],
      ['hashlib_module_relative', 'hashlib_module_sha256', '_hashlib.'],
      ['zlib_module_relative', 'zlib_module_sha256', 'zlib.'],
      ['sqlite_module_relative', 'sqlite_module_sha256', '_sqlite3.'],
    ]) {
      const relative = runtime.metadata[field],
        digest = inputs[checksum];
      if (
        typeof relative !== 'string' ||
        !path.posix.basename(relative).startsWith(prefix) ||
        typeof digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(digest) ||
        (await this.digest(await this.node.file(root, relative))) !== digest
      )
        fail('RUNTIME_NOT_READY');
    }
    const certfile = runtime.metadata.default_certfile_relative;
    if (
      typeof certfile !== 'string' ||
      (await this.digest(await this.node.file(root, certfile))) !==
        expected.ca_bundle_sha256
    )
      fail('RUNTIME_NOT_READY');
    await this.verifiedInputs(await this.paths.ownership(runtime.id), expected);
  }

  private async existing(relative: string) {
    // The reused path resolvers may mkdir their marker parent. Readiness first
    // proves every parent exists, so it cannot create runtime resources.
    return this.paths.directory(relative, false);
  }
  private async one<T extends object>(table: string, id: number) {
    const row = (
      await this.store.all<T>(`SELECT * FROM ${table} WHERE id=?`, [
        positiveId(id),
      ])
    )[0];
    if (!row) fail('RUNTIME_NOT_READY');
    return row;
  }
  private async runtime(id: number, kind: 'PYTHON' | 'NODE') {
    const row = await this.one<JsonRow<RuntimeInstallation>>(
      'RuntimeInstallations',
      id,
    );
    const provider = await this.one<RuntimeProvider>(
      'RuntimeProviders',
      row.provider_id,
    );
    if (
      row.state !== 'READY' ||
      row.language !== kind ||
      provider.language !== kind ||
      provider.state !== 'READY' ||
      provider.provider_type !==
        (kind === 'PYTHON' ? 'PYENV' : 'NODE_DISTRIBUTION')
    )
      fail('RUNTIME_NOT_READY');
    return { runtime: { ...row, metadata: metadata(row.metadata) }, provider };
  }
  private async executable(file: string, checksum: unknown) {
    if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum))
      fail('RUNTIME_NOT_READY');
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      !(stat.mode & 0o111) ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (await this.digest(file)) !== checksum
    )
      fail('RUNTIME_NOT_READY');
  }
  private async digest(file: string) {
    const handle = await openRegular(file, false);
    try {
      const before = await handle.stat(),
        hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      const after = await handle.stat(),
        named = await fs.lstat(file);
      for (const current of [after, named])
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.nlink !== 1 ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs ||
          current.ctimeMs !== before.ctimeMs
        )
          fail('RUNTIME_NOT_READY');
      return hash.digest('hex');
    } finally {
      await handle.close();
    }
  }

  private async inspectPython(id: number): Promise<ManagedRuntimeSnapshot> {
    const environment = await this.one<PythonEnvironment>(
      'PythonEnvironments',
      id,
    );
    if (
      !['READY', 'BUILDING'].includes(environment.state) ||
      !environment.current_build_id ||
      !environment.current_revision_id
    )
      fail('RUNTIME_NOT_READY');
    const raw = await this.one<
      JsonRow<PythonEnvironmentBuild> & { resolved: unknown }
    >('PythonEnvironmentBuilds', environment.current_build_id);
    const build: PythonEnvironmentBuild = {
      ...raw,
      metadata: metadata(raw.metadata),
      resolved: array(raw.resolved),
    };
    if (
      build.state !== 'READY' ||
      build.health !== 'HEALTHY' ||
      build.environment_id !== id
    )
      fail('RUNTIME_NOT_READY');
    const { runtime, provider } = await this.runtime(
      build.runtime_id,
      'PYTHON',
    );
    await this.existing('runtime/python/pyenv/ownership');
    await this.existing('runtime/python/pyenv/versions');
    await this.existing('runtime/python/environments');
    const location = await this.python.executable(build, runtime);
    await this.executable(
      location.base.executable,
      runtime.metadata.executable_sha256,
    );
    await this.inspectPythonArtifacts(
      runtime,
      provider,
      location.base.root,
      location.venv,
    );
    return {
      kind: 'PYTHON',
      executable: location.executable,
      environmentId: id,
      environmentVersion: environment.version,
      revisionId: build.revision_id,
      buildId: build.id,
      runtimeId: runtime.id,
      providerId: provider.id,
      runtimeVersion: runtime.version,
      providerRevision: provider.provider_revision || undefined,
      venvRoot: location.venv,
      dependencyHash: build.resolved_hash || undefined,
    };
  }

  private async inspectNode(
    id: number,
    language?: string,
  ): Promise<ManagedRuntimeSnapshot> {
    const environment = await this.one<NodeEnvironment>('NodeEnvironments', id);
    if (
      !['READY', 'BUILDING'].includes(environment.state) ||
      !environment.current_build_id ||
      !environment.current_revision_id
    )
      fail('RUNTIME_NOT_READY');
    const raw = await this.one<
      JsonRow<NodeEnvironmentBuild> & { resolved: unknown }
    >('NodeEnvironmentBuilds', environment.current_build_id);
    const build: NodeEnvironmentBuild = {
      ...raw,
      metadata: metadata(raw.metadata),
      resolved: array(raw.resolved),
    };
    if (
      build.state !== 'READY' ||
      build.health !== 'HEALTHY' ||
      build.environment_id !== id
    )
      fail('RUNTIME_NOT_READY');
    const { runtime, provider } = await this.runtime(build.runtime_id, 'NODE');
    const rawTool = await this.one<JsonRow<NodePackageManagerToolchain>>(
      'NodePackageManagerToolchains',
      build.toolchain_id,
    );
    const tool = { ...rawTool, metadata: metadata(rawTool.metadata) };
    if (tool.state !== 'READY' || tool.runtime_id !== runtime.id)
      fail('RUNTIME_NOT_READY');
    await this.existing('runtime/node/ownership');
    const runtimeRoot = await this.node.assertOwned('runtime', runtime.id);
    const executable = await this.node.file(runtimeRoot, 'bin/node');
    await this.executable(executable, runtime.metadata.executable_sha256);
    const buildRoot = await this.node.assertOwned('build', build.id, id);
    await this.existing(
      this.node.relative('build', build.id, id) + '/node_modules',
    );
    const lock =
      tool.manager_type === 'NPM' ? 'package-lock.json' : 'pnpm-lock.yaml';
    if (
      nodeHash(await this.node.text(buildRoot, lock)) !== build.lock_hash ||
      (await this.node.text(buildRoot, 'package.json')) !==
        build.package_json ||
      nodeHash(await this.node.text(buildRoot, '.npmrc')) !==
        build.metadata.config_hash ||
      (tool.manager_type === 'PNPM' &&
        nodeHash(await this.node.text(buildRoot, 'pnpm-workspace.yaml')) !==
          build.metadata.workspace_hash)
    )
      fail('RUNTIME_NOT_READY');
    const toolRoot =
      tool.manager_type === 'NPM'
        ? runtimeRoot
        : await this.node.assertOwned('toolchain', tool.id);
    const cli = await this.node.file(
      toolRoot,
      tool.manager_type === 'NPM'
        ? 'lib/node_modules/npm/bin/npm-cli.js'
        : 'node_modules/pnpm/bin/pnpm.cjs',
    );
    if ((await this.digest(cli)) !== tool.metadata.cli_sha256)
      fail('RUNTIME_NOT_READY');
    await this.inspectNodeArtifacts(
      runtime,
      tool,
      build,
      runtimeRoot,
      buildRoot,
      language,
    );
    const result: ManagedRuntimeSnapshot = {
      kind: 'NODE',
      executable,
      providerId: provider.id,
      providerRevision: provider.provider_revision || undefined,
      runtimeVersion: runtime.version,
      environmentId: id,
      environmentVersion: environment.version,
      revisionId: build.revision_id,
      buildId: build.id,
      runtimeId: runtime.id,
      toolchainId: tool.id,
      toolchainVersion: tool.version,
      buildRoot,
      nodeModulesRoot: path.join(buildRoot, 'node_modules'),
      dependencyHash: build.lock_hash || undefined,
    };
    if (language === 'TYPESCRIPT') {
      const packageFile = await this.node.file(
        buildRoot,
        'node_modules/tsx/package.json',
      );
      const tsxCli = await this.node.file(
        buildRoot,
        'node_modules/tsx/dist/cli.mjs',
      );
      const manifest = JSON.parse(await fs.readFile(packageFile, 'utf8')) as {
        name?: unknown;
        version?: unknown;
        bin?: string | { tsx?: string };
      };
      const bin =
        typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsx;
      if (
        manifest.name !== 'tsx' ||
        typeof manifest.version !== 'string' ||
        !/^4\.\d+\.\d+$/.test(manifest.version) ||
        !['./dist/cli.mjs', 'dist/cli.mjs'].includes(bin || '')
      )
        fail('RUNTIME_NOT_READY');
      result.tsxCli = tsxCli;
      result.tsxVersion = manifest.version;
    }
    return result;
  }

  async inspect(
    kind: PhysicalRuntimeSelection['kind'],
    environmentId: number | null,
    language?: string,
  ): Promise<ManagedRuntimeSnapshot> {
    if (kind === 'SHELL') {
      if (environmentId !== null) fail('CONFIGURATION_REQUIRED');
      const stat = await fs.stat('/bin/sh');
      if (!stat.isFile() || !(stat.mode & 0o111)) fail('RUNTIME_NOT_READY');
      return { kind: 'SHELL', executable: '/bin/sh' };
    }
    if (!environmentId) fail('CONFIGURATION_REQUIRED');
    try {
      this.artifactPolicy();
      return kind === 'PYTHON'
        ? await this.inspectPython(environmentId)
        : await this.inspectNode(environmentId, language);
    } catch {
      fail('RUNTIME_NOT_READY');
    }
  }

  async pin(selection: PhysicalRuntimeSelection, language?: string) {
    const first = await this.inspect(
      selection.kind,
      selection.environmentId,
      language,
    );
    const leases: RuntimeLease[] = [];
    const temporary: RuntimeLease[] = [];
    try {
      if (first.kind === 'PYTHON') {
        temporary.push(
          await RuntimeLease.acquire(this.paths, first.providerId!, 'shared'),
        );
        temporary.push(
          await this.python.lock(first.environmentId!, 'environment', 'shared'),
        );
        leases.push(await this.python.lock(first.buildId!, 'build', 'shared'));
      } else if (first.kind === 'NODE') {
        for (const [kind, id] of [
          ['runtime', first.runtimeId],
          ['toolchain', first.toolchainId],
        ] as const)
          leases.push(await this.node.lease(kind, id!, 'shared'));
        temporary.push(
          await this.node.lease('environment', first.environmentId!, 'shared'),
        );
        leases.push(await this.node.lease('build', first.buildId!, 'shared'));
      }
      const runtime = await this.inspect(
        selection.kind,
        selection.environmentId,
        language,
      );
      if (JSON.stringify(first) !== JSON.stringify(runtime))
        fail('SOURCE_SUPERSEDED');
      // The immutable selected Build remains pinned; a new generation can build
      // and promote without replacing this run's executable or dependency tree.
      for (const lease of temporary.reverse()) await lease.release();
      return {
        runtime,
        leases,
        async release() {
          for (const lease of [...leases].reverse()) await lease.release();
        },
      };
    } catch (error) {
      for (const lease of temporary.reverse()) await lease.release();
      for (const lease of leases.reverse()) await lease.release();
      throw error;
    }
  }
}
