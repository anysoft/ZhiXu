import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
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
  constructor(readonly store: WorkspaceStore) {
    this.paths = new RuntimePathResolver(store.dataRoot);
    this.python = new PythonEnvironmentPathResolver(this.paths);
    this.node = new NodePathResolver(store.dataRoot);
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
