'use strict';
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const {
  createChannelPayload,
} = require('../../src/features/notifications/channelForm.ts');
const base = {
  name: 'Channel',
  type: 'lark',
  enabled: true,
  is_default: false,
  secret_action: 'REPLACE',
  providerConfig: { larkKey: 'fixture-key' },
};
const existing = { id: 7, type: 'lark', version: 3 };
test('new channels always replace; API metadata is explicitly allowlisted', () => {
  const result = createChannelPayload({
    ...base,
    secret_action: 'KEEP',
    unexpected: 'discard',
    confirmClear: true,
  });
  assert.deepEqual(result, {
    name: 'Channel',
    type: 'lark',
    enabled: true,
    is_default: false,
    secret_action: 'REPLACE',
    secret: { larkKey: 'fixture-key' },
  });
});
test('KEEP and confirmed DELETE omit secret entirely, including stale drafts', () => {
  const keep = createChannelPayload(
    { ...base, secret_action: 'KEEP' },
    existing,
  );
  assert.equal(Object.hasOwn(keep, 'secret'), false);
  assert.equal(keep.expected_version, 3);
  assert.throws(() =>
    createChannelPayload({ ...base, secret_action: 'DELETE' }, existing),
  );
  const cleared = createChannelPayload(
    { ...base, secret_action: 'DELETE', confirmClear: true },
    existing,
  );
  assert.equal(Object.hasOwn(cleared, 'secret'), false);
  assert.equal(cleared.secret_action, 'DELETE');
});
test('provider change requires replacement and never sends the previous provider fields', () => {
  for (const action of ['KEEP', 'DELETE'])
    assert.throws(() =>
      createChannelPayload(
        {
          ...base,
          type: 'telegramBot',
          secret_action: action,
          confirmClear: true,
        },
        existing,
      ),
    );
  const configs = [
    ['lark', { larkKey: 'key', telegramBotToken: 'stale' }],
    [
      'telegramBot',
      {
        telegramBotToken: 'token',
        telegramBotUserId: 'chat',
        larkKey: 'stale',
      },
    ],
    [
      'email',
      {
        emailMode: 'smtp',
        emailHost: 'smtp.example.invalid',
        emailUser: 'user',
        emailPass: 'pass',
        telegramBotToken: 'stale',
      },
    ],
  ];
  for (const [type, providerConfig] of configs) {
    const result = createChannelPayload(
      { ...base, type, providerConfig },
      existing,
    );
    assert.equal(Object.values(result.secret).includes('stale'), false);
    assert.equal(Object.hasOwn(result.secret, 'emailMode'), false);
  }
});
test('REPLACE is complete, never treats omitted required fields as preserved secrets', () => {
  assert.throws(() =>
    createChannelPayload({ ...base, providerConfig: {} }, existing),
  );
  assert.throws(() =>
    createChannelPayload(
      {
        ...base,
        type: 'email',
        providerConfig: {
          emailMode: 'smtp',
          emailHost: 'smtp.example.invalid',
        },
      },
      existing,
    ),
  );
});
