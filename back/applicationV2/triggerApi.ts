import { randomUUID, timingSafeEqual } from 'crypto';
import type { ApiCall, RouteMap, V2Services } from './types';
import {
  cronNext,
  newWebhookSecret,
  secretDigest,
  relativeGlob,
} from '../shared/triggerDefinition';
import { fail, errorCode } from '../services/workspaceV2/errors';
import {
  object,
  pathId,
  number,
  text,
  boolean,
  choice,
  expected,
  json,
  strings,
  pagination,
} from './taskValidation';

export class CandidateTaskTriggers {
  constructor(readonly services: V2Services) {}
  async row(taskId: number, id: number) {
    await this.services.tasks.get(taskId);
    const row = (
      await this.services.store.all<any>(
        'SELECT * FROM TaskTriggers WHERE id=? AND task_id=?',
        [id, taskId],
      )
    )[0];
    if (!row) fail('TRIGGER_NOT_FOUND', 404);
    return row;
  }
  async list(taskId: number) {
    await this.services.tasks.get(taskId);
    const rows = await this.services.store.all<any>(
      'SELECT * FROM TaskTriggers WHERE task_id=? ORDER BY id',
      [taskId],
    );
    return Promise.all(
      rows.map(async (row) => {
        const config =
          row.type === 'CRON'
            ? (
                await this.services.store.all<any>(
                  'SELECT trigger_id,expression,timezone,misfire_policy,next_fire_at,last_fire_at FROM CronTriggers WHERE trigger_id=?',
                  [row.id],
                )
              )[0]
            : row.type === 'WEBHOOK'
            ? (
                await this.services.store.all<any>(
                  'SELECT trigger_id,public_id FROM WebhookTriggers WHERE trigger_id=?',
                  [row.id],
                )
              )[0]
            : (
                await this.services.store.all<any>(
                  'SELECT trigger_id,mode,path_filters,fire_on_initial FROM GitUpdateTriggers WHERE trigger_id=?',
                  [row.id],
                )
              )[0];
        if (!config) fail('DATABASE_SCHEMA_CORRUPTED', 503);
        if (row.type === 'GIT_UPDATE') {
          config.path_filters = json(config.path_filters, []);
          config.fire_on_initial = !!config.fire_on_initial;
        }
        return {
          id: row.id,
          task_id: row.task_id,
          type: row.type,
          origin: row.origin,
          enabled: !!row.enabled,
          version: row.version,
          discovery_key: row.discovery_key,
          config,
        };
      }),
    );
  }
  private async mutation<T>(
    taskId: number,
    allowArchived: boolean,
    action: () => Promise<T>,
  ) {
    const d = await this.services.tasks.get(taskId);
    return this.services.leases.withWorkspace(
      d.task.workspace_id,
      'API_TRIGGER_WRITE',
      async (lease) => {
        const ws = await this.services.store.assertAccessible(
          d.task.workspace_id,
          !allowArchived,
        );
        if (allowArchived) {
          await lease.assertHeld();
          await this.services.roots.requireOwned(ws);
        } else await this.services.roots.requireReady(ws, lease);
        return this.services.store.transaction(action);
      },
    );
  }
  async save(taskId: number, input: unknown, id?: number) {
    const b = object(
      input,
      ['type', 'enabled', 'config', 'expected_version'],
      ['type', ...(id === undefined ? [] : ['expected_version'])],
    );
    const type = choice(b.type, ['CRON', 'WEBHOOK', 'GIT_UPDATE']),
      d = await this.services.tasks.get(taskId),
      old = id === undefined ? null : await this.row(taskId, id);
    if (old && old.type !== type) fail('TRIGGER_TYPE_IMMUTABLE', 400);
    const enabled =
      b.enabled === undefined
        ? old
          ? !!old.enabled
          : true
        : boolean(b.enabled);
    const config = object(
      b.config ?? {},
      type === 'CRON'
        ? ['expression', 'timezone', 'misfire_policy']
        : type === 'GIT_UPDATE'
        ? ['mode', 'path_filters', 'fire_on_initial']
        : [],
    );
    if (type === 'GIT_UPDATE') {
      const value = {
        enabled,
        mode: choice(config.mode, [
          'ANY_CHANGE',
          'SOURCE_CHANGE',
          'PATH_FILTER',
        ]),
        pathFilters: strings(config.path_filters ?? [], 64, 1024).map(
          relativeGlob,
        ),
        fireOnInitial:
          config.fire_on_initial === undefined
            ? false
            : boolean(config.fire_on_initial),
      };
      const row =
        id === undefined
          ? await this.services.gitUpdateTriggers.create(
              taskId,
              b.expected_version === undefined
                ? d.task.version
                : number(b.expected_version),
              value,
            )
          : await this.services.gitUpdateTriggers.update(
              id,
              number(b.expected_version),
              value,
            );
      return (await this.list(taskId)).find((item) => item.id === row.id);
    }
    const timezone =
      type === 'CRON'
        ? config.timezone === undefined || config.timezone === ''
          ? 'UTC'
          : text(config.timezone, 100)
        : 'UTC';
    const expression = type === 'CRON' ? text(config.expression, 255) : '';
    const misfire =
      type === 'CRON'
        ? choice(config.misfire_policy ?? 'SKIP', ['SKIP', 'FIRE_ONCE'])
        : 'SKIP';
    const next =
      type === 'CRON'
        ? cronNext(expression, timezone, new Date()).toISOString()
        : null;
    const secret =
      type === 'WEBHOOK' && id === undefined ? newWebhookSecret() : undefined;
    const result = await this.mutation(taskId, false, async () => {
      if (
        id === undefined &&
        b.expected_version !== undefined &&
        (await this.services.tasks.get(taskId)).task.version !==
          number(b.expected_version)
      )
        fail('TASK_VERSION_CONFLICT');
      const previous = id === undefined ? null : await this.row(taskId, id),
        now = new Date().toISOString();
      if (previous && previous.version !== number(b.expected_version))
        fail('TRIGGER_VERSION_CONFLICT');
      let triggerId = id;
      if (previous)
        await this.services.store.run(
          "UPDATE TaskTriggers SET enabled=?,origin='USER',version=version+1,updatedAt=? WHERE id=? AND task_id=? AND version=?",
          [enabled ? 1 : 0, now, id, taskId, previous.version],
        );
      else
        triggerId = (
          await this.services.store.run(
            "INSERT INTO TaskTriggers(task_id,type,origin,enabled,createdAt,updatedAt) VALUES(?,?,'USER',?,?,?)",
            [taskId, type, enabled ? 1 : 0, now, now],
          )
        ).lastID;
      if (type === 'CRON') {
        if (previous) {
          const current = (
            await this.services.store.all<any>(
              'SELECT next_fire_at FROM CronTriggers WHERE trigger_id=?',
              [id],
            )
          )[0];
          await this.services.store.run(
            'UPDATE CronTriggers SET expression=?,timezone=?,misfire_policy=?,next_fire_at=?,updatedAt=? WHERE trigger_id=?',
            [
              expression,
              timezone,
              misfire,
              enabled ? next : current.next_fire_at,
              now,
              id,
            ],
          );
        } else
          await this.services.store.run(
            'INSERT INTO CronTriggers(trigger_id,expression,timezone,misfire_policy,next_fire_at,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)',
            [triggerId, expression, timezone, misfire, next, now, now],
          );
      } else if (!previous)
        await this.services.store.run(
          'INSERT INTO WebhookTriggers(trigger_id,public_id,secret_hash,createdAt,updatedAt) VALUES(?,?,?,?,?)',
          [triggerId, randomUUID(), secretDigest(secret!), now, now],
        );
      return triggerId!;
    });
    return {
      ...(await this.list(taskId)).find((item) => item.id === result)!,
      ...(secret ? { secret } : {}),
    };
  }
  async remove(taskId: number, id: number, version: number) {
    return this.mutation(taskId, true, async () => {
      const row = await this.row(taskId, id);
      if (row.version !== version) fail('TRIGGER_VERSION_CONFLICT');
      if (row.discovery_key)
        await this.services.store.run(
          "UPDATE TaskTriggers SET enabled=0,origin='USER',version=version+1,updatedAt=CURRENT_TIMESTAMP WHERE id=? AND task_id=?",
          [id, taskId],
        );
      else
        await this.services.store.run(
          'DELETE FROM TaskTriggers WHERE id=? AND task_id=?',
          [id, taskId],
        );
      return null;
    });
  }
  async rotate(taskId: number, id: number, version: number) {
    const secret = newWebhookSecret();
    await this.mutation(taskId, false, async () => {
      const row = await this.row(taskId, id);
      if (row.type !== 'WEBHOOK') fail('TRIGGER_NOT_FOUND', 404);
      if (row.version !== version) fail('TRIGGER_VERSION_CONFLICT');
      await this.services.store.run(
        'UPDATE WebhookTriggers SET secret_hash=?,updatedAt=CURRENT_TIMESTAMP WHERE trigger_id=?',
        [secretDigest(secret), id],
      );
      await this.services.store.run(
        'UPDATE TaskTriggers SET version=version+1,updatedAt=CURRENT_TIMESTAMP WHERE id=?',
        [id],
      );
    });
    return { secret };
  }
  async event(id: number) {
    const row = (
      await this.services.store.all<any>(
        'SELECT * FROM TriggerEvents WHERE id=?',
        [number(id)],
      )
    )[0];
    if (!row) fail('TRIGGER_EVENT_NOT_FOUND', 404);
    const metadata = json<any>(row.metadata, {}),
      safe: Record<string, string | number | boolean | null> = {};
    for (const key of [
      'scheduled_at',
      'repository_id',
      'workspace_id',
      'workspace_update_id',
      'source_generation',
      'content_revision',
      'before',
      'after',
      'before_commit',
      'after_commit',
      'initial',
    ]) {
      const value = metadata[key];
      if (
        value === null ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        (typeof value === 'string' &&
          (/^[0-9a-f]{40,64}$/.test(value) || /^\d{4}-\d\d-\d\dT/.test(value)))
      )
        safe[key] = value;
    }
    return {
      id: row.id,
      trigger_id: row.trigger_id,
      origin_trigger_id: row.origin_trigger_id,
      task_id: row.task_id,
      workspace_id: row.workspace_id,
      workspace_update_id: row.workspace_update_id,
      event_key: row.event_key,
      trigger_type: row.trigger_type,
      status: row.status,
      task_run_id: row.task_run_id,
      error_code: row.error_code,
      metadata: safe,
      received_at: row.received_at,
      attempt_count: row.attempt_count,
    };
  }
  async authenticateWebhook(
    publicId: string,
    authorization: string | undefined,
  ) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '')?.[1];
    const hook = /^[0-9a-f-]{36}$/.test(publicId)
      ? (
          await this.services.store.all<any>(
            'SELECT w.*,t.task_id FROM WebhookTriggers w JOIN TaskTriggers t ON t.id=w.trigger_id WHERE w.public_id=?',
            [publicId],
          )
        )[0]
      : null;
    const actual = Buffer.from(secretDigest(token ?? ''), 'hex'),
      expectedHash = Buffer.from(hook?.secret_hash ?? '0'.repeat(64), 'hex');
    if (
      !hook ||
      !token ||
      expectedHash.length !== actual.length ||
      !timingSafeEqual(actual, expectedHash)
    )
      fail('WEBHOOK_UNAUTHORIZED', 401);
    return {
      trigger_id: hook.trigger_id as number,
      task_id: hook.task_id as number,
    };
  }
  async receiveWebhook(
    publicId: string,
    authorization: string | undefined,
    key?: string,
  ) {
    const hook = await this.authenticateWebhook(publicId, authorization);
    if (
      key !== undefined &&
      (typeof key !== 'string' ||
        !key.length ||
        key.length > 200 ||
        /[^\x21-\x7e]/.test(key))
    )
      fail('WEBHOOK_IDEMPOTENCY_KEY_INVALID', 400);
    const eventKey = 'webhook:' + secretDigest(key ?? randomUUID());
    const eventId = await this.services.leases.barrier.mutation(() =>
      this.services.store.transaction(async (tx) => {
        const old = (
          await tx.all<{ id: number }>(
            'SELECT id FROM TriggerEvents WHERE origin_trigger_id=? AND event_key=?',
            [hook.trigger_id, eventKey],
          )
        )[0];
        if (old) return old.id;
        const trigger = await this.row(hook.task_id, hook.trigger_id),
          task = await this.services.tasks.get(hook.task_id);
        await tx.assertAccessible(task.task.workspace_id, true);
        return (
          await tx.run(
            "INSERT INTO TriggerEvents(trigger_id,origin_trigger_id,task_id,workspace_id,event_key,trigger_type,metadata,received_at) VALUES(?,?,?,?,?,'WEBHOOK','{}',?)",
            [
              trigger.id,
              trigger.id,
              task.task.id,
              task.task.workspace_id,
              eventKey,
              new Date().toISOString(),
            ],
          )
        ).lastID;
      }),
    );
    const event = await this.event(eventId);
    if (event.status === 'RECEIVED' || event.status === 'PROCESSING')
      await this.services.execution.submit(hook.task_id, {
        triggerType: 'WEBHOOK',
        eventId,
        waitMode: 'WAIT',
      });
    return {
      event_id: eventId,
      run_id: (await this.event(eventId)).task_run_id,
    };
  }
  async recoverWebhookEvents(limit = 100) {
    for (const row of await this.services.store.all<{
      id: number;
      task_id: number | null;
    }>(
      "SELECT id,task_id FROM TriggerEvents WHERE trigger_type='WEBHOOK' AND status IN ('RECEIVED','PROCESSING') ORDER BY id LIMIT ?",
      [number(limit, 1, 1000)],
    )) {
      if (!row.task_id) {
        await this.services.store.run(
          "UPDATE TriggerEvents SET status='SKIPPED',error_code='TASK_DELETED' WHERE id=?",
          [row.id],
        );
        continue;
      }
      try {
        await this.services.execution.submit(row.task_id, {
          triggerType: 'WEBHOOK',
          eventId: row.id,
          waitMode: 'WAIT',
        });
      } catch (error) {
        if (
          ![
            'WORKSPACE_BUSY',
            'WORKSPACE_NOT_READY',
            'PLATFORM_BACKUP_IN_PROGRESS',
            'RUNTIME_NOT_READY',
            'CONFIGURATION_REQUIRED',
          ].includes(errorCode(error))
        )
          throw error;
      }
    }
  }
}
export function triggerApiRoutes(s: V2Services): RouteMap {
  const service = new CandidateTaskTriggers(s),
    id = (c: ApiCall) => pathId(c.params.id),
    trigger = (c: ApiCall) => pathId(c.params.triggerId);
  return {
    'GET /tasks/:id/triggers': async (c) => {
      object(c.query, []);
      return service.list(id(c));
    },
    'POST /tasks/:id/triggers': async (c) => service.save(id(c), c.body),
    'PUT /tasks/:id/triggers/:triggerId': async (c) =>
      service.save(id(c), c.body, trigger(c)),
    'DELETE /tasks/:id/triggers/:triggerId': async (c) =>
      service.remove(id(c), trigger(c), expected(c.body)),
    'POST /tasks/:id/triggers/:triggerId/rotate-secret': async (c) =>
      service.rotate(id(c), trigger(c), expected(c.body)),
    'GET /tasks/:id/trigger-events': async (c) => {
      object(c.query, ['page', 'size']);
      await s.tasks.get(id(c));
      const p = pagination(c.query),
        rows = await s.store.all<{ id: number }>(
          'SELECT id FROM TriggerEvents WHERE task_id=? ORDER BY id DESC LIMIT ? OFFSET ?',
          [id(c), p.size, p.offset],
        );
      return Promise.all(rows.map((row) => service.event(row.id)));
    },
    'GET /trigger-events/:id': async (c) => {
      object(c.query, []);
      return service.event(id(c));
    },
  };
}
