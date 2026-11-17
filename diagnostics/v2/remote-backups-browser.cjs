// Targeted UI interaction tests against controlled APIs; no release qualification.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ZHIXU_BROWSER_EXECUTABLE
      ? { executablePath: process.env.ZHIXU_BROWSER_EXECUTABLE }
      : {}),
  });
  try {
    const context = await browser.newContext({
      locale: 'en-US',
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [],
      requests = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
      process.stderr.write('BROWSER_ERROR ' + error.message + '\n');
    });
    let settings = {
      enabled: false,
      target_id: 's3',
      retain_count: 14,
      has_passphrase: false,
    };
    const targets = [
      {
        id: 's3',
        name: 'S3 fixture',
        type: 'S3',
        enabled: true,
        endpoint: 'https://s3.example.invalid',
        region: 'us-east-1',
        bucket: 'fixture',
        prefix: 'backups',
        access_key_id: 'key-id',
        has_secret_access_key: true,
        has_session_token: true,
        path_style: false,
        proxy: { mode: 'DIRECT' },
      },
    ];
    const snapshots = [
      {
        id: 'full-snapshot',
        created_at: '2026-11-17T03:00:00Z',
        backup_mode: 'FULL',
        status: 'READY',
      },
      {
        id: 'light-snapshot',
        created_at: '2026-11-17T04:00:00Z',
        backup_mode: 'LIGHTWEIGHT',
        status: 'READY',
      },
    ];
    const uploads = [
      {
        id: 'failed-upload',
        snapshot_id: 'full-snapshot',
        target_id: 's3',
        target_name: 'S3 fixture',
        source: 'MANUAL',
        mode: 'FULL',
        status: 'FAILED',
        error_code: 'BACKUP_REMOTE_REQUEST_FAILED',
        size: 4096,
        processed_bytes: 1024,
        created_at: '2026-11-17T03:00:00Z',
      },
      {
        id: 'active-upload',
        target_name: 'S3 fixture',
        source: 'SCHEDULED',
        mode: 'LIGHTWEIGHT',
        status: 'UPLOADING',
        size: 4096,
        processed_bytes: 2048,
        created_at: '2026-11-17T04:00:00Z',
      },
    ];
    const objects = [
      {
        key: 'zhixu-v2/MANUAL/FULL/fixture.encrypted',
        backup_id: 'remote-full',
        created_at: '2026-11-16T03:00:00Z',
        mode: 'FULL',
        source: 'MANUAL',
        size: 4096,
      },
    ];
    await page.route('**/api/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        p = url.pathname,
        method = req.method();
      if (p === '/api/env.js')
        return route.fulfill({
          contentType: 'application/javascript',
          body: 'window.__ENV__QlBaseUrl="/";',
        });
      let data = [];
      if (p === '/api/system')
        data = { mode: 'v2', initialized: true, ready: true, version: '2.0.0' };
      else if (p === '/api/user') data = { username: 'fixture' };
      else if (p === '/api/restore/status') data = null;
      else if (p === '/api/backups') data = snapshots;
      else if (p === '/api/backups/schedule')
        data = {
          enabled: false,
          time: '03:00',
          timezone: 'Asia/Shanghai',
          retain_count: 3,
        };
      else if (p === '/api/backups/history') data = { items: [], total: 0 };
      else if (p === '/api/backups/remote/settings') {
        if (method === 'PUT') {
          const body = req.postDataJSON();
          requests.push({ p, method, body });
          settings = {
            ...settings,
            enabled: body.enabled,
            target_id: body.target_id,
            retain_count: body.retain_count,
            has_passphrase: settings.has_passphrase || !!body.passphrase,
          };
        }
        data = settings;
      } else if (p === '/api/backups/remote/targets') {
        if (method === 'POST') {
          const body = req.postDataJSON();
          requests.push({ p, method, body });
          targets.push({
            id: 'dav',
            ...body,
            has_password: !!body.password,
            password: undefined,
          });
        }
        data = targets;
      } else if (p === '/api/backups/remote/targets/s3') {
        const body = req.postDataJSON();
        requests.push({ p, method, body });
        Object.assign(targets[0], body);
        data = targets[0];
      } else if (p.endsWith('/test')) {
        requests.push({ p, method, body: req.postDataJSON() });
        data = { status: 'SUCCESS' };
      } else if (p.endsWith('/download')) {
        requests.push({ p, method, key: url.searchParams.get('key') });
        return route.fulfill({
          contentType: 'application/octet-stream',
          body: 'encrypted-fixture',
        });
      } else if (p.endsWith('/objects')) {
        if (method === 'DELETE') {
          requests.push({ p, method, body: req.postDataJSON() });
          objects.length = 0;
        }
        data = objects;
      } else if (p === '/api/backups/remote/uploads') {
        if (method === 'POST') {
          requests.push({ p, method, body: req.postDataJSON() });
          data = { id: 'new-upload', status: 'WAITING' };
        } else data = uploads;
      } else if (p.endsWith('/retry')) {
        requests.push({ p, method, body: req.postDataJSON() });
        uploads[0].status = 'WAITING';
        data = uploads[0];
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ code: 200, data }),
      });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/setting`);
    await page
      .getByRole('tab', { name: 'Backup / Restore', exact: true })
      .click();
    const card = (title) =>
      page.locator('.ant-card').filter({
        has: page
          .locator('.ant-card-head-title')
          .getByText(title, { exact: true }),
      });
    const config = card('Remote storage targets'),
      automatic = card('Remote automatic backups'),
      remote = card('Remote backups');
    await config.getByText('S3 fixture', { exact: true }).waitFor();
    assert.match(
      await automatic.innerText(),
      /Disabled[\s\S]*14[\s\S]*Recovery passphrase not configured/,
    );
    assert.equal(
      await remote
        .getByRole('button', { name: 'Upload encrypted backup', exact: true })
        .isDisabled(),
      true,
    );
    await page
      .locator('tr[data-row-key="failed-upload"]')
      .getByText('BACKUP_REMOTE_REQUEST_FAILED')
      .waitFor();
    assert.match(
      await page.locator('tr[data-row-key="active-upload"]').innerText(),
      /Uploading[\s\S]*50%/,
    );
    assert.match(
      await page
        .locator('tr[data-row-key="zhixu-v2/MANUAL/FULL/fixture.encrypted"]')
        .innerText(),
      /Full backup[\s\S]*Manual/,
    );
    process.stdout.write(
      'PASS remote defaults, disabled uploads without key, independent recovery-key guidance, source/mode/progress/error presentation\n',
    );

    await config.getByRole('button', { name: 'Edit', exact: true }).click();
    let dialog = page.getByRole('dialog');
    assert.equal(
      await dialog
        .getByLabel('Secret Access Key', { exact: true })
        .inputValue(),
      '',
    );
    await dialog.getByLabel('Name', { exact: true }).fill('S3 renamed');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const edit = requests.find(
      (r) => r.method === 'PUT' && r.p.endsWith('/targets/s3'),
    );
    assert.equal(edit.body.name, 'S3 renamed');
    assert.equal('secret_access_key' in edit.body, false);
    assert.equal('session_token' in edit.body, false);
    assert.equal('has_secret_access_key' in edit.body, false);
    await config.getByRole('button', { name: 'Edit', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog
      .getByRole('checkbox', { name: 'Clear saved session token', exact: true })
      .check();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(
      requests
        .filter((r) => r.method === 'PUT' && r.p.endsWith('/targets/s3'))
        .at(-1).body.session_token,
      '',
    );
    await config
      .getByRole('button', { name: 'Test connection', exact: true })
      .click();
    await config
      .getByText('Connection and write permission test passed.', {
        exact: true,
      })
      .waitFor();
    assert.equal(
      requests.some((r) => r.p.endsWith('/targets/s3/test')),
      true,
    );
    process.stdout.write(
      'PASS target edit preserves omitted secrets and connection test reports actual API result\n',
    );

    await config
      .getByRole('button', { name: 'New remote target', exact: true })
      .click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('NAS WebDAV');
    await dialog
      .getByLabel('Type', { exact: true })
      .locator('xpath=../..')
      .click();
    await page.getByTitle('WebDAV', { exact: true }).click();
    await dialog
      .getByLabel('Endpoint', { exact: true })
      .fill('https://dav.example.invalid');
    await dialog
      .getByLabel('Remote directory (optional)', { exact: true })
      .fill('backups');
    await dialog
      .getByLabel('Username (optional)', { exact: true })
      .fill('fixture-user');
    await dialog
      .getByLabel('Password or app password', { exact: true })
      .fill('fixture-app-password');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const created = requests.find(
      (r) => r.method === 'POST' && r.p.endsWith('/targets'),
    );
    assert.equal(created.body.type, 'WEBDAV');
    assert.equal(created.body.password, 'fixture-app-password');
    assert.equal('bucket' in created.body, false);
    assert.equal('region' in created.body, false);

    await automatic
      .getByRole('button', { name: 'Remote backup settings', exact: true })
      .click();
    dialog = page.getByRole('dialog');
    await dialog
      .getByRole('switch', {
        name: 'Enable remote automatic backups',
        exact: true,
      })
      .click();
    await dialog
      .getByLabel('Recovery passphrase', { exact: true })
      .fill('independently-saved-fixture-key');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const updated = requests.find(
      (r) => r.method === 'PUT' && r.p === '/api/backups/remote/settings',
    );
    assert.deepEqual(updated.body, {
      enabled: true,
      target_id: 's3',
      retain_count: 14,
      passphrase: 'independently-saved-fixture-key',
    });
    await automatic
      .getByText('Recovery passphrase configured', { exact: true })
      .waitFor();
    process.stdout.write(
      'PASS WebDAV creation uses only WebDAV fields and write-only recovery key config enables automatic upload\n',
    );

    await remote
      .getByRole('combobox', { name: 'Local backup snapshot', exact: true })
      .locator('xpath=../..')
      .click();
    await page
      .getByTitle('2026-11-17T03:00:00Z · FULL', { exact: true })
      .click();
    await remote
      .getByRole('button', { name: 'Upload encrypted backup', exact: true })
      .click();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('button')].find(
          (b) => b.textContent === 'Upload encrypted backup',
        )?.disabled,
    );
    assert.deepEqual(
      requests.find((r) => r.method === 'POST' && r.p.endsWith('/uploads'))
        .body,
      { snapshot_id: 'full-snapshot', target_id: 's3' },
    );
    await page
      .locator('tr[data-row-key="failed-upload"]')
      .getByRole('button', { name: 'Retry upload', exact: true })
      .click();
    await page
      .locator('tr[data-row-key="failed-upload"]')
      .getByText('Waiting', { exact: true })
      .waitFor();
    assert.equal(
      requests.some((r) => r.p.endsWith('/uploads/failed-upload/retry')),
      true,
    );
    const objectRow = page.locator(
      'tr[data-row-key="zhixu-v2/MANUAL/FULL/fixture.encrypted"]',
    );
    const download = page.waitForEvent('download');
    await objectRow
      .getByRole('button', { name: 'Download', exact: true })
      .click();
    assert.equal((await download).suggestedFilename(), 'fixture.encrypted');
    assert.equal(
      requests.find((r) => r.p.endsWith('/download')).key,
      'zhixu-v2/MANUAL/FULL/fixture.encrypted',
    );
    await objectRow
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await page.locator('.ant-popover-buttons .ant-btn-primary').click();
    await objectRow.waitFor({ state: 'hidden' });
    assert.deepEqual(
      requests.find((r) => r.method === 'DELETE' && r.p.endsWith('/objects'))
        .body,
      { key: 'zhixu-v2/MANUAL/FULL/fixture.encrypted' },
    );
    assert.deepEqual(errors, []);
    process.stdout.write(
      'PASS manual FULL upload, retry, encrypted download and confirmed delete use scoped APIs without browser errors\n',
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  process.stderr.write((error.stack || error.message) + '\n');
  process.exitCode = 1;
});
