import { fail } from '../services/workspaceV2/errors';

export function object(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_REQUEST', 400);
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in row))
  )
    fail('INVALID_REQUEST', 400);
  return row;
}
export function integer(
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
) {
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number < min ||
    number > max
  )
    fail('INVALID_REQUEST', 400);
  return number;
}
export function number(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') fail('INVALID_REQUEST', 400);
  return integer(value, min, max);
}
export function pathId(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
    fail('INVALID_REQUEST', 400);
  return integer(value);
}
export function text(value: unknown, max = 4096, empty = false) {
  if (
    typeof value !== 'string' ||
    (!empty && !value.length) ||
    value.length > max ||
    /\0/.test(value)
  )
    fail('INVALID_REQUEST', 400);
  return value;
}
export function boolean(value: unknown) {
  if (typeof value !== 'boolean') fail('INVALID_REQUEST', 400);
  return value;
}
export function queryBoolean(value: unknown, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  fail('INVALID_REQUEST', 400);
}
export function choice<T extends string>(
  value: unknown,
  options: readonly T[],
): T {
  if (typeof value !== 'string' || !options.includes(value as T))
    fail('INVALID_REQUEST', 400);
  return value as T;
}
export function strings(value: unknown, max = 1000): string[] {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_REQUEST', 400);
  return value.map((item) => text(item));
}
export function pagination(query: Record<string, unknown>) {
  return {
    page: integer(query.page ?? 1, 1, 1000000),
    size: integer(query.size ?? 50, 1, 200),
  };
}
export function hash(value: unknown) {
  const result = text(value, 64);
  if (!/^[0-9a-f]{64}$/.test(result)) fail('INVALID_REQUEST', 400);
  return result;
}
export function uuid(value: unknown) {
  const result = text(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      result,
    )
  )
    fail('INVALID_REQUEST', 400);
  return result;
}
/** SQLite CURRENT_TIMESTAMP is UTC; the public contract always emits ISO-8601. */
export function utcTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') fail('WORKSPACE_RECOVERY_REQUIRED');
  const source = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(source) ||
    !Number.isFinite(Date.parse(source))
  )
    fail('WORKSPACE_RECOVERY_REQUIRED');
  return new Date(source).toISOString();
}
