import { fail } from '../services/workspaceV2/errors';

export function object(
  value: unknown,
  allowed: string[],
  required: string[] = [],
) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    fail('INVALID_REQUEST', 400);
  return value as Record<string, any>;
}
export function number(
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail('INVALID_REQUEST', 400);
  return value;
}
export function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail('INVALID_REQUEST', 400);
  return value;
}
export function pathId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
    fail('INVALID_REQUEST', 400);
  return number(Number(value));
}
export function queryNumber(
  value: unknown,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    fail('INVALID_REQUEST', 400);
  return number(Number(value), min, max);
}
export function text(value: unknown, max = 65536, empty = false): string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value) > max ||
    value.includes('\0')
  )
    fail('INVALID_REQUEST', 400);
  return value;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('INVALID_REQUEST', 400);
  return value;
}
export function choice<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value))
    fail('INVALID_REQUEST', 400);
  return value;
}
export function nullableId(value: unknown): number | null {
  return value === null ? null : number(value);
}
export function expected(body: unknown) {
  return number(
    object(body, ['expected_version'], ['expected_version']).expected_version,
  );
}
export function pagination(query: Record<string, unknown>) {
  const page = queryNumber(query.page, 1),
    size = queryNumber(query.size, 20, 1, 500);
  if (!Number.isSafeInteger((page - 1) * size)) fail('INVALID_REQUEST', 400);
  return { page, size, offset: (page - 1) * size };
}
export function json<T = any>(
  value: string | null | undefined,
  fallback: T,
): T {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    fail('DATABASE_SCHEMA_CORRUPTED', 503);
  }
}
export function canonicalDate(value: unknown): string {
  const result = text(value, 40);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    fail('INVALID_REQUEST', 400);
  return result;
}
export function strings(value: unknown, max = 100, itemMax = 65536): string[] {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_REQUEST', 400);
  return value.map((item) => text(item, itemMax, true));
}
