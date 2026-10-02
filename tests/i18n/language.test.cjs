'use strict';
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const {
  normalizePreference,
  LANGUAGE_STORAGE_KEY,
  resolveLocale,
  createLanguageController,
} = require('../../src/utils/language.ts');
test('formal preference model and browser locale resolution', () => {
  for (const [raw, expected] of [
    ['system', 'system'],
    ['zh-CN', 'zh-CN'],
    ['en-US', 'en-US'],
    [null, 'system'],
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
  const map = new Map([[LANGUAGE_STORAGE_KEY, 'zh-CN']]);
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
  assert.equal(map.get(LANGUAGE_STORAGE_KEY), 'en-US');
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

test('fresh installation defaults to system and writes only the formal namespace', () => {
  const reads = [],
    writes = [];
  const c = createLanguageController({
    storage: {
      getItem: (key) => {
        reads.push(key);
        return null;
      },
      setItem: (key, value) => writes.push([key, value]),
    },
    browserLanguage: () => 'fr-FR',
    apply: () => {},
  });
  assert.equal(LANGUAGE_STORAGE_KEY, 'zhixu.language');
  assert.deepEqual(reads, ['zhixu.language']);
  assert.equal(c.getPreference(), 'system');
  assert.equal(c.getLocale(), 'en-US');
  for (const value of ['system', 'zh-CN', 'en-US']) c.setPreference(value);
  assert.deepEqual(
    writes,
    ['system', 'zh-CN', 'en-US'].map((value) => ['zhixu.language', value]),
  );
});
