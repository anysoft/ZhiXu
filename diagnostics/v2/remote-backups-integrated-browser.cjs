// Real UI -> authenticated V2 API -> controlled WebDAV -> encrypted Portable.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.ZHIXU_PLAYWRIGHT_MODULE ||
  'playwright');
const {
  httpFixture,
  until,
} = require('../../tests/workspace-v2/s4/http-support.cjs');
const { startWebdav } = require('../../tests/backup-remote/servers.cjs');

test(
  'real remote backup UI manages WebDAV, uploads FULL and downloads encrypted data through the V2 API',
  { timeout: 120000 },
  async (t) => {
    const dav = await startWebdav();
    t.after(() => dav.close());
    const f = await httpFixture(t, 'REMOTE-BACKUP-INTEGRATED-BROWSER', {
      background: false,
      frontendRoot: path.resolve('static/dist-v2'),
    });
    const workspace = await f.app.services.lifecycle.createLocal({
      name: 'Browser remote data',
      requestKey: 'remote-browser-workspace',
    });
    await f.app.services.files.create(
      workspace.id,
      'main.sh',
      'echo browser-remote-business-content\n',
    );
    const snapshot = await f.app.services.backup.create(1000, 'FULL');
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ZHIXU_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZHIXU_BROWSER_EXECUTABLE }
        : {}),
    });
    t.after(() => browser.close());
    t.after(async () => {
      await f.app.close();
      const markerFile = path.join(f.h.root, '.s1b-case-owner.json');
      const ownership = JSON.parse(await fs.readFile(markerFile, 'utf8'));
      const identity = await fs.lstat(f.h.root);
      assert.equal(identity.isDirectory() && !identity.isSymbolicLink(), true);
      assert.equal(ownership.root, f.h.root);
      assert.equal(ownership.dev, identity.dev);
      assert.equal(ownership.ino, identity.ino);
      assert.equal(path.dirname(f.h.root), ownership.runRoot);
      assert.match(
        path.basename(f.h.root),
        /^REMOTE-BACKUP-INTEGRATED-BROWSER-/,
      );
      await fs.rm(f.h.root, { recursive: true });
      if (!process.env.ZHIXU_S1B_SANDBOX) {
        const names = await fs.readdir(ownership.runRoot);
        if (names.length === 1 && names[0] === '.s1b-run-owner.json') {
          await fs.unlink(path.join(ownership.runRoot, names[0]));
          await fs.rmdir(ownership.runRoot);
        }
      }
    });
    const page = await (
      await browser.newContext({ locale: 'en-US', acceptDownloads: true })
    ).newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(f.app.origin + '/setting');
    await page.getByLabel('Username', { exact: true }).fill('owner');
    await page.getByLabel('Password', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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
    await config
      .getByRole('button', { name: 'New remote target', exact: true })
      .click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Browser WebDAV');
    await dialog
      .getByLabel('Type', { exact: true })
      .locator('xpath=../..')
      .click();
    await page.getByTitle('WebDAV', { exact: true }).click();
    await dialog
      .getByLabel('Endpoint', { exact: true })
      .fill(dav.target.endpoint);
    await dialog
      .getByLabel('Remote directory (optional)', { exact: true })
      .fill(dav.target.directory);
    await dialog
      .getByLabel('Username (optional)', { exact: true })
      .fill(dav.target.username);
    await dialog
      .getByLabel('Password or app password', { exact: true })
      .fill(dav.target.password);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/backups/remote/targets',
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const createdResponse = await created;
    assert.equal(createdResponse.status(), 200);
    const target = (await createdResponse.json()).data;
    assert.equal(target.has_password, true);
    assert.equal(target.password, undefined);
    await dialog.waitFor({ state: 'hidden' });
    await config
      .getByRole('button', { name: 'Test connection', exact: true })
      .click();
    await config
      .getByText('Connection and write permission test passed.', {
        exact: true,
      })
      .waitFor();
    await automatic
      .getByRole('button', { name: 'Remote backup settings', exact: true })
      .click();
    dialog = page.getByRole('dialog');
    const phrase = 'independent-browser-recovery-key';
    await dialog
      .getByLabel('Recovery passphrase', { exact: true })
      .fill(phrase);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === '/api/backups/remote/settings',
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal((await saved).status(), 200);
    await dialog.waitFor({ state: 'hidden' });
    await automatic
      .getByText('Recovery passphrase configured', { exact: true })
      .waitFor();
    await remote
      .getByRole('combobox', { name: 'Local backup snapshot', exact: true })
      .locator('xpath=../..')
      .click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .first()
      .click();
    const uploaded = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/backups/remote/uploads',
    );
    await remote
      .getByRole('button', { name: 'Upload encrypted backup', exact: true })
      .click();
    assert.equal((await uploaded).status(), 200);
    const finished = await until(
      () => f.request('GET', '/api/backups/remote/uploads'),
      (response) => response.body.data?.[0]?.status === 'SUCCESS',
    );
    const upload = finished.body.data[0];
    assert.equal(upload.snapshot_id, snapshot);
    assert.equal(upload.mode, 'FULL');
    assert.equal(upload.source, 'MANUAL');
    await remote.getByRole('button', { name: /Refresh$/ }).click();
    const objectRow = remote
      .locator('tr')
      .filter({ has: page.getByText(snapshot, { exact: true }) });
    await objectRow.waitFor();
    assert.match(await objectRow.innerText(), /Full backup[\s\S]*Manual/);
    const downloaded = page.waitForEvent('download');
    await objectRow
      .getByRole('button', { name: 'Download', exact: true })
      .click();
    const download = await downloaded;
    const payload = await fs.readFile(await download.path());
    assert.equal(payload.subarray(0, 8).toString(), 'PLATBKP1');
    assert.equal(payload.length, upload.size);
    assert.equal(
      payload.includes(Buffer.from('browser-remote-business-content')),
      false,
    );
    assert.equal(dav.objects.size, 1);
    await objectRow
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await page.locator('.ant-popover-buttons .ant-btn-primary').click();
    await objectRow.waitFor({ state: 'hidden' });
    assert.equal(dav.objects.size, 0);
    assert.equal((await f.app.services.backup.list()).length, 1);
    assert.deepEqual(errors, []);
  },
);
