import { historyTimestamp } from '../shared/historyQuery';
import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { WorkspaceStore } from './workspaceV2/store';
import { WorkspaceLeaseService } from './workspaceV2/lease';
import { PlatformBackupBarrier } from './backup/barrier';
import { WorkspaceExecutionPaths } from './taskExecutionV2/paths';
import RuntimePathResolver from './runtimePaths';
import NodePathResolver from './nodePaths';
import { RuntimeLease } from './runtimeProcess';
import { errorCode, fail } from './workspaceV2/errors';

export interface MaintenanceSettings {
  auto_enabled: boolean;
  task_days: number | null;
  runtime_days: number | null;
  cache_days: number | null;
}
export interface CleanupInput {
  kind: 'task' | 'runtime' | 'storage';
  mode?: 'records' | 'logs';
  from?: string;
  to?: string;
  ids?: number[];
  status?: string;
  workspace_id?: number;
  task_id?: number;
}
interface FileIdentity {
  relative: string;
  dev: number;
  ino: number;
  size: number;
  mtime: number;
  ctime: number;
  atime: number;
}
interface Candidate {
  kind: 'task' | 'runtime' | 'cache' | 'temporary';
  id?: number;
  provider_id?: number;
  operation_type?: string;
  files: FileIdentity[];
  temp?: string;
  directory?: FileIdentity;
  mode: 'records' | 'logs';
  cutoff?: number;
}
interface Plan {
  pending?: Promise<CleanupResult>;
  expires: number;
  candidates: Candidate[];
  skipped: number;
  has_more: boolean;
  result?: CleanupResult;
}
export interface CleanupResult {
  deleted: number;
  logs_deleted: number;
  files_deleted: number;
  freed_bytes: number;
  skipped: number;
  errors: { kind: string; id?: number; code: string }[];
  has_more: boolean;
  replayed?: boolean;
}
const TASK_TERMINAL = [
  'SUCCESS',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
  'INTERRUPTED',
  'SKIPPED',
];
const RUNTIME_TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED', 'INTERRUPTED'];
const RUNTIME_REFERENCE_TABLES = [
  'RuntimeInstallations',
  'PythonEnvironmentBuilds',
  'NodeEnvironmentBuilds',
  'NodePackageManagerToolchains',
];
const RUNTIME_REFERENCE_FIELDS = [
  'operation_id',
  'last_operation_id',
  'last_install_operation_id',
  'last_verify_operation_id',
];
const CACHE_ROOTS = [
  'cache/runtime/python/downloads',
  'cache/python/pip',
  'cache/node/npm',
  'cache/node/pnpm-store',
];
const DEFAULTS: MaintenanceSettings = {
  auto_enabled: true,
  task_days: 90,
  runtime_days: 30,
  cache_days: 30,
};
const DAY = 86400000;
const integer = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const parsed = (value: unknown) => {
  try {
    return value ? JSON.parse(String(value)) : {};
  } catch {
    fail('MAINTENANCE_METADATA_INVALID', 409);
  }
};
const date = (value: unknown) => {
  try {
    return historyTimestamp(value);
  } catch {
    fail('MAINTENANCE_RANGE_INVALID', 400);
  }
};

/** One owned DATA-root service. It never visits Workspaces, installed runtimes, artifact stores or backups. */
export class StorageMaintenance {
  private readonly leases: WorkspaceLeaseService;
  private readonly paths: WorkspaceExecutionPaths;
  private readonly plans = new Map<string, Plan>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<unknown>;
  private closed = false;
  constructor(
    readonly store: WorkspaceStore,
    leases?: WorkspaceLeaseService,
    private readonly options: {
      now?: () => Date;
      planTtlMs?: number;
      batchSize?: number;
      fault?: (
        point: string,
        value: { kind: string; id?: number },
      ) => Promise<void>;
    } = {},
  ) {
    this.leases =
      leases ??
      new WorkspaceLeaseService(
        store.dataRoot,
        new PlatformBackupBarrier(store.dataRoot + '.platform-control'),
      );
    if (this.leases.dataRoot !== store.dataRoot)
      fail('MAINTENANCE_PATH_INVALID', 400);
    this.paths = new WorkspaceExecutionPaths(store.dataRoot);
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private get limit() {
    return Math.max(1, Math.min(500, this.options.batchSize ?? 500));
  }
  private async state() {
    const rows = await this.store.all<{ id: number; info: string }>(
      "SELECT id,info FROM Auths WHERE type='storageMaintenance'",
    );
    if (rows.length > 1) fail('MAINTENANCE_SETTINGS_INVALID', 503);
    return { id: rows[0]?.id, value: rows.length ? parsed(rows[0].info) : {} };
  }
  async getSettings(): Promise<
    MaintenanceSettings & {
      last_automatic_at: string | null;
      last_automatic_attempt_at?: string;
      last_automatic_result?: {
        status: 'SUCCESS' | 'FAILED';
        error_code?: string;
        errors: number;
        deleted: number;
        freed_bytes: number;
      };
    }
  > {
    const state = await this.state();
    return {
      ...DEFAULTS,
      ...(state.value.settings ?? {}),
      last_automatic_at: state.value.last_automatic_at ?? null,
      ...(state.value.last_automatic_attempt_at
        ? {
            last_automatic_attempt_at: state.value.last_automatic_attempt_at,
            last_automatic_result: state.value.last_automatic_result,
          }
        : {}),
    };
  }
  async saveSettings(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail('MAINTENANCE_SETTINGS_INVALID', 400);
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((k) => !Object.keys(DEFAULTS).includes(k)))
      fail('MAINTENANCE_SETTINGS_INVALID', 400);
    for (const key of ['task_days', 'runtime_days', 'cache_days'])
      if (
        value[key] !== undefined &&
        value[key] !== null &&
        (!integer(value[key]) || Number(value[key]) > 36500)
      )
        fail('MAINTENANCE_SETTINGS_INVALID', 400);
    if (
      value.auto_enabled !== undefined &&
      typeof value.auto_enabled !== 'boolean'
    )
      fail('MAINTENANCE_SETTINGS_INVALID', 400);
    await this.leases.barrier.mutation(() =>
      this.store.transaction(async (tx) => {
        const state = await this.state();
        state.value.settings = {
          ...DEFAULTS,
          ...state.value.settings,
          ...value,
        };
        const now = this.now().toISOString();
        if (state.id)
          await tx.run('UPDATE Auths SET info=?,updatedAt=? WHERE id=?', [
            JSON.stringify(state.value),
            now,
            state.id,
          ]);
        else
          await tx.run(
            "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('storageMaintenance',?,?,?)",
            [JSON.stringify(state.value), now, now],
          );
      }),
    );
    return this.getSettings();
  }
  private async inspect(
    relative: string,
    directory = false,
  ): Promise<FileIdentity | null> {
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative
        .split('/')
        .some((s) => !s || s === '.' || s === '..' || /[\\\0]/.test(s))
    )
      fail('MAINTENANCE_PATH_INVALID', 400);
    let current = this.store.dataRoot;
    const root = await fs.lstat(current);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (process.getuid && root.uid !== process.getuid())
    )
      fail('MAINTENANCE_PATH_INVALID');
    for (const [i, part] of relative.split('/').entries()) {
      current = path.join(current, part);
      const st = await fs.lstat(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (!st) return null;
      const last = i === relative.split('/').length - 1;
      if (
        st.isSymbolicLink() ||
        (process.getuid && st.uid !== process.getuid()) ||
        (!last || directory
          ? !st.isDirectory()
          : !st.isFile() || st.nlink !== 1)
      )
        fail('MAINTENANCE_PATH_INVALID');
      if (last)
        return {
          relative,
          dev: st.dev,
          ino: st.ino,
          size: directory ? 0 : st.size,
          mtime: st.mtimeMs,
          ctime: st.ctimeMs,
          atime: st.atimeMs,
        };
    }
    return null;
  }
  private async walk(relative: string, maximum = 100000) {
    const files: FileIdentity[] = [];
    let skipped = 0,
      truncated = false;
    const visit = async (root: string, depth: number): Promise<void> => {
      if (files.length >= maximum || depth > 24) {
        truncated = true;
        return;
      }
      try {
        if (!(await this.inspect(root, true))) return;
      } catch {
        skipped++;
        return;
      }
      for (const item of await fs.readdir(
        path.join(this.store.dataRoot, root),
        { withFileTypes: true },
      )) {
        if (files.length >= maximum) {
          truncated = true;
          break;
        }
        const name = root + '/' + item.name;
        if (item.isDirectory()) await visit(name, depth + 1);
        else {
          try {
            const info = await this.inspect(name);
            if (info) files.push(info);
          } catch {
            skipped++;
          }
        }
      }
    };
    await visit(relative, 0);
    return { files, skipped, truncated };
  }
  private async taskBlocked(row: any) {
    if (
      !TASK_TERMINAL.includes(row.status) ||
      !row.finished_at ||
      row.active_workspace_id !== null
    )
      return true;
    for (const [table, column] of [
      ['NotificationOutbox', 'task_run_id'],
      ['TriggerEvents', 'task_run_id'],
      ['TaskHealthStates', 'last_run_id'],
    ])
      if (
        (
          await this.store.all(
            `SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`,
            [row.id],
          )
        ).length
      )
        return true;
    const key = createHash('sha256')
      .update(`workspace:${row.workspace_id}`)
      .digest('hex');
    for (const relative of [
      `tmp/config-materialization/${key}`,
      `tmp/execution/node-bindings/workspace-${row.workspace_id}.json`,
    ]) {
      try {
        const st = await fs.lstat(path.join(this.store.dataRoot, relative));
        if (
          !st.isDirectory() ||
          (await fs.readdir(path.join(this.store.dataRoot, relative))).length
        )
          return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
    }
    return false;
  }
  private async runtimeBlocked(row: any, mode: 'records' | 'logs' = 'records') {
    if (
      !RUNTIME_TERMINAL.includes(row.status) ||
      !row.finished_at ||
      /CLEANUP_REQUIRED|RECOVERY_REQUIRED/.test(String(row.stage)) ||
      /CLEANUP_FAILED|RECOVERY_REQUIRED/.test(String(row.error_code))
    )
      return true;
    const metadata = parsed(row.metadata);
    if (
      metadata.cleanup_required === true ||
      metadata.recovery_required === true
    )
      return true;
    if (mode === 'logs') return false;
    for (const table of RUNTIME_REFERENCE_TABLES) {
      if (
        (
          await this.store.all(
            `SELECT 1 FROM ${table} WHERE NOT json_valid(metadata) LIMIT 1`,
          )
        ).length
      )
        return true;
      if (
        (
          await this.store.all(
            `SELECT 1 FROM ${table} WHERE ${RUNTIME_REFERENCE_FIELDS.map(
              (k) => `json_extract(metadata,'$.${k}')=?`,
            ).join(' OR ')} LIMIT 1`,
            RUNTIME_REFERENCE_FIELDS.map(() => row.id),
          )
        ).length
      )
        return true;
    }
    return false;
  }
  private async runtimeActive() {
    return !!(
      await this.store.all(
        "SELECT 1 FROM RuntimeOperations WHERE status IN ('QUEUED','RUNNING') OR stage IN ('CLEANUP_REQUIRED','RECOVERY_REQUIRED') LIMIT 1",
      )
    ).length;
  }
  private async taskTemporarySafe(relative: string, id: number) {
    for (const name of await fs.readdir(
      path.join(this.store.dataRoot, relative),
    )) {
      if (!/^attempt-[1-9]\d*$/.test(name)) return false;
      const directory = await this.inspect(relative + '/' + name, true);
      if (!directory) return false;
      const names = await fs.readdir(
        path.join(this.store.dataRoot, relative, name),
      );
      if (!names.length) continue;
      if (
        names.some(
          (file) =>
            file !== '.owner.json' &&
            !/^hook-[1-9]\d*\.(?:json|sh)$/.test(file),
        )
      )
        return false;
      const marker = await this.inspect(relative + '/' + name + '/.owner.json');
      if (!marker) return false;
      const owner = parsed(
        await fs.readFile(
          path.join(this.store.dataRoot, relative, name, '.owner.json'),
          'utf8',
        ),
      );
      if (
        owner.runId !== id ||
        `attempt-${owner.attempt}` !== name ||
        owner.dev !== directory.dev ||
        owner.ino !== directory.ino
      )
        return false;
    }
    return true;
  }
  private async rowCandidate(
    kind: 'task' | 'runtime',
    row: any,
    mode: 'records' | 'logs',
  ): Promise<Candidate | null> {
    if (
      await (kind === 'task'
        ? this.taskBlocked(row)
        : this.runtimeBlocked(row, mode))
    )
      return null;
    if (
      kind === 'runtime' &&
      mode === 'logs' &&
      parsed(row.metadata).log_cleaned === true
    )
      return null;
    const log =
      kind === 'task'
        ? `log/task-runs/run-${row.id}.log`
        : `log/runtime/runtime-operation-${row.id}.log`;
    const info = await this.inspect(log),
      files = info ? [info] : [];
    const temp =
      kind === 'task'
        ? `tmp/execution/run-${row.id}`
        : `tmp/runtime/${
            row.operation_type.startsWith('NODE_') ? 'node' : 'python'
          }/operation-${row.id}`;
    const directory =
      mode === 'records' ? await this.inspect(temp, true) : null;
    if (directory) {
      if (kind === 'task' && !(await this.taskTemporarySafe(temp, row.id)))
        return null;
      const scan = await this.walk(temp);
      if (scan.skipped || scan.truncated || scan.files.length > 2000)
        return null;
      files.push(...scan.files);
    }
    return {
      kind,
      id: row.id,
      provider_id: row.provider_id,
      operation_type: row.operation_type,
      files,
      mode,
      ...(directory ? { temp, directory } : {}),
    };
  }
  async usage() {
    const sizes = async (roots: string[]) => {
      let files = 0,
        bytes = 0,
        skipped = 0,
        truncated = false;
      for (const root of roots) {
        const s = await this.walk(root);
        files += s.files.length;
        bytes += s.files.reduce((n, f) => n + f.size, 0);
        skipped += s.skipped;
        truncated ||= s.truncated;
      }
      return { files, bytes, skipped, truncated };
    };
    const settings = await this.getSettings();
    const temporary =
        settings.cache_days === null
          ? { candidates: [], skipped: 0, truncated: false }
          : await this.temporaryCandidates(
              this.now().getTime() - settings.cache_days * DAY,
              100000,
            ),
      tempFiles = temporary.candidates.flatMap((c) => c.files);
    const databaseFiles: FileIdentity[] = [];
    for (const name of [
      'db/database.sqlite',
      'db/database.sqlite-wal',
      'db/database.sqlite-shm',
    ]) {
      const i = await this.inspect(name);
      if (i) databaseFiles.push(i);
    }
    const stat = await (
      fs as typeof fs & {
        statfs(
          target: string,
        ): Promise<{ bavail: number; blocks: number; bsize: number }>;
      }
    ).statfs(this.store.dataRoot);
    return {
      categories: {
        task_logs: await sizes(['log/task-runs']),
        runtime_logs: await sizes(['log/runtime']),
        download_cache: await sizes(CACHE_ROOTS),
        temporary: {
          files: tempFiles.length,
          bytes: tempFiles.reduce((n, f) => n + f.size, 0),
          skipped: temporary.skipped,
          truncated: temporary.truncated,
        },
        database: {
          files: databaseFiles.length,
          bytes: databaseFiles.reduce((n, f) => n + f.size, 0),
        },
      },
      disk: {
        free_bytes: Number(stat.bavail) * Number(stat.bsize),
        total_bytes: Number(stat.blocks) * Number(stat.bsize),
      },
      scanned_at: this.now().toISOString(),
    };
  }
  private input(input: CleanupInput) {
    if (
      !input ||
      !['task', 'runtime', 'storage'].includes(input.kind) ||
      Object.keys(input).some(
        (k) =>
          ![
            'kind',
            'mode',
            'from',
            'to',
            'ids',
            'status',
            'workspace_id',
            'task_id',
          ].includes(k),
      )
    )
      fail('MAINTENANCE_FILTER_INVALID', 400);
    const normalized = { ...input, mode: input.mode ?? 'records' };
    if (!['records', 'logs'].includes(normalized.mode))
      fail('MAINTENANCE_FILTER_INVALID', 400);
    if (input.kind !== 'runtime' && normalized.mode === 'logs')
      fail('MAINTENANCE_FILTER_INVALID', 400);
    if (input.from !== undefined) normalized.from = date(input.from);
    if (input.to !== undefined) normalized.to = date(input.to);
    if (normalized.from && normalized.to && normalized.from >= normalized.to)
      fail('MAINTENANCE_RANGE_INVALID', 400);
    if (
      input.ids !== undefined &&
      (!Array.isArray(input.ids) ||
        !input.ids.length ||
        input.ids.length > 500 ||
        input.ids.some((id) => !integer(id)))
    )
      fail('MAINTENANCE_FILTER_INVALID', 400);
    for (const key of ['workspace_id', 'task_id'] as const)
      if (input[key] !== undefined && !integer(input[key]))
        fail('MAINTENANCE_FILTER_INVALID', 400);
    if (
      input.status !== undefined &&
      !(
        input.kind === 'task'
          ? [
              ...TASK_TERMINAL,
              'QUEUED',
              'RESOLVING',
              'RUNNING',
              'RECOVERY_REQUIRED',
            ]
          : [...RUNTIME_TERMINAL, 'QUEUED', 'RUNNING']
      ).includes(input.status)
    )
      fail('MAINTENANCE_FILTER_INVALID', 400);
    if (
      input.kind === 'runtime' &&
      (input.workspace_id !== undefined || input.task_id !== undefined)
    )
      fail('MAINTENANCE_FILTER_INVALID', 400);
    if (
      input.kind === 'storage' &&
      ['from', 'to', 'ids', 'status', 'workspace_id', 'task_id'].some((k) =>
        Object.prototype.hasOwnProperty.call(input, k),
      )
    )
      fail('MAINTENANCE_FILTER_INVALID', 400);
    return normalized;
  }
  private async historyCandidates(input: CleanupInput, automatic = false) {
    const task = input.kind === 'task',
      table = task ? 'TaskRuns' : 'RuntimeOperations',
      parts: string[] = [],
      args: unknown[] = [];
    const time = automatic
      ? 'finished_at'
      : task
      ? 'COALESCE(started_at,submitted_at)'
      : 'COALESCE(started_at,createdAt)';
    if (input.from) {
      parts.push(`julianday(${time})>=julianday(?)`);
      args.push(input.from);
    }
    if (input.to) {
      parts.push(`julianday(${time})<julianday(?)`);
      args.push(input.to);
    }
    if (input.ids) {
      parts.push(`id IN (${input.ids.map(() => '?').join(',')})`);
      args.push(...input.ids);
    }
    if (input.status) {
      parts.push('status=?');
      args.push(input.status);
    }
    if (task && input.workspace_id) {
      parts.push('workspace_id=?');
      args.push(input.workspace_id);
    }
    if (task && input.task_id) {
      parts.push('task_id=?');
      args.push(input.task_id);
    }
    const scope = parts.length ? ' WHERE ' + parts.join(' AND ') : '';
    const count = (
      await this.store.all<{ n: number }>(
        `SELECT COUNT(*) n FROM ${table}${scope}`,
        args,
      )
    )[0].n;
    const terminal = (task ? TASK_TERMINAL : RUNTIME_TERMINAL)
      .map((s) => `'${s}'`)
      .join(',');
    parts.push(`status IN (${terminal})`);
    parts.push('finished_at IS NOT NULL');
    if (task)
      for (const [ref, col] of [
        ['NotificationOutbox', 'task_run_id'],
        ['TriggerEvents', 'task_run_id'],
        ['TaskHealthStates', 'last_run_id'],
      ])
        parts.push(
          `NOT EXISTS(SELECT 1 FROM ${ref} WHERE ${ref}.${col}=TaskRuns.id)`,
        );
    else {
      parts.push(
        "stage NOT LIKE '%CLEANUP_REQUIRED%' AND stage NOT LIKE '%RECOVERY_REQUIRED%'",
      );
      parts.push(
        "COALESCE(error_code,'') NOT LIKE '%CLEANUP_FAILED%' AND COALESCE(error_code,'') NOT LIKE '%RECOVERY_REQUIRED%'",
      );
      parts.push(
        "CASE WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata,'$.cleanup_required'),0) != 1 AND COALESCE(json_extract(metadata,'$.recovery_required'),0) != 1 ELSE 0 END",
      );
      if (input.mode === 'logs')
        parts.push(
          "CASE WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata,'$.log_cleaned'),0) != 1 ELSE 0 END",
        );
      if (input.mode !== 'logs')
        for (const ref of RUNTIME_REFERENCE_TABLES)
          parts.push(
            `NOT EXISTS(SELECT 1 FROM ${ref} WHERE CASE WHEN json_valid(${ref}.metadata) THEN ${RUNTIME_REFERENCE_FIELDS.map(
              (key) =>
                `json_extract(${ref}.metadata,'$.${key}')=RuntimeOperations.id`,
            ).join(' OR ')} ELSE 1 END)`,
          );
    }
    const rows = await this.store.all<any>(
      `SELECT * FROM ${table} WHERE ${parts.join(' AND ')} ORDER BY id LIMIT ?`,
      [...args, this.limit + 1],
    );
    const candidates: Candidate[] = [];
    for (const row of rows.slice(0, this.limit)) {
      try {
        const c = await this.rowCandidate(
          input.kind as 'task' | 'runtime',
          row,
          input.mode ?? 'records',
        );
        if (c) candidates.push(c);
      } catch {}
    }
    return {
      candidates,
      skipped: Math.max(0, count - candidates.length),
      has_more: rows.length > this.limit,
    };
  }
  private async temporaryCandidates(cutoff?: number, limit = this.limit) {
    const candidates: Candidate[] = [];
    let skipped = 0,
      truncated = false,
      visited = 0;
    // Inspect known operation directories, rather than a prefix of all history rows.
    // Unknown owners remain untouched; installed resources are outside these roots.
    for (const language of ['python', 'node']) {
      const relative = `tmp/runtime/${language}`;
      if (!(await this.inspect(relative, true))) continue;
      for (const name of await fs.readdir(
        path.join(this.store.dataRoot, relative),
      )) {
        if (!/^operation-[1-9]\d*$/.test(name)) {
          skipped++;
          continue;
        }
        if (++visited > 100000 || candidates.length >= limit) {
          truncated = true;
          break;
        }
        const id = Number(name.slice('operation-'.length));
        const row = (
          await this.store.all<any>(
            'SELECT * FROM RuntimeOperations WHERE id=?',
            [id],
          )
        )[0];
        if (
          !row ||
          row.operation_type.startsWith('NODE_') !== (language === 'node')
        ) {
          skipped++;
          continue;
        }
        if (cutoff !== undefined && Date.parse(row.finished_at) > cutoff)
          continue;
        try {
          const c = await this.rowCandidate('runtime', row, 'records');
          if (c?.temp && c.directory)
            candidates.push({
              ...c,
              kind: 'temporary',
              files: c.files.filter((f) =>
                f.relative.startsWith(c.temp! + '/'),
              ),
            });
          else skipped++;
        } catch {
          skipped++;
        }
      }
    }
    return { candidates, skipped, truncated };
  }
  private async storageCandidates() {
    const settings = await this.getSettings(),
      candidates: Candidate[] = [];
    let skipped = 0,
      has_more = false;
    if (settings.cache_days === null) return { candidates, skipped, has_more };
    const cutoff = this.now().getTime() - settings.cache_days * DAY;
    if (await this.runtimeActive())
      return { candidates, skipped: 1, has_more: false };
    for (const root of CACHE_ROOTS) {
      const scan = await this.walk(root);
      skipped += scan.skipped;
      has_more ||= scan.truncated;
      for (const file of scan.files) {
        if (Math.max(file.atime, file.mtime, file.ctime) > cutoff) continue;
        if (candidates.length >= this.limit) {
          has_more = true;
          break;
        }
        candidates.push({ kind: 'cache', files: [file], mode: 'logs', cutoff });
      }
    }
    const temps = await this.temporaryCandidates(
      cutoff,
      this.limit - candidates.length,
    );
    candidates.push(...temps.candidates);
    skipped += temps.skipped;
    has_more ||= temps.truncated;
    return { candidates, skipped, has_more };
  }
  private async policyCandidates(settings: MaintenanceSettings) {
    const candidates: Candidate[] = [],
      seen = new Set<string>();
    let skipped = 0,
      has_more = false;
    const append = (selection: {
      candidates: Candidate[];
      skipped: number;
      has_more: boolean;
    }) => {
      skipped += selection.skipped;
      has_more ||= selection.has_more;
      for (const candidate of selection.candidates) {
        const key =
          candidate.id === undefined
            ? `file:${candidate.files[0]?.relative}`
            : `${candidate.kind === 'temporary' ? 'runtime' : candidate.kind}:${
                candidate.id
              }`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (candidates.length < this.limit) candidates.push(candidate);
        else has_more = true;
      }
    };
    for (const [kind, days] of [
      ['task', settings.task_days],
      ['runtime', settings.runtime_days],
    ] as const) {
      if (days === null) continue;
      const to = new Date(this.now().getTime() - days * DAY).toISOString();
      append(await this.historyCandidates({ kind, mode: 'records', to }, true));
      // Installed resources may retain their operation record indefinitely, but not its old log.
      if (kind === 'runtime')
        append(await this.historyCandidates({ kind, mode: 'logs', to }, true));
    }
    append(await this.storageCandidates());
    return { candidates, skipped, has_more };
  }
  async preview(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      fail('MAINTENANCE_FILTER_INVALID', 400);
    const input = this.input(raw as CleanupInput),
      selected =
        input.kind === 'storage'
          ? await this.policyCandidates(await this.getSettings())
          : await this.historyCandidates(input);
    return this.plan(selected);
  }
  private plan(selected: {
    candidates: Candidate[];
    skipped: number;
    has_more: boolean;
  }) {
    const now = this.now().getTime();
    for (const [id, p] of this.plans)
      if (p.expires < now) this.plans.delete(id);
    while (this.plans.size >= 64)
      this.plans.delete(this.plans.keys().next().value!);
    const preview_id = randomUUID(),
      expires = now + (this.options.planTtlMs ?? 600000);
    this.plans.set(preview_id, { ...selected, expires });
    return {
      preview_id,
      count: selected.candidates.length,
      bytes: selected.candidates.reduce(
        (n, c) => n + c.files.reduce((v, f) => v + f.size, 0),
        0,
      ),
      skipped: selected.skipped,
      has_more: selected.has_more,
      expires_at: new Date(expires).toISOString(),
    };
  }
  private async identities(candidate: Candidate) {
    for (const expected of candidate.files) {
      const current = await this.inspect(expected.relative);
      if (!current) continue;
      if (
        ['dev', 'ino', 'size', 'mtime', 'ctime'].some(
          (k) =>
            current[k as keyof FileIdentity] !==
            expected[k as keyof FileIdentity],
        )
      )
        return false;
      if (
        candidate.cutoff !== undefined &&
        Math.max(current.atime, current.mtime, current.ctime) > candidate.cutoff
      )
        return false;
    }
    if (candidate.temp && candidate.directory) {
      const actual = await this.inspect(candidate.temp, true);
      if (actual) {
        if (
          ['dev', 'ino', 'mtime', 'ctime'].some(
            (k) =>
              actual[k as keyof FileIdentity] !==
              candidate.directory![k as keyof FileIdentity],
          )
        )
          return false;
        const scan = await this.walk(candidate.temp),
          expected = new Set(
            candidate.files
              .filter((f) => f.relative.startsWith(candidate.temp! + '/'))
              .map((f) => f.relative),
          );
        if (
          scan.skipped ||
          scan.truncated ||
          scan.files.some((f) => !expected.has(f.relative))
        )
          return false;
      }
    }
    return true;
  }
  private async removeFiles(candidate: Candidate, result: CleanupResult) {
    if (!(await this.identities(candidate))) return false;
    const existingTemp = new Map<string, FileIdentity>();
    if (candidate.temp)
      for (const file of candidate.files)
        if (file.relative.startsWith(candidate.temp + '/')) {
          const actual = await this.inspect(file.relative);
          if (actual) existingTemp.set(file.relative, actual);
        }
    if (candidate.temp) {
      if (candidate.kind === 'task')
        await this.paths.cleanupRunDirectory(candidate.id!);
      else
        await fs.rm(path.join(this.store.dataRoot, candidate.temp), {
          recursive: true,
          force: true,
        });
    }
    for (const file of candidate.files) {
      if (candidate.temp && file.relative.startsWith(candidate.temp + '/')) {
        const actual = existingTemp.get(file.relative);
        if (actual) {
          result.files_deleted++;
          result.freed_bytes += actual.size;
        }
        continue;
      }
      const current = await this.inspect(file.relative);
      if (!current) continue;
      await this.options.fault?.('before-unlink', candidate);
      await fs.unlink(path.join(this.store.dataRoot, file.relative));
      result.files_deleted++;
      result.freed_bytes += current.size;
      if (/^(log\/)/.test(file.relative)) result.logs_deleted++;
    }
    await this.options.fault?.('after-files', candidate);
    return true;
  }
  private async cleanCandidate(candidate: Candidate, result: CleanupResult) {
    if (candidate.kind === 'cache')
      return this.store.transaction(async () => {
        if (
          (await this.runtimeActive()) ||
          !(await this.removeFiles(candidate, result))
        )
          return false;
        return true;
      });
    const task = candidate.kind === 'task',
      table = task ? 'TaskRuns' : 'RuntimeOperations';
    const owner = task
      ? await this.paths.owner(candidate.id!)
      : candidate.operation_type?.startsWith('NODE_')
      ? await new NodePathResolver(this.store.dataRoot).lease(
          'operation',
          candidate.id!,
        )
      : await RuntimeLease.acquire(
          new RuntimePathResolver(this.store.dataRoot),
          candidate.provider_id!,
        );
    try {
      const action = () =>
        this.store.transaction(async (tx) => {
          const row = (
            await tx.all<any>(`SELECT * FROM ${table} WHERE id=?`, [
              candidate.id!,
            ])
          )[0];
          if (!row) return true;
          if (
            await (task
              ? this.taskBlocked(row)
              : this.runtimeBlocked(row, candidate.mode))
          )
            return false;
          if (!(await this.removeFiles(candidate, result))) return false;
          if (candidate.kind === 'temporary') return true;
          await this.options.fault?.('before-delete', candidate);
          if (candidate.mode === 'records') {
            await tx.run(`DELETE FROM ${table} WHERE id=?`, [row.id]);
            result.deleted++;
          } else {
            const metadata = parsed(row.metadata);
            metadata.log_cleaned = true;
            await tx.run(
              'UPDATE RuntimeOperations SET metadata=?,updatedAt=? WHERE id=?',
              [JSON.stringify(metadata), this.now().toISOString(), row.id],
            );
          }
          return true;
        });
      if (task) {
        const row = (
          await this.store.all<any>('SELECT * FROM TaskRuns WHERE id=?', [
            candidate.id!,
          ])
        )[0];
        return (
          !row ||
          this.leases.withWorkspace(row.workspace_id, 'HISTORY_CLEANUP', action)
        );
      }
      return action();
    } finally {
      await owner.release();
    }
  }
  async clean(input: { preview_id: string }) {
    if (
      !input ||
      typeof input.preview_id !== 'string' ||
      Object.keys(input).some((k) => k !== 'preview_id')
    )
      fail('MAINTENANCE_PREVIEW_INVALID', 400);
    const plan = this.plans.get(input.preview_id);
    if (!plan || plan.expires < this.now().getTime())
      fail('MAINTENANCE_PREVIEW_EXPIRED', 409);
    if (plan.result) return { ...plan.result, replayed: true };
    if (plan.pending) return plan.pending;
    plan.pending = this.executePlan(plan);
    try {
      return await plan.pending;
    } finally {
      plan.pending = undefined;
    }
  }
  private async executePlan(plan: Plan) {
    const result: CleanupResult = {
      deleted: 0,
      logs_deleted: 0,
      files_deleted: 0,
      freed_bytes: 0,
      skipped: plan.skipped,
      errors: [],
      has_more: plan.has_more,
    };
    await this.leases.barrier.mutation(async () => {
      for (const candidate of plan.candidates) {
        try {
          if (!(await this.cleanCandidate(candidate, result))) result.skipped++;
        } catch (e) {
          const code = errorCode(e);
          if (
            [
              'RUNTIME_BUSY',
              'WORKSPACE_BUSY',
              'PLATFORM_BACKUP_IN_PROGRESS',
            ].includes(code)
          )
            result.skipped++;
          else
            result.errors.push({
              kind: candidate.kind,
              id: candidate.id,
              code:
                code === 'WORKSPACE_OPERATION_FAILED'
                  ? 'MAINTENANCE_DELETE_FAILED'
                  : code,
            });
        }
        await new Promise<void>((r) => setImmediate(r));
      }
    });
    if (!result.errors.length) plan.result = result;
    return result;
  }
  async runAutomatic() {
    const settings = await this.getSettings();
    if (!settings.auto_enabled) return { disabled: true };
    const last = settings.last_automatic_at;
    if (last && this.now().getTime() - Date.parse(last) < DAY)
      return { not_due: true };
    try {
      const result = await this.performAutomatic(settings);
      const errors = result.results.reduce((n, r) => n + r.errors.length, 0);
      await this.recordAutomatic({
        status: errors ? 'FAILED' : 'SUCCESS',
        errors,
        deleted: result.results.reduce((n, r) => n + r.deleted, 0),
        freed_bytes: result.results.reduce((n, r) => n + r.freed_bytes, 0),
        ...(errors
          ? { error_code: result.results.flatMap((r) => r.errors)[0].code }
          : {}),
      });
      return result;
    } catch (error) {
      const code = errorCode(error),
        error_code =
          code === 'WORKSPACE_OPERATION_FAILED'
            ? 'MAINTENANCE_AUTOMATIC_FAILED'
            : code;
      await this.recordAutomatic({
        status: 'FAILED',
        error_code,
        errors: 1,
        deleted: 0,
        freed_bytes: 0,
      }).catch(() =>
        console.warn(
          JSON.stringify({ event: 'MAINTENANCE_AUTOMATIC_FAILED', error_code }),
        ),
      );
      throw error;
    }
  }
  private async recordAutomatic(result: {
    status: 'SUCCESS' | 'FAILED';
    error_code?: string;
    errors: number;
    deleted: number;
    freed_bytes: number;
  }) {
    await this.leases.barrier.mutation(() =>
      this.store.transaction(async (tx) => {
        const state = await this.state(),
          now = this.now().toISOString();
        state.value.last_automatic_attempt_at = now;
        state.value.last_automatic_result = result;
        if (result.status === 'SUCCESS') state.value.last_automatic_at = now;
        if (state.id)
          await tx.run('UPDATE Auths SET info=?,updatedAt=? WHERE id=?', [
            JSON.stringify(state.value),
            now,
            state.id,
          ]);
        else
          await tx.run(
            "INSERT INTO Auths(type,info,createdAt,updatedAt) VALUES('storageMaintenance',?,?,?)",
            [JSON.stringify(state.value), now, now],
          );
      }),
    );
  }
  private async performAutomatic(settings: MaintenanceSettings) {
    const results: CleanupResult[] = [];
    for (let batch = 0; batch < 20; batch++) {
      const selection = await this.policyCandidates(settings),
        preview = this.plan(selection);
      if (!preview.count) break;
      const result = await this.clean({ preview_id: preview.preview_id });
      results.push(result);
      if (
        !result.has_more ||
        result.errors.length ||
        result.skipped > selection.skipped
      )
        break;
    }
    return { results };
  }
  start() {
    if (this.closed || this.timer || this.pending) return;
    const tick = () => {
      this.timer = undefined;
      if (this.pending || this.closed) return;
      this.pending = this.runAutomatic()
        .catch(() => ({ error_code: 'MAINTENANCE_AUTOMATIC_FAILED' }))
        .finally(() => {
          this.pending = undefined;
          // Check hourly; runAutomatic's daily due gate prevents duplicate cleanups.
          if (!this.closed) {
            this.timer = setTimeout(tick, 3600000);
            this.timer.unref();
          }
        });
    };
    this.timer = setTimeout(tick, 30000);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pending;
    this.plans.clear();
  }
}
