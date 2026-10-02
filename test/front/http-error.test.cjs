const assert = require('node:assert/strict');
const test = require('node:test');
const { getErrorDetails } = require('../../src/utils/httpError');
const { setLanguagePreference, translateError } = require('../../src/utils/i18n');

test('raw validation messages and values never leak through error details', () => {
  assert.deepEqual(getErrorDetails({ validation: { body: {
    keys: ['password'], message: 'invalid secret=private-canary',
  } }, errors: [{ message: 'duplicate value', value: 'private-canary' }] }), []);
});
test('explicit safe API error codes retain actionable localized details', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    setLanguagePreference(locale);
    assert.deepEqual(getErrorDetails({ errors: [
      { message: 'NODE_DEPENDENCY_MISSING', value: 'private-canary' },
      { message: 'FUTURE_ERROR_CODE' },
    ] }), [translateError('NODE_DEPENDENCY_MISSING'), translateError('FUTURE_ERROR_CODE')]);
  }
});
