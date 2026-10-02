'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  net = require('node:net'),
  { spawn } = require('node:child_process');
const acceptance = require('../ci/acceptance.cjs'),
  { locale, ui, pattern, configure } = require('../ci/browser-locale.cjs');
const output = acceptance.output(
  path.resolve(
    __dirname,
    '../../diagnostics/branding/browser-' +
      (process.env.BRAND_PREFERENCE || 'explicit') +
      '-' +
      locale,
  ),
);
const root = path.resolve(__dirname, '../..'),
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixu-brand-focused-'));
let backend,
  browser,
  flush = () => {},
  logs = '';
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
(async () => {
  for (const name of ['shell', 'sample'])
    fs.cpSync(path.join(root, name), path.join(tmp, name), { recursive: true });
  fs.copyFileSync(
    path.join(root, 'version.yaml'),
    path.join(tmp, 'version.yaml'),
  );
  fs.symlinkSync(
    path.join(root, 'node_modules'),
    path.join(tmp, 'node_modules'),
  );
  fs.mkdirSync(path.join(tmp, 'back'));
  fs.symlinkSync(path.join(root, 'back/protos'), path.join(tmp, 'back/protos'));
  fs.mkdirSync(path.join(tmp, 'static'));
  for (const name of ['build', 'dist'])
    fs.symlinkSync(
      path.join(root, 'static', name),
      path.join(tmp, 'static', name),
    );
  fs.mkdirSync(path.join(tmp, 'home'));
  fs.writeFileSync(
    path.join(tmp, '.env'),
    'JWT_SECRET=' + acceptance.secret('focused-browser-jwt') + '\n',
    { mode: 0o600 },
  );
  const http = await port(),
    grpc = await port(),
    base = 'http://127.0.0.1:' + http;
  backend = spawn(process.execPath, [path.join(root, 'static/build/app.js')], {
    cwd: root,
    env: {
      ...process.env,
      QL_DIR: tmp,
      QL_DATA_DIR: path.join(tmp, 'data'),
      HOME: path.join(tmp, 'home'),
      JWT_SECRET: acceptance.secret('focused-browser-jwt'),
      BACK_PORT: String(http),
      GRPC_PORT: String(grpc),
      BIND_HOST: '127.0.0.1',
      BIND_HOST_GRPC: '127.0.0.1',
      QL_SCHEDULER: 'node',
      NODE_ENV: 'production',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  acceptance.track(backend);
  backend.stdout.on('data', (b) => (logs += b));
  backend.stderr.on('data', (b) => (logs += b));
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      if ((await (await fetch(base + '/api/system')).json()).code === 200)
        break;
    } catch {}
    if (Date.now() > deadline) throw Error('BACKEND_START_TIMEOUT');
    await new Promise((r) => setTimeout(r, 200));
  }
  const { chromium } = require(path.join(
    process.env.QL_BROWSER_RUNTIME || '/tmp/zhixu-browser-tools/node_modules',
    'playwright',
  ));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.QL_BROWSER_EXECUTABLE
      ? { executablePath: process.env.QL_BROWSER_EXECUTABLE }
      : process.platform === 'darwin'
      ? { channel: 'chrome' }
      : {}),
  });
  const context = await browser.newContext({
      locale,
      viewport: { width: 1440, height: 1100 },
    }),
    page = await context.newPage();
  await page.addInitScript(
    (preference) => localStorage.setItem('zhixu.language', preference),
    process.env.BRAND_PREFERENCE || locale,
  );
  flush = acceptance.observe(page, output);
  const checks = [];
  async function verify(name, screenshot = true) {
    await page.waitForFunction(() => document.title.includes('ZhiXu'));
    await page.waitForFunction(
      (expected) => document.documentElement.lang === expected,
      locale,
    );
    await page.getByText(/ZhiXu/).first().waitFor({ state: 'visible' });
    const title = await page.title(),
      text = await page.locator('body').innerText();
    assert.doesNotMatch(
      title + '\n' + text,
      /qing[ -]?long|青龙|枝序|知序|智序|秩序/i,
    );
    assert.match(text, /ZhiXu/);
    if (screenshot)
      await page.screenshot({
        path: path.join(output, name + '.png'),
        fullPage: true,
      });
    checks.push({
      name,
      title,
      locale,
      preference: await page.evaluate(() =>
        localStorage.getItem('zhixu.language'),
      ),
      status: 'PASS',
    });
  }
  await page.goto(base);
  await page
    .getByRole('button', { name: ui('开始安装'), exact: true })
    .waitFor();
  await verify('initialization');
  await page.getByRole('button', { name: ui('开始安装'), exact: true }).click();
  await page.getByLabel(ui('用户名'), { exact: true }).fill('brand-owner');
  await page
    .getByLabel(ui('密码'), { exact: true })
    .fill(acceptance.secret('focused-browser-password'));
  await page
    .getByLabel(ui('确认密码'), { exact: true })
    .fill(acceptance.secret('focused-browser-password'));
  await page.getByRole('button', { name: pattern('提交') }).click();
  await page.getByRole('button', { name: ui('去登录'), exact: true }).click();
  await page.getByLabel(ui('用户名'), { exact: true }).waitFor();
  await verify('login');
  async function login() {
    await page.getByLabel(ui('用户名'), { exact: true }).fill('brand-owner');
    await page
      .getByLabel(ui('密码'), { exact: true })
      .fill(acceptance.secret('focused-browser-password'));
    await page.getByRole('button', { name: pattern('登录') }).click();
    await page.waitForFunction(() => !!localStorage.getItem('token'));
  }
  await login();
  try {
    for (const [route, name] of [
      ['/dashboard', 'dashboard'],
      ['/repository', 'repository'],
      ['/tasks', 'tasks'],
      ['/runs', 'runs'],
      ['/runtime-python', 'runtime'],
      ['/notifications', 'notifications'],
      ['/setting', 'settings'],
      ['/not-a-real-brand-route', '404'],
    ]) {
      await page.goto(base + route);
      await page.locator('.ant-pro-sider').waitFor();
      await verify(name);
    }
    await page.goto(base + '/setting');
    await require('../ci/browser-tab.cjs').activateTab(page, ui('关于'));
    await page
      .getByRole('tabpanel')
      .getByText('ZhiXu', { exact: true })
      .waitFor();
    await verify('about');
    for (const meta of ['application-name', 'apple-mobile-web-app-title'])
      assert.equal(
        await page.locator(`meta[name="${meta}"]`).getAttribute('content'),
        'ZhiXu',
      );
    fs.writeFileSync(
      path.join(output, 'brand-browser.json'),
      JSON.stringify({ status: 'PASS', locale, checks }, null, 2) + '\n',
    );
    console.log(
      'BRAND_BROWSER_PASS',
      locale,
      process.env.BRAND_PREFERENCE || 'explicit',
    );
  } catch (error) {
    await page.screenshot({
      path: path.join(output, 'failure.png'),
      fullPage: true,
    });
    fs.writeFileSync(
      path.join(output, 'failure.txt'),
      await page.locator('body').innerText(),
    );
    throw error;
  }
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    flush();
    await browser?.close();
    if (backend) {
      const exited = new Promise((r) => backend.once('exit', r));
      try {
        process.kill(-backend.pid, 'SIGTERM');
      } catch {}
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      try {
        process.kill(-backend.pid, 'SIGKILL');
      } catch {}
    }
    fs.writeFileSync(path.join(output, 'backend.log'), logs);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
