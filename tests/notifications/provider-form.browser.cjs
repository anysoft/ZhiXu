'use strict';
// Real browser + real isolated backend. All provider credentials are synthetic;
// the only delivery target is an owned loopback receiver.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const net = require('node:net'),
  http = require('node:http'),
  crypto = require('node:crypto');
const assert = require('node:assert/strict'),
  { spawn } = require('node:child_process');
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const {
  providerSchemas,
  getProviderDefaults,
  isProviderFieldVisible,
  serializeProviderConfig,
} = require('../../src/features/notifications/providerSchemas.ts');
const { chooseSelect } = require('../../scripts/ci/browser-select.cjs');
const root = path.resolve(__dirname, '../..');
const runtime =
  process.env.QL_BROWSER_RUNTIME ||
  '/tmp/zhixu-notifications-browser-tools/node_modules';
const { chromium } = require(path.join(runtime, 'playwright'));
const evidenceDir =
  process.env.QL_ACCEPTANCE_DIR ||
  path.join(root, 'diagnostics/notifications/browser');
const temp = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), 'zhixu-provider-form-'),
);
fs.chmodSync(temp, 0o700);
fs.mkdirSync(evidenceDir, { recursive: true });
const evidence = {
  status: 'RUNNING',
  providerCases: [],
  cases: [],
  browserErrors: [],
  cleanup: 'NOT_RUN',
};
const canary = 'notification-fixture-' + crypto.randomBytes(12).toString('hex');
let backend,
  browser,
  receiver,
  backendOutput = '',
  token = '',
  page,
  base,
  locale = 'zh-CN';
const catalogs = {
  'zh-CN': require('../../src/locales/zh-CN.json'),
  'en-US': require('../../src/locales/en-US.json'),
};
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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await pause(150);
  }
  throw last || Error('BROWSER_CONDITION_TIMEOUT');
}
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function api(route, method = 'GET', body) {
  const r = await fetch(base + '/api' + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  assert.equal(
    data.code,
    200,
    'API_FAILED:' + method + ':' + route + ':' + data.error_code,
  );
  return data.data;
}
const modal = () =>
  page.getByRole('dialog').filter({ has: page.getByTestId('provider-select') });
async function open() {
  await page
    .getByRole('button', { name: buttonText('ui.addChannel'), exact: true })
    .click();
  await modal().waitFor();
}
async function close() {
  await modal()
    .getByRole('button', {
      name: buttonText('notifications.form.cancel'),
      exact: true,
    })
    .click();
  await modal().waitFor({ state: 'hidden' });
}
async function selectProvider(id) {
  // Search also exercises friendly labels and avoids relying on virtual-list position.
  await modal()
    .getByTestId('provider-select')
    .getByRole('combobox')
    .fill(text(providerSchemas[id].labelKey));
  await chooseSelect(
    page,
    modal(),
    text('ui.provider'),
    text(providerSchemas[id].labelKey),
  );
  await modal().getByTestId('provider-config').waitFor();
  await modal().locator('.ant-modal-title').click();
}
async function prepareScreenshot() {
  const input = modal().getByTestId('provider-select').getByRole('combobox');
  if ((await input.getAttribute('aria-expanded')) === 'true')
    await input.press('Escape');
  await input.evaluate((element) => element.blur());
  await modal().locator('.ant-modal-title').click();
  await until(
    async () =>
      (await page
        .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
        .count()) === 0,
    10,
  );
  assert.equal(
    await page.locator('.ant-select-dropdown:visible').count(),
    0,
    'SCREENSHOT_DROPDOWN_STILL_VISIBLE',
  );
}
async function action(value) {
  await chooseSelect(
    page,
    modal(),
    text('notifications.form.action'),
    text(
      'notifications.form.' +
        { KEEP: 'keep', REPLACE: 'replace', DELETE: 'delete' }[value],
    ),
  );
}
async function expand() {
  const panel = modal()
    .locator('.ant-collapse-header')
    .filter({ hasText: text('notifications.form.advanced') });
  if (
    (await panel.count()) &&
    (await panel.getAttribute('aria-expanded')) !== 'true'
  )
    await panel.click();
}
function fixture(id) {
  const values = getProviderDefaults(id);
  for (const field of providerSchemas[id].fields) {
    if (!isProviderFieldVisible(field, values)) continue;
    if (Object.hasOwn(values, field.name)) continue;
    values[field.name] =
      field.type === 'select'
        ? field.options[0].value
        : field.type === 'number'
        ? 2
        : field.type === 'boolean'
        ? false
        : field.type === 'url'
        ? receiverUrl + '/' + canary + '/' + field.name
        : field.type === 'keyValue'
        ? [{ key: 'X-Provider-Fixture', value: canary + '-header' }]
        : canary + '-' + field.name;
  }
  Object.assign(values, {
    ...(id === 'telegramBot' ? { telegramBotProxyPort: '8080' } : {}),
    ...(id === 'email'
      ? {
          emailService: 'Gmail',
          emailUser: 'fixture@example.invalid',
          emailPass: canary + '-email',
        }
      : {}),
    ...(id === 'weWorkApp'
      ? {
          corpId: 'fixture-corp',
          corpSecret: canary + '-corp',
          toUser: '@all',
          agentId: '1001',
          messageType: 'text',
        }
      : {}),
    ...(id === 'wxPusherBot'
      ? { wxPusherBotTopicIds: '123', wxPusherBotUids: 'UID_fixture' }
      : {}),
    ...(id === 'chronocat' ? { chronocatQQ: 'user_id=123' } : {}),
    ...(id === 'goCqHttpBot' ? { goCqHttpBotQq: 'user_id=123' } : {}),
    ...(id === 'webhook'
      ? { webhookBody: '{"title":"$title","content":"$content"}' }
      : {}),
  });
  return values;
}
async function fillField(field, value) {
  const item = modal().getByTestId('provider-field-' + field.name);
  await item.waitFor({ state: 'visible' });
  if (field.type === 'select')
    await chooseSelect(
      page,
      modal(),
      text(field.labelKey),
      text(field.options.find((v) => v.value === value).labelKey),
    );
  else if (field.type === 'boolean')
    await item.getByRole('switch').setChecked(Boolean(value));
  else if (field.type === 'keyValue') {
    for (const row of value) {
      await item
        .getByRole('button', {
          name: buttonText('notifications.form.addPair'),
          exact: true,
        })
        .click();
      await item
        .getByLabel(text('notifications.form.pairKey'), { exact: true })
        .last()
        .fill(row.key);
      await item
        .getByLabel(text('notifications.form.pairValue'), { exact: true })
        .last()
        .fill(row.value);
    }
  } else
    await item
      .locator('input:not([type=hidden]), textarea')
      .first()
      .fill(String(value));
}
async function fillProvider(id, values) {
  await expand();
  for (const field of providerSchemas[id].fields)
    if (
      isProviderFieldVisible(field, values) &&
      Object.hasOwn(values, field.name)
    )
      await fillField(field, values[field.name]);
}
async function basic(name) {
  await modal().getByLabel(text('ui.name'), { exact: true }).fill(name);
  for (const key of ['ui.enabled', 'ui.defaultChannel'])
    await modal().getByLabel(text(key), { exact: true }).setChecked(false);
}
async function save() {
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.startsWith('/api/notification-channels') &&
      ['POST', 'PATCH'].includes(r.request().method()),
  );
  await modal()
    .getByRole('button', {
      name: buttonText('notifications.form.save'),
      exact: true,
    })
    .click();
  const r = await response,
    sent = r.request().postDataJSON(),
    data = await r.json();
  assert.equal(data.code, 200, 'FORM_SAVE_FAILED:' + data.error_code);
  await modal().waitFor({ state: 'hidden' });
  return { sent, data: data.data };
}
async function edit(name) {
  await page
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('button', { name: buttonText('ui.edit'), exact: true })
    .click();
  await modal().waitFor();
}
function assertNoSecret(value) {
  const raw = JSON.stringify(value);
  assert.ok(!raw.includes(canary), 'SECRET_READBACK');
  if (Array.isArray(value)) value.forEach(assertNoSecret);
  else if (value && typeof value === 'object')
    assert.equal(
      Object.hasOwn(value, 'secret'),
      false,
      'SECRET_PROPERTY_RETURNED',
    );
}
let receiverUrl;
const deliveries = [];
(async () => {
  for (const name of ['shell', 'sample'])
    fs.cpSync(path.join(root, name), path.join(temp, name), {
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
  for (const name of ['build', 'dist'])
    fs.symlinkSync(
      path.join(root, 'static', name),
      path.join(temp, 'static', name),
    );
  fs.mkdirSync(path.join(temp, 'home'));
  const jwt = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(temp, '.env'), 'JWT_SECRET=' + jwt + '\n', {
    mode: 0o600,
  });
  receiver = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    deliveries.push({ headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = 'http://127.0.0.1:' + receiver.address().port;
  const httpPort = await port(),
    grpc = await port();
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
      GRPC_PORT: String(grpc),
      BIND_HOST: '127.0.0.1',
      BIND_HOST_GRPC: '127.0.0.1',
      NODE_ENV: 'production',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (b) => (backendOutput += b));
  backend.stderr.on('data', (b) => (backendOutput += b));
  await until(async () => {
    const r = await fetch(base + '/api/system');
    return (await r.json()).code === 200;
  });
  const password = crypto.randomBytes(24).toString('hex');
  await api('/user/init', 'PUT', { username: 'provider-form-owner', password });
  token = (
    await api('/user/login', 'POST', {
      username: 'provider-form-owner',
      password,
    })
  ).token;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.QL_BROWSER_EXECUTABLE
      ? { executablePath: process.env.QL_BROWSER_EXECUTABLE }
      : process.platform === 'darwin'
      ? { channel: 'chrome' }
      : {}),
  });
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1100 },
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  await context.addInitScript(
    ({ token, locale }) => {
      localStorage.setItem('token', token);
      if (!localStorage.getItem('zhixu.language'))
        localStorage.setItem('zhixu.language', locale);
    },
    { token, locale },
  );
  page.on('pageerror', (e) =>
    evidence.browserErrors.push(
      e.name + ':' + e.message.replaceAll(canary, '[REDACTED]'),
    ),
  );
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['http:', 'https:'].includes(url.protocol) && url.origin !== base
      ? route.abort()
      : route.continue();
  });
  await page.goto(base + '/notifications');
  await page
    .getByRole('button', { name: buttonText('ui.addChannel'), exact: true })
    .waitFor();
  const ids = await api('/notification-providers');
  assert.equal(ids.length, 25);
  assert.deepEqual([...ids].sort(), Object.keys(providerSchemas).sort());
  for (const id of ids) {
    await open();
    await selectProvider(id);
    await basic('Provider coverage ' + id);
    await expand();
    const before = getProviderDefaults(id);
    for (const field of providerSchemas[id].fields)
      if (isProviderFieldVisible(field, before))
        assert.equal(
          await modal()
            .getByTestId('provider-field-' + field.name)
            .count(),
          1,
          'MISSING_RENDERED_FIELD:' + id + ':' + field.name,
        );
    await modal()
      .getByRole('button', {
        name: buttonText('notifications.form.save'),
        exact: true,
      })
      .click();
    await modal().locator('.ant-form-item-explain-error').first().waitFor();
    const values = fixture(id);
    await fillProvider(id, values);
    if (id === 'wxPusherBot') {
      // Delimiters alone must not count as a recipient, and validation must
      // prevent the request before the existing backend contract is invoked.
      let invalidRequestSent = false;
      const observeSave = (request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/notification-channels'
        )
          invalidRequestSent = true;
      };
      page.on('request', observeSave);
      try {
        const fields = providerSchemas.wxPusherBot.fields;
        await fillField(
          fields.find((field) => field.name === 'wxPusherBotTopicIds'),
          ';;',
        );
        await fillField(
          fields.find((field) => field.name === 'wxPusherBotUids'),
          '',
        );
        await modal()
          .getByRole('button', {
            name: buttonText('notifications.form.save'),
            exact: true,
          })
          .click();
        await modal()
          .getByTestId('provider-field-wxPusherBotTopicIds')
          .locator('.ant-form-item-explain-error')
          .waitFor();
        assert.equal(
          invalidRequestSent,
          false,
          'SEPARATOR_ONLY_RECIPIENTS_SAVED',
        );
        await fillField(
          fields.find((field) => field.name === 'wxPusherBotTopicIds'),
          values.wxPusherBotTopicIds,
        );
        await fillField(
          fields.find((field) => field.name === 'wxPusherBotUids'),
          values.wxPusherBotUids,
        );
      } finally {
        page.off('request', observeSave);
      }
    }
    const saved = await save();
    assert.equal(saved.sent.secret_action, 'REPLACE');
    assert.deepEqual(
      saved.sent.secret,
      serializeProviderConfig(id, values),
      'SERIALIZATION_DRIFT:' + id,
    );
    assertNoSecret(saved.data);
    assertNoSecret(await api('/notification-channels/' + saved.data.id));
    evidence.providerCases.push({
      id,
      renderedFields: providerSchemas[id].fields
        .filter((f) => isProviderFieldVisible(f, values))
        .map((f) => f.name),
      requiredValidation: 'PASS',
      ...(id === 'wxPusherBot'
        ? { separatorOnlyRecipientsValidation: 'PASS' }
        : {}),
      serialization: 'PASS',
    });
  }
  assertNoSecret(await api('/notification-channels'));
  evidence.cases.push(
    '25-provider-render-validation-serialization-and-no-readback',
  );
  // Editing cannot retrieve or silently merge protected configuration.
  await edit('Provider coverage lark');
  assert.equal(await modal().getByTestId('provider-config').count(), 0);
  await modal()
    .getByLabel(text('ui.name'), { exact: true })
    .fill('Lark renamed KEEP');
  let saved = await save();
  assert.equal(saved.sent.secret_action, 'KEEP');
  assert.equal(Object.hasOwn(saved.sent, 'secret'), false);
  evidence.cases.push('edit-keep-no-secret');
  await edit('Lark renamed KEEP');
  await action('REPLACE');
  await modal()
    .getByTestId('provider-field-larkKey')
    .locator('input')
    .fill(canary + '-replacement');
  saved = await save();
  assert.deepEqual(saved.sent.secret, { larkKey: canary + '-replacement' });
  evidence.cases.push('edit-replace-full-config');
  await edit('Lark renamed KEEP');
  await action('DELETE');
  await modal()
    .getByRole('button', {
      name: buttonText('notifications.form.save'),
      exact: true,
    })
    .click();
  await modal().locator('.ant-form-item-explain-error').first().waitFor();
  await modal().getByTestId('confirm-clear').setChecked(true);
  saved = await save();
  assert.equal(saved.sent.secret_action, 'DELETE');
  assert.equal(Object.hasOwn(saved.sent, 'secret'), false);
  assert.equal(Boolean(saved.data.secret_configured), false);
  evidence.cases.push('edit-delete-explicit-confirmation');
  await edit('Lark renamed KEEP');
  await selectProvider('telegramBot');
  assert.ok(
    (await modal().getByTestId('action-select').innerText()).includes(
      text('notifications.form.replace'),
    ),
  );
  await fillField(
    providerSchemas.telegramBot.fields.find(
      (f) => f.name === 'telegramBotToken',
    ),
    canary + '-telegram-draft',
  );
  await selectProvider('email');
  await fillProvider('email', fixture('email'));
  saved = await save();
  assert.equal(saved.sent.type, 'email');
  assert.ok(Object.keys(saved.sent.secret).every((k) => k.startsWith('email')));
  evidence.cases.push(
    'provider-switch-forces-replace-and-no-cross-provider-fields',
  );
  // Email and ntfy conditional fields are removed from the submitted configuration.
  await open();
  await selectProvider('email');
  await basic('Custom SMTP');
  const smtp = {
    ...fixture('email'),
    emailMode: 'smtp',
    emailHost: 'smtp.example.invalid',
    emailPort: 2525,
    emailSecure: true,
  };
  delete smtp.emailService;
  await fillProvider('email', smtp);
  saved = await save();
  assert.equal(saved.sent.secret.emailPort, 2525);
  assert.equal(saved.sent.secret.emailSecure, true);
  assert.equal(Object.hasOwn(saved.sent.secret, 'emailService'), false);
  evidence.cases.push('email-smtp-number-boolean-conditional');
  await open();
  await selectProvider('ntfy');
  await basic('ntfy auth switch');
  await fillField(
    providerSchemas.ntfy.fields.find((f) => f.name === 'ntfyAuthMode'),
    'token',
  );
  await fillField(
    providerSchemas.ntfy.fields.find((f) => f.name === 'ntfyToken'),
    canary + '-ntfy-token',
  );
  await fillField(
    providerSchemas.ntfy.fields.find((f) => f.name === 'ntfyAuthMode'),
    'basic',
  );
  assert.equal(
    await modal().getByTestId('provider-field-ntfyToken').count(),
    0,
  );
  const ntfy = {
    ...fixture('ntfy'),
    ntfyAuthMode: 'basic',
    ntfyUsername: 'fixture-user',
    ntfyPassword: canary + '-ntfy-password',
  };
  await fillProvider('ntfy', ntfy);
  saved = await save();
  assert.equal(Object.hasOwn(saved.sent.secret, 'ntfyToken'), false);
  evidence.cases.push('ntfy-auth-mode-clears-inactive-token');
  for (const messageType of ['textcard', 'mpnews']) {
    await open();
    await selectProvider('weWorkApp');
    await basic('WeWorkApp ' + messageType);
    const values = {
      ...fixture('weWorkApp'),
      messageType,
      ...(messageType === 'mpnews'
        ? { thumbMediaId: 'fixture-thumbnail-id' }
        : {}),
    };
    await fillProvider('weWorkApp', values);
    saved = await save();
    assert.equal(
      saved.sent.secret.weWorkAppKey.split(',')[4],
      messageType === 'mpnews' ? 'fixture-thumbnail-id' : '0',
    );
  }
  evidence.cases.push('weworkapp-textcard-and-mpnews-conditional-wire-mapping');
  // Locale changes come through a real cross-tab storage event while the dialog stays open.
  await open();
  await selectProvider('lark');
  await basic('Locale draft');
  await modal()
    .getByTestId('provider-field-larkSecret')
    .locator('input')
    .fill(canary + '-locale-draft');
  await modal()
    .getByRole('button', {
      name: buttonText('notifications.form.save'),
      exact: true,
    })
    .click();
  await modal()
    .getByTestId('provider-field-larkKey')
    .getByText(text('notifications.form.fieldRequired'), { exact: true })
    .waitFor();
  const second = await context.newPage();
  await second.goto(base + '/login');
  for (const next of ['en-US', 'zh-CN']) {
    await second.evaluate(
      (next) => localStorage.setItem('zhixu.language', next),
      next,
    );
    locale = next;
    await modal()
      .getByLabel(text('notifications.field.larkKey'), { exact: true })
      .waitFor();
    await modal()
      .getByTestId('provider-field-larkKey')
      .getByText(text('notifications.form.fieldRequired'), { exact: true })
      .waitFor();
    assert.equal(
      await modal()
        .getByTestId('provider-field-larkSecret')
        .locator('input')
        .inputValue(),
      canary + '-locale-draft',
    );
  }
  await second.close();
  await close();
  await open();
  await selectProvider('lark');
  for (const name of ['larkKey', 'larkSecret'])
    assert.equal(
      await modal()
        .getByTestId('provider-field-' + name)
        .locator('input')
        .inputValue(),
      '',
    );
  await close();
  evidence.cases.push(
    'live-locale-switch-updates-errors-retains-draft-and-close-reopen-clears',
  );
  await open();
  await selectProvider('lark');
  await prepareScreenshot();
  await page.screenshot({
    path: path.join(evidenceDir, 'provider-form-desktop.png'),
    fullPage: true,
  });
  await close();
  locale = 'en-US';
  await page.evaluate(() => {
    localStorage.setItem('zhixu.language', 'en-US');
  });
  await page.reload();
  await page
    .getByRole('button', { name: buttonText('ui.addChannel'), exact: true })
    .waitFor();
  // A real local receiver checks the simple WEBHOOK protocol without external sends.
  await open();
  await selectProvider('WEBHOOK');
  await basic('Local receiver WEBHOOK');
  await modal()
    .getByLabel(text('ui.enabled'), { exact: true })
    .setChecked(true);
  await fillProvider('WEBHOOK', {
    url: receiverUrl + '/receive',
    authorization: 'Bearer ' + canary + '-authorization',
  });
  saved = await save();
  assert.deepEqual(Object.keys(saved.sent.secret).sort(), [
    'authorization',
    'url',
  ]);
  const localId = saved.data.id;
  const delivery = await api(
    '/notification-channels/' + localId + '/test',
    'POST',
    {},
  );
  await until(async () => {
    const list = await api('/notification-deliveries');
    return list.some((d) => d.id === delivery.id && d.status === 'SENT');
  });
  assert.equal(
    deliveries.at(-1).headers.authorization,
    'Bearer ' + canary + '-authorization',
  );
  evidence.cases.push('english-webhook-local-delivery-and-exact-authorization');
  await open();
  await selectProvider('webhook');
  assert.equal(await modal().getByTestId('provider-field-url').count(), 0);
  assert.equal(
    await modal().getByTestId('provider-field-webhookMethod').count(),
    1,
  );
  await close();
  evidence.cases.push('uppercase-lowercase-webhook-distinct-forms');
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await selectProvider('telegramBot');
  await expand();
  const box = await modal().boundingBox();
  assert.ok(box.width <= 390);
  assert.ok(
    await modal()
      .getByRole('button', {
        name: buttonText('notifications.form.save'),
        exact: true,
      })
      .isVisible(),
  );
  await close();
  evidence.cases.push('mobile-dialog-footer-accessible');
  await open();
  await selectProvider('lark');
  await prepareScreenshot();
  await page.screenshot({
    path: path.join(evidenceDir, 'provider-form-mobile.png'),
    fullPage: true,
  });
  await close();
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  assert.ok(!storage.includes(canary), 'PROVIDER_CONFIG_IN_BROWSER_STORAGE');
  assertNoSecret(await api('/notification-channels'));
  assert.deepEqual(evidence.browserErrors, []);
  evidence.cases.push('no-secret-readback-storage-or-pageerrors');
  evidence.status = 'PASS';
})()
  .catch((error) => {
    evidence.status = 'FAIL';
    evidence.error = String(error.stack || error).replaceAll(
      canary,
      '[REDACTED]',
    );
    console.error(evidence.error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const cleanupErrors = [];
    // Close backend WebSockets before closing the browser; Chrome can otherwise
    // wait indefinitely while the application reconnects during context teardown.
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
      const closed = await Promise.race([
        browser.close().then(
          () => true,
          () => false,
        ),
        pause(15000).then(() => false),
      ]);
      if (!closed) cleanupErrors.push('BROWSER_CLOSE_FAILED');
    }
    if (receiver) {
      receiver.closeAllConnections();
      await new Promise((r) => receiver.close(r));
      if (receiver.listening)
        cleanupErrors.push('OWNED_RECEIVER_STILL_LISTENING');
    }
    // Do not persist raw backend output: it may contain protected transport inputs.
    if (evidence.status !== 'PASS')
      evidence.backendLastLines = backendOutput
        .replaceAll(canary, '[REDACTED]')
        .split('\n')
        .slice(-12);
    if (!cleanupErrors.length)
      fs.rmSync(temp, { recursive: true, force: true });
    evidence.cleanup = cleanupErrors.length ? 'FAIL' : 'PASS';
    if (cleanupErrors.length) {
      evidence.status = 'FAIL';
      evidence.cleanupErrors = cleanupErrors;
      process.exitCode = 1;
    }
    fs.writeFileSync(
      path.join(evidenceDir, 'provider-form-browser.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    console.log(
      'NOTIFICATION_PROVIDER_BROWSER_' + evidence.status,
      evidence.providerCases.length,
      'providers',
      evidence.cases.length,
      'cases',
    );
  });
