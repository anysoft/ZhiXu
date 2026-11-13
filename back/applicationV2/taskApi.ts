import type { ApiCall, RouteMap, V2Services } from './types';
import type {
  TaskDefinition,
  TaskWrite,
} from '../services/taskExecutionV2/task';
import type { RunRow } from '../services/taskExecutionV2/types';
import { fail } from '../services/workspaceV2/errors';
import { runtimeKind } from '../shared/taskDefinition';
import {
  object,
  number,
  pathId,
  queryNumber,
  text,
  boolean,
  choice,
  nullableId,
  pagination,
  json,
  canonicalDate,
  strings,
  expected,
} from './taskValidation';

const STATES = [
  'QUEUED',
  'RESOLVING',
  'RUNNING',
  'SUCCESS',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
  'INTERRUPTED',
  'SKIPPED',
  'RECOVERY_REQUIRED',
] as const;
export function taskWrite(
  value: unknown,
  update = false,
): TaskWrite & { expected_version?: number } {
  const fields = [
    'name',
    'description',
    'enabled',
    'arguments',
    'source',
    'runtime',
    'execution',
    'env_profile_id',
  ];
  const b = object(
    value,
    [...fields, ...(update ? ['expected_version'] : [])],
    [...fields, ...(update ? ['expected_version'] : [])],
  );
  const source = object(
    b.source,
    [
      'type',
      'workspace_id',
      'relative_entrypoint',
      'language',
      'cwd_mode',
      'cwd_relative_path',
    ],
    [
      'type',
      'workspace_id',
      'relative_entrypoint',
      'language',
      'cwd_mode',
      'cwd_relative_path',
    ],
  );
  const runtime = object(
    b.runtime,
    ['kind', 'python_environment_id', 'node_environment_id'],
    ['kind', 'python_environment_id', 'node_environment_id'],
  );
  const execution = object(
    b.execution,
    [
      'timeout_seconds',
      'max_attempts',
      'initial_delay_seconds',
      'backoff',
      'concurrency',
      'notification',
    ],
    [
      'timeout_seconds',
      'max_attempts',
      'initial_delay_seconds',
      'backoff',
      'concurrency',
      'notification',
    ],
  );
  return {
    name: text(b.name, 255),
    description: text(b.description, 65536, true),
    enabled: boolean(b.enabled),
    arguments: strings(b.arguments),
    env_profile_id: nullableId(b.env_profile_id),
    source: {
      type: choice(source.type, ['WORKSPACE_ENTRYPOINT']),
      workspace_id: number(source.workspace_id),
      relative_entrypoint: text(source.relative_entrypoint, 4096),
      language: choice(source.language, [
        'PYTHON',
        'JAVASCRIPT',
        'TYPESCRIPT',
        'SHELL',
      ]),
      cwd_mode: choice(source.cwd_mode, [
        'WORKSPACE_ROOT',
        'ENTRYPOINT_DIR',
        'CUSTOM_RELATIVE',
      ]),
      cwd_relative_path:
        source.cwd_relative_path === null
          ? null
          : text(source.cwd_relative_path, 4096),
    },
    runtime: {
      kind: choice(runtime.kind, ['PYTHON', 'NODE', 'SHELL']),
      python_environment_id: nullableId(runtime.python_environment_id),
      node_environment_id: nullableId(runtime.node_environment_id),
    },
    execution: {
      timeout_seconds:
        execution.timeout_seconds === null
          ? null
          : number(execution.timeout_seconds),
      max_attempts: number(execution.max_attempts, 1, 100),
      initial_delay_seconds: number(execution.initial_delay_seconds, 0),
      backoff: choice(execution.backoff, ['FIXED', 'EXPONENTIAL']),
      concurrency: choice(execution.concurrency, ['FORBID', 'QUEUE', 'ALLOW']),
      notification: choice(execution.notification, [
        'NONE',
        'FAILURE',
        'SUCCESS',
        'ALWAYS',
      ]),
    },
    ...(update ? { expected_version: number(b.expected_version) } : {}),
  };
}
export function taskDto(d: TaskDefinition) {
  return {
    id: d.task.id,
    version: d.task.version,
    name: d.task.name,
    description: d.task.description,
    enabled: !!d.task.enabled,
    arguments: json(d.task.arguments, []),
    source: {
      type: d.source.type,
      workspace_id: d.source.workspace_id,
      relative_entrypoint: d.source.relative_entrypoint,
      language: d.source.language,
      cwd_mode: d.source.cwd_mode,
      cwd_relative_path: d.source.cwd_relative_path,
    },
    runtime: d.runtimeBinding
      ? {
          kind: d.runtimeBinding.kind,
          python_environment_id: d.runtimeBinding.python_environment_id,
          node_environment_id: d.runtimeBinding.node_environment_id,
        }
      : {
          kind: runtimeKind(d.source.language),
          python_environment_id: null,
          node_environment_id: null,
        },
    execution: {
      timeout_seconds: d.settings.timeout_seconds,
      max_attempts: d.settings.max_attempts,
      initial_delay_seconds: d.settings.initial_delay_seconds,
      backoff: d.settings.backoff,
      concurrency: d.settings.concurrency,
      notification: d.settings.notification,
    },
    env_profile_id: d.task.env_profile_id,
    origin: d.task.origin,
    discovery_state: d.task.discovery_state,
  };
}
function resourceVersions(value: any) {
  return {
    global_env_version: value.global_env_version,
    system_allowlist_build_version: value.system_allowlist_build_version,
    profile: value.profile
      ? { id: value.profile.id, version: value.profile.version }
      : null,
    python: value.python
      ? {
          environment_id: value.python.environment_id,
          revision_id: value.python.revision_id,
          build_id: value.python.build_id,
          runtime_id: value.python.runtime_id,
        }
      : null,
    node: value.node
      ? {
          environment_id: value.node.environment_id,
          revision_id: value.node.revision_id,
          build_id: value.node.build_id,
          runtime_id: value.node.runtime_id,
          toolchain_id: value.node.toolchain_id,
        }
      : null,
    config_revisions: (value.config_revisions ?? []).map((c: any) => ({
      asset_id: c.asset_id,
      revision_id: c.revision_id,
      binding_id: c.binding_id,
      binding_version: c.binding_version,
    })),
  };
}
export function runDto(row: RunRow) {
  const source = json<any>(row.source_snapshot, null);
  return {
    id: row.id,
    task_id: row.task_id,
    workspace_id: row.workspace_id,
    status: row.status,
    concurrency_policy: row.concurrency_policy,
    submitted_at: row.submitted_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    queue: {
      reason: row.queue_reason,
      deadline_at: row.queue_deadline_at,
      next_eligible_at: row.next_eligible_at,
      attempt_count: row.queue_attempt_count,
      wait_mode: row.wait_mode,
    },
    attempt_count: row.attempt_count,
    error_code: row.error_code,
    source_snapshot: source
      ? {
          workspace_id: source.workspace_id,
          workspace_type: source.workspace_type,
          source_generation: source.source_generation,
          content_revision: source.content_revision,
          task_definition_version: source.task_definition_version,
          inventory_hash: source.inventory_hash,
          entrypoint_checksum: source.entrypoint_checksum,
          relative_entrypoint: source.relative_entrypoint,
          cwd_mode: source.cwd_mode,
          cwd_relative_path: source.cwd_relative_path,
          git: source.git
            ? {
                repository_id: source.git.repository_id,
                commit: source.git.commit,
                ref_type: source.git.ref_type,
                ref_name: source.git.ref_name,
              }
            : null,
          effective_resource_versions: resourceVersions(
            source.effective_resource_versions,
          ),
        }
      : null,
  };
}
function cursor(value: unknown) {
  if (value === undefined) return 0;
  const decoded = Buffer.from(text(value, 100), 'base64url').toString('utf8');
  if (!/^(0|[1-9][0-9]*)$/.test(decoded)) fail('INVALID_REQUEST', 400);
  return number(Number(decoded), 0);
}
const nextCursor = (offset: number) =>
  Buffer.from(String(offset)).toString('base64url');
export function taskApiRoutes(
  s: V2Services,
  privateRoots: readonly (string | undefined)[] = [],
): RouteMap {
  const id = (c: ApiCall) => pathId(c.params.id);
  const logRoots = [
    ...new Set(
      [
        s.store.dataRoot,
        s.store.dataRoot + '.platform-control',
        s.backup?.paths?.root,
        ...privateRoots,
      ].filter(
        (root): root is string =>
          typeof root === 'string' && root.startsWith('/') && root.length > 1,
      ),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .map((root) => Buffer.from(root));
  const maximumRootLength = Math.max(0, ...logRoots.map((root) => root.length));
  const listRuns = async (query: Record<string, unknown>, taskId?: number) => {
    object(query, ['page', 'size', 'task_id', 'workspace_id', 'status']);
    const page = pagination(query),
      where: string[] = [],
      values: any[] = [];
    for (const key of ['task_id', 'workspace_id'])
      if (query[key] !== undefined) {
        where.push(`${key}=?`);
        values.push(pathId(query[key]));
      }
    if (taskId !== undefined) {
      where.push('task_id=?');
      values.push(taskId);
    }
    if (query.status !== undefined) {
      where.push('status=?');
      values.push(choice(query.status, STATES));
    }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = (
      await s.store.all<{ n: number }>(
        `SELECT COUNT(*) n FROM TaskRuns${clause}`,
        values,
      )
    )[0].n;
    const rows = await s.store.all<RunRow>(
      `SELECT * FROM TaskRuns${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...values, page.size, page.offset],
    );
    return { items: rows.map(runDto), page: page.page, size: page.size, total };
  };
  const log = async (runId: number, query: Record<string, unknown>) => {
    object(query, ['cursor', 'limit_bytes']);
    const offset = cursor(query.cursor),
      limit = queryNumber(query.limit_bytes, 65536, 1, 1048576);
    const row = await s.execution.get(runId),
      bytes = Buffer.from(await s.execution.logs(runId)),
      end = Math.min(bytes.length, offset + limit);
    if (offset > bytes.length) fail('INVALID_REQUEST', 400);
    const complete =
      !['QUEUED', 'RESOLVING', 'RUNNING', 'RECOVERY_REQUIRED'].includes(
        row.status,
      ) && end === bytes.length;
    // Cursors and the requested window remain original-byte positions. Inspect
    // only enough neighbouring bytes to recognize a private root split across
    // pages, then project the selected slice without altering retained history.
    const windowStart = Math.max(0, offset - maximumRootLength + 1);
    const window = bytes.subarray(
      windowStart,
      Math.min(bytes.length, end + maximumRootLength - 1),
    );
    const matches: Array<{ start: number; end: number }> = [];
    for (const root of logRoots) {
      let found = window.indexOf(root);
      while (found !== -1) {
        const start = windowStart + found,
          stop = start + root.length;
        if (start < end && stop > offset)
          matches.push({
            start: Math.max(offset, start),
            end: Math.min(end, stop),
          });
        found = window.indexOf(root, found + root.length);
      }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Array<{ start: number; end: number }> = [];
    for (const match of matches) {
      const previous = merged.at(-1);
      if (previous && match.start <= previous.end)
        previous.end = Math.max(previous.end, match.end);
      else merged.push({ ...match });
    }
    const parts: Buffer[] = [];
    let position = offset;
    for (const match of merged) {
      parts.push(
        bytes.subarray(position, match.start),
        Buffer.from('<workspace-data>'),
      );
      position = match.end;
    }
    parts.push(bytes.subarray(position, end));
    return {
      text: Buffer.concat(parts).toString('utf8'),
      next_cursor: complete ? null : nextCursor(end),
      complete,
      truncated: end < bytes.length,
    };
  };
  const stats = async (taskId: number, query: Record<string, unknown>) => {
    object(query, ['from', 'to']);
    await s.tasks.get(taskId);
    const conditions = ['task_id=?'],
      params: any[] = [taskId];
    for (const [key, op] of [
      ['from', '>='],
      ['to', '<='],
    ] as const)
      if (query[key] !== undefined) {
        conditions.push(`submitted_at${op}?`);
        params.push(canonicalDate(query[key]));
      }
    const row = (
      await s.store.all<any>(
        `SELECT COUNT(*) total,SUM(status='SUCCESS') success,SUM(status IN ('FAILED','TIMEOUT','INTERRUPTED')) failed,SUM(status='SKIPPED') skipped FROM TaskRuns WHERE ${conditions.join(
          ' AND ',
        )}`,
        params,
      )
    )[0];
    return {
      task_id: taskId,
      total: row.total,
      success: row.success ?? 0,
      failed: row.failed ?? 0,
      skipped: row.skipped ?? 0,
    };
  };
  return {
    'GET /tasks': async (c) => {
      object(c.query, [
        'page',
        'size',
        'workspace_id',
        'workspace_type',
        'language',
        'enabled',
      ]);
      const page = pagination(c.query),
        where: string[] = [],
        params: any[] = [];
      if (c.query.workspace_id !== undefined) {
        where.push('t.workspace_id=?');
        params.push(pathId(c.query.workspace_id));
      }
      if (c.query.workspace_type !== undefined) {
        where.push('w.type=?');
        params.push(choice(c.query.workspace_type, ['LOCAL', 'GIT']));
      }
      if (c.query.enabled !== undefined) {
        where.push('t.enabled=?');
        params.push(
          choice(c.query.enabled, ['true', 'false']) === 'true' ? 1 : 0,
        );
      }
      if (c.query.language !== undefined) {
        where.push(
          'EXISTS(SELECT 1 FROM TaskSources source WHERE source.task_id=t.id AND source.language=?)',
        );
        params.push(
          choice(c.query.language, [
            'PYTHON',
            'JAVASCRIPT',
            'TYPESCRIPT',
            'SHELL',
          ]),
        );
      }
      const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
      const total = (
        await s.store.all<{ n: number }>(
          `SELECT COUNT(*) n FROM Tasks t JOIN Workspaces w ON w.id=t.workspace_id${clause}`,
          params,
        )
      )[0].n;
      const rows = await s.store.all<{ id: number }>(
        `SELECT t.id FROM Tasks t JOIN Workspaces w ON w.id=t.workspace_id${clause} ORDER BY t.id DESC LIMIT ? OFFSET ?`,
        [...params, page.size, page.offset],
      );
      return {
        items: await Promise.all(
          rows.map(async (r) => taskDto(await s.tasks.get(r.id))),
        ),
        page: page.page,
        size: page.size,
        total,
      };
    },
    'POST /tasks': async (c) =>
      taskDto(await s.tasks.create(taskWrite(c.body))),
    'POST /tasks/:id/restore-discovered': async (c) =>
      taskDto(await s.discovery.restoreRetired(id(c), expected(c.body))),
    'GET /tasks/:id': async (c) => {
      object(c.query, []);
      return taskDto(await s.tasks.get(id(c)));
    },
    'PUT /tasks/:id': async (c) => {
      const b = taskWrite(c.body, true);
      const { expected_version, ...write } = b;
      return taskDto(await s.tasks.update(id(c), expected_version!, write));
    },
    'DELETE /tasks/:id': async (c) => {
      await s.tasks.remove(id(c), expected(c.body));
      return null;
    },
    'POST /tasks/:id/clone': async (c) => {
      const b = object(
        c.body,
        ['name', 'expected_version'],
        ['name', 'expected_version'],
      );
      return taskDto(
        await s.tasks.clone(
          id(c),
          text(b.name, 255),
          number(b.expected_version),
        ),
      );
    },
    'PUT /tasks/:id/enabled': async (c) => {
      const b = object(
        c.body,
        ['enabled', 'expected_version'],
        ['enabled', 'expected_version'],
      );
      return taskDto(
        await s.tasks.setEnabled(
          id(c),
          number(b.expected_version),
          boolean(b.enabled),
        ),
      );
    },
    ...Object.fromEntries(
      ['GET /tasks/:id/resources', 'POST /tasks/:id/validate'].map((key) => [
        key,
        async (c: ApiCall) => {
          object(c.query, []);
          if (key.startsWith('POST')) object(c.body ?? {}, []);
          const d = await s.tasks.get(id(c)),
            r = await s.tasks.readiness(id(c));
          return {
            task_id: d.task.id,
            task_definition_version: d.task.version,
            workspace_id: d.task.workspace_id,
            status:
              r.status === 'RECOVERY_REQUIRED'
                ? 'RESOURCE_UNAVAILABLE'
                : r.status,
            diagnostics: r.diagnostics.map((x) => ({
              code: x.code,
              resource_type: 'TASK',
            })),
          };
        },
      ]),
    ),
    'POST /tasks/:id/run': async (c) => {
      const b = object(c.body ?? {}, ['wait_mode']);
      return runDto(
        await s.execution.submit(id(c), {
          waitMode:
            b.wait_mode === undefined
              ? 'WAIT'
              : choice(b.wait_mode, ['WAIT', 'SKIP', 'FAIL_FAST']),
          submissionKey: c.idempotencyKey,
          triggerType: 'MANUAL',
        }),
      );
    },
    'POST /tasks/:id/stop': async (c) => {
      object(c.body ?? {}, []);
      await s.tasks.get(id(c));
      const rows = await s.store.all<{ id: number }>(
        "SELECT id FROM TaskRuns WHERE task_id=? AND status IN ('QUEUED','RESOLVING','RUNNING')",
        [id(c)],
      );
      for (const row of rows) await s.execution.cancel(row.id);
      return { cancelled_run_ids: rows.map((r) => r.id) };
    },
    'POST /task-runs/:id/cancel': async (c) => {
      object(c.body ?? {}, []);
      return runDto(await s.execution.cancel(id(c)));
    },
    'GET /tasks/:id/runs': async (c) => {
      await s.tasks.get(id(c));
      return listRuns(c.query, id(c));
    },
    'GET /task-runs': async (c) => listRuns(c.query),
    'GET /task-runs/:id': async (c) => {
      object(c.query, []);
      return runDto(await s.execution.get(id(c)));
    },
    'GET /task-runs/:id/attempts': async (c) => {
      object(c.query, []);
      return (await s.execution.attempts(id(c))).map((r: any) => ({
        id: r.id,
        task_run_id: r.task_run_id,
        attempt_number: r.attempt_number,
        status: r.status,
        error_code: r.error_code,
      }));
    },
    'GET /task-runs/:id/events': async (c) => {
      object(c.query, ['cursor', 'limit_bytes']);
      const after = cursor(c.query.cursor),
        limit = queryNumber(c.query.limit_bytes, 65536, 1, 1048576),
        events: any[] = [];
      let bytes = 0;
      for (const raw of (await s.execution.events(id(c))) as any[]) {
        if (raw.sequence <= after) continue;
        const values = json<any>(raw.metadata, {}),
          safe_metadata: Record<string, string | number | boolean | null> = {};
        for (const key of [
          'task_id',
          'task_definition_version',
          'reason',
          'attempt',
          'delay_seconds',
          'code',
          'status',
        ]) {
          const v = values[key];
          if (
            v === null ||
            typeof v === 'number' ||
            typeof v === 'boolean' ||
            (typeof v === 'string' && /^[A-Z0-9_]+$/.test(v))
          )
            safe_metadata[key] = v;
        }
        const event = { sequence: raw.sequence, type: raw.type, safe_metadata };
        const size = Buffer.byteLength(JSON.stringify(event));
        if (events.length && bytes + size > limit) break;
        events.push(event);
        bytes += size;
      }
      return {
        events,
        next_cursor: events.length ? nextCursor(events.at(-1).sequence) : null,
      };
    },
    'GET /task-runs/:id/log': async (c) => log(id(c), c.query),
    'GET /tasks/:id/log': async (c) => {
      await s.tasks.get(id(c));
      const row = (
        await s.store.all<{ id: number }>(
          'SELECT id FROM TaskRuns WHERE task_id=? ORDER BY id DESC LIMIT 1',
          [id(c)],
        )
      )[0];
      return row
        ? log(row.id, c.query)
        : { text: '', next_cursor: null, complete: true, truncated: false };
    },
    'GET /tasks/:id/logs': async (c) => {
      object(c.query, ['page', 'size']);
      await s.tasks.get(id(c));
      const page = pagination(c.query),
        rows = await s.store.all<any>(
          'SELECT id run_id,started_at,finished_at FROM TaskRuns WHERE task_id=? ORDER BY id DESC LIMIT ? OFFSET ?',
          [id(c), page.size, page.offset],
        ),
        total = (
          await s.store.all<{ n: number }>(
            'SELECT COUNT(*) n FROM TaskRuns WHERE task_id=?',
            [id(c)],
          )
        )[0].n;
      return { items: rows, page: page.page, size: page.size, total };
    },
    'GET /observability/summary': async (c) => {
      object(c.query, ['workspace_id']);
      const params =
          c.query.workspace_id === undefined
            ? []
            : [pathId(c.query.workspace_id)],
        where = params.length ? ' WHERE workspace_id=?' : '';
      const row = (
        await s.store.all<any>(
          `SELECT SUM(status='QUEUED') queued,SUM(status IN ('RESOLVING','RUNNING')) running,SUM(status='SUCCESS') success,SUM(status IN ('FAILED','TIMEOUT','INTERRUPTED')) failed,SUM(status='SKIPPED') skipped FROM TaskRuns${where}`,
          params,
        )
      )[0];
      return {
        queued: row.queued ?? 0,
        running: row.running ?? 0,
        success: row.success ?? 0,
        failed: row.failed ?? 0,
        skipped: row.skipped ?? 0,
      };
    },
    'GET /tasks/:id/health': async (c) => {
      object(c.query, []);
      await s.tasks.get(id(c));
      const row = (
        await s.store.all<any>(
          'SELECT consecutive_failures,last_run_id FROM TaskHealthStates WHERE task_id=?',
          [id(c)],
        )
      )[0];
      return {
        task_id: id(c),
        consecutive_failures: row?.consecutive_failures ?? 0,
        last_run_id: row?.last_run_id ?? null,
      };
    },
    'GET /tasks/:id/stats': async (c) => stats(id(c), c.query),
  };
}
