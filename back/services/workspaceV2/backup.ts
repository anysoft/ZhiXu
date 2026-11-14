import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { WorkspaceStore } from './store';
import { WorkspaceRootResolver } from './roots';
import { WorkspaceLeaseService } from './lease';
import {
  WorkspaceBackupDomain,
  WorkspaceBackupManifest,
  manifestValue,
  backupFailure,
} from './manifest';
import { WorkspaceLimits, workspaceLimits } from './limits';
import { fail, errorCode } from './errors';
import type { FaultHook } from './types';
import { BackupPaths, backupId } from '../backup/paths';
import { PlatformBackupBarrier } from '../backup/barrier';
import { withInheritedLease } from '../backup/inheritedLeases';
import RuntimePathResolver from '../runtimePaths';
import { RuntimeLease } from '../runtimeProcess';
import {
  copyInventory,
  inventoryLines,
  validateInventory,
} from '../backup/inventory';
import { snapshotDatabase, validateDatabase } from '../backup/sqlite';
import {
  hashFile,
  privateDirectory,
  privateJson,
  readJson,
  sha256,
  syncDirectory,
  writeAll,
} from '../backup/files';
import { packArchive, unpackArchive } from '../backup/archive';
import { encryptPortable, decryptPortable } from '../backup/envelope';

const EXCLUDED = [
  'runtime',
  '.locks',
  'syslog',
  'cache/runtime',
  'cache/python/pip',
  'cache/node',
  'tmp/runtime',
  'tmp/execution',
  'tmp/config-materialization',
  'tmp/workspace-v2',
];
function excluded(name: string) {
  return (
    EXCLUDED.some(
      (prefix) => name === prefix || name.startsWith(prefix + '/'),
    ) || /^db\/database\.sqlite(?:-wal|-shm|-journal)?$/.test(name)
  );
}
class CatalogPaths extends RuntimePathResolver {
  async lock(id: number) {
    if (id !== 1) fail('BACKUP_RECOVERY_REQUIRED');
    return path.join(await privateDirectory(this.dataRoot), 'backup.lock');
  }
}
interface SpaceStats {
  bavail: number;
  bsize: number;
}
const RECOVERY_CONTEXT = Symbol('verified workspace restore context');

/** Internal S1.A coordinator: real production backup primitives, explicit v2 domain only. */
export class WorkspaceBackupService {
  readonly paths: BackupPaths;
  readonly barrier: PlatformBackupBarrier;
  readonly limits: WorkspaceLimits;
  readonly domain: WorkspaceBackupDomain;
  readonly fault: FaultHook;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
    backupRoot: string,
    options: { limits?: Partial<WorkspaceLimits>; fault?: FaultHook } = {},
    recovery?: { token: typeof RECOVERY_CONTEXT; targetRoot: string },
  ) {
    if (recovery && recovery.token !== RECOVERY_CONTEXT)
      fail('WORKSPACE_RECOVERY_REQUIRED');
    this.paths = new BackupPaths(
      recovery?.targetRoot || store.dataRoot,
      backupRoot,
    );
    if (
      roots.dataRoot !== this.paths.data ||
      leases.dataRoot !== this.paths.data
    )
      fail('WORKSPACE_PATH_INVALID');
    this.barrier = new PlatformBackupBarrier(this.paths.control);
    this.limits = workspaceLimits(options.limits);
    this.domain = new WorkspaceBackupDomain(this.limits);
    this.fault = options.fault || (async () => undefined);
  }

  static async forRestoreRecovery(
    store: WorkspaceStore,
    roots: WorkspaceRootResolver,
    leases: WorkspaceLeaseService,
    backupRoot: string,
  ) {
    const paths = new BackupPaths(roots.dataRoot, backupRoot);
    const { readWorkspaceRestoreJournal } = await import('./restore');
    const journal = await readWorkspaceRestoreJournal(paths);
    if (!journal) fail('WORKSPACE_RECOVERY_REQUIRED');
    const choices = [
      {
        root: journal.target,
        identities: [journal.old_identity, journal.candidate_identity],
      },
      { root: journal.old_root, identities: [journal.old_identity] },
      { root: journal.candidate, identities: [journal.candidate_identity] },
    ];
    const choice = choices.find((value) => value.root === store.dataRoot);
    if (!choice) fail('WORKSPACE_RECOVERY_REQUIRED');
    const stat = await fs.lstat(choice.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !choice.identities.some(
        (value) => value && value.dev === stat.dev && value.ino === stat.ino,
      )
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    await store.verifySchema();
    return new WorkspaceBackupService(
      store,
      roots,
      leases,
      backupRoot,
      {},
      { token: RECOVERY_CONTEXT, targetRoot: paths.data },
    );
  }

  async withCatalogLock<T>(action: () => Promise<T>) {
    try {
      await this.paths.initialize();
      // Shared BACKUP_DIR has one catalog lock even across source/restore DATA_DIRs.
      const lease = await RuntimeLease.acquire(
        new CatalogPaths(this.paths.root),
        1,
      );
      try {
        return await withInheritedLease(lease.handle.fd, action);
      } finally {
        await lease.release();
      }
    } catch (error) {
      return backupFailure(error);
    }
  }

  async idle() {
    return this.domain.assertIdle(this.store);
  }

  private async measure(
    root: string,
    skip: (name: string) => boolean = () => false,
  ) {
    let bytes = 0,
      entries = 0;
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > 128) fail('BACKUP_QUOTA_EXCEEDED', 422);
      const directory = path.join(root, relative);
      for (const name of await fs.readdir(directory)) {
        const key = relative ? relative + '/' + name : name;
        if (skip(key)) continue;
        const file = path.join(root, key),
          stat = await fs.lstat(file);
        if (++entries > 1_000_000) fail('BACKUP_QUOTA_EXCEEDED', 422);
        if (stat.isDirectory() && !stat.isSymbolicLink())
          await walk(key, depth + 1);
        else if (stat.isFile()) {
          if (
            stat.nlink !== 1 ||
            (process.getuid && stat.uid !== process.getuid())
          )
            fail('BACKUP_SOURCE_INCOMPLETE');
          bytes += stat.size;
          if (!Number.isSafeInteger(bytes)) fail('BACKUP_QUOTA_EXCEEDED', 422);
        } else if (!stat.isSymbolicLink()) fail('BACKUP_SOURCE_INCOMPLETE');
      }
    };
    await walk('', 0);
    return bytes;
  }

  async reserve(bytes: number, destination = this.paths.root) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.limits.temporaryMaxBytes
    )
      fail('DISK_BUDGET_EXCEEDED', 422);
    const disk = fs as typeof fs & {
      statfs(file: string): Promise<SpaceStats>;
    };
    if (typeof disk.statfs !== 'function') fail('DISK_BUDGET_EXCEEDED', 422);
    const stats = await disk.statfs(destination);
    if (stats.bavail * stats.bsize < bytes + this.limits.minimumFreeBytes)
      fail('DISK_BUDGET_EXCEEDED', 422);
  }

  async create(timeoutMs = 600000) {
    if (this.store.dataRoot !== this.paths.data)
      fail('WORKSPACE_RECOVERY_REQUIRED');
    return this.withCatalogLock(() =>
      this.barrier.snapshot(
        () => this.idle(),
        async () => {
          const workspaces = await this.domain.collect(this.store);
          const dependencies = [];
          for (const held of await this.store.all<{ snapshot_key: string }>(
            'SELECT DISTINCT snapshot_key FROM WorkspacePreservationHolds WHERE released_at IS NULL ORDER BY snapshot_key',
          )) {
            const snapshot = await this.snapshot(held.snapshot_key);
            dependencies.push({
              ...snapshot,
              id: held.snapshot_key,
              bytes: await this.measure(snapshot.root),
            });
          }
          if (dependencies.length > 1024) fail('BACKUP_QUOTA_EXCEEDED', 422);
          const payloadEstimate =
            (await this.measure(this.paths.data, (name) =>
              EXCLUDED.some(
                (prefix) => name === prefix || name.startsWith(prefix + '/'),
              ),
            )) +
            dependencies.reduce((sum, dependency) => sum + dependency.bytes, 0);
          if (payloadEstimate > this.limits.backupSnapshotBytes)
            fail('BACKUP_QUOTA_EXCEEDED', 422);
          const retained = await this.measure(this.paths.root);
          if (retained + payloadEstimate > this.limits.backupRetainedBytes)
            fail('BACKUP_QUOTA_EXCEEDED', 422);
          await this.reserve(Math.ceil(payloadEstimate * 1.1));
          const allocated = await this.paths.allocate('.staging');
          try {
            const data = path.join(allocated.root, 'data');
            await fs.mkdir(data, { mode: 0o700 });
            await this.fault('backup-before-copy', { id: allocated.id });
            const progress = { processed_bytes: 0, processed_files: 0 };
            await copyInventory(
              this.paths.data,
              data,
              path.join(allocated.root, 'inventory.ndjson'),
              excluded,
              progress,
            );
            await this.fault('backup-after-copy', { id: allocated.id });
            await fs
              .mkdir(path.join(data, 'db'), { mode: 0o700 })
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'EEXIST') throw error;
              });
            await snapshotDatabase(
              this.store.databasePath,
              path.join(data, 'db/database.sqlite'),
            );
            const database = await hashFile(
              path.join(data, 'db/database.sqlite'),
            );
            const output = await fs.open(
              path.join(allocated.root, 'inventory.ndjson'),
              'a',
            );
            try {
              await writeAll(
                output,
                Buffer.from(
                  JSON.stringify({
                    path: 'db/database.sqlite',
                    kind: 'file',
                    mode: 0o600,
                    ...database,
                  }) + '\n',
                ),
              );
              await output.sync();
            } finally {
              await output.close();
            }
            const inventory = await hashFile(
              path.join(allocated.root, 'inventory.ndjson'),
            );
            const preserved: WorkspaceBackupManifest['preserved_snapshots'] =
              [];
            if (dependencies.length)
              await fs.mkdir(path.join(allocated.root, 'preserved'), {
                mode: 0o700,
              });
            for (const dependency of dependencies) {
              const destination = path.join(
                allocated.root,
                'preserved',
                dependency.id,
              );
              await fs.mkdir(destination, { mode: 0o700 });
              const temporaryInventory = path.join(
                allocated.root,
                'dependency-copy.ndjson',
              );
              await copyInventory(
                dependency.root,
                destination,
                temporaryInventory,
                () => false,
                { processed_bytes: 0, processed_files: 0 },
              );
              await fs.unlink(temporaryInventory);
              preserved.push({
                backup_id: dependency.id,
                manifest_sha256: (
                  await hashFile(path.join(destination, 'manifest.json'))
                ).sha256,
              });
            }
            const manifest: WorkspaceBackupManifest = {
              format_family: 'zhixu-workspace-backup',
              format_version: 2,
              backup_id: allocated.id,
              created_at: new Date().toISOString(),
              schema_identity: 'zhixu.workspace.v2.s0.1',
              schema_signature:
                'f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c',
              database,
              inventory,
              total_bytes:
                progress.processed_bytes +
                database.size +
                dependencies.reduce(
                  (sum, item) => sum + item.manifest.total_bytes,
                  0,
                ),
              file_count:
                progress.processed_files +
                1 +
                dependencies.reduce(
                  (sum, item) => sum + item.manifest.file_count,
                  0,
                ),
              preserved_snapshots: preserved,
              workspaces,
            };
            if (manifest.total_bytes > this.limits.backupSnapshotBytes)
              fail('BACKUP_QUOTA_EXCEEDED', 422);
            await privateJson(
              path.join(allocated.root, 'manifest.json'),
              manifest,
            );
            await privateJson(path.join(allocated.root, 'READY'), {
              manifest_sha256: sha256(JSON.stringify(manifest) + '\n'),
            });
            await this.validateRoot(allocated.root, allocated.id);
            await this.fault('backup-before-publish', { id: allocated.id });
            const target = await this.paths.bucket('snapshots', allocated.id);
            await fs.rename(allocated.root, target);
            await syncDirectory(path.dirname(target));
            return allocated.id;
          } catch (error) {
            await privateJson(path.join(allocated.root, 'FAILED'), {
              code: errorCode(error),
            }).catch(() => undefined);
            throw error;
          }
        },
        timeoutMs,
      ),
    );
  }

  async validateRoot(root: string, expectedId?: string) {
    try {
      return await this.validateRootUnchecked(root, expectedId);
    } catch (error) {
      return backupFailure(error);
    }
  }

  private async validateRootUnchecked(
    root: string,
    expectedId?: string,
    ancestors = new Set<string>(),
    budget = { nodes: 0 },
  ) {
    await privateDirectory(root);
    const manifest = manifestValue(
      await readJson(path.join(root, 'manifest.json'), 64 * 1024 * 1024),
    );
    backupId(manifest.backup_id);
    if (
      ++budget.nodes > 1024 ||
      ancestors.size >= 16 ||
      ancestors.has(manifest.backup_id)
    )
      fail('BACKUP_SOURCE_INCOMPLETE');
    const branch = new Set(ancestors).add(manifest.backup_id);
    if (expectedId && manifest.backup_id !== backupId(expectedId))
      fail('BACKUP_SOURCE_INCOMPLETE');
    const ready = (await readJson(path.join(root, 'READY'))) as {
      manifest_sha256?: unknown;
    };
    if (ready.manifest_sha256 !== sha256(JSON.stringify(manifest) + '\n'))
      fail('BACKUP_SOURCE_INCOMPLETE');
    const database = await hashFile(path.join(root, 'data/db/database.sqlite'));
    const inventory = await hashFile(path.join(root, 'inventory.ndjson'));
    if (
      JSON.stringify(database) !== JSON.stringify(manifest.database) ||
      JSON.stringify(inventory) !== JSON.stringify(manifest.inventory)
    )
      fail('BACKUP_SOURCE_INCOMPLETE');
    const stats = await validateInventory(
      path.join(root, 'data'),
      path.join(root, 'inventory.ndjson'),
    );
    let preservedBytes = 0,
      preservedFiles = 0;
    const ids = new Set<string>(),
      dependencies = new Map<string, WorkspaceBackupManifest>();
    for (const dependency of manifest.preserved_snapshots) {
      const id = backupId(dependency.backup_id);
      if (ids.has(id)) fail('BACKUP_SOURCE_INCOMPLETE');
      ids.add(id);
      const child = path.join(root, 'preserved', id);
      if (
        (await hashFile(path.join(child, 'manifest.json'))).sha256 !==
        dependency.manifest_sha256
      )
        fail('BACKUP_SOURCE_INCOMPLETE');
      const verified = await this.validateRootUnchecked(
        child,
        id,
        branch,
        budget,
      );
      dependencies.set(id, verified);
      preservedBytes += verified.total_bytes;
      preservedFiles += verified.file_count;
    }
    const members = await fs
      .readdir(path.join(root, 'preserved'))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    if (members.length !== ids.size || members.some((id) => !ids.has(id)))
      fail('BACKUP_SOURCE_INCOMPLETE');
    for (const entry of manifest.workspaces)
      for (const hold of entry.preservation_holds) {
        if (
          !hold ||
          typeof hold !== 'object' ||
          !('snapshot_key' in hold) ||
          !('released_at' in hold)
        )
          fail('BACKUP_SOURCE_INCOMPLETE');
        if (hold.released_at === null) {
          const record = hold as Record<string, unknown>;
          const dependency = dependencies.get(String(record.snapshot_key));
          const asset = dependency?.workspaces.find(
            (value) => value.workspace_id === entry.workspace_id,
          );
          if (
            !dependency ||
            !asset ||
            asset.storage_state !== 'PRESENT' ||
            record.source_generation !== asset.source_generation ||
            record.content_revision !== asset.content_revision ||
            record.inventory_hash !== asset.content_inventory_hash ||
            record.manifest_hash !== sha256(JSON.stringify(dependency) + '\n')
          )
            fail('BACKUP_SOURCE_INCOMPLETE');
        }
      }
    if (
      stats.bytes + preservedBytes !== manifest.total_bytes ||
      stats.files + preservedFiles !== manifest.file_count ||
      manifest.total_bytes > this.limits.backupSnapshotBytes
    )
      fail('BACKUP_SOURCE_INCOMPLETE');
    const modes = new Map<string, number>();
    for await (const entry of inventoryLines(
      path.join(root, 'inventory.ndjson'),
    ))
      modes.set(entry.path, entry.mode);
    const store = await WorkspaceStore.open(
      path.join(root, 'data/db/database.sqlite'),
      path.join(root, 'data'),
      { readOnly: true },
    );
    try {
      await validateDatabase(path.join(root, 'data/db/database.sqlite'));
      await this.domain.collect(store, 'snapshot', manifest.workspaces, modes);
    } finally {
      await store.close();
    }
    return manifest;
  }

  /** Copy authenticated bundled preservation assets into the shared catalog, never overwrite. */
  async materializePreservation(
    root: string,
    manifest: WorkspaceBackupManifest,
  ) {
    for (const dependency of manifest.preserved_snapshots) {
      const source = path.join(root, 'preserved', dependency.backup_id);
      const verified = await this.validateRoot(source, dependency.backup_id);
      await this.materializePreservation(source, verified);
      const destination = await this.paths.bucket(
        'snapshots',
        dependency.backup_id,
      );
      const present = await fs
        .lstat(destination)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      if (present) {
        await this.snapshot(dependency.backup_id);
        if (
          (await hashFile(path.join(destination, 'manifest.json'))).sha256 !==
          dependency.manifest_sha256
        )
          fail('BACKUP_SOURCE_INCOMPLETE');
        continue;
      }
      const bytes = await this.measure(source);
      if (
        bytes + (await this.measure(this.paths.root)) >
        this.limits.backupRetainedBytes
      )
        fail('BACKUP_QUOTA_EXCEEDED', 422);
      await this.reserve(bytes);
      const staging = await this.paths.bucket('.staging', dependency.backup_id);
      if (await fs.lstat(staging).catch(() => null))
        await this.paths.remove('.staging', dependency.backup_id);
      await fs.mkdir(staging, { mode: 0o700 });
      const stat = await fs.lstat(staging);
      await privateJson(path.join(staging, '.owner.json'), {
        version: 1,
        id: dependency.backup_id,
        dev: stat.dev,
        ino: stat.ino,
      });
      const inventoryFile = path.join(
        this.paths.control,
        'preserved-copy-' + dependency.backup_id + '.ndjson',
      );
      await fs.unlink(inventoryFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await copyInventory(
        source,
        staging,
        inventoryFile,
        (name) => name === '.owner.json',
        { processed_bytes: 0, processed_files: 0 },
      );
      await fs.unlink(inventoryFile);
      await this.validateRoot(staging, dependency.backup_id);
      await fs.rename(staging, destination);
      await syncDirectory(path.dirname(destination));
    }
    for (const entry of manifest.workspaces)
      for (const hold of entry.preservation_holds) {
        const record = hold as Record<string, unknown>;
        if (record.released_at === null)
          await this.recordPreservationHold(
            String(record.snapshot_key),
            entry.workspace_id,
            {
              ...record,
              workspace_id: entry.workspace_id,
              receipt_version: 1,
              restored_from: manifest.backup_id,
            },
          );
      }
  }

  async snapshot(id: string) {
    try {
      const root = await this.paths.bucket('snapshots', backupId(id));
      await this.paths.assertOwned(root, id);
      return { root, manifest: await this.validateRoot(root, id) };
    } catch (error) {
      return backupFailure(error);
    }
  }

  async list() {
    return this.withCatalogLock(async () => {
      const entries: {
        id: string;
        created_at: string;
        bytes: number;
        held: boolean;
      }[] = [];
      for (const id of await fs.readdir(await this.paths.bucket('snapshots'))) {
        const { manifest } = await this.snapshot(id);
        const holds = await this.store.all(
          'SELECT id FROM WorkspacePreservationHolds WHERE snapshot_key=? AND released_at IS NULL LIMIT 1',
          [id],
        );
        entries.push({
          id,
          created_at: manifest.created_at,
          bytes: manifest.total_bytes,
          held: holds.length > 0 || (await this.catalogHeld(id)),
        });
      }
      return entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    });
  }

  async recordPreservationHold(
    id: string,
    workspaceId: number,
    receipt: Record<string, unknown>,
  ) {
    backupId(id);
    if (!Number.isSafeInteger(workspaceId) || workspaceId < 1)
      fail('WORKSPACE_PRESERVATION_REQUIRED');
    const directory = await privateDirectory(
      path.join(this.paths.root, 'preservation-holds', id),
      true,
    );
    const body = {
      version: 1,
      snapshot_key: id,
      workspace_id: workspaceId,
      receipt,
    };
    await privateJson(path.join(directory, workspaceId + '.json'), {
      ...body,
      checksum: sha256(JSON.stringify(body)),
    });
  }

  private async catalogHeld(id: string) {
    const directory = path.join(
      this.paths.root,
      'preservation-holds',
      backupId(id),
    );
    const present = await fs
      .lstat(directory)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (!present) return false;
    await privateDirectory(directory);
    const names = await fs.readdir(directory);
    for (const name of names) {
      if (!/^[1-9][0-9]*\.json$/.test(name)) fail('BACKUP_RECOVERY_REQUIRED');
      const value = (await readJson(path.join(directory, name))) as Record<
        string,
        unknown
      >;
      const { checksum, ...body } = value;
      const receipt = value.receipt as Record<string, unknown> | undefined;
      if (
        value.version !== 1 ||
        value.snapshot_key !== id ||
        value.workspace_id + '.json' !== name ||
        checksum !== sha256(JSON.stringify(body)) ||
        !receipt ||
        receipt.workspace_id !== value.workspace_id ||
        receipt.snapshot_key !== id ||
        !Number.isSafeInteger(receipt.source_generation) ||
        !Number.isSafeInteger(receipt.content_revision) ||
        typeof receipt.inventory_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.inventory_hash) ||
        typeof receipt.manifest_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.manifest_hash)
      )
        fail('BACKUP_RECOVERY_REQUIRED');
    }
    return names.length > 0;
  }

  async delete(id: string) {
    return this.withCatalogLock(() =>
      this.barrier.mutation(async () => {
        await this.snapshot(id);
        if (
          (await this.catalogHeld(id)) ||
          (
            await this.store.all(
              'SELECT id FROM WorkspacePreservationHolds WHERE snapshot_key=? AND released_at IS NULL LIMIT 1',
              [id],
            )
          ).length
        )
          fail('WORKSPACE_PRESERVATION_REQUIRED');
        await this.paths.remove('snapshots', id);
      }),
    );
  }

  async exportPortable(id: string, passphrase: Buffer) {
    try {
      return await this.withCatalogLock(async () => {
        const snapshot = await this.snapshot(id);
        // Include manifest/inventory/dependency metadata and both plaintext/ciphertext.
        const estimated = Math.ceil(
          (await this.measure(snapshot.root)) * 3 + 65536,
        );
        if (
          (await this.measure(this.paths.root)) + estimated >
          this.limits.backupRetainedBytes
        )
          fail('BACKUP_QUOTA_EXCEEDED', 422);
        await this.reserve(estimated);
        const token = randomUUID(),
          plain = path.join(
            await this.paths.bucket('exports'),
            token + '.archive',
          );
        const encrypted = path.join(
          await this.paths.bucket('exports'),
          token + '.encrypted',
        );
        try {
          await packArchive(snapshot.root, plain, {
            entries: 1_000_000,
            bytes: this.limits.backupSnapshotBytes + 64 * 1024 * 1024,
            entryBytes: this.limits.backupSnapshotBytes,
          });
          await encryptPortable(
            plain,
            encrypted,
            passphrase,
            this.limits.backupSnapshotBytes + 64 * 1024 * 1024,
          );
          return encrypted;
        } finally {
          await fs.unlink(plain).catch(() => undefined);
        }
      });
    } finally {
      if (Buffer.isBuffer(passphrase)) passphrase.fill(0);
    }
  }

  async importPortable(file: string, passphrase: Buffer) {
    try {
      return await this.withCatalogLock(async () => {
        const estimated = Math.ceil((await fs.stat(file)).size * 2.2);
        if (
          (await this.measure(this.paths.root)) + estimated >
          this.limits.backupRetainedBytes
        )
          fail('BACKUP_QUOTA_EXCEEDED', 422);
        await this.reserve(estimated);
        const allocated = await this.paths.allocate('imports');
        const plain = path.join(allocated.root, 'payload.archive'),
          snapshot = path.join(allocated.root, 'snapshot');
        try {
          await decryptPortable(
            file,
            plain,
            passphrase,
            this.limits.backupSnapshotBytes + 64 * 1024 * 1024,
          );
          await fs.mkdir(snapshot, { mode: 0o700 });
          await unpackArchive(plain, snapshot, {
            entries: 1_000_000,
            bytes: this.limits.backupSnapshotBytes + 64 * 1024 * 1024,
            entryBytes: this.limits.backupSnapshotBytes,
          });
          const manifest = await this.validateRoot(snapshot);
          return {
            id: allocated.id,
            snapshot_id: manifest.backup_id,
            root: snapshot,
          };
        } catch (error) {
          await this.paths
            .remove('imports', allocated.id)
            .catch(() => undefined);
          throw error;
        } finally {
          await fs.unlink(plain).catch(() => undefined);
        }
      });
    } finally {
      if (Buffer.isBuffer(passphrase)) passphrase.fill(0);
    }
  }
}
