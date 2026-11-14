import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import RuntimePathResolver from './runtimePaths';
import { RuntimeCommand } from './runtimeProcess';
import { RuntimeInstallation } from '../data/runtime';
import {
  RuntimeError,
  exactPythonVersion,
  PYENV_RELEASE,
  PYENV_REVISION,
  PYENV_SOURCE,
} from '../shared/runtime';
import { VerifiedRuntimeArtifactStore } from './runtimeArtifacts';
import { currentRuntimeDomain } from './runtimeDomainScope';

export interface ProviderContext {
  id: number;
  providerId: number;
  directory: string;
  environment: NodeJS.ProcessEnv;
  command: RuntimeCommand;
  stage: (stage: string) => Promise<void>;
}
export function parsePythonCatalog(output: string) {
  if (Buffer.byteLength(output) > 1024 * 1024)
    throw new RuntimeError('RUNTIME_CATALOG_INVALID');
  const versions = new Set<string>();
  for (const row of output.split(/\r?\n/)) {
    const value = row.trim();
    try {
      versions.add(exactPythonVersion(value));
    } catch {
      /* Other implementations/pre-releases are not installable. */
    }
  }
  if (!versions.size || versions.size > 5000)
    throw new RuntimeError('RUNTIME_CATALOG_INVALID');
  return [...versions].sort((a, b) => {
    const aa = a.split('.').map(Number),
      bb = b.split('.').map(Number);
    return bb[0] - aa[0] || bb[1] - aa[1] || bb[2] - aa[2];
  });
}
const diagnostic =
  'import json,sys,platform,ssl,_ssl,_hashlib,zlib,_sqlite3\n' +
  'sqlite_source_id=_sqlite3.connect(":memory:").execute("SELECT sqlite_source_id()").fetchone()[0]\n' +
  'print(json.dumps(dict(executable=sys.executable,version=list(sys.version_info[:3]),version_text=sys.version,prefix=sys.prefix,base_prefix=sys.base_prefix,implementation=platform.python_implementation(),machine=platform.machine(),system=platform.system(),openssl_version=ssl.OPENSSL_VERSION,zlib_version=zlib.ZLIB_RUNTIME_VERSION,ssl_module=_ssl.__file__,hashlib_module=_hashlib.__file__,zlib_module=zlib.__file__,sqlite_module=_sqlite3.__file__,default_verify_paths=ssl.get_default_verify_paths()._asdict(),sqlite_version=_sqlite3.sqlite_version,sqlite_source_id=sqlite_source_id)))';
const legacyDiagnostic =
  'import json,sys,platform; print(json.dumps(dict(executable=sys.executable,version=list(sys.version_info[:3]),version_text=sys.version,prefix=sys.prefix,base_prefix=sys.base_prefix,implementation=platform.python_implementation(),machine=platform.machine(),system=platform.system())))';

/** Trusted, pinned pyenv source; standalone python-build avoids host pyenv hooks/shims. */
export default class PyenvProvider {
  readonly revision = PYENV_REVISION;
  readonly release = PYENV_RELEASE;
  constructor(readonly paths = new RuntimePathResolver()) {}
  async code(ctx: ProviderContext, revision: string) {
    await this.paths.provider(false, ctx.providerId);
    const code = await this.paths.code(revision);
    await this.paths.directory(
      'runtime/python/pyenv/providers/' + revision + '/.git',
    );
    for (const relative of [
      'libexec/pyenv',
      'plugins/python-build/bin/python-build',
    ]) {
      const absolute = path.join(code, relative);
      await this.paths.directory(
        'runtime/python/pyenv/providers/' +
          revision +
          '/' +
          path.dirname(relative),
      );
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111))
        throw new RuntimeError('RUNTIME_PROVIDER_INVALID');
    }
    return code;
  }
  async setup(ctx: ProviderContext, repair = false) {
    const artifacts = VerifiedRuntimeArtifactStore.current(this.paths.dataRoot);
    if (!artifacts && currentRuntimeDomain())
      throw new RuntimeError('RUNTIME_ARTIFACT_TRUST_CONFIGURATION_REQUIRED');
    await ctx.stage('FETCHING_PROVIDER');
    const stage = path.join(ctx.directory, 'provider-stage');
    if (artifacts) {
      await artifacts.extract(
        ctx,
        artifacts.pythonProvider(this.revision),
        stage,
      );
    } else {
      await fs.mkdir(stage, { mode: 0o700 });
    }
    const git = (args: string[]) =>
      ctx.command.run('git', args, stage, ctx.environment, true);
    if (!artifacts) {
      await git(['init', '--quiet']);
      await git(['fetch', '--depth=1', PYENV_SOURCE, this.revision]);
      await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    }
    if ((await git(['rev-parse', 'HEAD'])).trim() !== this.revision)
      throw new RuntimeError('RUNTIME_PROVIDER_INVALID');
    for (const relative of ['.git', 'libexec', 'plugins/python-build/bin']) {
      await this.paths.directory(
        `tmp/runtime/python/operation-${ctx.id}/provider-stage/${relative}`,
      );
    }
    for (const relative of [
      'libexec/pyenv',
      'plugins/python-build/bin/python-build',
    ]) {
      const stat = await fs.lstat(path.join(stage, relative));
      if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111))
        throw new RuntimeError('RUNTIME_PROVIDER_INVALID');
    }
    const stagedVersion = await ctx.command.run(
      path.join(stage, 'libexec/pyenv'),
      ['--version'],
      ctx.directory,
      ctx.environment,
      true,
    );
    if (!/^pyenv \d+\./.test(stagedVersion.trim()))
      throw new RuntimeError('RUNTIME_PROVIDER_INVALID');
    const target = await this.paths.code(this.revision, true);
    let exists = true;
    try {
      await fs.lstat(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      exists = false;
    }
    if (exists) {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new RuntimeError('RUNTIME_PATH_INVALID');
      if (!repair) {
        await this.verifyProvider(ctx, this.revision);
        return { revision: this.revision, release: this.release };
      }
      // Only provider code moves; versions and ownership records are siblings.
      const quarantine = await this.paths.quarantine(ctx.id);
      await fs.rename(
        target,
        path.join(quarantine, 'provider-' + this.revision),
      );
    }
    await fs.rename(stage, target);
    await this.verifyProvider(ctx, this.revision);
    return { revision: this.revision, release: this.release };
  }
  async verifyProvider(ctx: ProviderContext, revision: string) {
    const code = await this.code(ctx, revision);
    const head = await ctx.command.run(
      'git',
      [
        '--git-dir=' + path.join(code, '.git'),
        '--work-tree=' + code,
        '-c',
        'core.fsmonitor=false',
        'rev-parse',
        'HEAD',
      ],
      code,
      ctx.environment,
      true,
    );
    if (head.trim() !== revision)
      throw new RuntimeError('RUNTIME_PROVIDER_INVALID');
    const dirty = await ctx.command.run(
      'git',
      [
        '--git-dir=' + path.join(code, '.git'),
        '--work-tree=' + code,
        '-c',
        'core.fsmonitor=false',
        'status',
        '--porcelain',
        '--untracked-files=normal',
      ],
      code,
      ctx.environment,
      true,
    );
    if (dirty.trim()) throw new RuntimeError('RUNTIME_PROVIDER_INVALID');
    const result = await ctx.command.run(
      path.join(code, 'libexec/pyenv'),
      ['--version'],
      ctx.directory,
      ctx.environment,
      true,
    );
    if (!/^pyenv \d+\./.test(result.trim()))
      throw new RuntimeError('RUNTIME_PROVIDER_INVALID');
    return result.trim();
  }
  async catalog(ctx: ProviderContext, revision: string) {
    const code = await this.code(ctx, revision);
    const output = await ctx.command.run(
      path.join(code, 'plugins/python-build/bin/python-build'),
      ['--definitions'],
      ctx.directory,
      ctx.environment,
      true,
    );
    const artifacts = VerifiedRuntimeArtifactStore.current(this.paths.dataRoot);
    return parsePythonCatalog(output).filter(
      (version) =>
        !artifacts ||
        artifacts.manifest.python.some(
          (p) => p.version === version && p.provider_revision === revision,
        ),
    );
  }
  async install(
    ctx: ProviderContext,
    runtime: RuntimeInstallation,
    revision: string,
  ) {
    const artifacts = VerifiedRuntimeArtifactStore.current(this.paths.dataRoot);
    if (!artifacts && currentRuntimeDomain())
      throw new RuntimeError('RUNTIME_ARTIFACT_TRUST_CONFIGURATION_REQUIRED');
    const code = await this.code(ctx, revision);
    const target = await this.paths.createInstallation(
      runtime.version,
      runtime.id,
      ctx.providerId,
    );
    const environment = artifacts
      ? await artifacts.preparePython(ctx, runtime.version, revision)
      : ctx.environment;
    await ctx.stage('BUILDING');
    await ctx.command.run(
      path.join(code, 'plugins/python-build/bin/python-build'),
      ['-v', exactPythonVersion(runtime.version), target],
      ctx.directory,
      environment,
    );
    await ctx.stage('VERIFYING');
    const metadata = await this.verify(ctx, runtime, true);
    if (!artifacts) return metadata;
    const profile = artifacts.manifest.python.find(
      (p) => p.version === runtime.version && p.provider_revision === revision,
    )!;
    const verifiedInputs = {
      schema: 1,
      kind: 'PYTHON_RUNTIME',
      manifest_sha256: artifacts.manifestSha256,
      trust_anchor_sha256: artifacts.trustAnchorSha256,
      provider_artifact_id: artifacts.pythonProvider(revision),
      definition_artifact_id: profile.definition,
      source_artifact_ids: artifacts
        .pythonSources(runtime.version, revision)
        .map((s) => s.artifact),
      ca_bundle_artifact_id: profile.ca_bundle,
      executable_sha256: metadata.executable_sha256,
      ssl_module_sha256: metadata.ssl_module_sha256,
      hashlib_module_sha256: metadata.hashlib_module_sha256,
      zlib_module_sha256: metadata.zlib_module_sha256,
      openssl_version: metadata.openssl_version,
      zlib_version: metadata.zlib_version,
      ca_bundle_sha256: artifacts.artifact(profile.ca_bundle).sha256,
      sqlite_artifact_id: profile.sqlite,
      sqlite_module_sha256: metadata.sqlite_module_sha256,
      sqlite_version: metadata.sqlite_version,
      sqlite_source_id: metadata.sqlite_source_id,
      pip_artifact_id: metadata.pip_artifact_id,
      pip_wheel_sha256: metadata.pip_wheel_sha256,
      pip_init_sha256: metadata.pip_init_sha256,
      pip_vendor_manifest_sha256: metadata.pip_vendor_manifest_sha256,
      pip_version: metadata.pip_version,
    };
    const marker = await this.paths.ownership(runtime.id);
    await this.paths.privateWrite(
      marker,
      JSON.stringify({
        ...(await this.paths.readJson(marker)),
        verified_inputs: verifiedInputs,
      }),
    );
    return {
      ...metadata,
      ...(artifacts
        ? {
            verified_provider: artifacts.provenance(
              artifacts.pythonProvider(revision),
            ),
            verified_sources: artifacts
              .pythonSources(runtime.version, revision)
              .map((s) => artifacts.provenance(s.artifact)),
            verified_inputs: verifiedInputs,
          }
        : {}),
    };
  }
  async verify(
    ctx: ProviderContext,
    runtime: RuntimeInstallation,
    newInstallation = false,
  ): Promise<Record<string, unknown> & { executable_sha256: string }> {
    const { root, executable } = await this.paths.executable(
      runtime.version,
      runtime.id,
      ctx.providerId,
    );
    const handle = await fs.open(
      executable,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let checksum: string;
    try {
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      checksum = hash.digest('hex');
    } finally {
      await handle.close();
    }
    if (
      !newInstallation &&
      runtime.metadata.executable_sha256 &&
      runtime.metadata.executable_sha256 !== checksum
    )
      throw new RuntimeError('RUNTIME_VERIFY_FAILED');
    let metadata: any;
    try {
      metadata = JSON.parse(
        await ctx.command.run(
          executable,
          [
            '-I',
            '-S',
            '-c',
            VerifiedRuntimeArtifactStore.current(this.paths.dataRoot)
              ? diagnostic
              : legacyDiagnostic,
          ],
          ctx.directory,
          ctx.environment,
          true,
        ),
      );
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('RUNTIME_VERIFY_FAILED');
    }
    if (
      metadata.implementation !== 'CPython' ||
      !Array.isArray(metadata.version) ||
      metadata.version.join('.') !== runtime.version ||
      typeof metadata.executable !== 'string' ||
      typeof metadata.prefix !== 'string' ||
      typeof metadata.base_prefix !== 'string'
    )
      throw new RuntimeError('RUNTIME_VERIFY_FAILED');
    if (
      (await fs.realpath(metadata.executable)) !== executable ||
      (await fs.realpath(metadata.prefix)) !== root ||
      (await fs.realpath(metadata.base_prefix)) !== root
    )
      throw new RuntimeError('RUNTIME_VERIFY_FAILED');
    const artifacts = VerifiedRuntimeArtifactStore.current(this.paths.dataRoot);
    const facts: Record<string, unknown> = {};
    if (artifacts) {
      Object.assign(
        facts,
        await artifacts.verifyPythonPip(ctx, executable, runtime.version),
      );
      const profiles = artifacts.manifest.python.filter(
        (p) =>
          p.version === runtime.version &&
          p.provider_revision === this.revision,
      );
      const profile = profiles.length === 1 ? profiles[0] : undefined;
      if (
        !profile ||
        String(metadata.openssl_version).match(
          /^OpenSSL (\d+\.\d+\.\d+)(?:\s|$)/,
        )?.[1] !== artifacts.artifact(profile.openssl).version ||
        metadata.zlib_version !== artifacts.artifact(profile.zlib).version ||
        metadata.sqlite_version !==
          artifacts.artifact(profile.sqlite).version ||
        metadata.sqlite_source_id !==
          artifacts.artifact(profile.sqlite).provenance?.sqlite_source_id
      )
        throw new RuntimeError('RUNTIME_CRYPTO_VERIFY_FAILED');
      const linked: Record<string, string[]> = {};
      for (const name of ['ssl', 'hashlib', 'zlib', 'sqlite']) {
        const module = await fs.realpath(metadata[name + '_module']);
        if (!module.startsWith(root + path.sep))
          throw new RuntimeError('RUNTIME_VERIFY_FAILED');
        const relative = path.relative(root, module).split(path.sep).join('/');
        await this.paths.directory(
          path
            .relative(await this.paths.root(), path.dirname(module))
            .split(path.sep)
            .join('/'),
        );
        const digest = await artifacts.digestFile(module);
        facts[name + '_module_relative'] = relative;
        facts[name + '_module_sha256'] = digest.sha256;
        const output = await ctx.command.run(
          process.platform === 'darwin' ? '/usr/bin/otool' : '/usr/bin/ldd',
          process.platform === 'darwin' ? ['-L', module] : [module],
          ctx.directory,
          ctx.environment,
          true,
        );
        const lines = output
          .split(/\r?\n/)
          .slice(process.platform === 'darwin' ? 1 : 0);
        linked[name] = [
          ...new Set(
            lines
              .map((line) => line.trim().split(/\s+/)[0])
              .filter(Boolean)
              .map((file) => path.basename(file)),
          ),
        ].sort();
        if (
          !linked[name].length ||
          linked[name].some((file) =>
            /^lib(?:ssl|crypto|sqlite3)(?:[.-]|$)|^libz(?:[.-]|$)/i.test(file),
          )
        )
          throw new RuntimeError('RUNTIME_CRYPTO_VERIFY_FAILED');
      }
      const cert = await fs.realpath(metadata.default_verify_paths.cafile);
      if (!cert.startsWith(root + path.sep))
        throw new RuntimeError('RUNTIME_CRYPTO_VERIFY_FAILED');
      const digest = await artifacts.digestFile(cert);
      if (digest.sha256 !== artifacts.artifact(profile.ca_bundle).sha256)
        throw new RuntimeError('RUNTIME_CRYPTO_VERIFY_FAILED');
      Object.assign(facts, {
        openssl_version: metadata.openssl_version,
        zlib_version: metadata.zlib_version,
        default_certfile_relative: path
          .relative(root, cert)
          .split(path.sep)
          .join('/'),
        linked_library_names: linked,
        python_sqlite_version: metadata.sqlite_version,
        sqlite_version: metadata.sqlite_version,
        sqlite_source_id: metadata.sqlite_source_id,
      });
    }
    return {
      disk_usage_bytes: await this.paths.diskUsage(root),
      version_text: metadata.version_text,
      version: runtime.version,
      implementation: 'CPython',
      platform: metadata.system,
      architecture: metadata.machine,
      executable_sha256: checksum,
      ...facts,
    };
  }
  async uninstall(ctx: ProviderContext, runtime: RuntimeInstallation) {
    const target = await this.paths.version(runtime.version, ctx.providerId);
    try {
      await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await this.paths.assertInstallation(
      runtime.version,
      runtime.id,
      ctx.providerId,
    );
    await fs.rm(target, { recursive: true });
    await fs.rm(await this.paths.ownership(runtime.id), { force: true });
    if (
      await fs.lstat(target).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      )
    )
      throw new RuntimeError('RUNTIME_REMOVE_FAILED');
  }
  async repair(
    ctx: ProviderContext,
    runtime: RuntimeInstallation,
    revision: string,
  ) {
    const target = await this.paths.version(runtime.version, ctx.providerId);
    let exists = true;
    try {
      await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exists = false;
    }
    if (exists) {
      await this.paths.assertInstallation(
        runtime.version,
        runtime.id,
        ctx.providerId,
      );
      const quarantine = await this.paths.quarantine(ctx.id);
      await this.paths.privateWrite(
        path.join(quarantine, 'ownership.json'),
        JSON.stringify(
          await this.paths.readJson(await this.paths.ownership(runtime.id)),
        ),
      );
      await fs.rename(target, path.join(quarantine, 'runtime-' + runtime.id));
    }
    return this.install(ctx, runtime, revision);
  }
}
