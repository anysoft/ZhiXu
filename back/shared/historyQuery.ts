import { fail } from '../services/workspaceV2/errors';

export interface HistoryQuery {
  page: number;
  size: number;
  offset: number;
  from: string | null;
  to: string | null;
  status?: string;
}
export const historyQueryKeys = ['page', 'size', 'from', 'to', 'status'];
export function hasHistoryQuery(query: Record<string, unknown>) {
  return historyQueryKeys.some((key) => query[key] !== undefined);
}
function integer(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (
    (typeof value !== 'number' &&
      (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > maximum
  )
    fail('INVALID_REQUEST', 400);
  return Number(value);
}
/** Explicit timezone only; validate calendar fields before normalizing to UTC. */
export function historyTimestamp(value: unknown): string {
  if (typeof value !== 'string') fail('INVALID_REQUEST', 400);
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) fail('INVALID_REQUEST', 400);
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const time = Date.parse(value);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (match[7] !== undefined &&
      (Number(match[7]) > 23 || Number(match[8]) > 59)) ||
    !Number.isFinite(time)
  )
    fail('INVALID_REQUEST', 400);
  return new Date(time).toISOString();
}
export function parseHistoryQuery(
  query: Record<string, unknown>,
  options: {
    statuses?: readonly string[];
    allowedStatuses?: readonly string[];
    now?: Date;
    defaultDays?: number;
  },
): HistoryQuery {
  const page = integer(query.page, 1, 1000000),
    size = integer(query.size, 20, 200),
    offset = (page - 1) * size;
  const supplied = query.from !== undefined || query.to !== undefined;
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) fail('INVALID_REQUEST', 400);
  const from =
    query.from === undefined
      ? supplied
        ? null
        : new Date(
            now.getTime() - (options.defaultDays ?? 7) * 86400000,
          ).toISOString()
      : historyTimestamp(query.from);
  const to =
    query.to === undefined
      ? supplied
        ? null
        : now.toISOString()
      : historyTimestamp(query.to);
  if (from && to && from >= to) fail('INVALID_REQUEST', 400);
  const statuses = options.statuses ?? options.allowedStatuses ?? [];
  if (
    query.status !== undefined &&
    (typeof query.status !== 'string' || !statuses.includes(query.status))
  )
    fail('INVALID_REQUEST', 400);
  return {
    page,
    size,
    offset,
    from,
    to,
    ...(query.status === undefined ? {} : { status: query.status as string }),
  };
}
/** Time expressions come only from server code; values remain bound SQL parameters. */
export function historyWhere(
  query: Pick<HistoryQuery, 'from' | 'to' | 'status'>,
  expression: string,
) {
  const clauses: string[] = [],
    values: (string | number)[] = [];
  if (query.from) {
    clauses.push(`julianday(${expression}) >= julianday(?)`);
    values.push(query.from);
  }
  if (query.to) {
    clauses.push(`julianday(${expression}) < julianday(?)`);
    values.push(query.to);
  }
  if (query.status) {
    clauses.push('status=?');
    values.push(query.status);
  }
  return { clauses, values };
}
