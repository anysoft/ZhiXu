const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, Transaction } = require('sequelize');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const load = require('../../test/helpers/load-security-module.cjs');
require('reflect-metadata');

// Only isolated SQLite and generated fixture keys are used here.
async function setup(t) {
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
    transactionType: Transaction.TYPES.IMMEDIATE,
  });
  t.after(() => sequelize.close());
  const cache = new Map();
  const mocks = { '.': { sequelize }, '../data': { sequelize } };
  const get = (file) => load('back/' + file + '.ts', mocks, cache);
  const { GitCredentialModel } = get('data/gitCredential');
  get('data/repository');
  await sequelize.sync();
  const secrets = new (get('services/credentialSecret').default)();
  const credentials = new (get('services/gitCredential').default)(
    secrets,
    new (get('services/gitCredentialResolver').default)(),
  );
  return { sequelize, get, GitCredentialModel, credentials, secrets };
}

const metadata = { name: 'Fixture', provider: 'generic' };
const tokenInput = {
  ...metadata,
  auth_type: 'https_token',
  replace_secret: true,
  token: 'fixture-token-original',
};

function noReadback(value, sensitive) {
  const raw = JSON.stringify(value);
  for (const secret of sensitive.filter(Boolean))
    assert.ok(!raw.includes(secret), 'RESPONSE_CONTAINS_SECRET');
  if (Array.isArray(value))
    value.forEach((item) => noReadback(item, sensitive));
  else if (value && typeof value === 'object')
    for (const field of ['secret', 'token', 'private_key', 'passphrase'])
      assert.ok(!Object.hasOwn(value, field), 'RESPONSE_HAS_SECRET_FIELD');
}

async function rejectsWithoutReadback(action, sensitive, message) {
  await assert.rejects(action, (error) => {
    for (const secret of sensitive.filter(Boolean))
      assert.ok(!String(error).includes(secret), 'ERROR_CONTAINS_SECRET');
    if (message) assert.match(error.message, message);
    return true;
  });
}

async function fixtureKey(t, passphrase) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'zhixu-credential-test-'),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'identity');
  execFileSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'fixture', '-f', file],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const private_key = await fs.readFile(file, 'utf8');
  const public_key = (await fs.readFile(file + '.pub', 'utf8'))
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  return { private_key, passphrase, public_key };
}

test('HTTPS create/keep/replace preserves secrets and excludes plaintext from metadata', async (t) => {
  const x = await setup(t);
  const created = await x.credentials.save(tokenInput);
  assert.equal(created.has_secret, true);
  const kept = await x.credentials.save({
    id: created.id,
    name: 'Renamed fixture',
    replace_secret: false,
  });
  assert.equal(kept.name, 'Renamed fixture');
  assert.ok(
    (await x.secrets.getCredentialSecret(created.id)).token ===
      tokenInput.token,
    'KEEP_CHANGED_TOKEN',
  );
  const replacement = 'fixture-token-replacement';
  const replaced = await x.credentials.save({
    id: created.id,
    replace_secret: true,
    token: replacement,
  });
  assert.ok(
    (await x.secrets.getCredentialSecret(created.id)).token === replacement,
    'REPLACE_DID_NOT_CHANGE_TOKEN',
  );
  for (const result of [
    created,
    kept,
    replaced,
    await x.credentials.detail(created.id),
    await x.credentials.list(),
  ])
    noReadback(result, [tokenInput.token, replacement]);
});

test('HTTPS empty and invalid control/whitespace tokens reject without storing or reflecting material', async (t) => {
  const x = await setup(t);
  for (const token of [
    undefined,
    '',
    ' ',
    '\t',
    'fixture\ninvalid',
    'fixture\rinvalid',
    'fixture\0invalid',
  ]) {
    await rejectsWithoutReadback(
      x.credentials.save({ ...tokenInput, token }),
      token && token.trim() ? [token] : [],
      /valid token/,
    );
    assert.equal(await x.GitCredentialModel.count(), 0);
  }
});

test('KEEP rejects authenticated records without saved secrets and passphrase-only updates', async (t) => {
  const x = await setup(t);
  for (const auth_type of ['https_token', 'ssh_key']) {
    const row = await x.GitCredentialModel.create({
      ...metadata,
      name: 'Missing secret ' + auth_type,
      auth_type,
      known_hosts: 'fixture.invalid ssh-ed25519 AAAATEST',
    });
    await rejectsWithoutReadback(
      x.credentials.save({ id: row.id, replace_secret: false }),
      [],
      /required/,
    );
    assert.equal((await x.credentials.detail(row.id)).has_secret, false);
  }
  const created = await x.credentials.save(tokenInput);
  await rejectsWithoutReadback(
    x.credentials.save({
      id: created.id,
      replace_secret: false,
      passphrase: 'fixture-passphrase-draft',
    }),
    ['fixture-passphrase-draft'],
    /replace secret/,
  );
  assert.ok(
    (await x.secrets.getCredentialSecret(created.id)).token ===
      tokenInput.token,
    'REJECTED_KEEP_CHANGED_SECRET',
  );
});

test('SSH keep preserves key/passphrase and allows public known_hosts updates', async (t) => {
  const x = await setup(t);
  const key = await fixtureKey(t, 'fixture-encrypted-passphrase');
  const known_hosts = 'fixture.invalid ' + key.public_key;
  const created = await x.credentials.save({
    ...metadata,
    auth_type: 'ssh_key',
    replace_secret: true,
    private_key: key.private_key,
    passphrase: key.passphrase,
    known_hosts,
  });
  assert.equal(created.public_key, key.public_key);
  const kept = await x.credentials.save({
    id: created.id,
    replace_secret: false,
  });
  assert.equal(kept.known_hosts, known_hosts);
  assert.equal(kept.public_key, key.public_key);
  assert.deepEqual(await x.secrets.getCredentialSecret(created.id), {
    private_key: key.private_key,
    passphrase: key.passphrase,
  });
  const updatedHosts = 'other.fixture.invalid ' + key.public_key;
  const changed = await x.credentials.save({
    id: created.id,
    replace_secret: false,
    known_hosts: updatedHosts,
  });
  assert.equal(changed.known_hosts, updatedHosts);
  await rejectsWithoutReadback(
    x.credentials.save({
      id: created.id,
      replace_secret: false,
      passphrase: 'fixture-passphrase-only-draft',
    }),
    ['fixture-passphrase-only-draft'],
    /replace secret/,
  );
  assert.ok(
    (await x.secrets.getCredentialSecret(created.id)).passphrase ===
      key.passphrase,
    'REJECTED_PASSPHRASE_ONLY_UPDATE_CHANGED_SECRET',
  );
  for (const result of [created, kept, changed, await x.credentials.list()])
    noReadback(result, [key.private_key, key.passphrase]);
});

test('SSH encrypted/plain replacements derive a new public key and invalid updates roll back', async (t) => {
  const x = await setup(t);
  const encrypted = await fixtureKey(t, 'fixture-original-password');
  const replacement = await fixtureKey(t, 'fixture-replacement-password');
  const plain = await fixtureKey(t, '');
  const created = await x.credentials.save({
    ...metadata,
    auth_type: 'ssh_key',
    replace_secret: true,
    private_key: encrypted.private_key,
    passphrase: encrypted.passphrase,
    known_hosts: 'fixture.invalid ' + encrypted.public_key,
  });
  const input = {
    id: created.id,
    replace_secret: true,
    private_key: replacement.private_key,
    passphrase: replacement.passphrase,
  };
  const replaced = await x.credentials.save(input);
  assert.equal(replaced.public_key, replacement.public_key);
  const before = await x.secrets.getCredentialSecret(created.id);
  await rejectsWithoutReadback(
    x.credentials.save({ ...input, passphrase: 'fixture-wrong-password' }),
    [replacement.private_key, 'fixture-wrong-password'],
    /Invalid SSH/,
  );
  await rejectsWithoutReadback(
    x.credentials.save({
      ...input,
      private_key: 'PRIVATE KEY fixture-invalid-key',
    }),
    ['PRIVATE KEY fixture-invalid-key', replacement.passphrase],
    /Invalid SSH/,
  );
  assert.deepEqual(await x.secrets.getCredentialSecret(created.id), before);
  assert.equal(
    (await x.credentials.detail(created.id)).public_key,
    replacement.public_key,
  );
  const unencrypted = await x.credentials.save({
    id: created.id,
    replace_secret: true,
    private_key: plain.private_key,
    passphrase: '',
  });
  assert.equal(unencrypted.public_key, plain.public_key);
  assert.deepEqual(await x.secrets.getCredentialSecret(created.id), {
    private_key: plain.private_key,
    passphrase: '',
  });
  const sensitive = [
    encrypted.private_key,
    encrypted.passphrase,
    replacement.private_key,
    replacement.passphrase,
    plain.private_key,
  ];
  for (const result of [
    created,
    replaced,
    unencrypted,
    await x.credentials.list(),
  ])
    noReadback(result, sensitive);
});

test('SSH creation requires a real private key and verified known_hosts', async (t) => {
  const x = await setup(t);
  const key = await fixtureKey(t, '');
  for (const input of [
    { known_hosts: 'fixture.invalid ' + key.public_key },
    { private_key: '', known_hosts: 'fixture.invalid ' + key.public_key },
    { private_key: key.private_key, known_hosts: '' },
    { private_key: key.private_key, known_hosts: ' ' },
  ])
    await rejectsWithoutReadback(
      x.credentials.save({
        ...metadata,
        auth_type: 'ssh_key',
        replace_secret: true,
        ...input,
      }),
      [key.private_key],
      /required/,
    );
  assert.equal(await x.GitCredentialModel.count(), 0);
});

test('anonymous creation and update never preserve secret material', async (t) => {
  const x = await setup(t);
  const created = await x.credentials.save(tokenInput);
  const anonymous = await x.credentials.save({
    id: created.id,
    auth_type: 'anonymous',
    replace_secret: false,
    token: 'fixture-unrelated-token',
    private_key: 'fixture-unrelated-private-key',
    passphrase: 'fixture-unrelated-passphrase',
    known_hosts: 'fixture.invalid ssh-ed25519 AAAATEST',
  });
  assert.equal(anonymous.has_secret, false);
  assert.deepEqual(await x.secrets.getCredentialSecret(created.id), {});
  assert.equal(anonymous.known_hosts, 'fixture.invalid ssh-ed25519 AAAATEST');
  const fresh = await x.credentials.save({
    ...metadata,
    name: 'Fresh anonymous',
    auth_type: 'anonymous',
    replace_secret: false,
  });
  assert.deepEqual(await x.secrets.getCredentialSecret(fresh.id), {});
  noReadback(await x.credentials.list(), [
    tokenInput.token,
    'fixture-unrelated-token',
    'fixture-unrelated-private-key',
    'fixture-unrelated-passphrase',
  ]);
});

test('real Git credential HTTP responses hide secrets and invalid input errors', async (t) => {
  const x = await setup(t);
  class Credentials {}
  class Repositories {}
  const register = load('back/api/gitResources.ts', {
    './scopedEnvironment': () => {},
    typedi: {
      Container: { get: (type) => (type === Credentials ? x.credentials : {}) },
    },
    '../services/gitCredential': Credentials,
    '../services/repository': Repositories,
  }).default;
  const app = express();
  app.use(express.json());
  register(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    noReadback(result, [tokenInput.token]);
    if (result.data) noReadback(result.data, [tokenInput.token]);
    return { status: response.status, body: result };
  };
  const created = await request('/git-credentials', 'POST', tokenInput);
  assert.equal(created.status, 200);
  assert.equal((await request('/git-credentials')).status, 200);
  assert.equal(
    (await request('/git-credentials/' + created.body.data.id)).status,
    200,
  );
  for (const token of ['fixture\ninvalid', 'fixture\0invalid']) {
    const rejected = await request('/git-credentials', 'POST', {
      ...tokenInput,
      token,
    });
    assert.equal(rejected.status, 400);
    noReadback(rejected.body, [token]);
  }
  const rejected = await request('/git-credentials', 'POST', {
    ...tokenInput,
    unexpected: tokenInput.token,
  });
  assert.equal(rejected.status, 400);
});
