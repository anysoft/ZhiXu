import { fail } from './errors';
import { WorkspaceStore } from './store';
import { cronNext, relativeGlob } from '../../shared/triggerDefinition';

export interface WorkspaceInitialization {
  sync_policy?: unknown;
  discovery?: unknown;
}
function record(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_REQUEST', 400);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key)))
    fail('INVALID_REQUEST', 400);
  return row;
}
/** Validate before allocating an identity, then persist the canonical request for recovery. */
export function normalizeWorkspaceInitialization(
  input: WorkspaceInitialization | undefined,
  refType?: string,
) {
  if (
    !input ||
    (input.sync_policy === undefined && input.discovery === undefined)
  )
    return undefined;
  const result: WorkspaceInitialization = {};
  if (input.sync_policy !== undefined) {
    const p = record(input.sync_policy, ['enabled', 'mode', 'schedule']);
    if (
      typeof p.enabled !== 'boolean' ||
      !['MANUAL', 'SCHEDULED'].includes(String(p.mode))
    )
      fail('SYNC_POLICY_INVALID', 400);
    if (p.mode === 'MANUAL') {
      if (p.schedule !== null) fail('SYNC_POLICY_INVALID', 400);
    } else {
      if (refType !== 'branch') fail('SYNC_POLICY_INVALID', 400);
      const s = record(p.schedule, [
        'type',
        'expression',
        'timezone',
        'interval_ms',
        'anchor_at',
        'misfire_policy',
      ]);
      if (!['SKIP', 'FIRE_ONCE'].includes(String(s.misfire_policy)))
        fail('SYNC_POLICY_INVALID', 400);
      if (s.type === 'CRON') {
        if (
          Object.keys(s).some(
            (key) =>
              !['type', 'expression', 'timezone', 'misfire_policy'].includes(
                key,
              ),
          ) ||
          typeof s.expression !== 'string' ||
          typeof s.timezone !== 'string'
        )
          fail('SYNC_POLICY_INVALID', 400);
        try {
          cronNext(s.expression, s.timezone, new Date());
        } catch {
          fail('SYNC_POLICY_INVALID', 400);
        }
      } else if (s.type === 'INTERVAL') {
        if (
          Object.keys(s).some(
            (key) =>
              !['type', 'interval_ms', 'anchor_at', 'misfire_policy'].includes(
                key,
              ),
          ) ||
          !Number.isSafeInteger(s.interval_ms) ||
          Number(s.interval_ms) < 1 ||
          typeof s.anchor_at !== 'string' ||
          !Number.isFinite(Date.parse(s.anchor_at)) ||
          new Date(s.anchor_at).toISOString() !== s.anchor_at
        )
          fail('SYNC_POLICY_INVALID', 400);
      } else fail('SYNC_POLICY_INVALID', 400);
    }
    result.sync_policy = {
      enabled: p.enabled,
      mode: p.mode,
      schedule:
        p.mode === 'MANUAL'
          ? null
          : (() => {
              const schedule = record(p.schedule, [
                'type',
                'expression',
                'timezone',
                'interval_ms',
                'anchor_at',
                'misfire_policy',
              ]);
              return schedule.type === 'CRON'
                ? {
                    type: 'CRON',
                    expression: schedule.expression,
                    timezone: schedule.timezone,
                    misfire_policy: schedule.misfire_policy,
                  }
                : {
                    type: 'INTERVAL',
                    interval_ms: schedule.interval_ms,
                    anchor_at: schedule.anchor_at,
                    misfire_policy: schedule.misfire_policy,
                  };
            })(),
    };
  }
  if (input.discovery !== undefined) {
    const p = record(input.discovery, [
      'enabled',
      'includes',
      'excludes',
      'languages',
    ]);
    if (
      typeof p.enabled !== 'boolean' ||
      !Array.isArray(p.includes) ||
      !p.includes.length ||
      !Array.isArray(p.excludes) ||
      p.includes.length + p.excludes.length > 128 ||
      !Array.isArray(p.languages) ||
      !p.languages.length ||
      p.languages.some(
        (item) =>
          !['PYTHON', 'JAVASCRIPT', 'TYPESCRIPT', 'SHELL'].includes(item),
      )
    )
      fail('DISCOVERY_POLICY_INVALID', 400);
    result.discovery = {
      enabled: p.enabled,
      includes: p.includes.map(relativeGlob),
      excludes: p.excludes.map(relativeGlob),
      languages: [...new Set(p.languages)],
    };
  }
  return result;
}
export async function applyWorkspaceInitialization(
  tx: WorkspaceStore,
  id: number,
  input: WorkspaceInitialization | undefined,
) {
  if (input?.sync_policy !== undefined) {
    const p = record(input.sync_policy, ['enabled', 'mode', 'schedule']),
      s = p.schedule
        ? record(p.schedule, [
            'type',
            'expression',
            'timezone',
            'interval_ms',
            'anchor_at',
            'misfire_policy',
          ])
        : {};
    const now = new Date(),
      interval = Number(s.interval_ms),
      anchor = typeof s.anchor_at === 'string' ? s.anchor_at : null;
    const due =
      !p.enabled || p.mode === 'MANUAL'
        ? null
        : s.type === 'CRON'
        ? cronNext(String(s.expression), String(s.timezone), now).toISOString()
        : new Date(
            Date.parse(anchor!) +
              Math.max(
                0,
                Math.floor((now.getTime() - Date.parse(anchor!)) / interval) +
                  1,
              ) *
                interval,
          ).toISOString();
    await tx.run(
      'INSERT INTO WorkspaceSyncPolicies(workspace_id,enabled,update_mode,schedule_kind,cron_expression,timezone,interval_ms,anchor_at,misfire_policy,next_due_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        p.enabled ? 1 : 0,
        p.mode,
        s.type ?? 'NONE',
        s.expression ?? null,
        s.timezone ?? 'UTC',
        s.interval_ms ?? null,
        anchor,
        s.misfire_policy ?? 'SKIP',
        due,
      ],
    );
  }
  if (input?.discovery !== undefined) {
    const p = record(input.discovery, [
      'enabled',
      'includes',
      'excludes',
      'languages',
    ]);
    await tx.run(
      'INSERT INTO WorkspaceDiscoveryPolicies(workspace_id,enabled,includes,excludes,languages,version) VALUES(?,?,?,?,?,1)',
      [
        id,
        p.enabled ? 1 : 0,
        JSON.stringify(p.includes),
        JSON.stringify(p.excludes),
        JSON.stringify(p.languages),
      ],
    );
  }
}
