export type LanguagePreference = 'system' | 'zh-CN' | 'en-US';
export type EffectiveLocale = 'zh-CN' | 'en-US';
export const LANGUAGE_STORAGE_KEY = 'zhixu.language';

export function normalizePreference(value: unknown): LanguagePreference {
  if (value === 'zh-CN' || value === 'en-US') return value;
  return 'system';
}
export function resolveLocale(
  preference: LanguagePreference,
  browserLanguage?: string,
): EffectiveLocale {
  if (preference !== 'system') return preference;
  return /^zh(?:-|$)/i.test(browserLanguage || '') ? 'zh-CN' : 'en-US';
}

export function createLanguageController(options: {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  browserLanguage: () => string;
  apply: (locale: EffectiveLocale) => void;
}) {
  const read = () => {
    try {
      return normalizePreference(options.storage.getItem(LANGUAGE_STORAGE_KEY));
    } catch {
      return 'system' as const;
    }
  };
  let preference = read();
  let locale = resolveLocale(preference, options.browserLanguage());
  let initialized = false;
  let applying = false;
  const listeners = new Set<() => void>();
  const apply = () => {
    if (applying) return;
    const next = resolveLocale(preference, options.browserLanguage());
    const changed = !initialized || next !== locale;
    locale = next;
    if (changed) {
      applying = true;
      try {
        options.apply(locale);
        initialized = true;
      } finally {
        applying = false;
      }
    }
    listeners.forEach((fn) => fn());
  };
  return {
    getPreference: () => preference,
    getLocale: () => locale,
    getSnapshot: () => `${preference}:${locale}`,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    apply,
    setPreference: (value: LanguagePreference) => {
      if (value !== 'system' && value !== 'zh-CN' && value !== 'en-US') {
        throw new Error('INVALID_LANGUAGE_PREFERENCE');
      }
      preference = value;
      try {
        options.storage.setItem(LANGUAGE_STORAGE_KEY, preference);
      } catch {
        /* In-memory switching remains available. */
      }
      apply();
    },
    systemLanguageChanged: () => {
      if (preference === 'system' && !applying) apply();
    },
    storageChanged: () => {
      preference = read();
      apply();
    },
  };
}
