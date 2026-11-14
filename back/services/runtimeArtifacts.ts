import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { load as yamlLoad } from 'js-yaml';
import config from '../config';
import { observeChildProcess } from '../shared/childProcess';
import { RuntimeError, RUNTIME_TOOL_PATH } from '../shared/runtime';
import { currentRuntimeDomain } from './runtimeDomainScope';
import type { ProviderContext } from './pyenvProvider';

export interface RuntimeArtifactOptions {
  mode: 'ONLINE_VERIFIED' | 'OFFLINE_VERIFIED';
  storeRoot: string;
  trustAnchorPath: string;
  manifestPath: string;
  excludedRoots?: readonly string[];
}
export interface RuntimeArtifact {
  id: string;
  provider: string;
  publisher: string;
  source_url: string;
  version: string;
  os: string;
  architecture: string;
  format: 'tar.gz' | 'tar.xz' | 'json' | 'text' | 'binary';
  sha256: string;
  size: number;
  signature_status:
    | 'SIGNATURE_NOT_AVAILABLE'
    | 'SIGNATURE_NOT_VERIFIED'
    | 'VERIFIED_BY_ACQUISITION';
  acquisition:
    | 'UPSTREAM_BYTES'
    | 'VERIFIED_REBUILD'
    | 'VERIFIED_SOURCE_SNAPSHOT';
  prefix?: string;
  npm_name?: string;
  npm_version?: string;
  integrity?: string;
  provenance?: Record<string, unknown>;
}
interface NodeArtifacts {
  version: string;
  archive: string;
  npm: string;
}
interface PythonArtifacts {
  version: string;
  provider_revision: string;
  provider_archive: string;
  definition: string;
  openssl: string;
  zlib: string;
  sqlite: string;
  pip_wheel: string;
  ca_bundle: string;
  sources: { artifact: string; cache_name: string }[];
}
interface NpmArtifacts {
  runtime_version: string;
  npm_version: string;
  package_json_sha256: string;
  lockfile: string;
  packages: string[];
  esbuild?: { artifact: string; package_name: string; version: string };
}
interface PnpmArtifacts extends Omit<NpmArtifacts, 'npm_version'> {
  pnpm_version: string;
  toolchain: string;
}
export interface RuntimeArtifactManifest {
  schema: 1;
  release_id: string;
  os: string;
  architecture: string;
  created_at: string;
  artifacts: RuntimeArtifact[];
  node: NodeArtifacts[];
  python: PythonArtifacts[];
  npm: NpmArtifacts[];
  pnpm?: PnpmArtifacts[];
}

/**
 * An administrator-selected, independently pinned manifest authenticates inputs.
 * Imported bytes never create or extend the trust anchor. This is not a Runtime
 * installation cache: ordinary Providers still install, build, verify and publish.
 */
export class VerifiedRuntimeArtifactStore {
  private constructor(
    readonly options: RuntimeArtifactOptions,
    readonly dataRoot: string,
    readonly manifest: RuntimeArtifactManifest,
    readonly manifestSha256: string,
    readonly trustAnchorSha256: string,
  ) {}
  static current(dataRoot: string) {
    const store = currentRuntimeDomain()?.artifacts;
    if (store && path.resolve(dataRoot) !== store.dataRoot)
      throw new RuntimeError('RUNTIME_ARTIFACT_DOMAIN_MISMATCH');
    return store;
  }
  static async assertPath(target: string, directory = false) {
    if (!path.isAbsolute(target) || path.resolve(target) !== target)
      throw new RuntimeError('RUNTIME_ARTIFACT_PATH_INVALID');
    let cursor = path.parse(target).root;
    for (const component of target.slice(cursor.length).split(path.sep)) {
      if (!component) continue;
      cursor = path.join(cursor, component);
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || (cursor !== target && !stat.isDirectory()))
        throw new RuntimeError('RUNTIME_ARTIFACT_PATH_INVALID');
    }
    const stat = await fs.lstat(target);
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      throw new RuntimeError('RUNTIME_ARTIFACT_PATH_INVALID');
    return stat;
  }
  static async readSafe(target: string, maximum = 4 * 1024 * 1024) {
    await this.assertPath(target);
    const file = await fs.open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > maximum)
        throw new RuntimeError('RUNTIME_ARTIFACT_PATH_INVALID');
      const bytes = await file.readFile();
      const after = await file.stat();
      if (bytes.length !== before.size || before.ctimeMs !== after.ctimeMs)
        throw new RuntimeError('RUNTIME_ARTIFACT_CHANGED');
      return bytes;
    } finally {
      await file.close();
    }
  }
  static parseManifest(bytes: Buffer): RuntimeArtifactManifest {
    let m: RuntimeArtifactManifest;
    try {
      m = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new RuntimeError('RUNTIME_ARTIFACT_MANIFEST_INVALID');
    }
    if (
      !m ||
      m.schema !== 1 ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(m.release_id) ||
      m.os !== process.platform ||
      m.architecture !== process.arch ||
      !Array.isArray(m.artifacts) ||
      !m.artifacts.length ||
      m.artifacts.length > 4096 ||
      !Array.isArray(m.node) ||
      !Array.isArray(m.python) ||
      !Array.isArray(m.npm) ||
      !Number.isFinite(Date.parse(m.created_at))
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_MANIFEST_INVALID');
    const ids = new Set<string>();
    let size = 0;
    for (const a of m.artifacts) {
      if (
        !a ||
        !/^[a-zA-Z0-9._-]{1,100}$/.test(a.id) ||
        ids.has(a.id) ||
        !/^[a-f0-9]{64}$/.test(a.sha256) ||
        !Number.isSafeInteger(a.size) ||
        a.size <= 0 ||
        a.size > 512 * 1024 * 1024 ||
        !['tar.gz', 'tar.xz', 'json', 'text', 'binary'].includes(a.format) ||
        ![
          'UPSTREAM_BYTES',
          'VERIFIED_REBUILD',
          'VERIFIED_SOURCE_SNAPSHOT',
        ].includes(a.acquisition) ||
        ![
          'SIGNATURE_NOT_AVAILABLE',
          'SIGNATURE_NOT_VERIFIED',
          'VERIFIED_BY_ACQUISITION',
        ].includes(a.signature_status) ||
        ![m.os, 'any'].includes(a.os) ||
        ![m.architecture, 'any'].includes(a.architecture) ||
        ![a.provider, a.publisher, a.version].every(
          (x) =>
            typeof x === 'string' &&
            x.length > 0 &&
            x.length < 500 &&
            !/[\x00-\x1f]/.test(x),
        ) ||
        ((a.format === 'tar.gz' || a.format === 'tar.xz') &&
          !/^[a-zA-Z0-9._+-]{1,150}$/.test(a.prefix || ''))
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_MANIFEST_INVALID');
      let u: URL;
      try {
        u = new URL(a.source_url);
      } catch {
        throw new RuntimeError('RUNTIME_ARTIFACT_SOURCE_INVALID');
      }
      if (
        u.protocol !== 'https:' ||
        u.username ||
        u.password ||
        u.hash ||
        u.search
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_SOURCE_INVALID');
      ids.add(a.id);
      size += a.size;
    }
    if (size > 4 * 1024 * 1024 * 1024)
      throw new RuntimeError('RUNTIME_ARTIFACT_PACKAGE_LIMIT');
    const ref = (id: string) => {
      if (!ids.has(id))
        throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
    };
    for (const n of m.node) {
      if (!/^\d+\.\d+\.\d+$/.test(n.version))
        throw new RuntimeError('RUNTIME_ARTIFACT_MANIFEST_INVALID');
      ref(n.archive);
      ref(n.npm);
    }
    for (const p of m.python) {
      if (
        !/^3\.\d+\.\d+$/.test(p.version) ||
        !/^[a-f0-9]{40}$/.test(p.provider_revision) ||
        !Array.isArray(p.sources) ||
        !p.sources.length
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_MANIFEST_INVALID');
      ref(p.provider_archive);
      for (const id of [
        p.definition,
        p.openssl,
        p.zlib,
        p.sqlite,
        p.ca_bundle,
        p.pip_wheel,
      ])
        ref(id);
      for (const s of p.sources) {
        ref(s.artifact);
        if (!/^[a-zA-Z0-9._+-]{1,200}$/.test(s.cache_name))
          throw new RuntimeError('RUNTIME_ARTIFACT_MANIFEST_INVALID');
      }
    }
    if (m.pnpm !== undefined && !Array.isArray(m.pnpm))
      throw new RuntimeError('RUNTIME_ARTIFACT_MANIFEST_INVALID');
    for (const n of [...m.npm, ...(m.pnpm ?? [])]) {
      const version = 'npm_version' in n ? n.npm_version : n.pnpm_version;
      if (
        !/^\d+\.\d+\.\d+$/.test(n.runtime_version) ||
        !/^\d+\.\d+\.\d+$/.test(version) ||
        !/^[a-f0-9]{64}$/.test(n.package_json_sha256) ||
        !Array.isArray(n.packages)
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_MANIFEST_INVALID');
      if ('toolchain' in n) ref(n.toolchain);
      ref(n.lockfile);
      for (const id of n.packages) ref(id);
      if (n.esbuild) ref(n.esbuild.artifact);
    }
    return m;
  }
  static async open(options: RuntimeArtifactOptions, dataRoot: string) {
    if (
      !options ||
      !['ONLINE_VERIFIED', 'OFFLINE_VERIFIED'].includes(options.mode)
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_POLICY_INVALID');
    const data = path.resolve(dataRoot),
      root = options.storeRoot;
    const excluded = [
      data,
      data + '.platform-control',
      data + '-backups',
      ...(options.excludedRoots ?? []),
    ];
    // A lexical boundary is insufficient if an existing DataRoot or backup
    // ancestor aliases the artifact directory. Fresh not-yet-created roots are
    // allowed, while every existing domain component must be a real directory.
    for (const target of excluded) {
      if (!path.isAbsolute(target) || path.resolve(target) !== target)
        throw new RuntimeError('RUNTIME_ARTIFACT_POLICY_INVALID');
      let cursor = path.parse(target).root;
      for (const component of target.slice(cursor.length).split(path.sep)) {
        if (!component) continue;
        cursor = path.join(cursor, component);
        let stat;
        try {
          stat = await fs.lstat(cursor);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
          throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new RuntimeError('RUNTIME_ARTIFACT_PATH_INVALID');
      }
    }
    for (const file of [root, options.trustAnchorPath, options.manifestPath])
      this.assertIdentity(file, excluded);
    if (
      data.startsWith(root + path.sep) ||
      options.trustAnchorPath === options.manifestPath ||
      options.trustAnchorPath.startsWith(root + path.sep) ||
      options.trustAnchorPath.startsWith(
        path.dirname(options.manifestPath) + path.sep,
      )
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_TRUST_NOT_INDEPENDENT');
    const ast = await this.assertPath(options.trustAnchorPath);
    if (
      ast.mode & 0o022 ||
      (process.getuid && ![0, process.getuid()].includes(ast.uid))
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_TRUST_UNPROTECTED');
    let trustDirectory = path.dirname(options.trustAnchorPath);
    while (true) {
      const parent = await this.assertPath(trustDirectory, true);
      if (
        (process.getuid && ![0, process.getuid()].includes(parent.uid)) ||
        ((parent.mode & 0o022) !== 0 &&
          !(parent.uid === 0 && parent.mode & 0o1000))
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_TRUST_UNPROTECTED');
      const next = path.dirname(trustDirectory);
      if (next === trustDirectory) break;
      trustDirectory = next;
    }
    const anchorBytes = await this.readSafe(options.trustAnchorPath);
    const manifestBytes = await this.readSafe(options.manifestPath);
    let anchor: {
      schema: number;
      authority: string;
      approved_manifest_sha256: string[];
    };
    try {
      anchor = JSON.parse(anchorBytes.toString('utf8'));
    } catch {
      throw new RuntimeError('RUNTIME_ARTIFACT_TRUST_INVALID');
    }
    const manifestHash = createHash('sha256')
      .update(manifestBytes)
      .digest('hex');
    if (
      anchor.schema !== 1 ||
      typeof anchor.authority !== 'string' ||
      !anchor.authority.trim() ||
      !Array.isArray(anchor.approved_manifest_sha256) ||
      anchor.approved_manifest_sha256.length > 1024 ||
      !anchor.approved_manifest_sha256.every((x) => /^[a-f0-9]{64}$/.test(x)) ||
      !anchor.approved_manifest_sha256.includes(manifestHash)
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_UNTRUSTED');
    const manifest = this.parseManifest(manifestBytes);
    await this.assertPath(path.dirname(root), true);
    await fs.mkdir(root, { mode: 0o700 }).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
    const st = await this.assertPath(root, true);
    if ((process.getuid && st.uid !== process.getuid()) || st.mode & 0o077)
      throw new RuntimeError('RUNTIME_ARTIFACT_STORE_INVALID');
    const ownerPath = path.join(root, '.artifact-owner.json');
    try {
      const owner = JSON.parse(
        (await this.readSafe(ownerPath)).toString('utf8'),
      );
      if (
        owner.owner !== 'zhixu-runtime-artifacts' ||
        owner.dev !== st.dev ||
        owner.ino !== st.ino
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_STORE_INVALID');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if ((await fs.readdir(root)).length)
        throw new RuntimeError('RUNTIME_ARTIFACT_STORE_INVALID');
      await fs.writeFile(
        ownerPath,
        JSON.stringify({
          owner: 'zhixu-runtime-artifacts',
          dev: st.dev,
          ino: st.ino,
          nonce: randomUUID(),
        }),
        { flag: 'wx', mode: 0o600 },
      );
    }
    for (const name of ['objects', 'imports', 'staging']) {
      const child = path.join(root, name);
      await fs.mkdir(child, { mode: 0o700 }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const cs = await this.assertPath(child, true);
      if ((process.getuid && cs.uid !== process.getuid()) || cs.mode & 0o077)
        throw new RuntimeError('RUNTIME_ARTIFACT_STORE_INVALID');
    }
    const pending: object[] = [manifest];
    while (pending.length) {
      const value = pending.pop()!;
      for (const child of Object.values(value))
        if (child && typeof child === 'object') pending.push(child);
      Object.freeze(value);
    }
    return Object.freeze(
      new VerifiedRuntimeArtifactStore(
        Object.freeze({ ...options, excludedRoots: Object.freeze(excluded) }),
        data,
        manifest,
        manifestHash,
        createHash('sha256').update(anchorBytes).digest('hex'),
      ),
    );
  }
  static assertIdentity(target: string, roots: readonly string[]) {
    if (!path.isAbsolute(target) || path.resolve(target) !== target)
      throw new RuntimeError('RUNTIME_ARTIFACT_PATH_INVALID');
    for (const root of roots) {
      if (!path.isAbsolute(root) || path.resolve(root) !== root)
        throw new RuntimeError('RUNTIME_ARTIFACT_POLICY_INVALID');
      if (
        target === root ||
        target.startsWith(root + path.sep) ||
        root.startsWith(target + path.sep)
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_DOMAIN_MISMATCH');
    }
  }
  async digestFile(file: string) {
    await VerifiedRuntimeArtifactStore.assertPath(file);
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat(),
        hash = createHash('sha256');
      if (!before.isFile() || before.nlink !== 1)
        throw new RuntimeError('RUNTIME_ARTIFACT_PATH_INVALID');
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      const after = await handle.stat();
      if (before.ctimeMs !== after.ctimeMs || before.size !== after.size)
        throw new RuntimeError('RUNTIME_ARTIFACT_CHANGED');
      return { sha256: hash.digest('hex'), size: before.size };
    } finally {
      await handle.close();
    }
  }
  async atomicWrite(target: string, bytes: Buffer | string, mode = 0o600) {
    await VerifiedRuntimeArtifactStore.assertPath(path.dirname(target), true);
    const temporary = path.join(
      path.dirname(target),
      '.publish-' + randomUUID(),
    );
    const h = await fs.open(temporary, 'wx', mode);
    try {
      await h.writeFile(bytes);
      await h.sync();
    } finally {
      await h.close();
    }
    try {
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    const dir = await fs.open(path.dirname(target), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  artifact(id: string) {
    const matches = this.manifest.artifacts.filter((a) => a.id === id);
    if (matches.length !== 1)
      throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
    return matches[0];
  }
  objectPath(a: RuntimeArtifact) {
    return path.join(this.options.storeRoot, 'objects', a.sha256);
  }
  async withImportLock<T>(action: () => Promise<T>) {
    const lock = await fs.open(
      path.join(this.options.storeRoot, '.import.lock'),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const st = await lock.stat();
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        (process.getuid && st.uid !== process.getuid())
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_STORE_INVALID');
      const child = spawn(
        '/usr/bin/python3',
        [
          '-I',
          '-S',
          path.join(config.rootPath, 'shell/runtime_lease.py'),
          'exclusive',
        ],
        {
          env: { PATH: RUNTIME_TOOL_PATH },
          stdio: ['pipe', 'pipe', 'pipe', lock.fd],
        },
      ) as ChildProcessWithoutNullStreams;
      child.stdin.end();
      const result = await observeChildProcess(child).completed;
      if (result.error || result.code !== 0)
        throw new RuntimeError(
          result.code === 75
            ? 'RUNTIME_ARTIFACT_IMPORT_BUSY'
            : 'RUNTIME_ARTIFACT_LOCK_FAILED',
        );
      return await action();
    } finally {
      await lock.close();
    }
  }
  async validateObject(file: string, artifact: RuntimeArtifact) {
    const result = await this.digestFile(file);
    if (result.sha256 !== artifact.sha256 || result.size !== artifact.size)
      throw new RuntimeError('RUNTIME_ARTIFACT_CHECKSUM_MISMATCH');
    if (artifact.format === 'tar.gz' || artifact.format === 'tar.xz') {
      const child = spawn(
        '/usr/bin/python3',
        [
          '-I',
          '-S',
          path.join(config.rootPath, 'shell/runtime_artifact_archive.py'),
          'validate',
          file,
          artifact.prefix!,
        ],
        { env: { PATH: RUNTIME_TOOL_PATH }, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      child.stdin.end();
      const r = await observeChildProcess(child).completed;
      if (r.error || r.code !== 0)
        throw new RuntimeError('RUNTIME_ARTIFACT_ARCHIVE_INVALID');
    }
  }
  async importPackage(
    directory: string,
    progress?: (stage: string) => Promise<void>,
  ) {
    VerifiedRuntimeArtifactStore.assertIdentity(
      directory,
      this.options.excludedRoots!,
    );
    await VerifiedRuntimeArtifactStore.assertPath(directory, true);
    if (
      directory === this.options.storeRoot ||
      directory.startsWith(this.options.storeRoot + path.sep) ||
      this.options.trustAnchorPath.startsWith(directory + path.sep)
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_TRUST_NOT_INDEPENDENT');
    const raw = await VerifiedRuntimeArtifactStore.readSafe(
      path.join(directory, 'manifest.json'),
    );
    if (createHash('sha256').update(raw).digest('hex') !== this.manifestSha256)
      throw new RuntimeError('RUNTIME_ARTIFACT_UNTRUSTED');
    if (
      (await fs.readdir(directory)).sort().join(',') !== 'manifest.json,objects'
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_PACKAGE_MISMATCH');
    const inputs = path.join(directory, 'objects');
    await VerifiedRuntimeArtifactStore.assertPath(inputs, true);
    const expected = [
      ...new Set(this.manifest.artifacts.map((a) => a.sha256)),
    ].sort();
    if (
      JSON.stringify((await fs.readdir(inputs)).sort()) !==
      JSON.stringify(expected)
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
    return this.withImportLock(async () => {
      const stage = path.join(this.options.storeRoot, 'staging', randomUUID());
      await fs.mkdir(stage, { mode: 0o700 });
      try {
        for (const a of this.manifest.artifacts) {
          const source = path.join(inputs, a.sha256),
            temporary = path.join(stage, a.sha256);
          await this.validateObject(source, a);
          if (progress) await progress('VERIFIED_SOURCE');
          const input = await fs.open(
            source,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          const output = await fs.open(temporary, 'wx', 0o400);
          try {
            for await (const chunk of input.createReadStream({
              autoClose: false,
            }))
              await output.writeFile(chunk);
            await output.sync();
          } finally {
            await input.close();
            await output.close();
          }
          await this.validateObject(temporary, a);
        }
        for (const a of this.manifest.artifacts) {
          const target = this.objectPath(a);
          try {
            await fs.link(path.join(stage, a.sha256), target);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          }
          await fs.unlink(path.join(stage, a.sha256));
          await this.validateObject(target, a);
        }
        const receipt = {
          schema: 1,
          manifest_sha256: this.manifestSha256,
          trust_anchor_sha256: this.trustAnchorSha256,
          mode: this.options.mode,
          artifact_count: this.manifest.artifacts.length,
          verified_at: new Date().toISOString(),
          status: 'VERIFIED_COMPLETE',
        };
        await this.atomicWrite(
          path.join(
            this.options.storeRoot,
            'imports',
            this.manifestSha256 + '.json',
          ),
          JSON.stringify(receipt) + '\n',
        );
        return receipt;
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    });
  }
  async resolve(id: string, ctx: ProviderContext) {
    const a = this.artifact(id),
      file = this.objectPath(a);
    if (this.options.mode === 'OFFLINE_VERIFIED') {
      let receipt: any;
      try {
        receipt = JSON.parse(
          (
            await VerifiedRuntimeArtifactStore.readSafe(
              path.join(
                this.options.storeRoot,
                'imports',
                this.manifestSha256 + '.json',
              ),
            )
          ).toString('utf8'),
        );
      } catch {
        throw new RuntimeError('RUNTIME_ARTIFACT_OFFLINE_MISSING');
      }
      if (
        receipt.status !== 'VERIFIED_COMPLETE' ||
        receipt.manifest_sha256 !== this.manifestSha256 ||
        receipt.trust_anchor_sha256 !== this.trustAnchorSha256
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_OFFLINE_MISSING');
    }
    try {
      await this.validateObject(file, a);
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (
      this.options.mode !== 'ONLINE_VERIFIED' ||
      a.acquisition !== 'UPSTREAM_BYTES'
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_OFFLINE_MISSING');
    const u = new URL(a.source_url);
    if (
      ![
        'nodejs.org',
        'www.python.org',
        'registry.npmjs.org',
        'github.com',
        'ftp.gnu.org',
        'zlib.net',
        'curl.se',
        'sqlite.org',
        'files.pythonhosted.org',
      ].includes(u.hostname)
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_SOURCE_INVALID');
    return this.withImportLock(async () => {
      const temporary = path.join(
        this.options.storeRoot,
        'staging',
        randomUUID(),
      );
      try {
        await ctx.command.run(
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
            '--max-filesize',
            String(a.size),
            '--output',
            temporary,
            a.source_url,
          ],
          ctx.directory,
          ctx.environment,
        );
        await this.validateObject(temporary, a);
        await fs.chmod(temporary, 0o400);
        try {
          await fs.link(temporary, file);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        await fs.unlink(temporary);
        await this.validateObject(file, a);
        return file;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
  }
  provenance(id: string) {
    const a = this.artifact(id);
    return {
      ...a,
      mode: this.options.mode,
      manifest_sha256: this.manifestSha256,
      trust_anchor_sha256: this.trustAnchorSha256,
      trust_method: 'INDEPENDENT_PREAPPROVED_MANIFEST_SHA256',
      verified_at: new Date().toISOString(),
    };
  }
  nodeCatalog() {
    const platform =
      this.manifest.os === 'darwin'
        ? 'osx-' + this.manifest.architecture + '-tar'
        : this.manifest.os + '-' + this.manifest.architecture;
    return this.manifest.node.map((n) => ({
      version: n.version,
      date: this.manifest.created_at.slice(0, 10),
      lts: 'approved-release',
      files: [platform],
      npm: this.artifact(n.npm).version,
    }));
  }
  nodeDistribution(version: string) {
    const rows = this.manifest.node.filter((n) => n.version === version);
    if (rows.length !== 1)
      throw new RuntimeError('RUNTIME_ARTIFACT_VERSION_UNAVAILABLE');
    return rows[0];
  }
  pythonProvider(revision: string) {
    const rows = this.manifest.python.filter(
      (p) => p.provider_revision === revision,
    );
    const ids = [...new Set(rows.map((p) => p.provider_archive))];
    if (ids.length !== 1)
      throw new RuntimeError('RUNTIME_ARTIFACT_VERSION_UNAVAILABLE');
    return ids[0];
  }
  pythonSources(version: string, revision: string) {
    const rows = this.manifest.python.filter(
      (p) => p.version === version && p.provider_revision === revision,
    );
    if (rows.length !== 1)
      throw new RuntimeError('RUNTIME_ARTIFACT_VERSION_UNAVAILABLE');
    return rows[0].sources;
  }
  async extract(ctx: ProviderContext, id: string, destination: string) {
    const a = this.artifact(id),
      file = await this.resolve(id, ctx);
    const snapshot = path.join(
      ctx.directory,
      'verified-extract-' + randomUUID(),
    );
    try {
      await fs.copyFile(file, snapshot, constants.COPYFILE_EXCL);
      await this.validateObject(snapshot, a);
      await ctx.command.run(
        '/usr/bin/python3',
        [
          '-I',
          '-S',
          path.join(config.rootPath, 'shell/runtime_artifact_archive.py'),
          'extract',
          snapshot,
          a.prefix!,
          destination,
        ],
        ctx.directory,
        ctx.environment,
      );
    } finally {
      await fs.rm(snapshot, { force: true });
    }
  }
  async preparePython(ctx: ProviderContext, version: string, revision: string) {
    const cache = path.join(ctx.directory, 'verified-python-cache');
    await fs.mkdir(cache, { mode: 0o700 });
    for (const s of this.pythonSources(version, revision)) {
      const source = await this.resolve(s.artifact, ctx);
      await fs.copyFile(
        source,
        path.join(cache, s.cache_name),
        constants.COPYFILE_EXCL,
      );
      await this.validateObject(
        path.join(cache, s.cache_name),
        this.artifact(s.artifact),
      );
    }
    const profile = this.manifest.python.find(
      (p) => p.version === version && p.provider_revision === revision,
    )!;
    const definitions = path.join(ctx.directory, 'verified-python-definitions');
    await fs.mkdir(definitions, { mode: 0o700 });
    const definition = path.join(definitions, version);
    await fs.copyFile(
      await this.resolve(profile.definition, ctx),
      definition,
      constants.COPYFILE_EXCL,
    );
    await this.validateObject(definition, this.artifact(profile.definition));
    const ca = path.join(ctx.directory, 'verified-ca-bundle.pem');
    await fs.copyFile(
      await this.resolve(profile.ca_bundle, ctx),
      ca,
      constants.COPYFILE_EXCL,
    );
    await this.validateObject(ca, this.artifact(profile.ca_bundle));
    const wheelArtifact = this.artifact(profile.pip_wheel);
    const wheelName = wheelArtifact.provenance?.wheel_filename;
    if (
      typeof wheelName !== 'string' ||
      !/^pip-[0-9.]+-py3-none-any\.whl$/.test(wheelName)
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_MANIFEST_INVALID');
    const wheel = path.join(ctx.directory, wheelName);
    await fs.copyFile(
      await this.resolve(profile.pip_wheel, ctx),
      wheel,
      constants.COPYFILE_EXCL,
    );
    await this.validateObject(wheel, wheelArtifact);
    // python-build's normal cache path remains in use. Unexpected downloads fail
    // before connecting instead of silently falling back to the network.
    const tools = path.join(ctx.directory, 'offline-download-tools');
    await fs.mkdir(tools, { mode: 0o700 });
    for (const name of ['curl', 'wget', 'aria2c'])
      await fs.writeFile(
        path.join(tools, name),
        '#!/bin/sh\nprintf "%s\\n" RUNTIME_OFFLINE_DOWNLOAD_FORBIDDEN >&2\nexit 78\n',
        { flag: 'wx', mode: 0o700 },
      );
    return {
      ...ctx.environment,
      PATH: tools + ':' + ctx.environment.PATH,
      PYTHON_BUILD_CACHE_PATH: cache,
      PYTHON_BUILD_SKIP_MIRROR: '1',
      PYTHON_BUILD_HTTP_CLIENT: 'curl',
      PYTHON_BUILD_DEFINITIONS: definitions,
      PYTHON_BUILD_SKIP_HOMEBREW: '1',
      PYTHON_BUILD_SKIP_MACPORTS: '1',
      ZHIXU_RUNTIME_CA_BUNDLE: ca,
      ZHIXU_RUNTIME_PIP_WHEEL: wheel,
    };
  }
  async verifyPythonPip(
    ctx: ProviderContext,
    python: string,
    version?: string,
  ) {
    const diagnostic =
      'import sys,json,sysconfig,pip,ensurepip,pathlib;print(json.dumps(dict(version=".".join(map(str,sys.version_info[:3])),prefix=sys.prefix,base_prefix=sys.base_prefix,pip_version=pip.__version__,pip_init=pip.__file__,pip_vendor=str(pathlib.Path(pip.__file__).parent/"_vendor"/"vendor.txt"),wheel_dir=sysconfig.get_config_var("WHEEL_PKG_DIR"),ensurepip_version=ensurepip.version())))';
    const facts = JSON.parse(
      await ctx.command.run(
        python,
        ['-I', '-B', '-c', diagnostic],
        ctx.directory,
        ctx.environment,
        true,
      ),
    );
    const profiles = this.manifest.python.filter(
      (p) => p.version === (version ?? facts.version),
    );
    if (profiles.length !== 1 || facts.version !== profiles[0].version)
      throw new RuntimeError('RUNTIME_PIP_VERIFY_FAILED');
    const artifact = this.artifact(profiles[0].pip_wheel),
      proof = artifact.provenance;
    const prefix = await fs.realpath(facts.prefix),
      base = await fs.realpath(facts.base_prefix);
    for (const target of [prefix, base])
      if (!target.startsWith(this.dataRoot + path.sep))
        throw new RuntimeError('RUNTIME_PIP_VERIFY_FAILED');
    const init = await fs.realpath(facts.pip_init),
      vendor = await fs.realpath(facts.pip_vendor);
    if (
      !init.startsWith(prefix + path.sep) ||
      !vendor.startsWith(prefix + path.sep) ||
      facts.pip_version !== artifact.version ||
      facts.ensurepip_version !== artifact.version ||
      facts.wheel_dir !== path.join(base, 'pip-wheels') ||
      typeof proof?.wheel_filename !== 'string'
    )
      throw new RuntimeError('RUNTIME_PIP_VERIFY_FAILED');
    const wheel = path.join(facts.wheel_dir, proof.wheel_filename);
    if (
      (await this.digestFile(init)).sha256 !== proof.pip_init_sha256 ||
      (await this.digestFile(vendor)).sha256 !==
        proof.pip_vendor_manifest_sha256 ||
      (await this.digestFile(wheel)).sha256 !== artifact.sha256
    )
      throw new RuntimeError('RUNTIME_PIP_VERIFY_FAILED');
    const bundled = path.join(
      base,
      'lib',
      'python' + facts.version.split('.').slice(0, 2).join('.'),
      'ensurepip/_bundled',
    );
    const names = await fs.readdir(bundled).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    if (names.some((name) => name.endsWith('.whl')))
      throw new RuntimeError('RUNTIME_PIP_VERIFY_FAILED');
    await ctx.command.run(
      python,
      ['-I', '-B', '-m', 'pip', '--version'],
      ctx.directory,
      ctx.environment,
      true,
    );
    return {
      pip_artifact_id: artifact.id,
      pip_version: artifact.version,
      pip_init_sha256: proof.pip_init_sha256,
      pip_vendor_manifest_sha256: proof.pip_vendor_manifest_sha256,
      pip_wheel_sha256: artifact.sha256,
      pip_init_relative: path.relative(prefix, init).split(path.sep).join('/'),
      pip_vendor_manifest_relative: path
        .relative(prefix, vendor)
        .split(path.sep)
        .join('/'),
      pip_wheel_relative: path.relative(base, wheel).split(path.sep).join('/'),
    };
  }
  async npmClosure(
    manifest: string,
    runtimeVersion: string,
    npmVersion: string,
  ) {
    const hash = createHash('sha256').update(manifest).digest('hex');
    const rows = this.manifest.npm.filter(
      (n) =>
        n.runtime_version === runtimeVersion &&
        n.npm_version === npmVersion &&
        n.package_json_sha256 === hash,
    );
    if (rows.length !== 1)
      throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_UNAVAILABLE');
    return rows[0];
  }
  async pnpmClosure(
    manifest: string,
    runtimeVersion: string,
    pnpmVersion: string,
  ) {
    if (this.options.mode !== 'ONLINE_VERIFIED')
      throw new RuntimeError('RUNTIME_ARTIFACT_MODE_UNSUPPORTED');
    const hash = createHash('sha256').update(manifest).digest('hex');
    const rows = (this.manifest.pnpm ?? []).filter(
      (n) =>
        n.runtime_version === runtimeVersion &&
        n.pnpm_version === pnpmVersion &&
        n.package_json_sha256 === hash,
    );
    if (rows.length !== 1)
      throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_UNAVAILABLE');
    return rows[0];
  }
  async seedPnpm(
    ctx: ProviderContext,
    closure: PnpmArtifacts,
    run: { node: string; cli: string; env: NodeJS.ProcessEnv },
    buildRoot: string,
  ) {
    if (this.options.mode !== 'ONLINE_VERIFIED')
      throw new RuntimeError('RUNTIME_ARTIFACT_MODE_UNSUPPORTED');
    const bytes = await VerifiedRuntimeArtifactStore.readSafe(
      await this.resolve(closure.lockfile, ctx),
    );
    let lock: any;
    try {
      lock = yamlLoad(bytes.toString('utf8'));
    } catch {
      throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
    }
    if (
      String(lock?.lockfileVersion) !== '9.0' ||
      !lock.importers ||
      (lock.packages !== undefined &&
        (typeof lock.packages !== 'object' || lock.packages === null))
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
    const available = closure.packages.map((id) => this.artifact(id));
    for (const [key, row] of Object.entries(lock.packages ?? {}) as [
      string,
      any,
    ][]) {
      if (
        (row.os && !row.os.includes(process.platform)) ||
        (row.cpu && !row.cpu.includes(process.arch))
      )
        continue;
      const at = key.lastIndexOf('@'),
        name = key.slice(0, at),
        version = key.slice(at + 1);
      if (
        at <= 0 ||
        row.resolution?.tarball ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(
          row.resolution?.integrity ?? '',
        ) ||
        available.filter(
          (a) =>
            a.npm_name === name &&
            a.npm_version === version &&
            a.integrity === row.resolution.integrity,
        ).length !== 1
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
    }
    // This is deliberately ONLINE-only: pnpm fetch obtains exactly the approved
    // integrity-locked closure into the normal owned store. Installation and
    // lifecycle execution below run offline after the fixed inputs are fetched.
    await this.atomicWrite(
      path.join(buildRoot, 'pnpm-lock.yaml'),
      bytes,
      0o600,
    );
    await ctx.command.run(
      run.node,
      [
        run.cli,
        'fetch',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--config.manage-package-manager-versions=false',
        '--reporter=append-only',
      ],
      buildRoot,
      run.env,
    );
    return {
      lockfile: bytes.toString('utf8'),
      env: { ...run.env, npm_config_offline: 'true' },
    };
  }
  async seedNpm(
    ctx: ProviderContext,
    closure: NpmArtifacts,
    run: { node: string; cli: string; env: NodeJS.ProcessEnv },
  ) {
    const lockPath = await this.resolve(closure.lockfile, ctx);
    const lockBytes = await VerifiedRuntimeArtifactStore.readSafe(lockPath);
    let lock: any;
    try {
      lock = JSON.parse(lockBytes.toString('utf8'));
    } catch {
      throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
    }
    if (
      lock.lockfileVersion !== 3 ||
      !lock.packages ||
      typeof lock.packages !== 'object'
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
    const available = closure.packages.map((id) => this.artifact(id));
    for (const [location, row] of Object.entries(lock.packages) as [
      string,
      any,
    ][]) {
      if (!location) continue;
      const excluded =
        row.optional &&
        ((Array.isArray(row.os) && !row.os.includes(process.platform)) ||
          (Array.isArray(row.cpu) && !row.cpu.includes(process.arch)));
      if (excluded) continue;
      const matches = available.filter(
        (a) =>
          a.integrity === row.integrity &&
          a.npm_version === row.version &&
          a.source_url === row.resolved,
      );
      if (
        matches.length !== 1 ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(row.integrity || '')
      )
        throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
    }
    const cache = path.join(ctx.directory, 'verified-npm-cache');
    await fs.mkdir(cache, { mode: 0o700 });
    const env = {
      ...run.env,
      npm_config_cache: cache,
      npm_config_offline: 'true',
    };
    for (const id of closure.packages) {
      const file = await this.resolve(id, ctx);
      const input = path.join(
        ctx.directory,
        'npm-input-' + this.artifact(id).sha256 + '.tgz',
      );
      await fs.copyFile(file, input, constants.COPYFILE_EXCL);
      await this.validateObject(input, this.artifact(id));
      await ctx.command.run(
        run.node,
        [
          run.cli,
          'cache',
          'add',
          input,
          '--offline',
          '--ignore-scripts',
          '--cache',
          cache,
        ],
        ctx.directory,
        env,
      );
    }
    return { lockfile: lockBytes.toString('utf8'), env };
  }
  async packageRoot(buildRoot: string, name: string, fromRoot = buildRoot) {
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
      throw new RuntimeError('RUNTIME_ARTIFACT_PATH_INVALID');
    const root = await fs.realpath(buildRoot);
    let cursor = await fs.realpath(fromRoot);
    if (cursor !== root && !cursor.startsWith(root + path.sep))
      throw new RuntimeError('RUNTIME_ARTIFACT_PATH_INVALID');
    while (true) {
      const candidate = path.join(cursor, 'node_modules', name);
      try {
        const actual = await fs.realpath(candidate);
        if (!actual.startsWith(root + path.sep))
          throw new RuntimeError('RUNTIME_ARTIFACT_PATH_INVALID');
        await VerifiedRuntimeArtifactStore.assertPath(actual, true);
        const pkg = JSON.parse(
          (
            await VerifiedRuntimeArtifactStore.readSafe(
              path.join(actual, 'package.json'),
            )
          ).toString('utf8'),
        );
        if (pkg.name !== name)
          throw new RuntimeError('RUNTIME_ARTIFACT_VERSION_UNAVAILABLE');
        return actual;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (cursor === root) break;
      cursor = path.dirname(cursor);
      if (!cursor.startsWith(root + path.sep) && cursor !== root) break;
    }
    throw new RuntimeError('RUNTIME_ARTIFACT_CLOSURE_INCOMPLETE');
  }
  async overlayEsbuild(
    ctx: ProviderContext,
    closure: NpmArtifacts | PnpmArtifacts,
    buildRoot: string,
  ) {
    if (!closure.esbuild) return;
    const overlay = closure.esbuild,
      artifact = this.artifact(overlay.artifact);
    if (
      artifact.format !== 'binary' ||
      artifact.acquisition !== 'VERIFIED_REBUILD' ||
      !artifact.provenance ||
      artifact.version !== overlay.version
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_PROVENANCE_INVALID');
    const source = await this.resolve(overlay.artifact, ctx);
    const from = closure.packages.some(
      (id) => this.artifact(id).npm_name === 'tsx',
    )
      ? await this.packageRoot(buildRoot, 'tsx')
      : buildRoot;
    const mainRoot = await this.packageRoot(buildRoot, 'esbuild', from);
    const packageRoot = await this.packageRoot(
      buildRoot,
      overlay.package_name,
      mainRoot,
    );
    const target = path.join(packageRoot, 'bin/esbuild');
    if (
      overlay.package_name !==
      '@esbuild/' + process.platform + '-' + process.arch
    )
      throw new RuntimeError('RUNTIME_ARTIFACT_MANIFEST_INVALID');
    await VerifiedRuntimeArtifactStore.assertPath(path.dirname(target), true);
    const pkg = JSON.parse(
      (
        await VerifiedRuntimeArtifactStore.readSafe(
          path.join(packageRoot, 'package.json'),
        )
      ).toString('utf8'),
    );
    if (pkg.name !== overlay.package_name || pkg.version !== overlay.version)
      throw new RuntimeError('RUNTIME_ARTIFACT_VERSION_UNAVAILABLE');
    await this.atomicWrite(
      target,
      await VerifiedRuntimeArtifactStore.readSafe(source, 64 * 1024 * 1024),
      0o700,
    );
    await this.validateObject(target, artifact);
    const entry = path.join(mainRoot, 'bin/esbuild');
    await VerifiedRuntimeArtifactStore.assertPath(path.dirname(entry), true);
    const main = JSON.parse(
      (
        await VerifiedRuntimeArtifactStore.readSafe(
          path.join(mainRoot, 'package.json'),
        )
      ).toString('utf8'),
    );
    if (main.name !== 'esbuild' || main.version !== overlay.version)
      throw new RuntimeError('RUNTIME_ARTIFACT_VERSION_UNAVAILABLE');
    await this.atomicWrite(
      entry,
      await VerifiedRuntimeArtifactStore.readSafe(source, 64 * 1024 * 1024),
      0o700,
    );
    await this.validateObject(entry, artifact);
  }
}
