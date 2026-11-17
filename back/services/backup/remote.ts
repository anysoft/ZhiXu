import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { WorkspaceBackupService } from '../workspaceV2/backup';
import type { BackupMode, BackupSource } from '../workspaceV2/manifest';
import { BackupOperations } from './operations';
import { BackupError, privateJson, readJson, openRegular } from './files';
import { backupId } from './paths';
import { createRemoteStorage, RemoteTarget } from './remoteStorage';
import { parseRemoteBackupKey, remoteBackupKey } from './remoteKeys';
import {
  ProxyManagement,
  holdResolvedProxy,
  validateProxySelection,
} from '../proxyManagement';
import type { WorkspaceStore } from '../workspaceV2/store';

interface Settings {
  enabled: boolean;
  target_id: string | null;
  retain_count: number;
  passphrase: string;
}
interface Configuration {
  version: 1;
  targets: RemoteTarget[];
  settings: Settings;
}
export interface RemoteUpload {
  id: string;
  snapshot_id: string;
  target_id: string;
  target_name: string;
  source: BackupSource;
  mode: BackupMode;
  key: string;
  status: 'WAITING' | 'UPLOADING' | 'SUCCESS' | 'FAILED';
  created_at: string;
  uploaded_at: string | null;
  processed_bytes: number;
  size: number | null;
  attempt: number;
  retry_at: string | null;
  error_code?: string;
  operation_id?: string;
  retention_errors?: string[];
}
interface State {
  version: 1;
  uploads: RemoteUpload[];
}
const defaults = (): Settings => ({
  enabled: false,
  target_id: null,
  retain_count: 14,
  passphrase: '',
});
const errorCode = (e: unknown) => {
  const code =
    (e as any)?.code ?? (e as any)?.error_code ?? (e as any)?.message;
  return typeof code === 'string' && /^BACKUP_[A-Z0-9_]{1,100}$/.test(code)
    ? code
    : 'BACKUP_REMOTE_REQUEST_FAILED';
};
function invalid(): never {
  throw new BackupError('BACKUP_REMOTE_CONFIGURATION_INVALID');
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, any>;
}
function text(value: unknown, max = 4096, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim()) ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    invalid();
  return value as string;
}

/** A small durable upload queue layered on the existing exclusive backup operation. */
export class RemoteBackupService {
  readonly stateFile: string;
  private serial: Promise<unknown> = Promise.resolve();
  private active?: Promise<void>;
  private closed = false;
  private readonly using = new Map<string, number>();
  private readonly usingKeys = new Map<string, number>();
  private readonly proxies: ProxyManagement;
  constructor(
    readonly backup: WorkspaceBackupService,
    readonly operations: BackupOperations,
    readonly options: {
      now?: () => Date;
      retryDelayMs?: number;
      storageFactory?: typeof createRemoteStorage;
    } = {},
  ) {
    this.stateFile = path.join(backup.paths.root, 'remote-backup-state.json');
    this.proxies = new ProxyManagement(backup.store, backup.barrier);
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private async configuration(
    tx = this.backup.store,
  ): Promise<{ id?: number; value: Configuration }> {
    const rows = await tx.all<{ id: number; info: string }>(
      "SELECT id,info FROM Auths WHERE type='remoteBackup'",
    );
    if (rows.length > 1) invalid();
    if (!rows.length)
      return { value: { version: 1, targets: [], settings: defaults() } };
    let value: Configuration;
    try {
      value = JSON.parse(rows[0].info);
    } catch {
      return invalid();
    }
    if (value.version !== 1 || !Array.isArray(value.targets) || !value.settings)
      invalid();
    return { id: rows[0].id, value };
  }
  private async writeConfiguration(
    tx: WorkspaceStore,
    state: { id?: number; value: Configuration },
  ) {
    const now = this.now().toISOString(),
      encoded = JSON.stringify(state.value);
    if (state.id)
      await tx.run('UPDATE Auths SET info=?,updatedAt=? WHERE id=?', [
        encoded,
        now,
        state.id,
      ]);
    else
      await tx.run(
        "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('remoteBackup',?,?,?)",
        [encoded, now, now],
      );
  }
  private target(c: Configuration, id: string) {
    const target = c.targets.find((entry) => entry.id === id);
    if (!target) throw new BackupError('BACKUP_REMOTE_TARGET_NOT_FOUND');
    return target;
  }
  private dto(target: RemoteTarget) {
    const { secret_access_key, session_token, password, ...visible } = target;
    return {
      ...visible,
      has_secret_access_key: !!secret_access_key,
      has_session_token: !!session_token,
      has_password: !!password,
    };
  }
  async listTargets() {
    return (await this.configuration()).value.targets.map((entry) =>
      this.dto(entry),
    );
  }
  async getSettings() {
    const { passphrase, ...visible } = (await this.configuration()).value
      .settings;
    return { ...visible, has_passphrase: !!passphrase };
  }
  async saveSettings(input: unknown) {
    const patch = object(input);
    if (
      Object.keys(patch).some(
        (key) =>
          !['enabled', 'target_id', 'retain_count', 'passphrase'].includes(key),
      )
    )
      invalid();
    await this.backup.barrier.mutation(() =>
      this.backup.store.transaction(async (tx) => {
        const state = await this.configuration(tx),
          settings = { ...state.value.settings, ...patch };
        if (
          typeof settings.enabled !== 'boolean' ||
          !Number.isSafeInteger(settings.retain_count) ||
          settings.retain_count < 1 ||
          settings.retain_count > 1000 ||
          (settings.target_id !== null &&
            typeof settings.target_id !== 'string')
        )
          invalid();
        text(settings.passphrase, 4096, true);
        if (Buffer.byteLength(settings.passphrase) > 4096) invalid();
        if (settings.target_id) this.target(state.value, settings.target_id);
        if (
          settings.enabled &&
          (!settings.passphrase ||
            !settings.target_id ||
            !this.target(state.value, settings.target_id).enabled)
        )
          throw new BackupError('BACKUP_REMOTE_SETUP_REQUIRED');
        state.value.settings = settings;
        await this.writeConfiguration(tx, state);
      }),
    );
    return this.getSettings();
  }
  async saveTarget(input: unknown, id?: string) {
    const patch = object(input),
      allowed = [
        'name',
        'type',
        'enabled',
        'endpoint',
        'region',
        'bucket',
        'prefix',
        'access_key_id',
        'secret_access_key',
        'session_token',
        'path_style',
        'username',
        'password',
        'directory',
        'proxy',
      ];
    if (Object.keys(patch).some((key) => !allowed.includes(key))) invalid();
    if (id && this.using.has(id))
      throw new BackupError('BACKUP_REMOTE_TARGET_BUSY');
    let targetId = id;
    await this.backup.barrier.mutation(() =>
      this.backup.store.transaction(async (tx) => {
        if (id && this.using.has(id))
          throw new BackupError('BACKUP_REMOTE_TARGET_BUSY');
        const state = await this.configuration(tx),
          old = id ? this.target(state.value, id) : undefined;
        const target = {
          enabled: true,
          prefix: '',
          directory: '',
          proxy: { mode: 'INHERIT' },
          ...old,
          ...patch,
          id: old?.id ?? randomUUID(),
        } as RemoteTarget;
        text(target.name, 100);
        text(target.endpoint, 2048);
        if (
          !['S3', 'WEBDAV'].includes(target.type) ||
          typeof target.enabled !== 'boolean'
        )
          invalid();
        let endpoint: URL;
        try {
          endpoint = new URL(target.endpoint);
        } catch {
          return invalid();
        }
        if (
          !['http:', 'https:'].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash
        )
          invalid();
        target.proxy = validateProxySelection(target.proxy);
        if (target.proxy.mode === 'PROFILE')
          await this.proxies.resolve({ override: target.proxy });
        for (const key of ['prefix', 'directory'] as const) {
          const value = text(target[key] ?? '', 1024, true).replace(
            /^\/+|\/+$/g,
            '',
          );
          if (
            /[\\\x00-\x1f]/.test(value) ||
            value
              .split('/')
              .some(
                (part) => part === '.' || part === '..' || (!part && !!value),
              )
          )
            invalid();
          target[key] = value;
        }
        if (target.type === 'S3') {
          text(target.bucket, 255);
          text(target.region, 100);
          text(target.access_key_id, 4096);
          text(target.secret_access_key, 4096);
          if (target.session_token !== undefined)
            text(target.session_token, 16384, true);
          if (
            target.path_style !== undefined &&
            typeof target.path_style !== 'boolean'
          )
            invalid();
          delete target.username;
          delete target.password;
        } else {
          text(target.username ?? '', 4096, true);
          text(target.password ?? '', 4096, true);
          delete target.access_key_id;
          delete target.secret_access_key;
          delete target.session_token;
        }
        if (
          state.value.targets.some(
            (entry) =>
              entry.id !== id &&
              entry.name.toLowerCase() === target.name.toLowerCase(),
          )
        )
          throw new BackupError('BACKUP_REMOTE_NAME_CONFLICT');
        if (
          !target.enabled &&
          state.value.settings.enabled &&
          state.value.settings.target_id === target.id
        )
          throw new BackupError('BACKUP_REMOTE_TARGET_IN_USE');
        if (old) state.value.targets[state.value.targets.indexOf(old)] = target;
        else state.value.targets.push(target);
        targetId = target.id;
        await this.writeConfiguration(tx, state);
      }),
    );
    return this.dto(this.target((await this.configuration()).value, targetId!));
  }
  async deleteTarget(id: string) {
    if (this.using.has(id)) throw new BackupError('BACKUP_REMOTE_TARGET_BUSY');
    if (
      (await this.readState()).uploads.some(
        (entry) =>
          entry.target_id === id &&
          ['WAITING', 'UPLOADING'].includes(entry.status),
      )
    )
      throw new BackupError('BACKUP_REMOTE_TARGET_IN_USE');
    await this.backup.barrier.mutation(() =>
      this.backup.store.transaction(async (tx) => {
        if (this.using.has(id))
          throw new BackupError('BACKUP_REMOTE_TARGET_BUSY');
        const state = await this.configuration(tx);
        this.target(state.value, id);
        if (state.value.settings.target_id === id)
          throw new BackupError('BACKUP_REMOTE_TARGET_IN_USE');
        state.value.targets = state.value.targets.filter(
          (entry) => entry.id !== id,
        );
        await this.writeConfiguration(tx, state);
      }),
    );
  }
  private hold(map: Map<string, number>, key: string) {
    map.set(key, (map.get(key) ?? 0) + 1);
    return () => {
      const count = (map.get(key) ?? 1) - 1;
      if (count) map.set(key, count);
      else map.delete(key);
    };
  }
  private async withStorage<T>(
    id: string,
    action: (storage: ReturnType<typeof createRemoteStorage>) => Promise<T>,
  ) {
    const done = this.hold(this.using, id);
    let release = () => {};
    let storage: ReturnType<typeof createRemoteStorage> | undefined;
    try {
      const target = this.target((await this.configuration()).value, id);
      if (!target.enabled)
        throw new BackupError('BACKUP_REMOTE_TARGET_DISABLED');
      const proxy = await this.proxies.resolve({
        override: target.proxy ?? { mode: 'INHERIT' },
      });
      release = holdResolvedProxy(this.backup.store, proxy.profileId);
      storage = (this.options.storageFactory ?? createRemoteStorage)(
        target,
        proxy.url,
      );
      return await action(storage);
    } catch (e) {
      throw new BackupError(errorCode(e));
    } finally {
      storage?.close?.();
      done();
      release();
    }
  }
  async testTarget(id: string) {
    await this.withStorage(id, (storage) => storage.testConnection());
    return { status: 'SUCCESS' };
  }
  private async readState(): Promise<State> {
    await this.backup.paths.initialize();
    let state: State;
    try {
      state = await readJson(this.stateFile, 16 * 1024 * 1024, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, uploads: [] };
      throw e;
    }
    if (
      state.version !== 1 ||
      !Array.isArray(state.uploads) ||
      state.uploads.some((entry) => {
        const parsed =
          entry && typeof entry.key === 'string'
            ? parseRemoteBackupKey(entry.key)
            : null;
        return (
          !parsed ||
          parsed.backup_id !== entry.snapshot_id ||
          parsed.mode !== entry.mode ||
          parsed.source !== entry.source ||
          !/^[0-9a-f-]{36}$/.test(entry.id) ||
          !/^[0-9a-f-]{36}$/.test(entry.target_id) ||
          !['WAITING', 'UPLOADING', 'SUCCESS', 'FAILED'].includes(
            entry.status,
          ) ||
          !Number.isSafeInteger(entry.attempt) ||
          entry.attempt < 0 ||
          entry.attempt > 3 ||
          !Number.isFinite(Date.parse(entry.created_at)) ||
          (entry.retry_at !== null &&
            !Number.isFinite(Date.parse(entry.retry_at))) ||
          !Number.isSafeInteger(entry.processed_bytes) ||
          entry.processed_bytes < 0 ||
          (entry.size !== null &&
            (!Number.isSafeInteger(entry.size) || entry.size < 0))
        );
      }) ||
      new Set(state.uploads.map((entry) => entry.id)).size !==
        state.uploads.length
    )
      throw new BackupError('BACKUP_REMOTE_STATE_INVALID');
    return state;
  }
  private mutate<T>(action: (state: State) => Promise<T> | T): Promise<T> {
    const job = this.serial
      .catch(() => {})
      .then(async () => {
        const state = await this.readState(),
          value = await action(state);
        await privateJson(this.stateFile, state);
        return value;
      });
    this.serial = job;
    return job;
  }
  async uploads() {
    await this.serial;
    const entries = (await this.readState()).uploads.slice().reverse();
    for (const entry of entries)
      if (entry.status === 'UPLOADING' && entry.operation_id) {
        try {
          entry.processed_bytes =
            (await this.operations.get(entry.operation_id)).processed_bytes ??
            entry.processed_bytes;
        } catch {
          /* Persisted upload state remains the source of truth after restart. */
        }
      }
    return entries;
  }
  async pendingSnapshotIds() {
    return (await this.uploads())
      .filter(
        (entry) =>
          ['WAITING', 'UPLOADING'].includes(entry.status) ||
          (entry.status === 'FAILED' && entry.attempt < 3),
      )
      .map((entry) => entry.snapshot_id);
  }
  async enqueue(
    snapshotId: string,
    targetId?: string,
    source: BackupSource = 'MANUAL',
  ) {
    const c = (await this.configuration()).value,
      id = targetId ?? c.settings.target_id;
    if (!id || !c.settings.passphrase)
      throw new BackupError('BACKUP_REMOTE_SETUP_REQUIRED');
    const target = this.target(c, id);
    if (!target.enabled) throw new BackupError('BACKUP_REMOTE_TARGET_DISABLED');
    const { manifest } = await this.backup.snapshot(backupId(snapshotId));
    if (
      source === 'SCHEDULED' &&
      (manifest.source !== 'SCHEDULED' ||
        manifest.backup_mode !== 'LIGHTWEIGHT')
    )
      throw new BackupError('BACKUP_REMOTE_SOURCE_INVALID');
    const key = remoteBackupKey(manifest, source);
    return this.mutate((state) => {
      const prior = state.uploads.find(
        (entry) => entry.target_id === id && entry.key === key,
      );
      if (prior) return { ...prior };
      const entry: RemoteUpload = {
        id: randomUUID(),
        snapshot_id: snapshotId,
        target_id: id,
        target_name: target.name,
        source,
        mode: manifest.backup_mode ?? 'FULL',
        key,
        status: 'WAITING',
        created_at: this.now().toISOString(),
        uploaded_at: null,
        processed_bytes: 0,
        size: null,
        attempt: 0,
        retry_at: null,
      };
      state.uploads.push(entry);
      return { ...entry };
    });
  }
  async enqueueScheduled(snapshotId: string) {
    const settings = (await this.configuration()).value.settings;
    if (!settings.enabled) return null;
    return this.enqueue(snapshotId, settings.target_id!, 'SCHEDULED');
  }
  async retry(id: string) {
    const result = await this.mutate((state) => {
      const entry = state.uploads.find((value) => value.id === id);
      if (!entry) throw new BackupError('BACKUP_REMOTE_UPLOAD_NOT_FOUND');
      if (entry.status !== 'FAILED')
        throw new BackupError('BACKUP_REMOTE_UPLOAD_NOT_RETRYABLE');
      entry.status = 'WAITING';
      entry.attempt = 0;
      entry.retry_at = null;
      delete entry.error_code;
      return { ...entry };
    });
    return result;
  }
  async listObjects(targetId: string) {
    return this.withStorage(targetId, async (storage) =>
      (await storage.list())
        .flatMap((entry) => {
          const parsed = parseRemoteBackupKey(entry.key);
          return parsed ? [{ ...entry, ...parsed }] : [];
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    );
  }
  async download(targetId: string, key: string) {
    if (!parseRemoteBackupKey(key))
      throw new BackupError('BACKUP_REMOTE_OBJECT_INVALID');
    if (this.usingKeys.has(targetId + ':' + key))
      throw new BackupError('BACKUP_REMOTE_OBJECT_BUSY');
    const done = this.hold(this.usingKeys, targetId + ':' + key);
    try {
      const file = path.join(
        await this.backup.paths.bucket('exports'),
        randomUUID() + '.encrypted',
      );
      await this.withStorage(targetId, (storage) =>
        storage.download(key, file),
      );
      return file;
    } finally {
      done();
    }
  }
  async deleteObject(targetId: string, key: string) {
    if (!parseRemoteBackupKey(key))
      throw new BackupError('BACKUP_REMOTE_OBJECT_INVALID');
    if (this.usingKeys.has(targetId + ':' + key))
      throw new BackupError('BACKUP_REMOTE_OBJECT_BUSY');
    const done = this.hold(this.usingKeys, targetId + ':' + key);
    try {
      if (
        (await this.uploads()).some(
          (entry) =>
            entry.target_id === targetId &&
            entry.key === key &&
            ['WAITING', 'UPLOADING'].includes(entry.status),
        )
      )
        throw new BackupError('BACKUP_REMOTE_UPLOAD_BUSY');
      await this.withStorage(targetId, (storage) => storage.delete(key));
      await this.mutate((state) => {
        state.uploads = state.uploads.filter(
          (entry) => entry.target_id !== targetId || entry.key !== key,
        );
      });
    } finally {
      done();
    }
  }
  private async retention(targetId: string, currentKey: string) {
    const settings = (await this.configuration()).value.settings;
    const pending = (await this.readState()).uploads.filter(
      (entry) => entry.target_id === targetId && entry.status !== 'SUCCESS',
    );
    const errors: string[] = [];
    await this.withStorage(targetId, async (storage) => {
      const objects = (await storage.list())
        .filter(
          (entry) =>
            parseRemoteBackupKey(entry.key)?.source === 'SCHEDULED' &&
            !pending.some((pending) => pending.key === entry.key),
        )
        .sort((a, b) =>
          parseRemoteBackupKey(b.key)!.created_at.localeCompare(
            parseRemoteBackupKey(a.key)!.created_at,
          ),
        );
      const keep = new Set([
        currentKey,
        ...objects
          .filter((entry) => entry.key !== currentKey)
          .slice(0, Math.max(0, settings.retain_count - 1))
          .map((entry) => entry.key),
      ]);
      // Portable exports contain their preservation payload; separate remote objects do not form a chain.
      for (const entry of objects)
        if (
          !keep.has(entry.key) &&
          !this.usingKeys.has(targetId + ':' + entry.key)
        ) {
          try {
            await storage.delete(entry.key);
            await this.mutate((state) => {
              state.uploads = state.uploads.filter(
                (item) => item.target_id !== targetId || item.key !== entry.key,
              );
            });
          } catch (e) {
            errors.push(errorCode(e));
          }
        }
    });
    return errors;
  }
  private async upload(
    id: string,
    progress: { processed_bytes: number; processed_files: number },
  ) {
    let file: string | undefined;
    const entry = await this.mutate((state) => {
      const current = state.uploads.find((value) => value.id === id)!;
      current.status = 'UPLOADING';
      current.attempt++;
      current.retry_at = null;
      current.processed_bytes = 0;
      delete current.error_code;
      return { ...current };
    });
    const done = this.hold(this.using, entry.target_id);
    try {
      const settings = (await this.configuration()).value.settings;
      if (!settings.passphrase)
        throw new BackupError('BACKUP_REMOTE_SETUP_REQUIRED');
      file = await this.backup.exportPortable(
        entry.snapshot_id,
        Buffer.from(settings.passphrase, 'utf8'),
      );
      const handle = await openRegular(file);
      let size: number;
      try {
        size = (await handle.stat()).size;
      } finally {
        await handle.close();
      }
      await this.mutate((state) => {
        state.uploads.find((value) => value.id === id)!.size = size;
      });
      await this.withStorage(entry.target_id, async (storage) => {
        await storage.upload(entry.key, file!, (bytes: number) => {
          progress.processed_bytes = bytes;
        });
        const confirmed = await storage.stat(entry.key);
        if (!confirmed || confirmed.size !== size)
          throw new BackupError('BACKUP_REMOTE_CONFIRMATION_FAILED');
      });
      progress.processed_bytes = size;
      progress.processed_files = 1;
      await this.mutate((state) => {
        const current = state.uploads.find((value) => value.id === id)!;
        current.status = 'SUCCESS';
        current.uploaded_at = this.now().toISOString();
        current.processed_bytes = size;
        current.retry_at = null;
      });
      if (entry.source === 'SCHEDULED') {
        let errors: string[];
        try {
          errors = await this.retention(entry.target_id, entry.key);
        } catch (e) {
          errors = [errorCode(e)];
        }
        if (errors.length)
          await this.mutate((state) => {
            state.uploads.find((value) => value.id === id)!.retention_errors =
              errors.slice(0, 20);
          });
      }
      return {
        id,
        confirmation: 'EXISTS_AND_SIZE_MATCH',
        content_verification: 'ON_DOWNLOAD_AND_RESTORE',
      };
    } catch (e) {
      await this.mutate((state) => {
        const current = state.uploads.find((value) => value.id === id)!;
        current.status = 'FAILED';
        current.error_code = errorCode(e);
        current.retry_at =
          current.attempt < 3
            ? new Date(
                this.now().getTime() +
                  (this.options.retryDelayMs ?? 15 * 60000),
              ).toISOString()
            : null;
      });
      throw new BackupError(errorCode(e));
    } finally {
      if (file) await fs.unlink(file).catch(() => {});
      done();
    }
  }
  async tick() {
    if (this.closed || this.active) return;
    const state = await this.readState();
    const entry = state.uploads.find(
      (entry) =>
        entry.status === 'WAITING' ||
        entry.status === 'UPLOADING' ||
        (entry.status === 'FAILED' &&
          entry.retry_at !== null &&
          Date.parse(entry.retry_at) <= this.now().getTime()),
    );
    if (!entry) return;
    if (entry.attempt >= 3) {
      await this.mutate((state) => {
        const value = state.uploads.find((value) => value.id === entry.id)!;
        value.status = 'FAILED';
        value.error_code = 'BACKUP_REMOTE_UPLOAD_INTERRUPTED';
        value.retry_at = null;
      });
      return;
    }
    let operation: { id: string };
    try {
      operation = await this.operations.start('REMOTE_UPLOAD', (progress) =>
        this.upload(entry.id, progress),
      );
    } catch (e) {
      if (errorCode(e) === 'BACKUP_OPERATION_BUSY') return;
      throw e;
    }
    await this.mutate((state) => {
      state.uploads.find((value) => value.id === entry.id)!.operation_id =
        operation.id;
    });
    this.active = this.operations.wait(operation.id).finally(() => {
      this.active = undefined;
    });
  }
  async close() {
    this.closed = true;
    await this.active;
    await this.serial;
  }
}
