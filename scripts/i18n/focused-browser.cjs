'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  net = require('node:net'),
  { spawn } = require('node:child_process');
const acceptance = require('../ci/acceptance.cjs'),
  { locale, ui, pattern, configure } = require('../ci/browser-locale.cjs');
const output = acceptance.output(
  path.resolve(__dirname, '../../diagnostics/i18n/focused-' + locale),
);
const root = path.resolve(__dirname, '../..'),
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixu-i18n-focused-'));
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
    process.env.QL_BROWSER_RUNTIME ||
      '/tmp/qinglong-phase45b-browser/node_modules',
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
  await configure(page);
  flush = acceptance.observe(page, output);
  await page.goto(base);
  await page.getByRole('button', { name: ui('开始安装'), exact: true }).click();
  await page.getByLabel(ui('用户名'), { exact: true }).fill('i18n-owner');
  await page
    .getByLabel(ui('密码'), { exact: true })
    .fill(acceptance.secret('focused-browser-password'));
  await page
    .getByLabel(ui('确认密码'), { exact: true })
    .fill(acceptance.secret('focused-browser-password'));
  await page.getByRole('button', { name: pattern('提交') }).click();
  await page.getByRole('button', { name: ui('去登录'), exact: true }).click();
  async function login() {
    await page.getByLabel(ui('用户名'), { exact: true }).fill('i18n-owner');
    await page
      .getByLabel(ui('密码'), { exact: true })
      .fill(acceptance.secret('focused-browser-password'));
    await page.getByRole('button', { name: pattern('登录') }).click();
    await page.waitForFunction(() => !!localStorage.getItem('token'));
  }
  await login();
  try {
    await require('./browser-qualification.cjs')({
      page,
      browser,
      base,
      locale,
      login,
      evidenceDirectory: output,
      mark: console.log,
    });
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
