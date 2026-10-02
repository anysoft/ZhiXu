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
  translateEnum,
  translateError,
} = require('../../src/utils/i18n.ts');
const format = require('../../src/utils/format.ts');
const domains = require('../../scripts/i18n/enums.json');
const errors = require('../../scripts/i18n/errors.json');
test('every declared active enum is translated in both locales; unknown values remain raw', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    setLanguagePreference(locale);
    for (const [domain, values] of Object.entries(domains))
      for (const value of values) {
        const key = `status.${domain}.${value}`;
        assert.ok(resources[locale][key], key);
        assert.equal(translateEnum(domain, value), resources[locale][key]);
      }
    assert.equal(translateEnum('taskRun', 'FUTURE_STATE'), 'FUTURE_STATE');
    assert.equal(translateEnum('taskRun', null), '—');
  }
});
test('known and unknown error codes are localized without exposing arbitrary diagnostic text', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    setLanguagePreference(locale);
    for (const code of errors)
      assert.equal(translateError(code), resources[locale]['error.' + code]);
    assert.match(translateError('FUTURE_CODE'), /FUTURE_CODE/);
    for (const sensitive of [
      'password=fixture-secret',
      'token: abc',
      'invalid value user@example.invalid',
      { token: 'secret' },
    ])
      assert.equal(translateError(sensitive), t('error.generic'));
  }
});
test('formatters use selected locale, preserve instants, and cover empty, invalid, fraction and boundaries', () => {
  const instant = new Date('2025-01-02T03:04:05Z');
  for (const locale of ['zh-CN', 'en-US']) {
    setLanguagePreference(locale);
    assert.equal(
      format.formatNumber(12345.6),
      new Intl.NumberFormat(locale).format(12345.6),
    );
    assert.equal(format.formatNumber(0), '0');
    assert.equal(format.formatNumber(NaN), '—');
    assert.equal(format.formatNumber(undefined), '—');
    assert.equal(
      format.formatPercent(0.125),
      new Intl.NumberFormat(locale, {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(0.125),
    );
    assert.equal(
      format.formatDateTime(instant),
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(instant),
    );
    assert.equal(
      format.formatDate(instant),
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(instant),
    );
    for (const v of [undefined, null, 'invalid'])
      assert.equal(format.formatDateTime(v), '—');
    assert.equal(
      format.formatDuration(59.6),
      new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: 'minute',
        unitDisplay: 'long',
      }).format(1),
    );
    assert.equal(
      format.formatDuration(3600),
      new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: 'hour',
        unitDisplay: 'long',
      }).format(1),
    );
    assert.equal(format.formatDuration(-1), '—');
    assert.equal(format.formatDuration(null), '—');
    assert.ok(format.formatDuration(0));
    for (const n of [0, 0.5, 1000, 1e6])
      assert.equal(
        format.formatBytes(n),
        new Intl.NumberFormat(locale, {
          style: 'unit',
          unit: n >= 1e6 ? 'megabyte' : n >= 1000 ? 'kilobyte' : 'byte',
          unitDisplay: 'short',
          maximumFractionDigits: 2,
        }).format(n / (n >= 1e6 ? 1e6 : n >= 1000 ? 1000 : 1)),
      );
    assert.equal(format.formatBytes(-1), '—');
    assert.equal(format.formatBytes(undefined), '—');
  }
});
