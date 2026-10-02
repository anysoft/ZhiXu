const baseUrl = window.__ENV__QlBaseUrl || '/';
import { setLocale } from '@umijs/max';
import { initializeLanguage } from './utils/i18n';

export function rootContainer(container: any) {
  initializeLanguage((locale) => setLocale(locale, false));
  return container;
}

export function modifyClientRenderOpts(memo: any) {
  return {
    ...memo,
    publicPath: baseUrl,
    basename: baseUrl,
  };
}

export function modifyContextOpts(memo: any) {
  return {
    ...memo,
    basename: baseUrl,
  };
}
