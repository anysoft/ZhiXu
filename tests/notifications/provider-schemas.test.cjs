'use strict';
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  ts = require('typescript');
const {
  providerSchemas,
  getProviderDefaults,
  isProviderFieldVisible,
  validateProviderConfig,
  serializeProviderConfig,
  deserializeProviderConfig,
} = require('../../src/features/notifications/providerSchemas.ts');
const {
  notificationRequiredFields,
  validateNotificationConfig,
} = require('../../back/shared/notificationConfig.ts');
function ast(file) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}
function nodes(root, predicate) {
  const result = [];
  function visit(n) {
    if (predicate(n)) result.push(n);
    ts.forEachChild(n, visit);
  }
  visit(root);
  return result;
}
const backend = ast('back/services/notificationChannels.ts');
const providers = nodes(
  backend,
  (n) =>
    ts.isVariableDeclaration(n) &&
    n.name.getText(backend) === 'channelProviders',
)[0].initializer.elements.map((n) => n.text);
const adapter = ast('back/services/notify.ts');
function fieldFixture(field) {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.options) return field.options[0].value;
  if (field.type === 'number') return Math.max(field.min ?? 0, 1);
  if (field.type === 'boolean') return false;
  if (field.type === 'keyValue')
    return [{ key: 'X-Fixture', value: 'scheme: value' }];
  if (field.type === 'url') return 'https://example.invalid/hook';
  return (
    {
      telegramBotProxyHost: 'proxy.example.invalid',
      telegramBotProxyPort: '8080',
      goCqHttpBotQq: 'user_id=123',
      chronocatQQ: 'group_id=123',
      wxPusherBotTopicIds: '1;2',
      wxPusherSptList: 'SPT-fixture',
      agentId: '100001',
      toUser: '@all',
      emailHost: 'smtp.example.invalid',
      webhookBody: 'title: $title\ncontent: $content',
    }[field.name] ?? 'fixture-value'
  );
}
function fixture(id, optional = false) {
  const values = getProviderDefaults(id);
  for (const f of providerSchemas[id].fields) {
    if (isProviderFieldVisible(f, values) && (f.required || optional))
      values[f.name] = fieldFixture(f);
  }
  if (id === 'webhook')
    values.webhookUrl = 'https://example.invalid/hook?title=$title';
  if (id === 'wxPusherBot') values.wxPusherBotTopicIds = '1;2';
  return values;
}
test('schema IDs exactly equal all 25 backend providers; required and every adapter field match', () => {
  assert.equal(providers.length, 25);
  assert.deepEqual(Object.keys(providerSchemas).sort(), [...providers].sort());
  for (const id of providers) {
    const schema = providerSchemas[id];
    assert.deepEqual(
      [...schema.requiredFields].sort(),
      [...notificationRequiredFields[id]].sort(),
      id,
    );
    const method = nodes(
      adapter,
      (n) => ts.isMethodDeclaration(n) && n.name.getText(adapter) === id,
    )[0];
    const fields =
      id === 'WEBHOOK'
        ? ['url', 'authorization']
        : nodes(
            method,
            (n) =>
              ts.isVariableDeclaration(n) &&
              ts.isObjectBindingPattern(n.name) &&
              n.initializer?.getText(adapter).includes('this.params'),
          ).flatMap((n) => n.name.elements.map((e) => e.name.getText(adapter)));
    assert.deepEqual(
      [...schema.wireFields].sort(),
      [...fields].sort(),
      id + ' optional field drift',
    );
    for (const optional of [false, true]) {
      const config = serializeProviderConfig(id, fixture(id, optional));
      assert.doesNotThrow(() => validateNotificationConfig(id, config), id);
      assert.ok(
        Object.keys(config).every((k) => schema.wireFields.includes(k)),
        id,
      );
    }
  }
});
test('every declared field has localized metadata, explicit type and preserves primitive/default types', () => {
  const zh = require('../../src/locales/zh-CN.json'),
    en = require('../../src/locales/en-US.json');
  for (const schema of Object.values(providerSchemas)) {
    for (const key of [
      schema.labelKey,
      schema.descriptionKey,
      ...schema.fields
        .flatMap((f) => [
          f.labelKey,
          f.descriptionKey,
          f.placeholderKey,
          ...(f.options || []).map((o) => o.labelKey),
        ])
        .filter(Boolean),
    ])
      assert.ok(zh[key] && en[key], key);
    const serialized = serializeProviderConfig(
      schema.id,
      fixture(schema.id, true),
    );
    for (const field of schema.fields) {
      assert.ok(
        [
          'text',
          'password',
          'url',
          'number',
          'boolean',
          'select',
          'textarea',
          'keyValue',
        ].includes(field.type),
      );
      if (Object.hasOwn(serialized, field.name)) {
        if (field.type === 'number')
          assert.equal(typeof serialized[field.name], 'number');
        else if (field.type === 'boolean')
          assert.equal(typeof serialized[field.name], 'boolean');
        else assert.equal(typeof serialized[field.name], 'string');
      }
      if (field.defaultValue !== undefined)
        assert.equal(
          getProviderDefaults(schema.id)[field.name],
          field.defaultValue,
        );
    }
  }
  assert.equal(getProviderDefaults('gotify').gotifyPriority, 1);
  assert.equal(getProviderDefaults('bark').barkGroup, undefined);
  assert.equal(getProviderDefaults('email').emailPort, 587);
  assert.equal(getProviderDefaults('email').emailSecure, false);
  assert.equal(getProviderDefaults('ntfy').ntfyPriority, '3');
});
test('Lark accepts key or URL with optional signing secret, rejects missing key or illegal types', () => {
  for (const larkKey of [
    'fixture-key',
    'https://open.feishu.cn/open-apis/bot/v2/hook/fixture',
  ]) {
    assert.deepEqual(serializeProviderConfig('lark', { larkKey }), { larkKey });
    assert.deepEqual(
      serializeProviderConfig('lark', {
        larkKey,
        larkSecret: 'secret:&+ 中文',
      }),
      { larkKey, larkSecret: 'secret:&+ 中文' },
    );
  }
  for (const input of [
    {},
    { larkKey: 123 },
    { larkKey: 'key', larkSecret: [] },
    null,
    [],
  ])
    assert.ok(validateProviderConfig('lark', input).length);
});
test('email service/custom SMTP validation, mode isolation, numbers and booleans', () => {
  const common = {
    emailUser: 'fixture@example.invalid',
    emailPass: ' untouched password ',
  };
  assert.deepEqual(
    serializeProviderConfig('email', { ...common, emailService: 'Gmail' }),
    { emailService: 'Gmail', ...common },
  );
  const smtp = serializeProviderConfig('email', {
    ...common,
    emailMode: 'smtp',
    emailHost: 'smtp.example.invalid',
    emailService: 'stale',
    emailPort: 465,
    emailSecure: true,
    emailTo: 'a@example.invalid;b@example.invalid',
  });
  assert.equal(smtp.emailService, undefined);
  assert.equal(smtp.emailHost, 'smtp.example.invalid');
  assert.equal(smtp.emailPort, 465);
  assert.equal(smtp.emailSecure, true);
  assert.equal(smtp.emailTo, 'a@example.invalid;b@example.invalid');
  for (const input of [
    { emailService: 'Gmail' },
    { ...common },
    { ...common, emailMode: 'smtp', emailHost: 'bad host' },
    {
      ...common,
      emailMode: 'smtp',
      emailHost: 'smtp.example.invalid',
      emailPort: '465',
    },
    {
      ...common,
      emailMode: 'smtp',
      emailHost: 'smtp.example.invalid',
      emailSecure: 'true',
    },
  ])
    assert.ok(validateProviderConfig('email', input).length);
});
test('standard and custom webhooks stay distinct and preserve templates/header values exactly', () => {
  assert.deepEqual(
    serializeProviderConfig('WEBHOOK', {
      url: 'https://example.invalid/hook',
      authorization: 'Custom scheme:value',
    }),
    {
      url: 'https://example.invalid/hook',
      authorization: 'Custom scheme:value',
    },
  );
  const input = {
    webhookUrl: 'https://example.invalid/hook',
    webhookMethod: 'POST',
    webhookContentType: 'application/json',
    webhookHeaders: [
      { key: 'Authorization', value: 'Basic a:b:c' },
      { key: 'X-Other', value: '& 中文 +' },
    ],
    webhookBody: 'title: $title\ntext: $content',
  };
  const config = serializeProviderConfig('webhook', input);
  assert.equal(config.webhookBody, input.webhookBody);
  assert.equal(
    config.webhookHeaders,
    'Authorization: Basic a:b:c\nX-Other: & 中文 +',
  );
  assert.equal(config.authorization, undefined);
  assert.deepEqual(
    serializeProviderConfig(
      'webhook',
      deserializeProviderConfig('webhook', config),
    ),
    config,
  );
  for (const bad of [
    { ...input, webhookMethod: 'DELETE' },
    { ...input, webhookContentType: 'arbitrary' },
    { ...input, webhookBody: 'no title' },
    {
      ...input,
      webhookHeaders: [
        { key: 'X-Header', value: 'safe\r\nAuthorization: leaked' },
      ],
    },
  ])
    assert.ok(validateProviderConfig('webhook', bad).length);
  assert.ok(
    validateProviderConfig('WEBHOOK', { url: 'javascript:alert(1)' }).length,
  );
});
test('WeWorkApp emits the actual fifth-item thumbnail protocol, validates separators and roundtrips', () => {
  const common = {
    corpId: 'corp',
    corpSecret: 's:&+',
    toUser: 'one|two',
    agentId: '100001',
  };
  for (const [messageType, fifth, extra] of [
    ['text', '1', {}],
    ['textcard', '0', {}],
    ['mpnews', 'media-id', { thumbMediaId: 'media-id' }],
  ]) {
    const out = serializeProviderConfig('weWorkApp', {
      ...common,
      messageType,
      ...extra,
    });
    assert.equal(
      out.weWorkAppKey,
      ['corp', 's:&+', 'one|two', '100001', fifth].join(','),
    );
    assert.deepEqual(
      serializeProviderConfig(
        'weWorkApp',
        deserializeProviderConfig('weWorkApp', out),
      ),
      out,
    );
  }
  for (const input of [
    { ...common, corpSecret: 'bad,value' },
    { ...common, messageType: 'mpnews' },
    { ...common, messageType: 'mpnews', thumbMediaId: '1' },
  ])
    assert.ok(validateProviderConfig('weWorkApp', input).length);
});
test('ntfy authentication modes discard inactive secrets and wxPusher recipient formats stay unchanged', () => {
  const stale = {
    ntfyTopic: 'topic',
    ntfyToken: 'old-token',
    ntfyUsername: 'old-user',
    ntfyPassword: 'old-password',
  };
  const none = serializeProviderConfig('ntfy', {
    ...stale,
    ntfyAuthMode: 'none',
  });
  assert.equal(none.ntfyToken, undefined);
  assert.equal(none.ntfyUsername, undefined);
  assert.equal(none.ntfyPassword, undefined);
  const basic = serializeProviderConfig('ntfy', {
    ...stale,
    ntfyAuthMode: 'basic',
  });
  assert.equal(basic.ntfyToken, undefined);
  assert.equal(basic.ntfyUsername, 'old-user');
  for (const value of [
    { wxPusherBotTopicIds: '1;2' },
    { wxPusherBotUids: 'UID_A;UID_B' },
  ]) {
    const out = serializeProviderConfig('wxPusherBot', {
      wxPusherBotAppToken: 'token',
      ...value,
    });
    for (const [k, v] of Object.entries(value)) assert.equal(out[k], v);
  }
  assert.ok(
    validateProviderConfig('wxPusherBot', { wxPusherBotAppToken: 'token' })
      .length,
  );
  assert.ok(
    validateProviderConfig('wxPusherBot', {
      wxPusherBotAppToken: 'token',
      wxPusherBotTopicIds: 'abc',
    }).length,
  );
  assert.ok(
    validateProviderConfig('wxPusherSpt', {
      wxPusherSptList: Array(11).fill('SPT').join(','),
    }).length,
  );
});
test('serialization rejects dangerous keys/types and never leaks cross-provider fields', () => {
  for (const forbidden of ['__proto__', 'constructor', 'prototype', 'type'])
    assert.ok(
      validateProviderConfig(
        'lark',
        JSON.parse('{"larkKey":"key","' + forbidden + '":"bad"}'),
      ).length,
    );
  assert.ok(validateProviderConfig('__proto__', {}).length);
  assert.ok(
    validateProviderConfig('lark', Object.create({ larkKey: 'inherited' }))
      .length,
  );
  assert.deepEqual(
    serializeProviderConfig('lark', {
      larkKey: 'key',
      telegramBotToken: 'must-not-leak',
      emailPass: 'must-not-leak',
    }),
    { larkKey: 'key' },
  );
  assert.equal(
    serializeProviderConfig('telegramBot', {
      telegramBotToken: 'tg',
      telegramBotUserId: '123',
      larkKey: 'stale',
    }).larkKey,
    undefined,
  );
  assert.equal(
    serializeProviderConfig('email', {
      emailService: 'Gmail',
      emailUser: 'u',
      emailPass: 'p',
      telegramBotToken: 'stale',
    }).telegramBotToken,
    undefined,
  );
});

test('wxPusher rejects separator-only recipient lists without rewriting valid strings', () => {
  for (const recipients of [
    { wxPusherBotTopicIds: ';;' },
    { wxPusherBotUids: ';;' },
    { wxPusherBotTopicIds: ' ; ; ', wxPusherBotUids: ' ; ; ' },
    { wxPusherBotTopicIds: ';;', wxPusherBotUids: 'UID_A' },
    { wxPusherBotTopicIds: '1', wxPusherBotUids: ';;' },
  ])
    assert.ok(
      validateProviderConfig('wxPusherBot', {
        wxPusherBotAppToken: 'fixture',
        ...recipients,
      }).length,
    );
  const valid = {
    wxPusherBotAppToken: 'fixture',
    wxPusherBotTopicIds: '1; 2',
    wxPusherBotUids: 'UID_A;UID_B',
  };
  assert.deepEqual(serializeProviderConfig('wxPusherBot', valid), valid);
});
