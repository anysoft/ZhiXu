'use strict';
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const {
  normalizePreference,
  resolveLocale,
  createLanguageController,
} = require('../../src/utils/language.ts');
test('canonical and legacy preference values and explicit locale override', () => {
  for (const [raw, expected] of [
    ['zh', 'zh-CN'],
    ['en', 'en-US'],
    ['', 'system'],
    ['system', 'system'],
    ['zh-CN', 'zh-CN'],
    ['en-US', 'en-US'],
    [null, 'system'],
    ['fr', 'system'],
  ])
    assert.equal(normalizePreference(raw), expected);
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLocale('en-US', 'zh-CN'), 'en-US');
  for (const v of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hant'])
    assert.equal(resolveLocale('system', v), 'zh-CN');
  for (const v of ['en', 'en-US', 'fr-FR', 'de', 'ja', 'ko', undefined, ''])
    assert.equal(resolveLocale('system', v), 'en-US');
});
test('persistence, system language events, explicit preference isolation and reentrant framework events', () => {
  const map = new Map([['lang', 'zh']]);
  let system = 'en-US',
    applied = [];
  let c;
  const options = {
    storage: { getItem: (k) => map.get(k), setItem: (k, v) => map.set(k, v) },
    browserLanguage: () => system,
    apply: (v) => {
      applied.push(v);
      c?.systemLanguageChanged();
    },
  };
  c = createLanguageController(options);
  c.apply();
  assert.equal(c.getLocale(), 'zh-CN');
  c.setPreference('en-US');
  assert.equal(map.get('lang'), 'en-US');
  system = 'zh-SG';
  c.systemLanguageChanged();
  assert.equal(c.getLocale(), 'en-US');
  c.setPreference('system');
  assert.equal(c.getLocale(), 'zh-CN');
  system = 'fr-FR';
  c.systemLanguageChanged();
  assert.equal(c.getLocale(), 'en-US');
  const next = createLanguageController({ ...options, apply: () => {} });
  assert.equal(next.getPreference(), 'system');
  assert.equal(next.getLocale(), 'en-US');
  assert.equal(applied.length, 4);
});
test('blocked storage does not prevent in-memory language switching', () => {
  const c = createLanguageController({
    storage: {
      getItem: () => {
        throw Error('blocked');
      },
      setItem: () => {
        throw Error('blocked');
      },
    },
    browserLanguage: () => '',
    apply: () => {},
  });
  c.setPreference('zh-CN');
  assert.equal(c.getLocale(), 'zh-CN');
});
