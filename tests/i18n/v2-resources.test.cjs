'use strict';
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const {
  resources,
  t,
  setLanguagePreference,
} = require('../../src/utils/i18n.ts');
const { text, label } = require('../../src/v2/i18n.ts');
const { inventory, check } = require('../../scripts/i18n/check.cjs');
test('v2 resources share the existing registry and preserve every default-interface message exactly', () => {
  for (const locale of ['en-US', 'zh-CN']) {
    const original = require('../../src/locales/' + locale + '.json'),
      v2 = require('../../src/v2/locales/' + locale + '.json');
    for (const [key, value] of Object.entries(original))
      assert.equal(resources[locale][key], value, locale + ':' + key);
    for (const [key, value] of Object.entries(v2)) {
      assert.ok(key.startsWith('v2.'));
      assert.equal(Object.hasOwn(original, key), false);
      assert.equal(resources[locale][key], value);
    }
  }
});
test('every v2 message uses the existing ICU formatter in both locales with matching interpolation variables', () => {
  const locales = {
    'en-US': require('../../src/v2/locales/en-US.json'),
    'zh-CN': require('../../src/v2/locales/zh-CN.json'),
  };
  assert.deepEqual(
    Object.keys(locales['en-US']).sort(),
    Object.keys(locales['zh-CN']).sort(),
  );
  for (const locale of ['en-US', 'zh-CN']) {
    setLanguagePreference(locale);
    for (const [key, value] of Object.entries(locales[locale])) {
      const parameters = [...value.matchAll(/(?<!')\{([a-zA-Z0-9]+)\}/g)]
        .map((x) => x[1])
        .sort();
      assert.deepEqual(
        parameters,
        [
          ...locales[locale === 'en-US' ? 'zh-CN' : 'en-US'][key].matchAll(
            /(?<!')\{([a-zA-Z0-9]+)\}/g,
          ),
        ]
          .map((x) => x[1])
          .sort(),
        key,
      );
      const args = Object.fromEntries(parameters.map((name) => [name, 7])),
        actual = text(key.slice(3), args);
      assert.equal(actual, t(key, args));
      assert.notEqual(actual, key);
      assert.ok(actual.length > 0);
    }
    assert.equal(label('READY'), t('v2.status.READY'));
    assert.equal(label('FUTURE_MACHINE_STATE'), 'FUTURE_MACHINE_STATE');
  }
});
test('strict static inventory resolves v2 hook, direct wrapper, and conditional keys without omitting the v2 source tree', () => {
  const calls = inventory().calls;
  for (const [file, key] of [
    ['src/v2/App.tsx', 'v2.languagePreference'],
    ['src/v2/components.tsx', 'v2.required'],
    ['src/v2/pages/Notifications.tsx', 'v2.missing'],
  ])
    assert.ok(
      calls.some((call) => call.file === file && call.key === key),
      file + ':' + key,
    );
  const result = check();
  assert.equal(result.status, 'PASS');
  assert.equal(result.missing.length, 0);
  assert.equal(
    result.literals.some(
      (row) =>
        row.file.startsWith('src/v2/') && row.classification === 'UNCLASSIFIED',
    ),
    false,
  );
});
