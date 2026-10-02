export type LanguagePreference = 'system' | 'zh-CN' | 'en-US';
export type EffectiveLocale = 'zh-CN' | 'en-US';

export function normalizePreference(value: unknown): LanguagePreference {
  if (value === 'zh' || value === 'zh-CN') return 'zh-CN';
  if (value === 'en' || value === 'en-US') return 'en-US';
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
      return normalizePreference(options.storage.getItem('lang'));
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
      preference = normalizePreference(value);
      try {
        options.storage.setItem('lang', preference);
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
