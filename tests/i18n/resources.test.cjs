'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { check } = require('../../scripts/i18n/check.cjs');
test('resources have parity, no duplicate keys, no missing static calls and every UI literal has a reviewed classification', () => {
  const result = check();
  assert.equal(
    result.status,
    'PASS',
    JSON.stringify(
      {
        ...result,
        literals: result.literals.filter(
          (x) => x.classification === 'UNCLASSIFIED',
        ),
      },
      null,
      2,
    ),
  );
  for (const item of result.literals)
    assert.ok(item.reason && item.reason.length > 10, JSON.stringify(item));
});
test('new semantic messages are valid ICU and retain the same interpolation variables', () => {
  const intl = require('react-intl-universal'),
    locales = {
      zh: require('../../src/locales/zh-CN.json'),
      en: require('../../src/locales/en-US.json'),
    };
  for (const locale of ['zh', 'en']) {
    intl.init({ currentLocale: locale, locales });
    for (const [key, value] of Object.entries(locales[locale])) {
      if (!/^(ui|common|settings|validation|status|field|error)\./.test(key))
        continue;
      const params = [...value.matchAll(/(?<!')\{([a-zA-Z0-9]+)\}/g)].map(
        (x) => x[1],
      );
      assert.deepEqual(
        params.slice().sort(),
        [
          ...locales[locale === 'zh' ? 'en' : 'zh'][key].matchAll(
            /(?<!')\{([a-zA-Z0-9]+)\}/g,
          ),
        ]
          .map((x) => x[1])
          .sort(),
        key,
      );
      assert.ok(
        intl.get(key, Object.fromEntries(params.map((x) => [x, '1']))),
        `${locale}:${key}`,
      );
    }
  }
});
