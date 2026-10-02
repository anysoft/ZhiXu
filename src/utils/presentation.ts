import {
  resources,
  getEffectiveLocale,
  t,
  translateEnum,
  translateError,
} from './i18n';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
} from './format';

/** Labels only. Unknown future fields remain inspectable without translating user data. */
export function fieldLabel(field: string) {
  const key = `field.${field}`;
  return Object.prototype.hasOwnProperty.call(
    resources[getEffectiveLocale()],
    key,
  )
    ? t(key)
    : field;
}
export function fieldValue(
  field: string,
  value: any,
  statusDomain = 'taskRun',
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (['error_code', 'last_error_code'].includes(field))
    return translateError(value);
  if (field === 'status' || field === 'result')
    return translateEnum(statusDomain, value);
  if (field === 'last_terminal_status') return translateEnum('taskRun', value);
  if (field === 'stage') return translateEnum('restoreStage', value);
  if (field === 'failure_alert_open')
    return t(value ? 'common.yes' : 'common.no');
  if (field === 'trigger_type') return translateEnum('triggerType', value);
  if (field === 'health_state') return translateEnum('health', value);
  if (field.endsWith('_at') || field.endsWith('At'))
    return formatDateTime(value);
  if (field === 'duration_ms') return formatDuration(value / 1000);
  if (field === 'retry_delay') return formatDuration(value);
  if (field === 'log_size') return formatBytes(value);
  if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no');
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
}
