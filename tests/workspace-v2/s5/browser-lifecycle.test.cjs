// S5 reruns preserved UI/domain assertions against an explicit compiled release candidate.
const { artifactModule, releaseRoot } = require('./artifact-support.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const {
  browserFixture,
  waitForDialogOpening,
} = require('./browser-support.cjs');
const { WorkspaceLifecycleService } = artifactModule(
  'services/workspaceV2/lifecycle',
);
async function readPreservedAfterRecovery(files, workspaceId) {
  const deadline = Date.now() + 5000;
  let busyRetries = 0;
  for (;;) {
    try {
      return { result: await files.read(workspaceId, 'kept.txt'), busyRetries };
    } catch (error) {
      if (error.error_code !== 'WORKSPACE_BUSY' || Date.now() >= deadline)
        throw error;
      busyRetries++;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
async function workspace(page, name) {
  await page
    .locator('.ant-menu')
    .getByText('Script Workspaces', { exact: true })
    .click();
  await page.getByRole('button', { name: /New workspace$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: /Save$/ }).click();
  await page.waitForURL(/\/workspaces\/\d+\?tab=files/);
  return Number(new URL(page.url()).pathname.split('/').pop());
}
async function operation(page, kind) {
  const response = await page.waitForResponse(
    async (response) => {
      if (
        !response.url().includes('/api/backups/operations/') ||
        response.request().method() !== 'GET' ||
        response.status() !== 200
      )
        return false;
      const payload = await response.json();
      return (
        payload.data?.kind === kind &&
        ['SUCCESS', 'FAILED'].includes(payload.data?.status)
      );
    },
    { timeout: 90000 },
  );
  const result = (await response.json()).data;
  assert.equal(result.status, 'SUCCESS');
  return result;
}
test(
  'S5 E2E05 real browser archive/read-only/unarchive, isolated permissions and portable backup preview/staging',
  { timeout: 360000 },
  async () => {
    let restarted = 0;
    const f = await browserFixture('s5-browser-lifecycle-portable', {
        onRestartRequested: () => {
          restarted++;
        },
      }),
      gates = [];
    try {
      const a = await f.context(),
        page = a.page;
      const loginResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/user/login') &&
          response.request().method() === 'POST',
      );
      await f.login(page, true);
      const session = (await (await loginResponse).json()).data;
      f.scenario.registerSecret(session.token);
      f.scenario.registerSecret(session.csrf_token);
      const name = 'Browser lifecycle source',
        id = await workspace(page, name);
      await page.getByRole('button', { name: 'New file', exact: true }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('Relative path', { exact: true }).fill('main.sh');
      await dialog
        .getByLabel('Content', { exact: true })
        .fill('#!/bin/sh\nprintf "BROWSER_PORTABLE_SOURCE\\n"\n');
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      let row = page
        .getByRole('row')
        .filter({ has: page.getByRole('link', { name, exact: true }) });
      const archived = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/workspaces/${id}/archive`) &&
          response.request().method() === 'POST',
      );
      await row.getByRole('button', { name: 'Archive', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /Save$/ })
        .click();
      assert.equal((await archived).status(), 202);
      await row.getByText('Archived', { exact: true }).waitFor();
      await row.getByRole('link', { name, exact: true }).click();
      await page.getByRole('tab', { name: 'Files', exact: true }).click();
      await page.getByText('Read-only', { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: 'New file', exact: true })
          .isDisabled(),
        true,
      );
      await page
        .locator('.v2-file-item span')
        .filter({ hasText: 'main.sh' })
        .click();
      const editor = page.locator('[data-testid="source-editor"] .cm-content');
      await editor.waitFor();
      assert.equal(await editor.getAttribute('contenteditable'), 'false');
      assert.match(await editor.textContent(), /BROWSER_PORTABLE_SOURCE/);
      assert.equal(
        await page.getByRole('button', { name: /Save$/ }).isDisabled(),
        true,
      );
      const archivedShot = await f.screenshot(page, 'archived-source-readonly');
      gates.push('ARCHIVE_ACTUAL_202_SOURCE_RETAINED_READONLY');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      row = page
        .getByRole('row')
        .filter({ has: page.getByRole('link', { name, exact: true }) });
      const unarchived = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/workspaces/${id}/unarchive`) &&
          response.request().method() === 'POST',
      );
      await row.getByRole('button', { name: 'Unarchive', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /Save$/ })
        .click();
      assert.equal((await unarchived).status(), 202);
      await row.getByText('Ready', { exact: true }).waitFor();
      gates.push('UNARCHIVE_ACTUAL_202');
      const isolated = await f.context();
      await isolated.context.addCookies([
        { name: 'token', value: session.token, url: f.app.origin },
      ]);
      const cookieOnly = await isolated.context.request.get(
        f.app.origin + '/api/workspaces',
      );
      assert.equal(cookieOnly.status(), 401);
      const appToken = await isolated.context.request.get(
        f.app.origin + '/api/workspaces',
        { headers: { Authorization: 'Bearer app-invalid-browser-credential' } },
      );
      assert.equal(appToken.status(), 401);
      const originDenied = await isolated.context.request.post(
        f.app.origin + '/api/workspaces',
        {
          headers: {
            Authorization: 'Bearer ' + session.token,
            Origin: 'https://foreign-origin.invalid',
            'X-CSRF-Token': session.csrf_token,
            'Idempotency-Key': randomUUID(),
          },
          data: { type: 'LOCAL', name: 'Forbidden origin' },
        },
      );
      assert.equal(originDenied.status(), 403);
      await isolated.page.goto(f.app.origin + '/workspaces');
      await isolated.page
        .getByRole('button', { name: 'Sign in', exact: true })
        .waitFor();
      gates.push('SECOND_CONTEXT_COOKIE_APP_CREDENTIAL_ORIGIN_DENIED');
      await page
        .locator('.ant-menu')
        .getByText('Settings', { exact: true })
        .click();
      await page
        .getByRole('tab', { name: 'Backup / Restore', exact: true })
        .click();
      const snapshotDone = operation(page, 'SNAPSHOT');
      await page
        .getByRole('button', { name: 'Create backup', exact: true })
        .click();
      const snapshot = await snapshotDone;
      row = page
        .getByRole('row')
        .filter({ has: page.getByText(snapshot.result, { exact: true }) });
      await row.waitFor();
      await row
        .getByRole('button', { name: 'Check readiness', exact: true })
        .click();
      await page
        .getByText('zhixu.workspace.v2.s0.1', { exact: true })
        .waitFor();
      const phrase = 'Browser private phrase ' + randomUUID();
      f.scenario.registerSecret(phrase);
      await row
        .getByRole('button', { name: 'Encrypted export', exact: true })
        .click();
      dialog = page.getByRole('dialog');
      await dialog
        .getByLabel('Backup passphrase', { exact: true })
        .fill(phrase);
      await dialog.getByLabel('Confirm password', { exact: true }).fill(phrase);
      const exportDone = operation(page, 'EXPORT');
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await exportDone;
      const downloading = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      const download = await downloading;
      const archive = path.join(
        f.scenario.evidenceRoot,
        'actual-browser-export.platform-backup',
      );
      await download.saveAs(archive);
      const archiveBytes = await fs.readFile(archive);
      assert.ok(archiveBytes.length > 80);
      await page
        .getByRole('button', { name: 'Import encrypted backup', exact: true })
        .click();
      dialog = page.getByRole('dialog');
      await dialog
        .getByLabel('Backup archive', { exact: true })
        .setInputFiles(archive);
      await dialog
        .getByLabel('Backup passphrase', { exact: true })
        .fill(phrase);
      const importDone = operation(page, 'IMPORT');
      await dialog.getByRole('button', { name: /Save$/ }).click();
      const imported = await importDone;
      const importCard = page.locator('.ant-card').filter({
        has: page
          .locator('.ant-card-head-title')
          .getByText('Import encrypted backup', { exact: true }),
      });
      await importCard.waitFor();
      const validated = operation(page, 'VALIDATE_IMPORT');
      await importCard
        .getByRole('button', {
          name: 'Validate restore candidate',
          exact: true,
        })
        .click();
      await validated;
      const stage = importCard.getByRole('button', {
        name: 'Stage restore',
        exact: true,
      });
      await stage.waitFor();
      await stage.click({ trial: true });
      const previewShot = await f.screenshot(page, 'actual-portable-preview');
      assert.ok(
        f.traffic.some(
          (entry) =>
            entry.path === `/api/restores/${imported.result.id}/preview` &&
            entry.status === 200,
        ),
      );
      await stage.click();
      dialog = page.getByRole('dialog');
      await dialog
        .getByLabel('Type RESTORE to stage this validated candidate', {
          exact: true,
        })
        .fill('RESTORE');
      const staged = operation(page, 'STAGE_RESTORE');
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await staged;
      await f.app.restartRequested;
      assert.equal(restarted, 1);
      assert.equal((await f.app.services.restore.status()).stage, 'PENDING');
      gates.push(
        'REAL_UI_SNAPSHOT_EXPORT_DOWNLOAD_IMPORT_VALIDATE_PREVIEW',
        'REAL_UI_CONFIRMATION_PENDING_CONTROLLED_RESTART',
      );
      assert.equal(f.pageErrors.length, 0);
      await f.scenario.record('s5-browser-lifecycle-portable', {
        status: 'PASS',
        workspace_id: id,
        snapshot_id: snapshot.result,
        import_id: imported.result.id,
        gates,
        artifact: f.artifact,
        screenshots: [archivedShot, previewShot],
        portable_archive: {
          bytes: archiveBytes.length,
          sha256: createHash('sha256').update(archiveBytes).digest('hex'),
        },
        actual_http: f.traffic,
        page_errors: f.pageErrors,
      });
    } catch (error) {
      await f.scenario.record('s5-browser-lifecycle-portable-failure', {
        status: 'FAIL',
        gates,
        error_code:
          error.code ?? error.error_code ?? error.name ?? 'BROWSER_FAILURE',
        actual_http: f.traffic,
        page_errors: f.pageErrors,
      });
      throw error;
    } finally {
      await f.close();
    }
  },
);

test(
  'S5 real browser preserves owned interrupted create and refuses unknown replacement root recovery',
  { timeout: 240000 },
  async () => {
    const f = await browserFixture('s5-browser-recovery-ownership'),
      gates = [];
    try {
      const { page } = await f.context();
      await f.login(page, true);
      const fired = new Set(),
        service = new WorkspaceLifecycleService(
          f.app.services.store,
          f.app.services.roots,
          f.app.services.leases,
          {
            fault: async (point, details) => {
              if (
                point === 'CREATE_BEFORE_READY' &&
                !fired.has(details.workspace_id)
              ) {
                fired.add(details.workspace_id);
                throw Error('CONTROLLED_CREATE_INTERRUPTION');
              }
            },
          },
        );
      f.app.services.lifecycle = service;
      const createInterrupted = async (name) => {
        await page
          .locator('.ant-menu')
          .getByText('Script Workspaces', { exact: true })
          .click();
        await page.getByRole('button', { name: /New workspace$/ }).click();
        let dialog = page.getByRole('dialog');
        await dialog.getByLabel('Name', { exact: true }).fill(name);
        const response = page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/workspaces') &&
            response.request().method() === 'POST',
        );
        await dialog.getByRole('button', { name: /Save$/ }).click();
        assert.ok((await response).status() >= 400);
        await dialog
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
        const row = page
          .getByRole('row')
          .filter({ has: page.getByRole('link', { name, exact: true }) });
        await row
          .getByRole('button', { name: 'Recover', exact: true })
          .waitFor();
        const ws = (
          await f.app.services.store.all(
            'SELECT * FROM Workspaces WHERE name=?',
            [name],
          )
        )[0];
        assert.equal(ws.lifecycle_state, 'RECOVERY_REQUIRED');
        return { row, ws };
      };
      const owned = await createInterrupted('Recoverable real journal');
      const ownedRoot = (await f.app.services.roots.requireOwned(owned.ws))
        .root;
      await fs.writeFile(
        path.join(ownedRoot, 'kept.txt'),
        'owned unique source remains\n',
        { mode: 0o600 },
      );
      const recovered = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/workspaces/${owned.ws.id}/recover`) &&
          response.request().method() === 'POST',
      );
      await owned.row
        .getByRole('button', { name: 'Recover', exact: true })
        .click();
      await waitForDialogOpening(page.getByRole('dialog'));
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /Save$/ })
        .click();
      assert.equal((await recovered).status(), 202);
      const preserved = await readPreservedAfterRecovery(
        f.app.services.files,
        owned.ws.id,
      );
      assert.equal(preserved.result.content, 'owned unique source remains\n');
      gates.push('GENUINE_CREATE_JOURNAL_UI_RECOVERY_SOURCE_PRESERVED');
      const unknown = await createInterrupted('Unknown root journal'),
        original = (await f.app.services.roots.requireOwned(unknown.ws)).root,
        held = path.join(f.scenario.root, 'held-owned-create-' + unknown.ws.id);
      await fs.rename(original, held);
      await fs.mkdir(original, { mode: 0o700 });
      await fs.writeFile(
        path.join(original, 'unknown.txt'),
        'unknown source preserved',
        { mode: 0o600 },
      );
      const refused = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/workspaces/${unknown.ws.id}/recover`) &&
          response.request().method() === 'POST',
      );
      await unknown.row
        .getByRole('button', { name: 'Recover', exact: true })
        .click();
      await waitForDialogOpening(page.getByRole('dialog'));
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /Save$/ })
        .click();
      assert.ok((await refused).status() >= 400);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      assert.equal(
        await fs.readFile(path.join(original, 'unknown.txt'), 'utf8'),
        'unknown source preserved',
      );
      await unknown.row
        .getByRole('link', { name: 'Unknown root journal', exact: true })
        .click();
      await page.getByRole('tab', { name: 'Files', exact: true }).click();
      await page.getByText('Read-only', { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: 'New file', exact: true })
          .isDisabled(),
        true,
      );
      const screenshot = await f.screenshot(
        page,
        'unknown-root-recovery-readonly',
      );
      gates.push(
        'UNKNOWN_REPLACEMENT_ROOT_RECOVERY_REJECTED',
        'RECOVERY_REQUIRED_UI_READONLY_NO_SOURCE_ADOPTION',
      );
      assert.equal(f.pageErrors.length, 0);
      await f.scenario.record('s5-browser-recovery-ownership', {
        status: 'PASS',
        workspace_ids: [owned.ws.id, unknown.ws.id],
        post_recovery_read_busy_retries: preserved.busyRetries,
        gates,
        artifact: f.artifact,
        screenshot,
        actual_http: f.traffic,
        page_errors: f.pageErrors,
      });
    } catch (error) {
      await f.scenario.record('s5-browser-recovery-ownership-failure', {
        status: 'FAIL',
        gates,
        error_code:
          error.code ?? error.error_code ?? error.name ?? 'BROWSER_FAILURE',
        actual_http: f.traffic,
        page_errors: f.pageErrors,
      });
      throw error;
    } finally {
      await f.close();
    }
  },
);
