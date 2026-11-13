import path from 'path';
import { randomUUID } from 'crypto';
import RuntimePathResolver from '../services/runtimePaths';
import { RuntimeLease } from '../services/runtimeProcess';
import { withInheritedLease } from '../services/backup/inheritedLeases';
import {
  notificationRequiredFields,
  validateNotificationConfig,
} from '../shared/notificationConfig';
import {
  notificationTransport,
  notificationUrl,
} from '../services/notificationTransport';
import NotificationService from '../services/notify';
import { loadTaskDefinition } from '../services/taskExecutionV2/task';
import type { NotificationInfo } from '../data/notify';
import { fail, errorCode } from '../services/workspaceV2/errors';
import type { V2Services, RouteMap } from './types';
import * as v from './workspaceValidation';

const providers = Object.keys(notificationRequiredFields);
const flags = [
  'enabled',
  'notify_success',
  'notify_failure',
  'notify_timeout',
  'notify_interrupted',
  'notify_cancelled',
  'notify_recovery',
] as const;
interface Channel {
  id: number;
  name: string;
  type: string;
  enabled: number;
  is_default: number;
  version: number;
  non_secret_config: string;
  secret: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}
interface Outbox {
  id: number;
  event_type: string;
  task_id: number | null;
  task_run_id: number | null;
  channel_id: number;
  dedupe_key: string;
  message: string;
  status: string;
  attempt_count: number;
  claim_token: string | null;
  next_attempt_at: string;
}
class DeliveryPaths extends RuntimePathResolver {
  async lock(id: number) {
    return path.join(
      await this.directory('.locks', true),
      `notification-${v.integer(id)}.lock`,
    );
  }
}
function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    fail('NOTIFICATION_RECOVERY_REQUIRED');
  }
}
function config(value: unknown, type: string) {
  const row = v.object(
    value,
    Object.keys(
      value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    ),
  );
  if (
    Buffer.byteLength(JSON.stringify(row)) > 32768 ||
    Object.values(row).some(
      (item) => !['string', 'number', 'boolean'].includes(typeof item),
    )
  )
    fail('CHANNEL_SECRET_INVALID', 400);
  validateNotificationConfig(type, row);
  if (type === 'WEBHOOK') {
    v.object(row, ['url', 'authorization'], ['url']);
    notificationUrl(v.text(row.url));
  }
  return row;
}
/** The frozen SQL terminal triggers already enqueue TaskRun notifications and health
 * in the terminal transaction. This domain dispatches that outbox; it has no second planner. */
export class CandidateNotificationDomain {
  private working?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(readonly s: V2Services) {}
  async channel(id: number) {
    const row = (
      await this.s.store.all<Channel>(
        'SELECT * FROM NotificationChannels WHERE id=?',
        [id],
      )
    )[0];
    if (!row) fail('CHANNEL_NOT_FOUND', 404);
    return row;
  }
  async channelDto(id: number) {
    const r = await this.channel(id);
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      enabled: !!r.enabled,
      is_default: !!r.is_default,
      version: r.version,
      non_secret_config: {},
      secret_configured: r.secret !== null,
      archived: !!r.archived,
      created_at: v.utcTimestamp(r.created_at),
      updated_at: v.utcTimestamp(r.updated_at),
    };
  }
  async save(body: unknown, id?: number) {
    const b = v.object(
      body,
      [
        'name',
        'type',
        'enabled',
        'is_default',
        'expected_version',
        'secret_action',
        'secret',
      ],
      ['name', 'type'],
    );
    const name = v.text(b.name, 200).trim(),
      type = v.choice(b.type, providers),
      action = v.choice(b.secret_action ?? (id ? 'KEEP' : 'REPLACE'), [
        'KEEP',
        'REPLACE',
        'DELETE',
      ]);
    if (!name || (action !== 'REPLACE' && b.secret !== undefined))
      fail('CHANNEL_SECRET_ACTION_INVALID', 400);
    const secret =
      action === 'REPLACE' ? JSON.stringify(config(b.secret, type)) : null;
    const enabled = b.enabled === undefined ? true : v.boolean(b.enabled),
      isDefault = b.is_default === undefined ? false : v.boolean(b.is_default);
    return this.s.leases.barrier.mutation(() =>
      this.s.store.transaction(async (tx) => {
        if (id) {
          const old = await this.channel(id);
          if (old.archived) fail('CHANNEL_NOT_FOUND', 404);
          if (old.version !== v.number(b.expected_version))
            fail('CHANNEL_VERSION_CONFLICT');
          if (old.type !== type && action === 'KEEP')
            fail('CHANNEL_SECRET_REPLACE_REQUIRED', 400);
          await tx.run(
            'UPDATE NotificationChannels SET name=?,type=?,enabled=?,is_default=?,secret=?,version=version+1,updated_at=? WHERE id=? AND version=?',
            [
              name,
              type,
              enabled ? 1 : 0,
              isDefault ? 1 : 0,
              action === 'KEEP' ? old.secret : secret,
              new Date().toISOString(),
              id,
              old.version,
            ],
          );
        } else {
          id = (
            await tx.run(
              'INSERT INTO NotificationChannels(name,type,enabled,is_default,secret) VALUES(?,?,?,?,?)',
              [name, type, enabled ? 1 : 0, isDefault ? 1 : 0, secret],
            )
          ).lastID;
        }
        return { id };
      }),
    );
  }
  async archive(id: number, version: number) {
    return this.s.leases.barrier.mutation(() =>
      this.s.store.transaction(async (tx) => {
        const old = await this.channel(id);
        if (old.version !== version) fail('CHANNEL_VERSION_CONFLICT');
        await tx.run(
          'UPDATE NotificationChannels SET archived=1,enabled=0,is_default=0,secret=NULL,version=version+1,updated_at=? WHERE id=? AND version=?',
          [new Date().toISOString(), id, version],
        );
        return { id };
      }),
    );
  }
  async test(id: number) {
    return this.s.leases.barrier.mutation(async () => {
      await this.channel(id);
      const key = 'test:' + randomUUID(),
        result = await this.s.store.run(
          "INSERT INTO NotificationOutbox(event_type,channel_id,dedupe_key,message) VALUES('TEST',?,?,?)",
          [
            id,
            key,
            JSON.stringify({
              event: 'TEST',
              title: 'This is a test notification',
            }),
          ],
        );
      return { id: result.lastID, status: 'PENDING' };
    });
  }
  async notifySystem(body: unknown) {
    const input = v.object(body, ['title', 'content'], ['title', 'content']),
      title = v.text(input.title, 2048),
      content = v.text(input.content, 65536);
    const rows = await this.s.leases.barrier.mutation(() =>
      this.s.store.transaction(async (tx) => {
        const channels = await tx.all<{ id: number }>(
          'SELECT id FROM NotificationChannels WHERE enabled=1 AND archived=0 AND is_default=1 ORDER BY id',
        );
        if (!channels.length) fail('CHANNEL_NOT_FOUND', 404);
        const ids: number[] = [];
        for (const channel of channels)
          ids.push(
            (
              await tx.run(
                "INSERT INTO NotificationOutbox(event_type,channel_id,dedupe_key,message) VALUES('SYSTEM',?,?,?)",
                [
                  channel.id,
                  'system:' + randomUUID(),
                  JSON.stringify({ event: 'SYSTEM', title, content }),
                ],
              )
            ).lastID,
          );
        return ids;
      }),
    );
    for (const id of rows) await this.deliver(id);
    const status = await this.s.store.all<{ status: string }>(
      `SELECT status FROM NotificationOutbox WHERE id IN (${rows
        .map(() => '?')
        .join(',')})`,
      rows,
    );
    if (status.some((row) => row.status !== 'SENT')) fail('PROVIDER_FAILED');
    return { message: 'Notification sent successfully' };
  }
  async policy(taskId: number) {
    const task = await loadTaskDefinition(this.s.store, taskId);
    const row = (
      await this.s.store.all<Record<string, unknown> & { version: number }>(
        'SELECT * FROM TaskNotificationPolicies WHERE task_id=?',
        [taskId],
      )
    )[0];
    if (!row) fail('TASK_NOT_FOUND', 404);
    return {
      ...row,
      channels: (
        await this.s.store.all<{ channel_id: number }>(
          'SELECT channel_id FROM TaskNotificationChannelBindings WHERE task_id=? ORDER BY channel_id',
          [task.task.id],
        )
      ).map((r) => r.channel_id),
    };
  }
  async savePolicy(taskId: number, body: unknown) {
    const b = v.object(
      body,
      [
        ...flags,
        'failure_threshold',
        'repeat_every_failures',
        'channel_mode',
        'channels',
        'expected_version',
      ],
      [
        ...flags,
        'failure_threshold',
        'channel_mode',
        'channels',
        'expected_version',
      ],
    );
    const values = flags.map((key) => (v.boolean(b[key]) ? 1 : 0)),
      threshold = v.number(b.failure_threshold, 1, 1000),
      repeat = v.number(b.repeat_every_failures ?? 0, 0, 1000),
      mode = v.choice(b.channel_mode, ['DEFAULT', 'EXPLICIT', 'NONE']);
    if (!Array.isArray(b.channels) || b.channels.length > 100)
      fail('POLICY_INVALID', 400);
    const ids = [...new Set(b.channels.map((value) => v.number(value)))];
    const task = await loadTaskDefinition(this.s.store, taskId);
    return this.s.leases.withWorkspace(
      task.task.workspace_id,
      'NOTIFICATION_POLICY',
      () =>
        this.s.store.transaction(async (tx) => {
          await tx.assertAccessible(task.task.workspace_id, true);
          const old = await this.policy(taskId);
          if (old.version !== v.number(b.expected_version))
            fail('POLICY_VERSION_CONFLICT');
          for (const id of ids) {
            if ((await this.channel(id)).archived)
              fail('CHANNEL_NOT_FOUND', 404);
          }
          await tx.run(
            `UPDATE TaskNotificationPolicies SET ${flags
              .map((key) => key + '=?')
              .join(
                ',',
              )},failure_threshold=?,repeat_every_failures=?,channel_mode=?,version=version+1 WHERE task_id=? AND version=?`,
            [...values, threshold, repeat, mode, taskId, old.version],
          );
          await tx.run(
            'DELETE FROM TaskNotificationChannelBindings WHERE task_id=?',
            [taskId],
          );
          for (const id of ids)
            await tx.run(
              'INSERT INTO TaskNotificationChannelBindings(task_id,channel_id) VALUES(?,?)',
              [taskId, id],
            );
          return this.policy(taskId);
        }),
    );
  }
  private async leased<T>(
    id: number,
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    return this.s.leases.barrier.mutation(async () => {
      let lease: RuntimeLease;
      try {
        lease = await RuntimeLease.acquire(
          new DeliveryPaths(this.s.roots.dataRoot),
          id,
        );
      } catch (error) {
        if (errorCode(error) === 'RUNTIME_BUSY') return;
        throw error;
      }
      try {
        return await withInheritedLease(lease.handle.fd, action);
      } finally {
        await lease.release();
      }
    }, true);
  }
  async recover() {
    const rows = await this.s.store.all<Outbox>(
      "SELECT * FROM NotificationOutbox WHERE status='SENDING' ORDER BY id",
    );
    for (const row of rows)
      await this.leased(row.id, () =>
        this.s.store.transaction(async (tx) => {
          const current = (
            await tx.all<Outbox>(
              'SELECT * FROM NotificationOutbox WHERE id=?',
              [row.id],
            )
          )[0];
          if (current?.status !== 'SENDING') return;
          if (
            !current.claim_token ||
            !/^[0-9a-f-]{36}$/.test(current.claim_token)
          )
            fail('NOTIFICATION_RECOVERY_REQUIRED');
          await tx.run(
            "UPDATE NotificationOutbox SET status='RETRY',last_error_code='DELIVERY_INTERRUPTED',claim_token=NULL,claimed_at=NULL,next_attempt_at=? WHERE id=? AND claim_token=?",
            [new Date().toISOString(), row.id, current.claim_token],
          );
          await tx.run(
            "UPDATE NotificationDeliveries SET result='INTERRUPTED',error_code='DELIVERY_INTERRUPTED',finished_at=? WHERE outbox_id=? AND result='SENDING'",
            [new Date().toISOString(), row.id],
          );
        }),
      );
  }
  private async send(row: Outbox) {
    const channel = await this.channel(row.channel_id);
    if (!channel.enabled || channel.archived) fail('CHANNEL_DISABLED');
    if (!channel.secret) fail('CHANNEL_SECRET_MISSING');
    const secret = config(json(channel.secret), channel.type),
      message = v.object(
        json(row.message),
        ['event', 'title', 'content', 'task', 'run'],
        ['event'],
      );
    if (channel.type === 'WEBHOOK') {
      const response = await notificationTransport.request(v.text(secret.url), {
        json: message,
        headers: {
          'Idempotency-Key': row.dedupe_key,
          ...(secret.authorization
            ? { Authorization: v.text(secret.authorization) }
            : {}),
        },
      });
      if (response.statusCode < 200 || response.statusCode >= 300)
        fail('PROVIDER_HTTP_FAILED');
      return;
    }
    const run =
      message.run && typeof message.run === 'object'
        ? (message.run as Record<string, unknown>)
        : {};
    const task =
      message.task && typeof message.task === 'object'
        ? (message.task as Record<string, unknown>)
        : {};
    const title =
      message.event === 'TEST'
        ? 'This is a test notification'
        : message.event === 'SYSTEM'
        ? v.text(message.title, 2048, true)
        : `Task ${String(task.name ?? task.id)}: ${String(message.event)}`;
    const content =
      message.event === 'TEST'
        ? 'This is a test notification'
        : message.event === 'SYSTEM'
        ? v.text(message.content, 65536, true)
        : `Run ${String(run.id)}; status ${String(
            run.status,
          )}; trigger ${String(run.trigger_type)}; attempts ${String(
            run.attempts,
          )}; code ${String(run.error_code ?? 'SUCCESS')}`;
    const adapter = new NotificationService(
      notificationTransport as ConstructorParameters<
        typeof NotificationService
      >[0],
    );
    if (
      !(await adapter.testNotify(
        { type: channel.type, ...secret } as unknown as NotificationInfo,
        title,
        content,
      ))
    )
      fail('PROVIDER_REJECTED');
  }
  async deliver(id: number) {
    return this.leased(id, async () => {
      const token = randomUUID(),
        row = await this.s.store.transaction(async (tx) => {
          const current = (
            await tx.all<Outbox>(
              'SELECT * FROM NotificationOutbox WHERE id=?',
              [id],
            )
          )[0];
          if (
            !current ||
            !['PENDING', 'RETRY'].includes(current.status) ||
            Date.parse(
              current.next_attempt_at.replace(' ', 'T').replace(/(?<!Z)$/, 'Z'),
            ) > Date.now()
          )
            return;
          const attempt = current.attempt_count + 1,
            now = new Date().toISOString();
          if (
            !(
              await tx.run(
                "UPDATE NotificationOutbox SET status='SENDING',attempt_count=?,claim_token=?,claimed_at=? WHERE id=? AND status=?",
                [attempt, token, now, id, current.status],
              )
            ).changes
          )
            return;
          await tx.run(
            "INSERT INTO NotificationDeliveries(outbox_id,attempt,started_at,result) VALUES(?,?,?,'SENDING')",
            [id, attempt, now],
          );
          return { ...current, attempt_count: attempt };
        });
      if (!row) return;
      let code: string | null = null;
      try {
        await this.send(row);
      } catch (error) {
        const candidate = errorCode(error);
        code = [
          'CHANNEL_DISABLED',
          'CHANNEL_SECRET_MISSING',
          'PROVIDER_HTTP_FAILED',
          'PROVIDER_RESPONSE_LIMIT',
          'PROVIDER_NETWORK_FAILED',
          'PROVIDER_REJECTED',
          'CHANNEL_URL_INVALID',
        ].includes(candidate)
          ? candidate
          : 'PROVIDER_FAILED';
      }
      const status = !code
          ? 'SENT'
          : row.attempt_count >= 5 ||
            [
              'CHANNEL_DISABLED',
              'CHANNEL_SECRET_MISSING',
              'CHANNEL_URL_INVALID',
            ].includes(code)
          ? 'DEAD'
          : 'RETRY',
        now = new Date().toISOString();
      await this.s.store.transaction(async (tx) => {
        if (
          !(
            await tx.run(
              'UPDATE NotificationOutbox SET status=?,last_error_code=?,sent_at=?,next_attempt_at=?,claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?',
              [
                status,
                code,
                status === 'SENT' ? now : null,
                new Date(
                  Date.now() +
                    Math.min(
                      3600000,
                      60000 * 2 ** Math.min(10, row.attempt_count - 1),
                    ),
                ).toISOString(),
                id,
                token,
              ],
            )
          ).changes
        )
          fail('NOTIFICATION_RECOVERY_REQUIRED');
        await tx.run(
          "UPDATE NotificationDeliveries SET result=?,error_code=?,finished_at=? WHERE outbox_id=? AND attempt=? AND result='SENDING'",
          [status, code, now, id, row.attempt_count],
        );
      });
    });
  }
  async tick() {
    if (this.stopped || this.working) return this.working;
    this.working = (async () => {
      await this.recover();
      const rows = await this.s.store.all<{ id: number }>(
        "SELECT id FROM NotificationOutbox WHERE status IN ('PENDING','RETRY') AND next_attempt_at<=? ORDER BY id LIMIT 32",
        [new Date().toISOString()],
      );
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, rows.length) }, async () => {
          while (next < rows.length && !this.stopped)
            await this.deliver(rows[next++].id);
        }),
      );
    })();
    try {
      await this.working;
    } finally {
      this.working = undefined;
    }
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(
      () => void this.tick().catch(() => undefined),
      1000,
    );
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.working;
  }
  async retry(id: number) {
    return this.s.leases.barrier.mutation(() =>
      this.s.store.transaction(async (tx) => {
        const row = (
          await tx.all<Outbox>('SELECT * FROM NotificationOutbox WHERE id=?', [
            id,
          ])
        )[0];
        if (!row) fail('DELIVERY_NOT_FOUND', 404);
        if (!['DEAD', 'RETRY'].includes(row.status))
          fail('DELIVERY_RETRY_INVALID');
        await tx.run(
          "UPDATE NotificationOutbox SET status='RETRY',next_attempt_at=? WHERE id=? AND status=?",
          [new Date().toISOString(), id, row.status],
        );
        return { id };
      }),
    );
  }
  routes(): RouteMap {
    return {
      'PUT /system/notify': async (call) => this.notifySystem(call.body),
      'GET /notification-providers': async () => providers,
      'GET /notification-channels': async () =>
        Promise.all(
          (
            await this.s.store.all<{ id: number }>(
              'SELECT id FROM NotificationChannels ORDER BY id DESC',
            )
          ).map((row) => this.channelDto(row.id)),
        ),
      'POST /notification-channels': async (call) => this.save(call.body),
      'GET /notification-channels/:id': async (call) =>
        this.channelDto(v.pathId(call.params.id)),
      'PATCH /notification-channels/:id': async (call) =>
        this.save(call.body, v.pathId(call.params.id)),
      'DELETE /notification-channels/:id': async (call) => {
        const b = v.object(
          call.body,
          ['expected_version'],
          ['expected_version'],
        );
        return this.archive(
          v.pathId(call.params.id),
          v.number(b.expected_version),
        );
      },
      'POST /notification-channels/:id/test': async (call) => {
        v.object(call.body ?? {}, []);
        return this.test(v.pathId(call.params.id));
      },
      'GET /tasks/:id/notification-policy': async (call) =>
        this.policy(v.pathId(call.params.id)),
      'PATCH /tasks/:id/notification-policy': async (call) =>
        this.savePolicy(v.pathId(call.params.id), call.body),
      'GET /notification-deliveries': async (call) => {
        const b = v.object(call.query, ['run_id', 'cursor', 'status']),
          where: string[] = [],
          args: unknown[] = [];
        if (b.run_id !== undefined) {
          where.push('o.task_run_id=?');
          args.push(v.integer(b.run_id));
        }
        if (b.cursor !== undefined) {
          where.push('o.id<?');
          args.push(v.integer(b.cursor));
        }
        if (b.status !== undefined) {
          where.push('o.status=?');
          args.push(
            v.choice(b.status, ['PENDING', 'SENDING', 'SENT', 'RETRY', 'DEAD']),
          );
        }
        return this.s.store.all(
          `SELECT o.id,o.event_type,o.task_id,o.task_run_id,o.channel_id,c.name channel_name,o.status,o.attempt_count,o.next_attempt_at,o.created_at,o.sent_at,o.last_error_code FROM NotificationOutbox o JOIN NotificationChannels c ON c.id=o.channel_id ${
            where.length ? 'WHERE ' + where.join(' AND ') : ''
          } ORDER BY o.id DESC LIMIT 100`,
          args,
        );
      },
      'GET /notification-deliveries/:id/attempts': async (call) =>
        this.s.store.all(
          'SELECT attempt,started_at,finished_at,result,error_code FROM NotificationDeliveries WHERE outbox_id=? ORDER BY attempt LIMIT 100',
          [v.pathId(call.params.id)],
        ),
      'POST /notification-deliveries/:id/retry': async (call) => {
        v.object(call.body ?? {}, []);
        return this.retry(v.pathId(call.params.id));
      },
    };
  }
}
export function createNotificationDomain(s: V2Services) {
  return new CandidateNotificationDomain(s);
}
