'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../test/helpers/load-security-module.cjs');
const { serializeCredentialInput } = load(
  'src/features/repository/credentialForm.ts',
);

const metadata = {
  name: 'Isolated form fixture',
  provider: 'generic',
  username: 'fixture-user',
  capability: 'READ',
  status: 'enabled',
};
const token = 'form-fixture-token';
// Deliberately preserve leading/trailing whitespace and final newlines. The
// serializer never normalizes SSH text; backend format validation owns it.
const privateKey =
  ' \n-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n\n';
const passphrase = 'form-fixture-passphrase';
const knownHosts = 'fixture.invalid ssh-ed25519 AAAAFIXTURE\n';
const keys = (value) => Object.keys(value).sort();
const noSensitiveFields = (value) => {
  for (const name of ['token', 'private_key', 'passphrase'])
    assert.equal(Object.hasOwn(value, name), false, 'Unexpected secret field');
};
const secretRequired = (action) =>
  assert.throws(action, (error) => {
    assert.equal(error.message, 'CREDENTIAL_SECRET_REQUIRED');
    return true;
  });

for (const auth of ['https_token', 'ssh_key']) {
  const field = auth === 'https_token' ? 'token' : 'private_key';
  const material = auth === 'https_token' ? token : privateKey;
  const base = { ...metadata, auth_type: auth, known_hosts: knownHosts };
  const editing = { id: 42, auth_type: auth, has_secret: true };

  test(
    auth + ': create and edit with nonempty material automatically replace',
    () => {
      for (const row of [
        undefined,
        editing,
        { ...editing, has_secret: false },
      ]) {
        const result = serializeCredentialInput(
          { ...base, [field]: material },
          row,
        );
        assert.equal(result.replace_secret, true);
        assert.ok(
          result[field] === material,
          'Credential text must remain exact',
        );
        if (auth === 'ssh_key') {
          assert.equal(result.passphrase, '');
          assert.ok(
            result.known_hosts === knownHosts,
            'Known hosts must remain exact',
          );
        }
      }
    },
  );

  test(
    auth + ': create and missing-secret edit require credential material',
    () => {
      for (const row of [
        undefined,
        { ...editing, has_secret: false },
        { id: 42, auth_type: auth },
      ])
        for (const blank of [undefined, ''])
          secretRequired(() =>
            serializeCredentialInput({ ...base, [field]: blank }, row),
          );
    },
  );

  test(
    auth + ': blank edit keeps saved secret and omits every sensitive field',
    () => {
      for (const blank of [undefined, '']) {
        const result = serializeCredentialInput(
          { ...base, [field]: blank, passphrase },
          editing,
        );
        assert.equal(result.replace_secret, false);
        noSensitiveFields(result);
        if (auth === 'ssh_key')
          assert.ok(
            result.known_hosts === knownHosts,
            'Blank private key must preserve known hosts',
          );
      }
    },
  );

  test(
    auth + ': serializer does not mutate form drafts or editing metadata',
    () => {
      const values = Object.freeze({ ...base, [field]: material, passphrase });
      const row = Object.freeze({ ...editing });
      serializeCredentialInput(values, row);
      assert.ok(values[field] === material, 'Form credential draft changed');
      assert.ok(
        values.passphrase === passphrase,
        'Form passphrase draft changed',
      );
      assert.deepEqual(row, editing);
    },
  );
}

test('SSH replacement includes only the current passphrase, including explicit removal', () => {
  const base = {
    ...metadata,
    auth_type: 'ssh_key',
    private_key: privateKey,
    known_hosts: knownHosts,
  };
  const editing = { id: 42, auth_type: 'ssh_key', has_secret: true };
  for (const phrase of [passphrase, '', undefined]) {
    const result = serializeCredentialInput(
      { ...base, passphrase: phrase },
      editing,
    );
    assert.equal(result.replace_secret, true);
    assert.ok(result.private_key === privateKey, 'SSH key must remain exact');
    assert.ok(
      result.passphrase === (phrase || ''),
      'Wrong replacement passphrase',
    );
  }
});

test('anonymous submissions exclude all secret fields while preserving public SSH host policy', () => {
  const result = serializeCredentialInput({
    ...metadata,
    auth_type: 'anonymous',
    token,
    private_key: privateKey,
    passphrase,
    known_hosts: knownHosts,
    replace_secret: true,
  });
  assert.equal(result.replace_secret, false);
  assert.ok(
    result.known_hosts === knownHosts,
    'Anonymous SSH must retain known hosts',
  );
  noSensitiveFields(result);
});

test('HTTPS submissions never forward SSH fields, stale actions, readback fields or unknown metadata', () => {
  const values = {
    ...metadata,
    auth_type: 'https_token',
    token,
    private_key: privateKey,
    passphrase,
    known_hosts: knownHosts,
    public_key: 'read-only-public-key',
    id: 99,
    has_secret: true,
    replace_secret: false,
    secret: { token },
    unexpected: passphrase,
  };
  const result = serializeCredentialInput(values);
  assert.deepEqual(
    keys(result),
    [...Object.keys(metadata), 'auth_type', 'replace_secret', 'token'].sort(),
  );
  assert.equal(result.replace_secret, true);
  assert.ok(result.token === token, 'Active token missing');
});

test('SSH submissions never forward stale token drafts and unrelated metadata', () => {
  const result = serializeCredentialInput({
    ...metadata,
    auth_type: 'ssh_key',
    private_key: privateKey,
    passphrase,
    known_hosts: knownHosts,
    token,
    replace_secret: false,
    public_key: 'read-only-public-key',
    id: 99,
    unexpected: token,
  });
  assert.deepEqual(
    keys(result),
    [
      ...Object.keys(metadata),
      'auth_type',
      'known_hosts',
      'replace_secret',
      'private_key',
      'passphrase',
    ].sort(),
  );
  assert.equal(result.replace_secret, true);
  assert.ok(result.private_key === privateKey, 'Active SSH draft missing');
});

test('serializer forwards nonempty invalid input verbatim for backend rejection', () => {
  for (const value of ['   ', 'line\nbreak', 'line\rbreak', 'nul\0byte']) {
    const result = serializeCredentialInput({
      ...metadata,
      auth_type: 'https_token',
      token: value,
    });
    assert.equal(result.replace_secret, true);
    assert.ok(
      result.token === value,
      'Serializer must not normalize credential material',
    );
  }
});

test('invalid or changed authentication type fails with a secret-free error', () => {
  for (const auth of [undefined, '', 'invalid', token])
    assert.throws(
      () =>
        serializeCredentialInput({
          ...metadata,
          auth_type: auth,
          token,
          private_key: privateKey,
          passphrase,
        }),
      (error) => {
        assert.equal(error.message, 'CREDENTIAL_AUTH_TYPE_INVALID');
        return true;
      },
    );
  for (const oldAuth of ['anonymous', 'https_token', 'ssh_key'])
    for (const newAuth of ['anonymous', 'https_token', 'ssh_key']) {
      if (oldAuth === newAuth) continue;
      assert.throws(
        () =>
          serializeCredentialInput(
            {
              ...metadata,
              auth_type: newAuth,
              token,
              private_key: privateKey,
              passphrase,
            },
            { id: 42, auth_type: oldAuth, has_secret: true },
          ),
        (error) => error.message === 'CREDENTIAL_AUTH_TYPE_INVALID',
      );
    }
});

test('credential form states and guidance have complete Chinese and English translations', () => {
  const names = [
    'accessToken',
    'privateKey',
    'passphrase',
    'keepExisting',
    'replaceHint',
    'configured',
    'notConfigured',
    'required',
    'replacing',
  ];
  for (const locale of ['zh-CN', 'en-US']) {
    const catalog = require('../../src/locales/' + locale + '.json');
    for (const name of names) {
      const key = 'credentials.form.' + name;
      assert.equal(
        typeof catalog[key],
        'string',
        'Missing credential locale: ' + locale + ':' + key,
      );
      assert.ok(
        catalog[key].length > 0,
        'Empty credential locale: ' + locale + ':' + key,
      );
      assert.notEqual(catalog[key], key);
      if (locale === 'en-US')
        assert.equal(/[\u4e00-\u9fff]/.test(catalog[key]), false);
    }
  }
});
