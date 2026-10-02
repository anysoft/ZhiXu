import intl from 'react-intl-universal';
import { useSyncExternalStore } from 'react';
import {
  createLanguageController,
  EffectiveLocale,
  LanguagePreference,
  LANGUAGE_STORAGE_KEY,
} from './language';
export { resolveLocale, normalizePreference } from './language';
export type { EffectiveLocale, LanguagePreference } from './language';

export const resources: Record<EffectiveLocale, Record<string, string>> = {
  'zh-CN': require('../locales/zh-CN.json'),
  'en-US': require('../locales/en-US.json'),
};
let frameworkApply: ((locale: EffectiveLocale) => void) | undefined;
let ready = false;
let controller: ReturnType<typeof createLanguageController>;
const storage = {
  getItem: (key: string) =>
    typeof window === 'undefined' ? null : window.localStorage.getItem(key),
  setItem: (key: string, value: string) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  },
};
controller = createLanguageController({
  storage,
  browserLanguage: () =>
    typeof navigator === 'undefined' ? 'en-US' : navigator.language,
  apply: (locale) => {
    void intl.init({ currentLocale: locale, locales: resources });
    ready = true;
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
    frameworkApply?.(locale);
  },
});
export const getLanguagePreference = controller.getPreference;
export const getEffectiveLocale = controller.getLocale;
export const setLanguagePreference = controller.setPreference;
export const applyLocale = controller.apply;
export const subscribeLocaleChange = controller.subscribe;
export function initializeLanguage(
  applyFramework: (locale: EffectiveLocale) => void,
) {
  controller.apply();
  frameworkApply = applyFramework;
  // Ensure framework state is synchronized even when messages initialized earlier.
  applyFramework(getEffectiveLocale());
}
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', controller.systemLanguageChanged);
  window.addEventListener('storage', (event) => {
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null)
      controller.storageChanged();
  });
}
export function useLocale() {
  useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return getEffectiveLocale();
}
export function t(
  key: string,
  values?: Record<string, string | number>,
): string {
  if (!ready) controller.apply();
  const value = intl.get(key, values);
  return String(value || key);
}
const warned = new Set<string>();
export function translateEnum(domain: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const raw = String(value),
    key = `status.${domain}.${raw}`;
  if (
    Object.prototype.hasOwnProperty.call(resources[getEffectiveLocale()], key)
  )
    return t(key);
  if (process.env.NODE_ENV !== 'production' && !warned.has(key)) {
    warned.add(key);
    console.warn('I18N_ENUM_MISSING', key);
  }
  return raw;
}
export const translateStatus = translateEnum;
export function translateError(code: unknown): string {
  const safeCode =
    typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(code)
      ? code
      : '';
  const key = `error.${safeCode}`;
  if (
    safeCode &&
    Object.prototype.hasOwnProperty.call(resources[getEffectiveLocale()], key)
  )
    return t(key);
  return safeCode
    ? t('error.unknownCode', { code: safeCode })
    : t('error.generic');
}

// Initialize messages before module-level configuration consumers are read.
applyLocale();
