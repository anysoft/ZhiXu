import type { Response } from 'express';
import { readFileSync } from 'fs';
import { BackupError } from '../services/backup/files';
import multer from 'multer';

const INTERNAL: Record<string, string> = {
  DIRTY_WORKTREE: 'GIT_DIRTY',
  STAGED_CHANGES: 'GIT_DIRTY',
  UNTRACKED_COLLISION: 'GIT_DIRTY',
  DIVERGED: 'GIT_DIVERGED',
  DIVERGED_BRANCH: 'GIT_DIVERGED',
  LOCAL_ONLY_COMMITS: 'GIT_LOCAL_COMMITS',
  UNSAFE_TARGET_TREE: 'GIT_CONFLICT',
  INVALID_GIT_ADMIN: 'WORKSPACE_RECOVERY_REQUIRED',
  MISSING_OBJECT: 'WORKSPACE_RECOVERY_REQUIRED',
  INVALID_REF: 'REF_NOT_FOUND',
  SYNC_RUN_NOT_FOUND: 'WORKSPACE_SYNC_RUN_NOT_FOUND',
  SYNC_POLICY_VERSION_CONFLICT: 'WORKSPACE_VERSION_CONFLICT',
  SYNC_POLICY_DISABLED: 'SYNC_POLICY_INVALID',
  CONFIGURATION_REQUIRED: 'TASK_NOT_READY',
  RUNTIME_NOT_READY: 'TASK_NOT_READY',
  TASK_RUNTIME_KIND_MISMATCH: 'TASK_NOT_READY',
  TASK_SOURCE_INVALID: 'INVALID_REQUEST',
  CRON_DEFINITION_INVALID: 'INVALID_REQUEST',
  TRIGGER_EVENT_INVALID: 'INVALID_REQUEST',
  TRIGGER_EVENT_NOT_FOUND: 'TRIGGER_NOT_FOUND',
  BACKUP_ID_INVALID: 'INVALID_REQUEST',
  WORKSPACE_OPERATION_FAILED: 'WORKSPACE_OPERATION_FAILED',
  BACKUP_SOURCE_NOT_IDLE: 'BACKUP_BUSY',
  EXECUTION_SUBMISSION_INVALID: 'INVALID_REQUEST',
};
const SUPPLEMENT: Record<string, number> = {
  ENV_VERSION_CONFLICT: 409,
  ENV_SECRET_ACTION_INVALID: 400,
  SECRET_CONTENT_UNAVAILABLE: 403,
  CONFIG_SECRET_DOWNGRADE_FORBIDDEN: 400,
  WEBHOOK_UNAUTHORIZED: 401,
  WEBHOOK_IDEMPOTENCY_KEY_INVALID: 400,
  SUBSCRIPTION_RETENTION_RETIRED: 410,
};
function diagnostics(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 200).flatMap((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !/^[A-Z][A-Z0-9_]{0,100}$/.test(item.code)
    )
      return [];
    const p = item.path ?? item.relativepath ?? null;
    if (
      p !== null &&
      (typeof p !== 'string' ||
        p.startsWith('/') ||
        p.includes('\\') ||
        p.split('/').some((x: string) => !x || x === '.' || x === '..') ||
        /[\x00-\x1f]/.test(p))
    )
      return [];
    return [{ code: item.code, path: p, blocking: !!item.blocking }];
  });
}
export class V2HttpErrors {
  readonly registry: Map<string, any>;
  constructor(file: string) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    this.registry = new Map(parsed.errors.map((row: any) => [row.code, row]));
  }
  send(res: Response, error: unknown): Response {
    const e = error as any;
    if (e instanceof multer.MulterError) {
      const limited = new Set([
        'LIMIT_PART_COUNT',
        'LIMIT_FILE_SIZE',
        'LIMIT_FILE_COUNT',
        'LIMIT_FIELD_KEY',
        'LIMIT_FIELD_VALUE',
        'LIMIT_FIELD_COUNT',
        'LIMIT_UNEXPECTED_FILE',
      ]);
      if (limited.has(e.code))
        return this.send(res, {
          error_code:
            e.code === 'LIMIT_FILE_SIZE'
              ? 'WORKSPACE_FILE_TOO_LARGE'
              : 'INVALID_REQUEST',
        });
    }
    const candidate = e instanceof BackupError ? e.code : e?.error_code;
    const raw =
      typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(candidate)
        ? candidate
        : undefined;
    let code = raw
      ? INTERNAL[raw] ?? raw
      : e?.type === 'entity.too.large'
      ? 'WORKSPACE_FILE_TOO_LARGE'
      : e instanceof SyntaxError
      ? 'INVALID_REQUEST'
      : 'WORKSPACE_OPERATION_FAILED';
    let row = this.registry.get(code);
    if (raw && SUPPLEMENT[raw]) {
      const status = SUPPLEMENT[raw];
      return res
        .status(status)
        .json({
          code: status,
          error_code: raw,
          message: raw,
          retryable: false,
        });
    }
    if (
      !row &&
      raw &&
      /^(?:RUNTIME|PYTHON|NODE|NOTIFICATION|CONFIG_ASSET|BACKUP|RESTORE|CHANNEL|POLICY|DELIVERY|PROVIDER|PROXY|MAINTENANCE)_[A-Z0-9_]+$/.test(
        raw,
      )
    ) {
      const status =
        Number.isInteger(e.status) && e.status >= 400 && e.status < 600
          ? e.status
          : 409;
      return res
        .status(status)
        .json({
          code: status,
          error_code: raw,
          message: raw,
          retryable: false,
        });
    }
    if (!row) {
      code = 'INVALID_REQUEST';
      row = this.registry.get(code);
    }
    const details: Record<string, unknown> = {};
    if (raw && raw !== code) details.reason = raw;
    if (
      typeof e?.details?.reason === 'string' &&
      /^[A-Z][A-Z0-9_]{0,100}$/.test(e.details.reason)
    )
      details.reason = e.details.reason;
    const diagnostic = diagnostics(e?.details?.diagnostics);
    if (diagnostic?.length) details.diagnostics = diagnostic;
    return res
      .status(row.http_status)
      .json({
        code: row.http_status,
        error_code: code,
        message: row.safe_message,
        retryable: row.retryable,
        resource: row.affected_resource,
        operation: row.operation,
        ...(Object.keys(details).length ? { details } : {}),
      });
  }
}
