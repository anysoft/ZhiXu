import fs from 'fs/promises';
import path from 'path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { RuntimeInstallation } from '../data/runtime';
import {
  NodePackageManagerToolchain,
  NodeEnvironmentRevision,
  NodeEnvironmentBuild,
} from '../data/nodeEnvironment';
import { NodeDependency, NodeResolvedPackage } from '../shared/nodeEnvironment';
import { RuntimeError } from '../shared/runtime';
import { ProviderContext } from './pyenvProvider';
import NodePathResolver, { nodeFileHash, nodeHash } from './nodePaths';
import NodeDistributionProvider from './nodeDistributionProvider';
import { VerifiedRuntimeArtifactStore } from './runtimeArtifacts';
import { runtimeTreeDigest } from './runtimeTreeWitness';
export const NODE_REGISTRY = 'https://registry.npmjs.org/';
const parseScript = `const fs=require('fs'),path=require('path');const root=process.argv[1],mode=process.argv[2],value=JSON.parse(process.argv[3]);const base=path.join(root,'lib/node_modules/npm/node_modules');const semver=require(path.join(base,'semver'));if(mode==='engine'){if(!semver.satisfies(value.version,value.engine))process.exit(42);console.log('true');}else{const validate=require(path.join(base,'validate-npm-package-name'));for(const d of value){if(!validate(d.name).validForNewPackages||!semver.validRange(d.specifier))process.exit(43);}console.log('true');}`;
/** Exact managed CLI invocation; no shell activation or business packages in Runtime. */
export default class NodePackageManager {
  readonly provider: NodeDistributionProvider;
  constructor(
    readonly paths: NodePathResolver,
    readonly registry = NODE_REGISTRY,
  ) {
    const u = new URL(registry);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !(
        registry === NODE_REGISTRY ||
        (u.protocol === 'http:' &&
          ['127.0.0.1', 'localhost'].includes(u.hostname))
      )
    )
      throw new RuntimeError('NODE_REGISTRY_INVALID', 400);
    this.provider = new NodeDistributionProvider(paths);
  }
  async environment(ctx: ProviderContext, runtime: RuntimeInstallation) {
    const root = await this.paths.assertOwned('runtime', runtime.id),
      node = await this.paths.file(root, 'bin/node');
    if (
      runtime.language !== 'NODE' ||
      runtime.state !== 'READY' ||
      (await nodeFileHash(node)) !== runtime.metadata.executable_sha256
    )
      throw new RuntimeError('NODE_RUNTIME_NOT_READY');
    const artifacts = VerifiedRuntimeArtifactStore.current(this.paths.dataRoot);
    if (artifacts) {
      const approved = artifacts.nodeDistribution(runtime.version);
      const nodeProof = artifacts.artifact(approved.archive).provenance;
      const npmProof = artifacts.artifact(approved.npm).provenance;
      const npmTree = await runtimeTreeDigest(
        path.join(root, 'lib/node_modules/npm'),
      );
      if (
        nodeProof?.executable_sha256 !== (await nodeFileHash(node)) ||
        npmProof?.tree_sha256 !== npmTree.sha256 ||
        npmProof?.tree_entry_count !== npmTree.entry_count
      )
        throw new RuntimeError('NODE_RUNTIME_NOT_READY');
    }
    const home = path.join(ctx.directory, 'home');
    await this.paths.directory(
      path
        .relative(await this.paths.root(), home)
        .split(path.sep)
        .join('/'),
      true,
    );
    return {
      root,
      node,
      env: {
        PATH: path.join(root, 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: home,
        TMPDIR: ctx.directory,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        XDG_CONFIG_HOME: home,
        XDG_DATA_HOME: home,
        XDG_CACHE_HOME: home,
        CI: 'true',
        npm_config_userconfig: path.join(home, 'user.npmrc'),
        npm_config_globalconfig: path.join(home, 'global.npmrc'),
        npm_config_registry: this.registry,
        npm_config_cache: await this.paths.directory('cache/node/npm', true),
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        npm_config_node_gyp: undefined,
      } as NodeJS.ProcessEnv,
    };
  }
  async validate(
    ctx: ProviderContext,
    runtime: RuntimeInstallation,
    deps: NodeDependency[],
  ) {
    if (!Array.isArray(deps) || deps.length > 100)
      throw new RuntimeError('NODE_DEPENDENCY_INVALID', 400);
    const seen = new Set<string>();
    for (const d of deps) {
      if (
        !d ||
        Object.keys(d).some(
          (k) => !['name', 'specifier', 'type'].includes(k),
        ) ||
        typeof d.name !== 'string' ||
        typeof d.specifier !== 'string' ||
        d.name.length > 214 ||
        d.specifier.length > 200 ||
        !['DEPENDENCY', 'DEV_DEPENDENCY'].includes(d.type) ||
        !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(d.name) ||
        /[\x00-\x1f\x7f`$\\/:]/.test(d.specifier) ||
        d.specifier.startsWith('-') ||
        !d.specifier.trim() ||
        seen.has(d.name)
      )
        throw new RuntimeError('NODE_DEPENDENCY_INVALID', 400);
      seen.add(d.name);
    }
    const { root, node, env } = await this.environment(ctx, runtime);
    try {
      await ctx.command.run(
        node,
        ['-e', parseScript, root, 'dependencies', JSON.stringify(deps)],
        ctx.directory,
        env,
        true,
      );
    } catch (e) {
      if (
        e instanceof RuntimeError &&
        e.error_code === 'RUNTIME_COMMAND_FAILED'
      )
        throw new RuntimeError('NODE_DEPENDENCY_INVALID', 400);
      throw e;
    }
    return [...deps].sort((a, b) => a.name.localeCompare(b.name));
  }
  async cli(
    ctx: ProviderContext,
    runtime: RuntimeInstallation,
    tool: NodePackageManagerToolchain,
  ) {
    if (tool.runtime_id !== runtime.id || tool.state !== 'READY')
      throw new RuntimeError('NODE_TOOLCHAIN_NOT_READY');
    const run = await this.environment(ctx, runtime);
    const toolRoot =
      tool.manager_type === 'NPM'
        ? run.root
        : await this.paths.assertOwned('toolchain', tool.id);
    const cli = await this.paths.file(
      toolRoot,
      tool.manager_type === 'NPM'
        ? 'lib/node_modules/npm/bin/npm-cli.js'
        : 'node_modules/pnpm/bin/pnpm.cjs',
    );
    if (
      tool.metadata.cli_sha256 &&
      (await nodeFileHash(cli)) !== tool.metadata.cli_sha256
    )
      throw new RuntimeError('NODE_TOOLCHAIN_INVALID');
    return { ...run, cli, toolRoot };
  }
  async verify(
    ctx: ProviderContext,
    runtime: RuntimeInstallation,
    tool: NodePackageManagerToolchain,
  ): Promise<Record<string, unknown> & { cli_sha256: string }> {
    const run = await this.cli(ctx, runtime, { ...tool, state: 'READY' });
    const pkg = JSON.parse(
      await this.paths.text(
        run.toolRoot,
        tool.manager_type === 'NPM'
          ? 'lib/node_modules/npm/package.json'
          : 'node_modules/pnpm/package.json',
      ),
    );
    if (pkg.version !== tool.version || typeof pkg.engines?.node !== 'string')
      throw new RuntimeError('NODE_TOOLCHAIN_INVALID');
    try {
      await ctx.command.run(
        run.node,
        [
          '-e',
          parseScript,
          run.root,
          'engine',
          JSON.stringify({
            version: runtime.version,
            engine: pkg.engines.node,
          }),
        ],
        ctx.directory,
        run.env,
        true,
      );
    } catch (e) {
      if (
        e instanceof RuntimeError &&
        e.error_code === 'RUNTIME_COMMAND_FAILED'
      )
        throw new RuntimeError('PACKAGE_MANAGER_RUNTIME_INCOMPATIBLE');
      throw e;
    }
    const version = (
      await ctx.command.run(
        run.node,
        [run.cli, '--version'],
        ctx.directory,
        run.env,
        true,
      )
    ).trim();
    if (version !== tool.version)
      throw new RuntimeError('NODE_TOOLCHAIN_INVALID');
    const artifacts = VerifiedRuntimeArtifactStore.current(this.paths.dataRoot);
    let verified: Record<string, unknown> = {};
    if (artifacts && tool.manager_type === 'PNPM') {
      if (artifacts.options.mode !== 'ONLINE_VERIFIED')
        throw new RuntimeError('RUNTIME_ARTIFACT_MODE_UNSUPPORTED');
      const approved = artifacts.manifest.artifacts.filter(
        (a) => a.npm_name === 'pnpm' && a.npm_version === tool.version,
      );
      if (approved.length !== 1)
        throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_UNAVAILABLE');
      const artifact = approved[0],
        proof = artifact.provenance;
      const tree = await runtimeTreeDigest(
        path.join(run.toolRoot, 'node_modules/pnpm'),
      );
      if (
        proof?.cli_relative_path !== 'bin/pnpm.cjs' ||
        proof.cli_sha256 !== (await nodeFileHash(run.cli)) ||
        proof.tree_sha256 !== tree.sha256 ||
        proof.tree_entry_count !== tree.entry_count
      )
        throw new RuntimeError('NODE_TOOLCHAIN_INVALID');
      verified = {
        verified_artifact: artifacts.provenance(artifact.id),
        verified_inputs: {
          schema: 1,
          kind: 'NODE_TOOLCHAIN',
          manifest_sha256: artifacts.manifestSha256,
          trust_anchor_sha256: artifacts.trustAnchorSha256,
          tool_artifact_id: artifact.id,
          cli_sha256: proof.cli_sha256,
          tree_sha256: proof.tree_sha256,
        },
      };
    }
    return {
      version,
      engines: pkg.engines,
      cli_sha256: await nodeFileHash(run.cli),
      runtime_executable_sha256: runtime.metadata.executable_sha256,
      ...verified,
    };
  }
  async install(
    ctx: ProviderContext,
    runtime: RuntimeInstallation,
    tool: NodePackageManagerToolchain,
  ) {
    if (tool.manager_type === 'NPM') return this.verify(ctx, runtime, tool);
    const artifacts = VerifiedRuntimeArtifactStore.current(this.paths.dataRoot);
    if (artifacts?.options.mode === 'OFFLINE_VERIFIED')
      throw new RuntimeError('RUNTIME_ARTIFACT_MODE_UNSUPPORTED');
    const run = await this.environment(ctx, runtime),
      root = await this.paths.create('toolchain', tool.id),
      npm = await this.paths.file(
        run.root,
        'lib/node_modules/npm/bin/npm-cli.js',
      );
    await this.paths.privateWrite(
      path.join(root, 'package.json'),
      JSON.stringify({ private: true, dependencies: { pnpm: tool.version } }),
    );
    await ctx.stage('INSTALLING_TOOLCHAIN');
    if (artifacts) {
      const approved = artifacts.manifest.artifacts.filter(
        (a) => a.npm_name === 'pnpm' && a.npm_version === tool.version,
      );
      if (approved.length !== 1)
        throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_UNAVAILABLE');
      const input = path.join(ctx.directory, 'verified-pnpm.tgz');
      await fs.copyFile(await artifacts.resolve(approved[0].id, ctx), input);
      if ((await nodeFileHash(input)) !== approved[0].sha256)
        throw new RuntimeError('RUNTIME_ARTIFACT_CHECKSUM_MISMATCH');
      await ctx.command.run(
        run.node,
        [
          npm,
          'install',
          input,
          '--offline',
          '--ignore-scripts',
          '--package-lock=false',
          '--engine-strict',
          '--no-audit',
          '--no-fund',
        ],
        root,
        { ...run.env, npm_config_offline: 'true' },
      );
      const metadata = await this.verify(ctx, runtime, tool);
      const marker = await this.paths.marker('toolchain', tool.id);
      await this.paths.privateWrite(
        marker,
        JSON.stringify({
          ...(await this.paths.readJson(marker)),
          verified_inputs: metadata.verified_inputs,
        }),
      );
      return metadata;
    }
    const engines = JSON.parse(
      await ctx.command.run(
        run.node,
        [
          npm,
          'view',
          'pnpm@' + tool.version,
          'engines',
          '--json',
          '--registry',
          this.registry,
        ],
        root,
        run.env,
        true,
      ),
    );
    if (typeof engines?.node !== 'string')
      throw new RuntimeError('NODE_TOOLCHAIN_INVALID');
    try {
      await ctx.command.run(
        run.node,
        [
          '-e',
          parseScript,
          run.root,
          'engine',
          JSON.stringify({ version: runtime.version, engine: engines.node }),
        ],
        ctx.directory,
        run.env,
        true,
      );
    } catch (e) {
      if (
        e instanceof RuntimeError &&
        e.error_code === 'RUNTIME_COMMAND_FAILED'
      )
        throw new RuntimeError(
          'PACKAGE_MANAGER_RUNTIME_INCOMPATIBLE',
          409,
          e.exit_code,
        );
      throw e;
    }
    await ctx.command.run(
      run.node,
      [
        npm,
        'install',
        '--ignore-scripts',
        '--engine-strict',
        '--no-audit',
        '--no-fund',
        '--registry',
        this.registry,
      ],
      root,
      run.env,
    );
    return this.verify(ctx, runtime, tool);
  }
  manifest(
    revision: NodeEnvironmentRevision,
    tool: NodePackageManagerToolchain,
  ) {
    const dependencies: Record<string, string> = Object.create(null),
      devDependencies: Record<string, string> = Object.create(null);
    for (const dep of revision.dependencies)
      (dep.type === 'DEPENDENCY' ? dependencies : devDependencies)[dep.name] =
        dep.specifier;
    return (
      JSON.stringify(
        {
          name: 'platform-environment',
          version: '0.0.0',
          private: true,
          packageManager:
            (tool.manager_type === 'PNPM' ? 'pnpm' : 'npm') +
            '@' +
            tool.version,
          dependencies,
          devDependencies,
        },
        null,
        2,
      ) + '\n'
    );
  }
  lockName(tool: NodePackageManagerToolchain) {
    return tool.manager_type === 'PNPM'
      ? 'pnpm-lock.yaml'
      : 'package-lock.json';
  }
  async configure(
    root: string,
    revision: NodeEnvironmentRevision,
    tool: NodePackageManagerToolchain,
  ) {
    const config = {
      registry: this.registry,
      'ignore-scripts': revision.install_scripts_policy === 'IGNORE',
      'engine-strict': true,
      audit: false,
      fund: false,
      'update-notifier': false,
      'manage-package-manager-versions': false,
      'package-manager-strict-version': true,
    };
    await this.paths.privateWrite(
      path.join(root, '.npmrc'),
      Object.entries(config)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
    );
    if (tool.manager_type === 'PNPM')
      await this.paths.privateWrite(
        path.join(root, 'pnpm-workspace.yaml'),
        yamlDump({
          packages: [],
          dangerouslyAllowAllBuilds:
            revision.install_scripts_policy === 'ALLOW',
          ignoreScripts: revision.install_scripts_policy === 'IGNORE',
          packageImportMethod: 'copy',
          sideEffectsCache: false,
          managePackageManagerVersions: false,
          storeDir: await this.paths.directory(
            `cache/node/pnpm-store/toolchain-${tool.id}`,
            true,
          ),
          virtualStoreDir: 'node_modules/.pnpm',
          enableGlobalVirtualStore: false,
        }),
      );
  }
  async installBuild(
    ctx: ProviderContext,
    runtime: RuntimeInstallation,
    tool: NodePackageManagerToolchain,
    revision: NodeEnvironmentRevision,
    build: NodeEnvironmentBuild,
    frozen?: NodeEnvironmentBuild,
  ) {
    await this.verify(ctx, runtime, tool);
    const run = await this.cli(ctx, runtime, tool),
      root = await this.paths.create('build', build.id, build.environment_id);
    const manifest = this.manifest(revision, tool);
    const artifacts = VerifiedRuntimeArtifactStore.current(this.paths.dataRoot);
    const closure = artifacts
      ? tool.manager_type === 'PNPM'
        ? await artifacts.pnpmClosure(manifest, runtime.version, tool.version)
        : await artifacts.npmClosure(manifest, runtime.version, tool.version)
      : undefined;
    await this.paths.privateWrite(path.join(root, 'package.json'), manifest);
    await this.configure(root, revision, tool);
    const verified =
      artifacts && closure
        ? 'pnpm_version' in closure
          ? await artifacts.seedPnpm(ctx, closure, run, root)
          : await artifacts.seedNpm(ctx, closure, run)
        : undefined;
    if (verified) {
      if (frozen && frozen.lockfile !== verified.lockfile)
        throw new RuntimeError('NODE_BUILD_SNAPSHOT_CHANGED');
      await this.paths.privateWrite(
        path.join(root, this.lockName(tool)),
        verified.lockfile,
      );
    } else if (frozen)
      await this.paths.privateWrite(
        path.join(root, this.lockName(tool)),
        frozen.lockfile,
      );
    const args =
      tool.manager_type === 'PNPM'
        ? [
            'install',
            frozen || verified ? '--frozen-lockfile' : '--no-frozen-lockfile',
            '--reporter=append-only',
            '--ignore-pnpmfile',
            '--config.manage-package-manager-versions=false',
            '--config.side-effects-cache=false',
            '--config.package-import-method=copy',
            ...(revision.production_only ? ['--prod'] : []),
          ]
        : [
            frozen || verified ? 'ci' : 'install',
            '--foreground-scripts',
            '--no-audit',
            '--no-fund',
            ...(revision.production_only ? ['--omit=dev'] : []),
          ];
    if (revision.install_scripts_policy === 'IGNORE')
      args.push('--ignore-scripts');
    if (verified) args.push('--offline', '--ignore-scripts');
    await ctx.stage('INSTALLING_DEPENDENCIES');
    try {
      await ctx.command.run(
        run.node,
        [run.cli, ...args],
        root,
        verified?.env ?? run.env,
      );
      if (artifacts && closure && verified) {
        await artifacts.overlayEsbuild(ctx, closure, root);
        if (revision.install_scripts_policy === 'ALLOW')
          await ctx.command.run(
            run.node,
            [
              run.cli,
              'rebuild',
              ...(tool.manager_type === 'PNPM'
                ? ['--config.offline=true']
                : [
                    '--offline',
                    '--foreground-scripts',
                    '--no-audit',
                    '--no-fund',
                  ]),
            ],
            root,
            verified.env,
          );
        await artifacts.overlayEsbuild(ctx, closure, root);
      }
    } catch (e) {
      if (
        e instanceof RuntimeError &&
        e.error_code === 'RUNTIME_COMMAND_FAILED'
      )
        throw new RuntimeError(
          'NODE_DEPENDENCY_BUILD_FAILED',
          409,
          e.exit_code,
        );
      throw e;
    }
    // Empty environments also own an independent modules directory.
    await this.paths.directory(
      this.paths.relative('build', build.id, build.environment_id) +
        '/node_modules',
      true,
    );
    if (
      artifacts &&
      closure &&
      tool.manager_type === 'PNPM' &&
      'pnpm_version' in closure
    )
      await this.normalizePnpmTsx(ctx, tool, build, artifacts, closure, root);
    const snapshot = await this.snapshot(ctx, runtime, tool, revision, build);
    if (
      snapshot.package_json !== manifest ||
      (frozen && snapshot.lock_hash !== frozen.lock_hash)
    )
      throw new RuntimeError('NODE_BUILD_SNAPSHOT_CHANGED');
    if (artifacts && snapshot.metadata.verified_artifacts) {
      const marker = await this.paths.marker('build', build.id);
      await this.paths.privateWrite(
        marker,
        JSON.stringify({
          ...(await this.paths.readJson(marker)),
          verified_inputs: snapshot.metadata.verified_artifacts,
        }),
      );
    }
    return snapshot;
  }
  private async normalizePnpmTsx(
    ctx: ProviderContext,
    tool: NodePackageManagerToolchain,
    build: NodeEnvironmentBuild,
    artifacts: VerifiedRuntimeArtifactStore,
    closure: Awaited<ReturnType<VerifiedRuntimeArtifactStore['pnpmClosure']>>,
    root: string,
  ) {
    const tsx = closure.packages
      .map((id) => artifacts.artifact(id))
      .filter((a) => a.npm_name === 'tsx');
    if (!tsx.length) return;
    // The service has already changed the newly allocated SQL row to INSTALLING;
    // its fetched immutable input can still carry the prior QUEUED state.
    if (
      tool.version !== '10.34.9' ||
      tsx.length !== 1 ||
      tsx[0].npm_version !== '4.23.15' ||
      !['QUEUED', 'INSTALLING'].includes(build.state) ||
      build.verified_at ||
      build.package_json !== '' ||
      build.lockfile !== '' ||
      build.metadata?.verified_artifacts
    )
      throw new RuntimeError('NODE_BUILD_INVALID');
    const owned = await this.paths.assertOwned(
      'build',
      build.id,
      build.environment_id,
    );
    if (owned !== root) throw new RuntimeError('NODE_BUILD_INVALID');
    const packageRoot = await artifacts.packageRoot(root, 'tsx');
    const modules = path.join(packageRoot, 'node_modules'),
      bins = path.join(modules, '.bin'),
      shim = path.join(bins, 'esbuild');
    const initial = await fs.lstat(modules).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!initial) return;
    for (const directory of [modules, bins]) {
      const stat = await fs.lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new RuntimeError('NODE_BUILD_INVALID');
    }
    if (
      JSON.stringify((await fs.readdir(modules)).sort()) !== '[".bin"]' ||
      JSON.stringify((await fs.readdir(bins)).sort()) !== '["esbuild"]'
    )
      throw new RuntimeError('NODE_BUILD_INVALID');
    const stat = await fs.lstat(shim);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size < 100 ||
      stat.size > 32768 ||
      !(stat.mode & 0o111)
    )
      throw new RuntimeError('NODE_BUILD_INVALID');
    // This manager-generated CLI wrapper is only needed while lifecycle scripts
    // run. TSX imports esbuild through the virtual-store dependency link. Remove
    // exactly the known wrapper before the first whole-package source digest;
    // neither snapshot nor READY verification ever performs this normalization.
    const text = await fs.readFile(shim, 'utf8');
    if (
      !text.startsWith('#!/bin/sh\n') ||
      !text.endsWith(
        '"$basedir/../../../esbuild/bin/esbuild"   "$@"\nexit $?\n',
      )
    )
      throw new RuntimeError('NODE_BUILD_INVALID');
    await fs.unlink(shim);
    await fs.rmdir(bins);
    await fs.rmdir(modules);
    await ctx.stage('NORMALIZED_PNPM_10_34_9_GENERATED_TSX_SHIM');
  }
  async snapshot(
    ctx: ProviderContext,
    runtime: RuntimeInstallation,
    tool: NodePackageManagerToolchain,
    revision: NodeEnvironmentRevision,
    build: NodeEnvironmentBuild,
  ) {
    await ctx.stage('VERIFYING_BUILD');
    await this.verify(ctx, runtime, tool);
    const run = await this.cli(ctx, runtime, tool),
      root = await this.paths.assertOwned(
        'build',
        build.id,
        build.environment_id,
      );
    const package_json = await this.paths.text(root, 'package.json'),
      lockfile = await this.paths.text(root, this.lockName(tool));
    if (package_json !== this.manifest(revision, tool))
      throw new RuntimeError('NODE_BUILD_INVALID');
    const parsed =
      tool.manager_type === 'PNPM' ? yamlLoad(lockfile) : JSON.parse(lockfile);
    if (!parsed || typeof parsed !== 'object' || !('lockfileVersion' in parsed))
      throw new RuntimeError('NODE_LOCKFILE_INVALID');
    await this.paths.directory(
      this.paths.relative('build', build.id, build.environment_id) +
        '/node_modules',
    );
    const raw = await ctx.command.run(
      run.node,
      [
        run.cli,
        tool.manager_type === 'PNPM' ? 'list' : 'ls',
        '--json',
        '--depth=100',
        ...(revision.production_only ? ['--prod'] : []),
      ],
      root,
      run.env,
      true,
    );
    const graph = JSON.parse(raw),
      packages = new Map<string, NodeResolvedPackage>();
    let count = 0;
    const visit = async (
      row: any,
      depth: number,
      type: string,
      optional = new Set<string>(),
    ): Promise<void> => {
      if (depth > 100 || ++count > 20000)
        throw new RuntimeError('NODE_GRAPH_LIMIT');
      for (const group of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
      ])
        for (const [key, value] of Object.entries(row[group] ?? {})) {
          const item = value as any,
            name = item.name ?? key,
            isOptional = group === 'optionalDependencies' || optional.has(key);
          // npm ls represents omitted platform-specific optional dependencies as {}.
          // Accept only an empty placeholder declared optional by the parent lock entry.
          if (
            tool.manager_type === 'NPM' &&
            item &&
            typeof item === 'object' &&
            Object.keys(item).length === 0 &&
            optional.has(key)
          )
            continue;
          if (
            typeof name !== 'string' ||
            typeof item.version !== 'string' ||
            item.missing ||
            item.invalid
          )
            throw new RuntimeError('NODE_DEPENDENCY_GRAPH_INVALID');
          const direct = depth === 0,
            dependency_type = direct
              ? group === 'devDependencies'
                ? 'DEV_DEPENDENCY'
                : 'DEPENDENCY'
              : type;
          let target: string | undefined;
          if (item.path) {
            try {
              target = await fs.realpath(item.path);
            } catch (error) {
              if (
                (error as NodeJS.ErrnoException).code === 'ENOENT' &&
                isOptional
              )
                continue;
              if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                throw new RuntimeError('NODE_DEPENDENCY_MISSING');
              throw error;
            }
            if (!target.startsWith(root + path.sep))
              throw new RuntimeError('NODE_PATH_INVALID');
          }
          const identity = name + '@' + item.version,
            old = packages.get(identity);
          packages.set(identity, {
            name,
            version: item.version,
            direct: direct || !!old?.direct,
            dependency_type: old?.direct
              ? old.dependency_type
              : dependency_type,
          });
          const optionalChildren = new Set<string>();
          if (target) {
            let packageManifest: any;
            try {
              packageManifest = JSON.parse(
                await fs.readFile(path.join(target, 'package.json'), 'utf8'),
              );
            } catch {
              throw new RuntimeError('NODE_DEPENDENCY_GRAPH_INVALID');
            }
            if (
              packageManifest.name !== name ||
              packageManifest.version !== item.version ||
              (packageManifest.optionalDependencies !== undefined &&
                (!packageManifest.optionalDependencies ||
                  typeof packageManifest.optionalDependencies !== 'object' ||
                  Array.isArray(packageManifest.optionalDependencies)))
            )
              throw new RuntimeError('NODE_DEPENDENCY_GRAPH_INVALID');
            for (const child of Object.keys(
              packageManifest.optionalDependencies ?? {},
            ))
              optionalChildren.add(child);
          }
          if (tool.manager_type === 'NPM')
            for (const [location, entry] of Object.entries(
              (parsed as any).packages ?? {},
            )) {
              const locked = entry as any;
              if (
                (location === `node_modules/${name}` ||
                  location.endsWith(`/node_modules/${name}`)) &&
                locked.version === item.version
              )
                for (const child of Object.keys(
                  locked.optionalDependencies ?? {},
                ))
                  optionalChildren.add(child);
            }
          await visit(item, depth + 1, dependency_type, optionalChildren);
        }
    };
    await visit(Array.isArray(graph) ? graph[0] : graph, 0, 'DEPENDENCY');
    // Inspect every symlink and package manifest, bounded; no per-file content hash claim.
    let entries = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (++entries > 250000) throw new RuntimeError('NODE_GRAPH_LIMIT');
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) {
          const target = await fs.realpath(p);
          if (!target.startsWith(root + path.sep))
            throw new RuntimeError('NODE_PATH_INVALID');
        } else if (e.isDirectory()) await walk(p);
        else if (!e.isFile()) throw new RuntimeError('NODE_PATH_INVALID');
      }
    };
    await walk(path.join(root, 'node_modules'));
    for (const dep of revision.dependencies.filter(
      (d) => !revision.production_only || d.type === 'DEPENDENCY',
    )) {
      const pkg = JSON.parse(
        await this.paths.text(
          root,
          'node_modules/' + dep.name + '/package.json',
        ),
      );
      if (pkg.name !== dep.name || !packages.has(pkg.name + '@' + pkg.version))
        throw new RuntimeError('NODE_DEPENDENCY_GRAPH_INVALID');
    }
    const resolved = [...packages.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );
    const metadata: Record<string, unknown> = {
      platform: process.platform,
      architecture: process.arch,
      node_version: runtime.version,
      manager_type: tool.manager_type,
      manager_version: tool.version,
      registry: this.registry,
      production_only: revision.production_only,
      install_scripts_policy: revision.install_scripts_policy,
      config_hash: nodeHash(await this.paths.text(root, '.npmrc')),
      workspace_hash:
        tool.manager_type === 'PNPM'
          ? nodeHash(await this.paths.text(root, 'pnpm-workspace.yaml'))
          : null,
    };
    const artifacts = VerifiedRuntimeArtifactStore.current(this.paths.dataRoot);
    let verified = build.metadata?.verified_artifacts as
      | Record<string, unknown>
      | undefined;
    if (!verified && artifacts && build.state !== 'READY') {
      const closure =
        tool.manager_type === 'PNPM'
          ? await artifacts.pnpmClosure(
              package_json,
              runtime.version,
              tool.version,
            )
          : await artifacts.npmClosure(
              package_json,
              runtime.version,
              tool.version,
            );
      verified = {
        schema: 1,
        kind: 'NODE_BUILD',
        manifest_sha256: artifacts.manifestSha256,
        trust_anchor_sha256: artifacts.trustAnchorSha256,
        lock_artifact_id: closure.lockfile,
        lock_artifact_sha256: artifacts.artifact(closure.lockfile).sha256,
        ...(closure.esbuild
          ? {
              esbuild_artifact_id: closure.esbuild.artifact,
              esbuild_sha256: artifacts.artifact(closure.esbuild.artifact)
                .sha256,
              esbuild_package: closure.esbuild.package_name,
              esbuild_publisher: artifacts.artifact(closure.esbuild.artifact)
                .publisher,
              esbuild_build_provenance: artifacts.artifact(
                closure.esbuild.artifact,
              ).provenance,
            }
          : {}),
      };
      const tsx = closure.packages
        .map((id) => artifacts.artifact(id))
        .filter((a) => a.npm_name === 'tsx');
      if (tsx.length > 1)
        throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
      if (tsx.length) {
        const proof = tsx[0].provenance;
        const tree = await runtimeTreeDigest(
          await artifacts.packageRoot(root, 'tsx'),
        );
        if (
          typeof proof?.cli_relative_path !== 'string' ||
          tree.sha256 !== proof.tree_sha256 ||
          tree.entry_count !== proof.tree_entry_count ||
          (await nodeFileHash(
            await this.paths.file(root, 'node_modules/tsx/dist/cli.mjs'),
          )) !== proof.cli_sha256
        )
          throw new RuntimeError('NODE_BUILD_INVALID');
        Object.assign(verified, {
          tsx_artifact_id: tsx[0].id,
          tsx_cli_relative_path: proof.cli_relative_path,
          tsx_cli_sha256: proof.cli_sha256,
          tsx_tree_sha256: proof.tree_sha256,
        });
      }
    }
    if (verified) {
      if (
        typeof verified !== 'object' ||
        Array.isArray(verified) ||
        !/^[a-f0-9]{64}$/.test(String(verified.manifest_sha256))
      )
        throw new RuntimeError('NODE_BUILD_INVALID');
      if (verified.esbuild_sha256) {
        if (
          !/^[a-f0-9]{64}$/.test(String(verified.esbuild_sha256)) ||
          verified.esbuild_package !==
            '@esbuild/' + process.platform + '-' + process.arch
        )
          throw new RuntimeError('NODE_BUILD_INVALID');
        const mainRoot = artifacts
          ? await artifacts.packageRoot(
              root,
              'esbuild',
              revision.dependencies.some((d) => d.name === 'tsx')
                ? await artifacts.packageRoot(root, 'tsx')
                : root,
            )
          : path.join(root, 'node_modules/esbuild');
        const binaryRoot = artifacts
          ? await artifacts.packageRoot(
              root,
              String(verified.esbuild_package),
              mainRoot,
            )
          : path.join(root, 'node_modules', String(verified.esbuild_package));
        for (const target of [
          path.join(binaryRoot, 'bin/esbuild'),
          path.join(mainRoot, 'bin/esbuild'),
        ])
          if (
            (await nodeFileHash(
              await this.paths.file(
                root,
                path.relative(root, target).split(path.sep).join('/'),
              ),
            )) !== verified.esbuild_sha256
          )
            throw new RuntimeError('NODE_BUILD_INVALID');
      }
      Object.assign(metadata, { verified_artifacts: verified });
    }
    return {
      package_json,
      lockfile,
      lock_hash: nodeHash(lockfile),
      resolved,
      resolved_hash: nodeHash(JSON.stringify(resolved)),
      metadata,
    };
  }
  async verifyBuild(
    ctx: ProviderContext,
    runtime: RuntimeInstallation,
    tool: NodePackageManagerToolchain,
    revision: NodeEnvironmentRevision,
    build: NodeEnvironmentBuild,
  ) {
    const root = await this.paths.assertOwned(
      'build',
      build.id,
      build.environment_id,
    );
    if (
      nodeHash(await this.paths.text(root, this.lockName(tool))) !==
        build.lock_hash ||
      (await this.paths.text(root, 'package.json')) !== build.package_json ||
      nodeHash(await this.paths.text(root, '.npmrc')) !==
        build.metadata.config_hash ||
      (tool.manager_type === 'PNPM' &&
        nodeHash(await this.paths.text(root, 'pnpm-workspace.yaml')) !==
          build.metadata.workspace_hash)
    )
      throw new RuntimeError('NODE_BUILD_INVALID');
    const result = await this.snapshot(ctx, runtime, tool, revision, build);
    if (
      build.lock_hash !== result.lock_hash ||
      build.resolved_hash !== result.resolved_hash ||
      JSON.stringify(build.metadata) !== JSON.stringify(result.metadata)
    )
      throw new RuntimeError('NODE_BUILD_INVALID');
    return result;
  }
}
