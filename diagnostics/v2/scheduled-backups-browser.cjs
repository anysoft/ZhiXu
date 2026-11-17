// UI behavior regression using controlled API responses; not release qualification.
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium } = require(process.env.ZHIXU_PLAYWRIGHT_MODULE ||
  'playwright');
(async () => {
  const root = path.resolve('static/dist-v2');
  const server = http.createServer((req, res) => {
    let file = path.join(root, new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(root, 'index.html');
    res.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'application/javascript'
        : file.endsWith('.css')
        ? 'text/css'
        : 'text/html',
    );
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ZHIXU_BROWSER_EXECUTABLE
      ? { executablePath: process.env.ZHIXU_BROWSER_EXECUTABLE }
      : {}),
  });
  try {
    const page = await (
      await browser.newContext({ locale: 'en-US' })
    ).newPage();
    page.setDefaultTimeout(15000);
    const errors = [],
      saved = [],
      runs = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let settings = {
      enabled: true,
      time: '03:00',
      timezone: 'Asia/Shanghai',
      retain_count: 3,
      mode: 'LIGHTWEIGHT',
      next_run_at: '2026-11-18T19:00:00Z',
      retry_at: '2026-11-17T08:15:00Z',
      running: false,
      last_result: {
        id: 'failed',
        status: 'FAILED',
        error_code: 'DISK_BUDGET_EXCEEDED',
      },
    };
    let failRun = false;
    const history = [
      {
        id: 'success',
        source: 'SCHEDULED',
        mode: 'LIGHTWEIGHT',
        status: 'SUCCESS',
        started_at: '2026-11-17T07:00:00Z',
        size: 2048,
        duration_ms: 1500,
        retention_errors: [
          { id: 'protected', error_code: 'BACKUP_REFERENCE_PROTECTED' },
        ],
      },
      {
        id: 'manual',
        source: 'MANUAL',
        mode: 'FULL',
        status: 'SUCCESS',
        started_at: '2026-11-16T07:00:00Z',
        size: 1048576,
        duration_ms: 2000,
      },
      {
        id: 'failed',
        source: 'SCHEDULED',
        mode: 'LIGHTWEIGHT',
        status: 'FAILED',
        started_at: '2026-11-17T08:00:00Z',
        size: null,
        duration_ms: 500,
        error_code: 'DISK_BUDGET_EXCEEDED',
      },
    ];
    const rows = [
      {
        id: 'legacy-manual',
        mode: 'FULL_PORTABLE',
        status: 'READY',
        size: 1048576,
      },
      {
        id: 'scheduled-snapshot',
        mode: 'FULL_PORTABLE',
        backup_mode: 'LIGHTWEIGHT',
        source: 'SCHEDULED',
        status: 'READY',
        size: 2048,
      },
    ];
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        p = new URL(request.url()).pathname;
      if (p === '/api/env.js')
        return route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: 'window.__ENV__QlBaseUrl="/";',
        });
      let data = [];
      if (p === '/api/system')
        data = { mode: 'v2', initialized: true, ready: true, version: '2.0.0' };
      else if (p === '/api/user') data = { username: 'fixture' };
      else if (p === '/api/restore/status') data = null;
      else if (p === '/api/backups/schedule') {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON();
          saved.push(body);
          settings = {
            ...settings,
            ...body,
            next_run_at: body.enabled ? '2026-11-19T09:15:00Z' : null,
            retry_at: null,
          };
        }
        data = settings;
      } else if (p === '/api/backups/history')
        data = { items: history, total: history.length };
      else if (p === '/api/backups/schedule/run') {
        runs.push(request.postDataJSON());
        if (failRun)
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 409,
              error_code: 'BACKUP_OPERATION_BUSY',
            }),
          });
        data = { id: 'scheduled-operation', status: 'QUEUED' };
      } else if (p.startsWith('/api/backups/operations/'))
        data = {
          id: 'scheduled-operation',
          kind: 'SNAPSHOT_SCHEDULED',
          status: 'SUCCESS',
          result: 'scheduled-snapshot',
        };
      else if (p === '/api/backups') data = rows;
      else if (p === '/api/backups/scheduled-snapshot')
        data = { ...rows[1], validation: { status: 'PASS' }, workspaces: [] };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 200, data }),
      });
    });
    await page.goto('http://127.0.0.1:' + server.address().port + '/setting');
    await page
      .getByRole('tab', { name: 'Backup / Restore', exact: true })
      .click();
    const automatic = page.locator('.ant-card').filter({
      has: page
        .locator('.ant-card-head-title')
        .getByText('Automatic backups', { exact: true }),
    });
    await automatic
      .getByRole('button', { name: 'Edit automatic backups', exact: true })
      .waitFor();
    assert.match(await automatic.innerText(), /03:00/);
    assert.match(await automatic.innerText(), /Asia\/Shanghai/);
    assert.match(await automatic.innerText(), /Lightweight backup/);
    await automatic
      .getByText('DISK_BUDGET_EXCEEDED', { exact: true })
      .waitFor();
    assert.match(
      await page.locator('tr[data-row-key="legacy-manual"]').innerText(),
      /Manual/,
    );
    assert.match(
      await page.locator('tr[data-row-key="scheduled-snapshot"]').innerText(),
      /Automatic/,
    );
    assert.match(
      await page.locator('tr[data-row-key="success"]').innerText(),
      /Automatic[\s\S]*Lightweight backup[\s\S]*2\.0 KB[\s\S]*1\.5 s/,
    );
    assert.match(
      await page.locator('tr[data-row-key="manual"]').innerText(),
      /Manual[\s\S]*Full backup/,
    );
    await page
      .getByText(
        'Backup succeeded; automatic cleanup needs attention. Protected or failed-to-delete snapshots remain available.',
        { exact: true },
      )
      .waitFor();
    process.stdout.write(
      'PASS automatic defaults, timezone, next/retry times, bounded history, disk/retention failures and legacy/manual provenance\n',
    );
    await automatic
      .getByRole('button', { name: 'Edit automatic backups', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('Timezone', { exact: true })
      .fill('Invalid/Timezone');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog
      .getByText('Enter a valid IANA timezone, such as Asia/Shanghai.', {
        exact: true,
      })
      .waitFor();
    assert.equal(saved.length, 0, 'invalid timezone must not be submitted');
    await dialog
      .getByRole('switch', { name: 'Enable automatic backups', exact: true })
      .click();
    await dialog
      .getByLabel('Daily execution time', { exact: true })
      .fill('04:15');
    await dialog
      .getByLabel('Timezone', { exact: true })
      .fill('America/New_York');
    await dialog
      .getByLabel('Automatic backups to keep', { exact: true })
      .fill('5');
    const update = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/api/backups/schedule' &&
        request.method() === 'PUT',
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    assert.deepEqual((await update).postDataJSON(), {
      enabled: false,
      time: '04:15',
      timezone: 'America/New_York',
      retain_count: 5,
    });
    await dialog.waitFor({ state: 'hidden' });
    assert.match(await automatic.innerText(), /Disabled/);
    assert.match(await automatic.innerText(), /04:15/);
    assert.match(await automatic.innerText(), /America\/New_York/);
    process.stdout.write(
      'PASS saving schedule disable/time/timezone/retention uses the API and shows recomputed settings\n',
    );
    const runNow = automatic.getByRole('button', {
      name: 'Run lightweight backup now',
      exact: true,
    });
    const run = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/api/backups/schedule/run' &&
        request.method() === 'POST',
    );
    await runNow.click();
    assert.deepEqual((await run).postDataJSON(), {});
    assert.equal(runs.length, 1);
    await page.getByText('scheduled-operation', { exact: true }).waitFor();
    await runNow.waitFor({ state: 'visible' });
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('button')].find(
          (button) => button.textContent === 'Run lightweight backup now',
        )?.disabled,
    );
    failRun = true;
    await runNow.click();
    await automatic
      .getByText('BACKUP_OPERATION_BUSY', { exact: true })
      .waitFor();
    assert.equal(runs.length, 2);
    settings = { ...settings, running: true };
    await automatic
      .getByRole('button', { name: /Refresh$/ })
      .click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('button')].find(
          (button) => button.textContent === 'Run lightweight backup now',
        )?.disabled,
    );
    assert.equal(await runNow.isDisabled(), true);
    await automatic.getByText('Running', { exact: true }).waitFor();
    assert.equal(errors.length, 0, JSON.stringify(errors));
    process.stdout.write(
      'PASS disabled daily schedule still permits one-off lightweight execution; busy failure is explicit and not reported as success\n',
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  process.stderr.write((e.stack || e.message) + '\n');
  process.exitCode = 1;
});
