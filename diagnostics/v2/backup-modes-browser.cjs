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
      requests = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const rows = [
      {
        id: 'full',
        mode: 'FULL_PORTABLE',
        created_at: '2026-11-16T00:00:00Z',
        status: 'READY',
        size: 1048576,
      },
      {
        id: 'light',
        mode: 'FULL_PORTABLE',
        backup_mode: 'LIGHTWEIGHT',
        restore_requires_remote: true,
        created_at: '2026-11-17T00:00:00Z',
        status: 'READY',
        size: 1024,
      },
    ];
    await page.route('**/api/**', async (route) => {
      const req = route.request(),
        p = new URL(req.url()).pathname;
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
      else if (p === '/api/backups' && req.method() === 'POST') {
        const body = req.postDataJSON();
        requests.push(body);
        data = { id: 'operation-' + requests.length, status: 'QUEUED' };
      } else if (p === '/api/backups') data = rows;
      else if (p.startsWith('/api/backups/operations/'))
        data = {
          id: p.split('/').at(-1),
          kind: 'SNAPSHOT',
          status: 'SUCCESS',
          result: 'fixture',
        };
      else if (p === '/api/backups/full')
        data = {
          ...rows[0],
          validation: {
            status: 'PASS',
            warnings: [
              'FULL_GIT_LFS_EXTERNAL_DATA_WARNING',
              'FULL_GIT_SUBMODULE_EXTERNAL_DATA_WARNING',
            ],
          },
          workspaces: [],
        };
      else if (p === '/api/backups/light')
        data = {
          ...rows[1],
          validation: {
            status: 'PASS',
            warnings: [
              'LIGHTWEIGHT_REQUIRES_REMOTE_GIT_BASE',
              'Fixture dependency warning',
            ],
          },
          schema: { identity: 'fixture-schema' },
          file_count: 3,
          counts: { workspaces: 1, tasks: 1 },
          workspaces: [],
        };
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
    const selected = page.getByRole('combobox', {
      name: 'Backup mode',
      exact: true,
    });
    await selected.waitFor();
    assert.match(
      await selected.locator('..').locator('..').innerText(),
      /Full backup/,
    );
    const first = page.waitForRequest(
      (r) =>
        new URL(r.url()).pathname === '/api/backups' && r.method() === 'POST',
    );
    await page
      .getByRole('button', { name: 'Create backup', exact: true })
      .click();
    assert.equal((await first).postDataJSON().mode, 'FULL');
    await page
      .getByRole('button', { name: 'Create backup', exact: true })
      .waitFor({ state: 'visible' });
    await selected.focus();
    await selected.press('ArrowDown');
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
      .filter({ hasText: 'Lightweight backup' })
      .click();
    assert.ok(
      await page
        .getByText(
          /Restoring Git workspaces requires the original remote repository/,
        )
        .isVisible(),
    );
    const next = page.waitForRequest(
      (r) =>
        new URL(r.url()).pathname === '/api/backups' && r.method() === 'POST',
    );
    await page
      .getByRole('button', { name: 'Create backup', exact: true })
      .click();
    assert.equal((await next).postDataJSON().mode, 'LIGHTWEIGHT');
    process.stdout.write(
      'PASS manual backup defaults to FULL and sends selected LIGHTWEIGHT mode\n',
    );
    await page
      .locator('tr[data-row-key="light"]')
      .getByRole('button', { name: 'Check readiness', exact: true })
      .click();
    await page
      .getByText('Fixture dependency warning', { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByText('LIGHTWEIGHT_REQUIRES_REMOTE_GIT_BASE', { exact: true })
        .count(),
      0,
    );
    assert.ok(
      await page
        .getByText(
          'Original Git remote, required objects and valid credentials / proxy',
          { exact: true },
        )
        .isVisible(),
    );
    assert.match(
      await page.locator('tr[data-row-key="full"]').innerText(),
      /Full backup/,
    );
    assert.match(
      await page.locator('tr[data-row-key="light"]').innerText(),
      /Lightweight backup/,
    );
    assert.match(
      await page.locator('tr[data-row-key="full"]').innerText(),
      /1\.0 MB/,
    );
    await page
      .locator('tr[data-row-key="full"]')
      .getByRole('button', { name: 'Check readiness', exact: true })
      .click();
    await page.getByText(/Git LFS configuration was detected/).waitFor();
    await page.getByText(/Git submodule configuration was detected/).waitFor();
    assert.equal(
      await page
        .getByText('FULL_GIT_LFS_EXTERNAL_DATA_WARNING', { exact: true })
        .count(),
      0,
    );
    assert.equal(errors.length, 0, JSON.stringify(errors));
    process.stdout.write(
      'PASS legacy FULL and LIGHTWEIGHT rows, readable sizes, recovery dependency and warnings\n',
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  process.stderr.write((e.stack || e.message) + '\n');
  process.exitCode = 1;
});
