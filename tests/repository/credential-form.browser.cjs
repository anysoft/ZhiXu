'use strict';
// Real browser against an owned fresh backend. All secret material is synthetic,
// created for this run, and never persisted in acceptance evidence.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { chooseSelect } = require('../../scripts/ci/browser-select.cjs');
const root = path.resolve(__dirname, '../..');
const { chromium } = require(path.join(
  process.env.QL_BROWSER_RUNTIME ||
    '/tmp/zhixu-notifications-browser-tools/node_modules',
  'playwright',
));
const evidenceDir =
  process.env.QL_ACCEPTANCE_DIR ||
  path.join(root, 'diagnostics/git-credential-ux');
const temp = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), 'zhixu-credential-browser-'),
);
fs.chmodSync(temp, 0o700);
fs.mkdirSync(evidenceDir, { recursive: true });
const evidence = {
  status: 'RUNNING',
  cases: [],
  browserErrors: [],
  cleanup: 'NOT_RUN',
};
const canary = 'credential-fixture-' + crypto.randomBytes(12).toString('hex');
const secretValues = [canary];
let backend,
  browser,
  browserServer,
  database,
  page,
  base,
  token = '',
  backendOutput = '',
  locale = 'zh-CN';
const consoleMessages = [];
const catalogs = {
  'zh-CN': require('../../src/locales/zh-CN.json'),
  'en-US': require('../../src/locales/en-US.json'),
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (key) => {
  assert.ok(catalogs[locale][key], 'MISSING_LOCALE_KEY:' + key);
  return catalogs[locale][key];
};
const buttonText = (key) =>
  new RegExp(
    '^' +
      text(key)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .split('')
        .join('\\s*') +
      '$',
  );
const redact = (value) =>
  secretValues.reduce(
    (s, secret) => s.replaceAll(secret, '[REDACTED]'),
    String(value),
  );
const modal = () =>
  page.getByRole('dialog').filter({ has: page.locator('#auth_type') });
const field = (name) => modal().locator('#' + name);
const digest = (value) =>
  crypto
    .createHash('sha256')
    .update(value || '')
    .digest('hex');
async function until(fn, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    await pause(150);
  }
  throw new Error('BROWSER_CONDITION_TIMEOUT');
}
async function port() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const value = server.address().port;
  await new Promise((r) => server.close(r));
  return value;
}
async function api(route, method = 'GET', body, expected = 200) {
  const response = await fetch(base + '/api' + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  assert.equal(value.code, expected, 'API_STATUS:' + method + ':' + route);
  if (route.startsWith('/git-credentials')) assertNoSecrets(value);
  return expected === 200 ? value.data : value;
}
function assertNoSecrets(value) {
  const raw = JSON.stringify(value);
  for (const secret of secretValues)
    assert.ok(!raw.includes(secret), 'SECRET_READBACK');
  if (Array.isArray(value)) value.forEach(assertNoSecrets);
  else if (value && typeof value === 'object') {
    for (const key of ['secret', 'token', 'private_key', 'passphrase'])
      assert.ok(!Object.hasOwn(value, key), 'SECRET_FIELD_RETURNED:' + key);
    Object.values(value).forEach((v) => {
      if (v && typeof v === 'object') assertNoSecrets(v);
    });
  }
}
async function dbGet(sql, params = []) {
  return new Promise((resolve, reject) =>
    database.get(sql, params, (error, row) =>
      error ? reject(error) : resolve(row),
    ),
  );
}
async function dbRun(sql, params = []) {
  return new Promise((resolve, reject) =>
    database.run(sql, params, (error) => (error ? reject(error) : resolve())),
  );
}
async function stored(id) {
  const row = await dbGet(
    'SELECT secret, known_hosts, public_key FROM GitCredentials WHERE id = ?',
    [id],
  );
  return { ...row, secret: JSON.parse(row.secret || '{}') };
}
async function open() {
  await page
    .getByRole('button', {
      name: buttonText('ui.createCredential'),
      exact: true,
    })
    .click();
  await modal().waitFor();
  assert.equal(
    await modal().getByRole('radio').count(),
    0,
    'SECRET_ACTION_RADIO_PRESENT',
  );
}
async function close() {
  await modal().locator('.ant-modal-close').click();
  await modal().waitFor({ state: 'hidden' });
}
async function edit(name) {
  await page
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('button', { name: buttonText('ui.edit'), exact: true })
    .click();
  await modal().waitFor();
  assert.ok(await field('auth_type').isDisabled(), 'EDIT_AUTH_TYPE_CHANGEABLE');
  assert.equal(await modal().getByRole('radio').count(), 0);
}
async function auth(value) {
  await chooseSelect(page, modal(), text('ui.authenticationMethod'), value);
  await modal().locator('.ant-modal-title').click();
}
async function name(value) {
  await field('name').fill(value);
}
async function clickSave() {
  await modal().locator('.ant-modal-footer .ant-btn-primary').click();
}
async function save(expected = 200) {
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/git-credentials' &&
      ['POST', 'PUT'].includes(r.request().method()),
  );
  await clickSave();
  const r = await response;
  const sent = r.request().postDataJSON();
  const value = await r.json();
  assert.equal(value.code, expected, 'FORM_SAVE_STATUS');
  assertNoSecrets(value);
  if (expected === 200) await modal().waitFor({ state: 'hidden' });
  return { sent, data: value.data };
}
async function required(name) {
  let requests = 0;
  const observe = (request) => {
    if (
      new URL(request.url()).pathname === '/api/git-credentials' &&
      ['POST', 'PUT'].includes(request.method())
    )
      requests++;
  };
  page.on('request', observe);
  try {
    await clickSave();
    await field(name)
      .locator(
        'xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," ant-form-item ")]',
      )
      .getByText(text('credentials.form.required'), { exact: true })
      .waitFor();
    assert.equal(requests, 0, 'REQUIRED_FIELD_SUBMITTED');
  } finally {
    page.off('request', observe);
  }
}
function noFields(sent, keys) {
  for (const key of keys)
    assert.ok(!Object.hasOwn(sent, key), 'INACTIVE_REQUEST_FIELD:' + key);
}
function fixtureKey(file, passphrase) {
  execFileSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    passphrase,
    '-C',
    'credential-browser-fixture',
    '-f',
    file,
  ]);
  const key = fs.readFileSync(file, 'utf8');
  secretValues.push(key);
  return key;
}
(async () => {
  for (const folder of ['shell', 'sample'])
    fs.cpSync(path.join(root, folder), path.join(temp, folder), {
      recursive: true,
    });
  fs.copyFileSync(
    path.join(root, 'version.yaml'),
    path.join(temp, 'version.yaml'),
  );
  fs.symlinkSync(
    path.join(root, 'node_modules'),
    path.join(temp, 'node_modules'),
  );
  fs.mkdirSync(path.join(temp, 'back'));
  fs.symlinkSync(
    path.join(root, 'back/protos'),
    path.join(temp, 'back/protos'),
  );
  fs.mkdirSync(path.join(temp, 'static'));
  for (const folder of ['build', 'dist'])
    fs.symlinkSync(
      path.join(root, 'static', folder),
      path.join(temp, 'static', folder),
    );
  fs.mkdirSync(path.join(temp, 'home'));
  const jwt = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(temp, '.env'), 'JWT_SECRET=' + jwt + '\n', {
    mode: 0o600,
  });
  const httpPort = await port(),
    grpcPort = await port();
  base = 'http://127.0.0.1:' + httpPort;
  backend = spawn(process.execPath, [path.join(root, 'static/build/app.js')], {
    cwd: root,
    env: {
      ...process.env,
      QL_DIR: temp,
      QL_DATA_DIR: path.join(temp, 'data'),
      HOME: path.join(temp, 'home'),
      JWT_SECRET: jwt,
      BACK_PORT: String(httpPort),
      GRPC_PORT: String(grpcPort),
      BIND_HOST: '127.0.0.1',
      BIND_HOST_GRPC: '127.0.0.1',
      NODE_ENV: 'production',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (b) => {
    backendOutput += b;
  });
  backend.stderr.on('data', (b) => {
    backendOutput += b;
  });
  await until(
    async () => (await (await fetch(base + '/api/system')).json()).code === 200,
  );
  const password = crypto.randomBytes(24).toString('hex');
  await api('/user/init', 'PUT', {
    username: 'credential-form-owner',
    password,
  });
  token = (
    await api('/user/login', 'POST', {
      username: 'credential-form-owner',
      password,
    })
  ).token;
  database = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      path.join(temp, 'data/db/database.sqlite'),
      (error) => (error ? reject(error) : resolve(db)),
    );
  });
  database.configure('busyTimeout', 10000);
  const passphrase = canary + '-passphrase';
  secretValues.push(passphrase);
  const privateKey = fixtureKey(path.join(temp, 'encrypted-key'), passphrase);
  const replacementKey = fixtureKey(path.join(temp, 'replacement-key'), '');
  const knownHosts =
    'credential-validation.invalid ' +
    fs.readFileSync(path.join(temp, 'replacement-key.pub'), 'utf8').trim();
  const originalToken = canary + '-original-token',
    replacementToken = canary + '-replacement-token';
  secretValues.push(originalToken, replacementToken);
  browserServer = await chromium.launchServer({
    headless: true,
    ...(process.env.QL_BROWSER_EXECUTABLE
      ? { executablePath: process.env.QL_BROWSER_EXECUTABLE }
      : process.platform === 'darwin'
      ? { channel: 'chrome' }
      : {}),
  });
  browser = await chromium.connect(browserServer.wsEndpoint());
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1100 },
  });
  await context.addInitScript(
    ({ token, locale }) => {
      localStorage.setItem('token', token);
      if (!localStorage.getItem('zhixu.language'))
        localStorage.setItem('zhixu.language', locale);
    },
    { token, locale },
  );
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) =>
    evidence.browserErrors.push(redact(error.name + ':' + error.message)),
  );
  page.on('console', (message) => consoleMessages.push(message.text()));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['http:', 'https:'].includes(url.protocol) && url.origin !== base
      ? route.abort()
      : route.continue();
  });
  await page.goto(base + '/repository');
  await page
    .getByRole('tab', { name: text('ui.credentials'), exact: true })
    .click();
  await page
    .getByRole('button', {
      name: buttonText('ui.createCredential'),
      exact: true,
    })
    .waitFor();
  await open();
  await auth('https_token');
  await field('token').waitFor();
  assert.equal(
    await field('token').getAttribute('autocomplete'),
    'new-password',
  );
  await name('Browser HTTPS');
  await required('token');
  await field('token').fill(originalToken);
  let saved = await save();
  const tokenId = saved.data.id;
  assert.equal(saved.sent.replace_secret, true);
  assert.ok(saved.sent.token === originalToken, 'TOKEN_CREATE_MISMATCH');
  noFields(saved.sent, ['private_key', 'passphrase', 'known_hosts']);
  assert.ok(
    (await stored(tokenId)).secret.token === originalToken,
    'TOKEN_NOT_STORED',
  );
  evidence.cases.push('https-create-direct-input-required-and-no-radio');
  await edit('Browser HTTPS');
  assert.equal(await field('token').inputValue(), '');
  await modal()
    .getByText(text('credentials.form.configured'), { exact: true })
    .waitFor();
  saved = await save();
  assert.equal(saved.sent.replace_secret, false);
  noFields(saved.sent, ['token', 'private_key', 'passphrase']);
  assert.ok(
    (await stored(tokenId)).secret.token === originalToken,
    'BLANK_EDIT_REPLACED_TOKEN',
  );
  evidence.cases.push('https-blank-edit-keeps-original-secret');
  await edit('Browser HTTPS');
  await field('token').fill(replacementToken);
  saved = await save();
  assert.equal(saved.sent.replace_secret, true);
  assert.ok(
    (await stored(tokenId)).secret.token === replacementToken,
    'TOKEN_REPLACE_MISMATCH',
  );
  evidence.cases.push('https-input-automatically-replaces-secret');
  await open();
  await auth('ssh_key');
  await field('private_key').waitFor();
  await field('passphrase').waitFor();
  await field('known_hosts').waitFor();
  await name('Browser SSH');
  await field('known_hosts').fill(knownHosts);
  await required('private_key');
  await field('private_key').fill(privateKey);
  await field('passphrase').fill(passphrase);
  saved = await save();
  const sshId = saved.data.id;
  assert.equal(saved.sent.replace_secret, true);
  noFields(saved.sent, ['token']);
  assert.ok(
    saved.data.public_key.startsWith('ssh-ed25519 '),
    'SSH_PUBLIC_KEY_NOT_DERIVED',
  );
  const originalState = await stored(sshId);
  assert.ok(
    digest(originalState.secret.private_key) === digest(privateKey),
    'SSH_CREATE_KEY_MISMATCH',
  );
  assert.ok(
    originalState.secret.passphrase === passphrase,
    'SSH_CREATE_PASSPHRASE_MISMATCH',
  );
  evidence.cases.push(
    'ssh-create-direct-fields-required-encrypted-key-public-derivation',
  );
  await edit('Browser SSH');
  assert.equal(await field('private_key').inputValue(), '');
  assert.equal(
    await field('passphrase').count(),
    0,
    'PASSPHRASE_VISIBLE_WITHOUT_NEW_KEY',
  );
  assert.equal(await field('known_hosts').inputValue(), knownHosts);
  const publicField = modal().locator('textarea[readonly]');
  assert.ok(await publicField.isVisible(), 'SSH_PUBLIC_KEY_NOT_SHOWN');
  assert.ok(
    (await publicField.getAttribute('readonly')) !== null,
    'SSH_PUBLIC_KEY_EDITABLE',
  );
  saved = await save();
  assert.equal(saved.sent.replace_secret, false);
  noFields(saved.sent, ['token', 'private_key', 'passphrase']);
  let state = await stored(sshId);
  assert.ok(
    digest(state.secret.private_key) === digest(privateKey),
    'SSH_KEEP_KEY_CHANGED',
  );
  assert.ok(
    state.secret.passphrase === passphrase,
    'SSH_KEEP_PASSPHRASE_CHANGED',
  );
  assert.equal(state.known_hosts, knownHosts);
  evidence.cases.push('ssh-blank-edit-keeps-key-passphrase-and-known-hosts');
  await edit('Browser SSH');
  await field('known_hosts').fill(
    knownHosts + '\n# independently edited host config',
  );
  saved = await save();
  assert.equal(saved.sent.replace_secret, false);
  assert.equal(
    (await stored(sshId)).known_hosts,
    knownHosts + '\n# independently edited host config',
  );
  evidence.cases.push('known-hosts-edits-save-without-private-key-replacement');
  await edit('Browser SSH');
  await field('private_key').fill(privateKey);
  await field('passphrase').fill(canary + '-abandoned-passphrase');
  await field('private_key').fill('');
  assert.equal(await field('passphrase').count(), 0);
  saved = await save();
  noFields(saved.sent, ['private_key', 'passphrase']);
  assert.ok(
    (await stored(sshId)).secret.passphrase === passphrase,
    'PASSPHRASE_DRAFT_OVERWROTE_KEEP',
  );
  evidence.cases.push('clearing-private-key-discards-passphrase-draft');
  await edit('Browser SSH');
  await field('private_key').fill(privateKey);
  await field('passphrase').fill(passphrase);
  saved = await save();
  assert.equal(saved.sent.replace_secret, true);
  assert.ok(
    (await stored(sshId)).secret.passphrase === passphrase,
    'ENCRYPTED_KEY_REPLACE_FAILED',
  );
  evidence.cases.push('ssh-new-encrypted-key-and-passphrase-replacement');
  await edit('Browser SSH');
  await field('private_key').fill(replacementKey);
  await field('passphrase').waitFor();
  assert.equal(await field('passphrase').inputValue(), '');
  saved = await save();
  assert.equal(saved.sent.replace_secret, true);
  state = await stored(sshId);
  assert.ok(
    digest(state.secret.private_key) === digest(replacementKey),
    'SSH_REPLACEMENT_KEY_MISMATCH',
  );
  assert.ok(!state.secret.passphrase, 'SSH_OLD_PASSPHRASE_RETAINED_ON_NEW_KEY');
  assert.equal(
    state.public_key,
    fs
      .readFileSync(path.join(temp, 'replacement-key.pub'), 'utf8')
      .split(/\s+/)
      .slice(0, 2)
      .join(' '),
  );
  evidence.cases.push(
    'ssh-new-unencrypted-key-clears-old-passphrase-and-rederives-public-key',
  );
  await open();
  await auth('https_token');
  await field('token').fill(canary + '-abandoned-token');
  await auth('ssh_key');
  assert.equal(await field('token').count(), 0);
  await field('private_key').fill(replacementKey);
  await field('passphrase').fill(canary + '-abandoned-ssh-passphrase');
  await field('known_hosts').fill(knownHosts);
  await auth('https_token');
  assert.equal(await field('token').inputValue(), '');
  for (const key of ['private_key', 'passphrase', 'known_hosts'])
    assert.equal(await field(key).count(), 0);
  await auth('ssh_key');
  assert.equal(await field('private_key').inputValue(), '');
  assert.equal(await field('passphrase').inputValue(), '');
  assert.equal(await field('known_hosts').inputValue(), '');
  await field('private_key').fill(replacementKey);
  await field('known_hosts').fill(knownHosts);
  await name('Browser switched SSH');
  saved = await save();
  noFields(saved.sent, ['token']);
  evidence.cases.push(
    'https-ssh-switch-clears-sensitive-drafts-and-inactive-fields',
  );
  await open();
  await auth('ssh_key');
  await field('private_key').fill(privateKey);
  await field('passphrase').fill(passphrase);
  await field('known_hosts').fill(knownHosts);
  await auth('https_token');
  await name('Browser switched HTTPS');
  await field('token').fill(originalToken);
  saved = await save();
  noFields(saved.sent, ['private_key', 'passphrase', 'known_hosts']);
  evidence.cases.push('ssh-https-submit-excludes-all-ssh-fields');
  await open();
  await auth('https_token');
  await field('token').fill(canary + '-cancelled-token');
  await close();
  await open();
  await auth('https_token');
  assert.equal(await field('token').inputValue(), '');
  await auth('ssh_key');
  await field('private_key').fill(privateKey);
  await field('passphrase').fill(passphrase);
  await close();
  await open();
  await auth('ssh_key');
  assert.equal(await field('private_key').inputValue(), '');
  assert.equal(await field('passphrase').inputValue(), '');
  await auth('anonymous');
  for (const key of ['token', 'private_key', 'passphrase'])
    assert.equal(await field(key).count(), 0);
  await name('Browser anonymous');
  saved = await save();
  noFields(saved.sent, ['token', 'private_key', 'passphrase']);
  assert.equal(saved.sent.replace_secret, false);
  assert.deepEqual((await stored(saved.data.id)).secret, {});
  evidence.cases.push(
    'cancel-reopen-clears-drafts-and-anonymous-has-no-secrets',
  );
  // A deliberately damaged owned fixture represents metadata with no stored secret.
  await dbRun('UPDATE GitCredentials SET secret = NULL WHERE id = ?', [
    tokenId,
  ]);
  await page.reload();
  await page
    .getByRole('tab', { name: text('ui.credentials'), exact: true })
    .click();
  await edit('Browser HTTPS');
  await modal()
    .getByText(text('credentials.form.notConfigured'), { exact: true })
    .waitFor();
  await required('token');
  await field('token').fill(originalToken);
  saved = await save();
  assert.equal(saved.sent.replace_secret, true);
  assert.ok(
    (await stored(tokenId)).secret.token === originalToken,
    'MISSING_TOKEN_NOT_SET',
  );
  evidence.cases.push('edit-missing-secret-requires-and-sets-new-value');
  await open();
  await auth('https_token');
  await name('Locale draft');
  await required('token');
  const second = await context.newPage();
  await second.goto(base + '/login');
  for (const next of ['en-US', 'zh-CN']) {
    await second.evaluate(
      (next) => localStorage.setItem('zhixu.language', next),
      next,
    );
    locale = next;
    await modal()
      .getByLabel(text('credentials.form.accessToken'), { exact: true })
      .waitFor();
    await field('token')
      .locator(
        'xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," ant-form-item ")]',
      )
      .getByText(text('credentials.form.required'), { exact: true })
      .waitFor();
    assert.equal(await field('name').inputValue(), 'Locale draft');
  }
  await field('token').fill(canary + '-locale-draft');
  for (const next of ['en-US', 'zh-CN']) {
    await second.evaluate(
      (next) => localStorage.setItem('zhixu.language', next),
      next,
    );
    locale = next;
    await modal()
      .getByLabel(text('credentials.form.accessToken'), { exact: true })
      .waitFor();
    assert.ok(
      (await field('token').inputValue()) === canary + '-locale-draft',
      'LOCALE_CHANGE_LOST_SECRET_DRAFT',
    );
  }
  await second.close();
  await close();
  evidence.cases.push(
    'live-zh-en-locale-updates-labels-validation-and-preserves-drafts',
  );
  for (const next of ['en-US', 'zh-CN']) {
    locale = next;
    await page.evaluate(
      (next) => localStorage.setItem('zhixu.language', next),
      next,
    );
    await page.reload();
    await page
      .getByRole('tab', { name: text('ui.credentials'), exact: true })
      .click();
    await edit('Browser SSH');
    assert.equal(await field('private_key').inputValue(), '');
    await modal().locator('.ant-modal-content').waitFor({ state: 'visible' });
    await modal().locator('.ant-modal-title').click();
    await page.screenshot({
      path: path.join(evidenceDir, 'credential-form-' + next + '.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await close();
  }
  for (const id of [tokenId, sshId])
    assertNoSecrets(await api('/git-credentials/' + id));
  assertNoSecrets(await api('/git-credentials'));
  for (const invalidToken of [
    '   ',
    canary + '\ninvalid',
    canary + '\rinvalid',
    canary + '\0invalid',
  ])
    await api(
      '/git-credentials',
      'POST',
      {
        name: 'Rejected fixture',
        provider: 'generic',
        auth_type: 'https_token',
        token: invalidToken,
        replace_secret: true,
      },
      400,
    );
  await api(
    '/git-credentials',
    'PUT',
    {
      id: sshId,
      replace_secret: true,
      private_key:
        '-----BEGIN PRIVATE KEY-----\n' +
        canary +
        '\n-----END PRIVATE KEY-----',
      passphrase,
    },
    400,
  );
  state = await stored(sshId);
  assert.ok(
    digest(state.secret.private_key) === digest(replacementKey),
    'FAILED_SSH_VALIDATION_MUTATED_SECRET',
  );
  evidence.cases.push(
    'list-detail-save-error-no-secret-readback-and-invalid-input-rollback',
  );
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  for (const secret of secretValues) {
    assert.ok(!storage.includes(secret), 'SECRET_IN_BROWSER_STORAGE');
    assert.ok(
      !consoleMessages.some((line) => line.includes(secret)),
      'SECRET_IN_BROWSER_CONSOLE',
    );
    assert.ok(!backendOutput.includes(secret), 'SECRET_IN_BACKEND_LOG');
  }
  assert.deepEqual(evidence.browserErrors, []);
  evidence.cases.push(
    'no-secret-leakage-in-storage-console-backend-logs-or-pageerrors',
  );
  evidence.status = 'PASS';
})()
  .catch((error) => {
    evidence.status = 'FAIL';
    evidence.error = redact(error.stack || error);
    console.error(evidence.error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const cleanupErrors = [];
    if (database)
      await new Promise((resolve) =>
        database.close((error) => {
          if (error) cleanupErrors.push('FIXTURE_DATABASE_CLOSE_FAILED');
          resolve();
        }),
      );
    if (backend) {
      const alive = () => {
        try {
          process.kill(-backend.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        process.kill(-backend.pid, 'SIGTERM');
      } catch {}
      for (let i = 0; i < 50 && alive(); i++) await pause(100);
      if (alive()) {
        try {
          process.kill(-backend.pid, 'SIGKILL');
        } catch {}
      }
      for (let i = 0; i < 20 && alive(); i++) await pause(100);
      if (alive()) cleanupErrors.push('OWNED_BACKEND_STILL_RUNNING');
    }
    if (browser) {
      await Promise.race([
        browser.close().then(
          () => true,
          () => false,
        ),
        pause(5000).then(() => false),
      ]);
    }
    if (browserServer) {
      // Keep the public BrowserServer process handle: client shutdown can hang
      // during WebSocket reconnects, so always reap the owned Chrome process.
      const child = browserServer.process();
      const exited = () => child.exitCode !== null || child.signalCode !== null;
      await Promise.race([browserServer.close().catch(() => {}), pause(5000)]);
      if (!exited())
        await Promise.race([browserServer.kill().catch(() => {}), pause(5000)]);
      for (let i = 0; i < 20 && !exited(); i++) await pause(100);
      if (!exited()) cleanupErrors.push('OWNED_BROWSER_STILL_RUNNING');
    }
    if (evidence.status !== 'PASS')
      evidence.backendLastLines = redact(backendOutput).split('\n').slice(-10);
    if (!cleanupErrors.length)
      fs.rmSync(temp, { recursive: true, force: true });
    evidence.cleanup = cleanupErrors.length ? 'FAIL' : 'PASS';
    if (cleanupErrors.length) {
      evidence.status = 'FAIL';
      evidence.cleanupErrors = cleanupErrors;
      process.exitCode = 1;
    }
    fs.writeFileSync(
      path.join(evidenceDir, 'browser.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    console.log(
      'GIT_CREDENTIAL_BROWSER_' + evidence.status,
      evidence.cases.length,
      'cases',
    );
  });
