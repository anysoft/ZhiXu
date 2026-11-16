import {
  useLocale,
  getEffectiveLocale,
  getLanguagePreference,
  setLanguagePreference,
  t as frameworkText,
  resources,
} from '../utils/i18n';
export { useLocale, getLanguagePreference, setLanguagePreference };
export function text(key: string, values: Record<string, any> = {}) {
  return frameworkText('v2.' + key, values);
}
export function useText() {
  useLocale();
  return text;
}
export function label(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  const key = 'v2.status.' + value;
  return Object.prototype.hasOwnProperty.call(
    resources[getEffectiveLocale()],
    key,
  )
    ? frameworkText(key)
    : String(value);
}
export function diagnostic(code?: string, status?: number) {
  const value = code || 'REQUEST_FAILED';
  const proxyErrors: Record<string, string> = {
    PROXY_PROFILE_IN_USE: 'proxyErrorInUse',
    PROXY_PROFILE_DISABLED: 'proxyErrorDisabled',
    PROXY_PROFILE_NOT_FOUND: 'proxyErrorNotFound',
    PROXY_SSH_UNSUPPORTED: 'proxyErrorSsh',
    RUNTIME_PROXY_SOCKS_SUPPORT_REQUIRED: 'proxyErrorSocks',
  };
  if (proxyErrors[value]) return text(proxyErrors[value]);
  if (value === 'V2_BACKEND_REQUIRED') return text('v2BackendRequired');
  if (value === 'TWO_FACTOR_REQUIRED') return text('twoFactorRequired');
  if (value === 'SOURCE_SUPERSEDED') return text('error.superseded');
  if (/CASEFOLD|UNSAFE_TARGET|GIT_PATH/.test(value))
    return text('error.unsafeTree');
  if (/DIRTY|STAGED|UNTRACKED|GIT_CONFLICT/.test(value))
    return text('error.dirty');
  if (/DIVERGED|LOCAL_ONLY|LOCAL_COMMITS/.test(value))
    return text('error.diverged');
  if (/PREVIEW_STALE/.test(value)) return text('error.preview');
  if (
    /FILE_CONFLICT|VERSION_CONFLICT|EDIT_CONFLICT|DESTINATION_EXISTS/.test(
      value,
    )
  )
    return text('error.conflict');
  if (/RECOVERY|RESTORE_PENDING/.test(value)) return text('error.recovery');
  if (/BUSY|BACKUP_IN_PROGRESS/.test(value)) return text('error.busy');
  if (/AUTHENTICATION/.test(value) || status === 401)
    return text('error.unauthorized');
  if (/PANEL_SESSION|FORBIDDEN/.test(value) || status === 403)
    return text('error.forbidden');
  if (value === 'NETWORK_ERROR') return text('error.network');
  return text('error.generic');
}
