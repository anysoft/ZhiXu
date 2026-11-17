import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { cronNext } from '../../shared/triggerDefinition';
import { WorkspaceBackupService } from '../workspaceV2/backup';
import type {
  BackupMode,
  WorkspaceBackupManifest,
} from '../workspaceV2/manifest';
import { BackupOperations } from './operations';
import { BackupError, privateJson, readJson } from './files';

export interface ScheduledBackupSettings {
  enabled: boolean;
  time: string;
  timezone: string;
  retain_count: number;
}
export interface BackupHistoryEntry {
  id: string;
  source: 'MANUAL' | 'SCHEDULED';
  mode: BackupMode;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  scheduled_at: string | null;
  started_at: string;
  finished_at: string | null;
  size: number | null;
  duration_ms: number | null;
  attempt: number;
  cycle_key?: string;
  snapshot_id?: string;
  error_code?: string;
  retention_errors?: { id?: string; error_code: string }[];
  retention_error_count?: number;
}
interface PendingCycle {
  cycle_key: string;
  scheduled_at: string;
  attempt: number;
  status: 'WAITING' | 'RUNNING';
  retry_at: string | null;
  history_id?: string;
}
interface ScheduleState {
  version: 1;
  schedule_key: string;
  next_run_at: string;
  pending: PendingCycle | null;
  history: BackupHistoryEntry[];
}
const DAY = 86400000;
const RETRY = 15 * 60000;
const parsedObject = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BackupError('BACKUP_SCHEDULE_STATE_INVALID');
  return value as Record<string, any>;
};
const failureCode = (error: unknown) => {
  const value = error as {
    error_code?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const candidate = value?.error_code ?? value?.code ?? value?.message;
  return typeof candidate === 'string' &&
    candidate.length <= 100 &&
    /^(?:BACKUP|RESTORE|PLATFORM|WORKSPACE|DISK)_[A-Z0-9_]+$/.test(candidate)
    ? candidate
    : 'BACKUP_OPERATION_FAILED';
};

/** Daily wall-clock scheduling reuses the platform's timezone-aware parser. */
export function dailyBackupNext(
  settings: Pick<ScheduledBackupSettings, 'time' | 'timezone'>,
  after: Date,
) {
  const [hour, minute] = settings.time.split(':').map(Number);
  return cronNext(
    `${minute} ${hour} * * *`,
    settings.timezone,
    after,
  ).toISOString();
}

/** One timer and the existing backup operation lock; no browser or external scheduler is needed. */
export class ScheduledBackupService {
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private ticking?: Promise<unknown>;
  private readonly active = new Set<Promise<void>>();
  readonly stateFile: string;
  constructor(
    readonly backup: WorkspaceBackupService,
    readonly operations: BackupOperations,
    readonly options: {
      now?: () => Date;
      waitTimeoutMs?: number;
      retryDelayMs?: number;
      fault?: (
        point: string,
        detail: { cycle_key: string; snapshot_id: string },
      ) => Promise<void>;
    } = {},
  ) {
    this.stateFile = path.join(
      backup.paths.root,
      'scheduled-backup-state.json',
    );
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private async configuration(): Promise<ScheduledBackupSettings> {
    const rows = await this.backup.store.all<{ id: number; info: string }>(
      "SELECT id,info FROM Auths WHERE type='scheduledBackup'",
    );
    if (rows.length > 1)
      throw new BackupError('BACKUP_SCHEDULE_SETTINGS_INVALID');
    let timezone = 'Asia/Shanghai';
    const system = await this.backup.store.all<{ info: string }>(
      "SELECT info FROM Auths WHERE type='systemConfig'",
    );
    if (system.length > 1)
      throw new BackupError('BACKUP_SCHEDULE_SETTINGS_INVALID');
    try {
      if (system[0]) {
        const value = parsedObject(JSON.parse(system[0].info));
        if (typeof value.timezone === 'string' && value.timezone)
          timezone = value.timezone;
      }
      const settings = {
        enabled: true,
        time: '03:00',
        timezone,
        retain_count: 3,
        ...(rows[0] ? parsedObject(JSON.parse(rows[0].info)) : {}),
      };
      return this.validateSettings(settings);
    } catch {
      throw new BackupError('BACKUP_SCHEDULE_SETTINGS_INVALID');
    }
  }
  private validateSettings(
    value: Record<string, any>,
  ): ScheduledBackupSettings {
    if (
      Object.keys(value).some(
        (key) => !['enabled', 'time', 'timezone', 'retain_count'].includes(key),
      ) ||
      typeof value.enabled !== 'boolean' ||
      typeof value.time !== 'string' ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time) ||
      typeof value.timezone !== 'string' ||
      value.timezone.length > 100 ||
      !Number.isSafeInteger(value.retain_count) ||
      value.retain_count < 1 ||
      value.retain_count > 1000
    )
      throw new BackupError('BACKUP_SCHEDULE_SETTINGS_INVALID');
    try {
      dailyBackupNext(value as ScheduledBackupSettings, this.now());
    } catch {
      throw new BackupError('BACKUP_SCHEDULE_SETTINGS_INVALID');
    }
    return value as ScheduledBackupSettings;
  }
  private key(settings: ScheduledBackupSettings) {
    return `${settings.timezone}|${settings.time}`;
  }
  private async readState(): Promise<ScheduleState | null> {
    let value: any;
    try {
      value = await readJson(this.stateFile, 2 * 1024 * 1024, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (
      !value ||
      value.version !== 1 ||
      typeof value.schedule_key !== 'string' ||
      typeof value.next_run_at !== 'string' ||
      !Number.isFinite(Date.parse(value.next_run_at)) ||
      !Array.isArray(value.history) ||
      value.history.length > 100 ||
      (value.pending !== null &&
        (!value.pending ||
          typeof value.pending.cycle_key !== 'string' ||
          typeof value.pending.scheduled_at !== 'string' ||
          !Number.isFinite(Date.parse(value.pending.scheduled_at)) ||
          !['WAITING', 'RUNNING'].includes(value.pending.status) ||
          !Number.isSafeInteger(value.pending.attempt) ||
          value.pending.attempt < 0 ||
          value.pending.attempt > 3 ||
          (value.pending.retry_at !== null &&
            !Number.isFinite(Date.parse(value.pending.retry_at)))))
    )
      throw new BackupError('BACKUP_SCHEDULE_STATE_INVALID');
    for (const entry of value.history)
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        !['MANUAL', 'SCHEDULED'].includes(entry.source) ||
        !['FULL', 'LIGHTWEIGHT'].includes(entry.mode) ||
        !['RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED'].includes(entry.status) ||
        !Number.isFinite(Date.parse(entry.started_at))
      )
        throw new BackupError('BACKUP_SCHEDULE_STATE_INVALID');
    return value;
  }
  private async writeState(state: ScheduleState) {
    const evicted = state.history.slice(
      0,
      Math.max(0, state.history.length - 100),
    );
    state.history = state.history.slice(-100);
    await privateJson(this.stateFile, state);
    for (const entry of evicted) {
      if (!['SUCCESS', 'FAILED', 'SKIPPED'].includes(entry.status)) continue;
      try {
        const file = await this.backup.paths.bucket('operations', entry.id);
        const operation = await readJson(file, undefined, true);
        if (
          operation.id === entry.id &&
          ['SNAPSHOT', 'SCHEDULED_SNAPSHOT'].includes(operation.kind) &&
          ['SUCCESS', 'FAILED'].includes(operation.status)
        )
          await fs.unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.warn(
            JSON.stringify({
              event: 'BACKUP_HISTORY_CLEANUP_FAILED',
              error_code: failureCode(error),
            }),
          );
      }
    }
  }
  /** Only called while the existing operation.lock is held. */
  private async initialized(settings: ScheduledBackupSettings) {
    let state = await this.readState();
    if (!state)
      state = {
        version: 1,
        schedule_key: this.key(settings),
        next_run_at: dailyBackupNext(settings, this.now()),
        pending: null,
        history: [],
      };
    else if (state.schedule_key !== this.key(settings)) {
      state.schedule_key = this.key(settings);
      state.next_run_at = dailyBackupNext(settings, this.now());
    }
    await this.writeState(state);
    return state;
  }
  private async stateForRead(settings: ScheduledBackupSettings) {
    const state = await this.readState();
    if (state) return state;
    try {
      return await this.operations.exclusive(() => this.initialized(settings));
    } catch (error) {
      if (failureCode(error) !== 'BACKUP_OPERATION_BUSY') throw error;
      return {
        version: 1 as const,
        schedule_key: this.key(settings),
        next_run_at: dailyBackupNext(settings, this.now()),
        pending: null,
        history: [],
      };
    }
  }
  async getSettings() {
    const settings = await this.configuration(),
      state = await this.stateForRead(settings);
    return {
      ...settings,
      mode: 'LIGHTWEIGHT' as const,
      next_run_at: settings.enabled
        ? state.schedule_key === this.key(settings)
          ? state.next_run_at
          : dailyBackupNext(settings, this.now())
        : null,
      retry_at: settings.enabled ? state.pending?.retry_at ?? null : null,
      running: state.history.some((entry) => entry.status === 'RUNNING'),
      last_result: state.history.at(-1) ?? null,
    };
  }
  async status() {
    return this.getSettings();
  }
  async history() {
    const state = await this.readState();
    return {
      items: [...(state?.history ?? [])].reverse(),
      total: state?.history.length ?? 0,
    };
  }
  async saveSettings(input: unknown) {
    const patch = parsedObject(input);
    if (
      Object.keys(patch).some(
        (key) => !['enabled', 'time', 'timezone', 'retain_count'].includes(key),
      )
    )
      throw new BackupError('BACKUP_SCHEDULE_SETTINGS_INVALID');
    await this.operations.exclusive(async () => {
      const current = await this.configuration(),
        settings = this.validateSettings({ ...current, ...patch });
      let state = await this.initialized(current);
      await this.reconcile(state, current);
      await this.backup.barrier.mutation(() =>
        this.backup.store.transaction(async (tx) => {
          const rows = await tx.all<{ id: number }>(
            "SELECT id FROM Auths WHERE type='scheduledBackup'",
          );
          if (rows.length > 1)
            throw new BackupError('BACKUP_SCHEDULE_SETTINGS_INVALID');
          const now = this.now().toISOString();
          if (rows[0])
            await tx.run('UPDATE Auths SET info=?,updatedAt=? WHERE id=?', [
              JSON.stringify(settings),
              now,
              rows[0].id,
            ]);
          else
            await tx.run(
              "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('scheduledBackup',?,?,?)",
              [JSON.stringify(settings), now, now],
            );
        }),
      );
      if (
        state.schedule_key !== this.key(settings) ||
        (!current.enabled && settings.enabled)
      ) {
        state.schedule_key = this.key(settings);
        state.next_run_at = dailyBackupNext(settings, this.now());
      }
      if (
        !settings.enabled ||
        (state.pending?.status === 'WAITING' &&
          this.key(current) !== this.key(settings))
      )
        state.pending = null;
      await this.writeState(state);
    });
    this.wake();
    return this.getSettings();
  }
  private latestDue(settings: ScheduledBackupSettings, next: string) {
    const now = this.now();
    let due = new Date(next);
    if (due.getTime() > now.getTime()) return null;
    if (due.getTime() < now.getTime() - 3 * DAY)
      due = new Date(
        dailyBackupNext(settings, new Date(now.getTime() - 3 * DAY)),
      );
    for (let limit = 0; limit < 8; limit++) {
      const following = new Date(dailyBackupNext(settings, due));
      if (following.getTime() > now.getTime()) return due.toISOString();
      due = following;
    }
    throw new BackupError('BACKUP_SCHEDULE_SETTINGS_INVALID');
  }
  private cycleKey(settings: ScheduledBackupSettings, scheduled: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: settings.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(scheduled));
    const part = (type: string) =>
      parts.find((entry) => entry.type === type)!.value;
    return `daily:${settings.timezone}:${settings.time}:${part('year')}-${part(
      'month',
    )}-${part('day')}`;
  }
  private async published(
    cycle: string,
  ): Promise<{ id: string; manifest: WorkspaceBackupManifest } | null> {
    for (const id of await fs.readdir(
      await this.backup.paths.bucket('snapshots'),
    )) {
      try {
        const root = await this.backup.paths.bucket('snapshots', id);
        await this.backup.paths.assertOwned(root, id);
        const metadata = await readJson(
          path.join(root, 'manifest.json'),
          64 * 1024 * 1024,
        );
        if (
          metadata.source !== 'SCHEDULED' ||
          metadata.scheduled?.cycle_key !== cycle
        )
          continue;
        const { manifest } = await this.backup.snapshot(id);
        if (
          manifest.source === 'SCHEDULED' &&
          manifest.scheduled?.cycle_key === cycle
        )
          return { id, manifest };
      } catch {
        /* Unknown or incomplete snapshots never count as a successful occurrence. */
      }
    }
    return null;
  }
  private entry(state: ScheduleState, cycle: PendingCycle) {
    let entry = state.history.find((item) => item.id === cycle.history_id);
    if (!entry) {
      entry = {
        id: cycle.history_id ?? randomUUID(),
        source: 'SCHEDULED',
        mode: 'LIGHTWEIGHT',
        status: 'RUNNING',
        scheduled_at: cycle.scheduled_at,
        started_at: this.now().toISOString(),
        finished_at: null,
        size: null,
        duration_ms: null,
        attempt: Math.max(1, cycle.attempt),
        cycle_key: cycle.cycle_key,
      };
      state.history.push(entry);
      cycle.history_id = entry.id;
    }
    return entry;
  }
  private finish(
    entry: BackupHistoryEntry,
    status: 'SUCCESS' | 'FAILED',
    error_code?: string,
  ) {
    entry.status = status;
    entry.finished_at = this.now().toISOString();
    entry.duration_ms = Math.max(
      0,
      this.now().getTime() - Date.parse(entry.started_at),
    );
    if (error_code) entry.error_code = error_code;
    else delete entry.error_code;
  }
  private async retention(settings: ScheduledBackupSettings, newestId: string) {
    const snapshots: { id: string; manifest: WorkspaceBackupManifest }[] = [],
      errors: { id?: string; error_code: string }[] = [];
    for (const id of await fs.readdir(
      await this.backup.paths.bucket('snapshots'),
    )) {
      try {
        const root = await this.backup.paths.bucket('snapshots', id);
        await this.backup.paths.assertOwned(root, id);
        const metadata = await readJson(
          path.join(root, 'manifest.json'),
          64 * 1024 * 1024,
        );
        if (metadata.source !== 'SCHEDULED') continue;
        const { manifest } = await this.backup.snapshot(id);
        if (manifest.source === 'SCHEDULED') snapshots.push({ id, manifest });
      } catch {
        /* Corrupt/unknown origin data is preserved, never guessed as scheduled. */
      }
    }
    snapshots.sort(
      (a, b) =>
        b.manifest.created_at.localeCompare(a.manifest.created_at) ||
        b.id.localeCompare(a.id),
    );
    // Wall-clock rollback or tied timestamps never let retention remove the
    // snapshot whose successful verification authorized this cleanup.
    const keep = new Set([
      newestId,
      ...snapshots
        .filter((snapshot) => snapshot.id !== newestId)
        .slice(0, settings.retain_count - 1)
        .map((snapshot) => snapshot.id),
    ]);
    for (const snapshot of snapshots.filter(
      (snapshot) => !keep.has(snapshot.id),
    )) {
      try {
        await this.backup.delete(snapshot.id, { scheduledOnly: true });
      } catch (error) {
        errors.push({ id: snapshot.id, error_code: failureCode(error) });
      }
    }
    return errors;
  }
  private async success(
    state: ScheduleState,
    settings: ScheduledBackupSettings,
    cycle: PendingCycle,
    snapshot: { id: string; manifest: WorkspaceBackupManifest },
  ) {
    const entry = this.entry(state, cycle);
    this.finish(entry, 'SUCCESS');
    entry.snapshot_id = snapshot.id;
    entry.size = snapshot.manifest.total_bytes;
    state.pending = null;
    await this.writeState(state);
    try {
      const errors = await this.retention(settings, snapshot.id);
      if (errors.length) {
        entry.retention_error_count = errors.length;
        entry.retention_errors = errors.slice(0, 20);
      }
    } catch (error) {
      entry.retention_error_count = 1;
      entry.retention_errors = [{ error_code: failureCode(error) }];
    }
    await this.writeState(state);
    return { id: snapshot.id, backup_mode: 'LIGHTWEIGHT', source: 'SCHEDULED' };
  }
  private failure(
    state: ScheduleState,
    settings: ScheduledBackupSettings,
    cycle: PendingCycle,
    code: string,
  ) {
    this.finish(this.entry(state, cycle), 'FAILED', code);
    if (cycle.attempt < 3 && settings.enabled) {
      cycle.status = 'WAITING';
      cycle.retry_at = new Date(
        this.now().getTime() + (this.options.retryDelayMs ?? RETRY),
      ).toISOString();
      state.pending = cycle;
    } else state.pending = null;
  }
  /** Repair only abandoned claims while operation.lock proves no other producer is active. */
  private async reconcile(
    state: ScheduleState,
    settings: ScheduledBackupSettings,
  ) {
    const cycle = state.pending;
    if (cycle) {
      const snapshot = await this.published(cycle.cycle_key);
      if (snapshot) await this.success(state, settings, cycle, snapshot);
      else if (cycle.status === 'RUNNING')
        this.failure(state, settings, cycle, 'BACKUP_OPERATION_INTERRUPTED');
      if (!settings.enabled) state.pending = null;
    }
    for (const entry of state.history)
      if (entry.source === 'MANUAL' && entry.status === 'RUNNING')
        this.finish(entry, 'FAILED', 'BACKUP_OPERATION_INTERRUPTED');
    await this.writeState(state);
  }
  private async executeScheduled(force: boolean, operationId: string) {
    const settings = await this.configuration(),
      state = await this.initialized(settings);
    await this.reconcile(state, settings);
    let cycle = state.pending;
    if (!force && !settings.enabled) return { skipped: true };
    if (!cycle) {
      const scheduled = this.latestDue(settings, state.next_run_at);
      if (!force && !scheduled) return { skipped: true };
      cycle = {
        cycle_key: scheduled
          ? this.cycleKey(settings, scheduled)
          : `on-demand:${randomUUID()}`,
        scheduled_at: scheduled ?? this.now().toISOString(),
        attempt: 0,
        status: 'WAITING',
        retry_at: null,
      };
      if (scheduled) state.next_run_at = dailyBackupNext(settings, this.now());
      state.pending = cycle;
    }
    const existing = await this.published(cycle.cycle_key);
    if (existing) return this.success(state, settings, cycle, existing);
    if (
      !force &&
      cycle.retry_at &&
      Date.parse(cycle.retry_at) > this.now().getTime()
    )
      return { skipped: true };
    cycle.attempt++;
    cycle.status = 'RUNNING';
    cycle.retry_at = null;
    cycle.history_id = operationId;
    this.entry(state, cycle);
    await this.writeState(state);
    let id: string;
    let created = false;
    let snapshot: Awaited<ReturnType<WorkspaceBackupService['snapshot']>>;
    try {
      id = await this.backup.create(
        this.options.waitTimeoutMs ?? 60000,
        'LIGHTWEIGHT',
        {
          source: 'SCHEDULED',
          scheduled: {
            cycle_key: cycle.cycle_key,
            scheduled_at: cycle.scheduled_at,
            attempt: cycle.attempt,
          },
        },
      );
      created = true;
      snapshot = await this.backup.snapshot(id);
    } catch (error) {
      const published = created ? null : await this.published(cycle.cycle_key);
      if (published) return this.success(state, settings, cycle, published);
      const code = failureCode(error);
      this.failure(state, settings, cycle, code);
      await this.writeState(state);
      throw new BackupError(code);
    }
    await this.options.fault?.('after-snapshot-published', {
      cycle_key: cycle.cycle_key,
      snapshot_id: id,
    });
    return this.success(state, settings, cycle, {
      id,
      manifest: snapshot.manifest,
    });
  }
  private async admit(
    action: (operationId: string) => Promise<unknown>,
    kind: string,
  ) {
    if (this.closed) throw new BackupError('BACKUP_OPERATION_BUSY');
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    this.active.add(done);
    try {
      let operationId = '';
      const handle = await this.operations.start(kind, () =>
        action(operationId),
      );
      operationId = handle.id;
      // The existing completion promise includes the terminal fsync and owner
      // release, not just completion of the snapshot callback.
      void this.operations.wait(handle.id).finally(() => {
        this.active.delete(done);
        settled();
      });
      return { handle, done };
    } catch (error) {
      this.active.delete(done);
      settled();
      throw error;
    }
  }
  async runNow() {
    return (
      await this.admit(
        (id) => this.executeScheduled(true, id),
        'SCHEDULED_SNAPSHOT',
      )
    ).handle;
  }
  async runManual(mode: BackupMode = 'FULL', timeoutMs = 600000) {
    if (!['FULL', 'LIGHTWEIGHT'].includes(mode))
      throw new BackupError('BACKUP_MODE_INVALID');
    return (
      await this.admit(async (operationId) => {
        const settings = await this.configuration(),
          state = await this.initialized(settings);
        await this.reconcile(state, settings);
        const entry: BackupHistoryEntry = {
          id: operationId,
          source: 'MANUAL',
          mode,
          status: 'RUNNING',
          scheduled_at: null,
          started_at: this.now().toISOString(),
          finished_at: null,
          size: null,
          duration_ms: null,
          attempt: 1,
        };
        state.history.push(entry);
        await this.writeState(state);
        try {
          const id = await this.backup.create(timeoutMs, mode);
          const snapshot = await this.backup.snapshot(id);
          entry.snapshot_id = id;
          entry.size = snapshot.manifest.total_bytes;
          this.finish(entry, 'SUCCESS');
          await this.writeState(state);
          return id;
        } catch (error) {
          const code = failureCode(error);
          this.finish(entry, 'FAILED', code);
          await this.writeState(state);
          throw new BackupError(code);
        }
      }, 'SNAPSHOT')
    ).handle;
  }
  async tick() {
    if (this.closed) return;
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      let ready = false;
      try {
        ready = await this.operations.exclusive(async () => {
          const settings = await this.configuration(),
            state = await this.initialized(settings);
          await this.reconcile(state, settings);
          if (!settings.enabled) return false;
          if (state.pending)
            return (
              !state.pending.retry_at ||
              Date.parse(state.pending.retry_at) <= this.now().getTime()
            );
          return !!this.latestDue(settings, state.next_run_at);
        });
        if (ready) {
          const accepted = await this.admit(
            (id) => this.executeScheduled(false, id),
            'SCHEDULED_SNAPSHOT',
          );
          await accepted.done;
          return accepted.handle;
        }
      } catch (error) {
        if (failureCode(error) === 'BACKUP_OPERATION_BUSY')
          return { busy: true };
        throw error;
      }
    })();
    try {
      return await this.ticking;
    } finally {
      this.ticking = undefined;
    }
  }
  private wake() {
    if (this.closed || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), 1000);
    this.timer.unref();
  }
  private async loop() {
    this.timer = undefined;
    if (this.closed) return;
    try {
      await this.tick();
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'BACKUP_SCHEDULE_FAILED',
          error_code: failureCode(error),
        }),
      );
    } finally {
      if (!this.closed) {
        this.timer = setTimeout(() => void this.loop(), 60000);
        this.timer.unref();
      }
    }
  }
  start() {
    if (this.closed || this.timer || this.ticking) return;
    this.timer = setTimeout(() => void this.loop(), 1000);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.ticking;
    while (this.active.size) await Promise.all([...this.active]);
  }
}
