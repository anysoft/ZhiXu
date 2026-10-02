import { getEffectiveLocale } from './i18n';
const numeric = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
export function formatNumber(
  value: unknown,
  options: Intl.NumberFormatOptions = {},
) {
  return numeric(value)
    ? new Intl.NumberFormat(getEffectiveLocale(), options).format(value)
    : '—';
}
export function formatPercent(value: unknown) {
  return formatNumber(value, { style: 'percent', maximumFractionDigits: 1 });
}
export function formatDateTime(
  value: string | number | Date | null | undefined,
  dateOnly = false,
) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(getEffectiveLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(dateOnly
      ? {}
      : { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }).format(date);
}
export function formatDate(value: string | number | Date | null | undefined) {
  return formatDateTime(value, true);
}
export function formatDuration(seconds: unknown) {
  if (!numeric(seconds) || seconds < 0) return '—';
  let rest = Math.round(seconds);
  const parts: string[] = [];
  for (const [unit, size] of [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const) {
    const value = Math.floor(rest / size);
    rest %= size;
    if (value || (unit === 'second' && parts.length === 0))
      parts.push(
        formatNumber(value, { style: 'unit', unit, unitDisplay: 'long' }),
      );
  }
  return parts.join(' ');
}
export function formatBytes(bytes: unknown) {
  if (!numeric(bytes) || bytes < 0) return '—';
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  const index = Math.max(
    0,
    Math.min(
      units.length - 1,
      bytes > 0 ? Math.floor(Math.log(bytes) / Math.log(1000)) : 0,
    ),
  );
  return formatNumber(bytes / 1000 ** index, {
    style: 'unit',
    unit: units[index],
    unitDisplay: 'short',
    maximumFractionDigits: 2,
  });
}
