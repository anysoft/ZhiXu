// S5 reruns preserved UI/domain assertions against an explicit compiled release candidate.
const test = require('node:test');
const assert = require('node:assert/strict');
const { browserFixture } = require('./browser-support.cjs');

test(
  'S5 real browser: first setup, LOCAL editor multi-session CAS, Task execution/logs, locale and owner session isolation',
  { timeout: 180000 },
  async () => {
    const f = await browserFixture('s5-browser-local-core');
    const gates = [];
    try {
      const a = await f.context(),
        page = a.page;
      await f.login(page, true);
      gates.push('FRESH_SETUP_REAL_AUTH');
      await page
        .locator('.ant-menu')
        .getByText('Script Workspaces', { exact: true })
        .click();
      await page.getByRole('button', { name: /New workspace$/ }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name', { exact: true }).fill('Browser LOCAL');
      assert.equal(
        await dialog.getByText('Repository', { exact: true }).count(),
        0,
      );
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await page.waitForURL(/\/workspaces\/\d+\?tab=files/);
      const workspaceId = Number(new URL(page.url()).pathname.split('/').pop());
      await page
        .getByRole('button', { name: 'New file', exact: true })
        .waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'New file', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Relative path', { exact: true }).fill('main.sh');
      await dialog
        .getByLabel('Content', { exact: true })
        .fill('#!/bin/sh\nprintf "BROWSER_INITIAL\\n"\n');
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await page
        .locator('.v2-file-item span')
        .filter({ hasText: 'main.sh' })
        .click();
      const editor = page.locator('[data-testid="source-editor"] .cm-content');
      await editor.fill('#!/bin/sh\nprintf "BROWSER_A_DRAFT\\n"\n');
      await page.getByText('Unsaved changes', { exact: true }).waitFor();
      const b = await f.context();
      await f.login(b.page);
      await b.page
        .locator('.ant-menu')
        .getByText('Script Workspaces', { exact: true })
        .click();
      await b.page
        .getByRole('link', { name: 'Browser LOCAL', exact: true })
        .click();
      await b.page.getByRole('tab', { name: 'Files', exact: true }).click();
      await b.page
        .locator('.v2-file-item span')
        .filter({ hasText: 'main.sh' })
        .click();
      const second = '#!/bin/sh\nprintf "BROWSER_B_COMMITTED\\n"\n';
      await b.page
        .locator('[data-testid="source-editor"] .cm-content')
        .fill(second);
      const savedB = b.page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().endsWith(`/api/workspaces/${workspaceId}/files`),
      );
      await b.page.getByRole('button', { name: /Save$/ }).click();
      assert.equal((await savedB).status(), 200);
      const staleA = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().endsWith(`/api/workspaces/${workspaceId}/files`),
      );
      await page.getByRole('button', { name: /Save$/ }).click();
      assert.equal((await staleA).status(), 409);
      assert.match(await editor.textContent(), /BROWSER_A_DRAFT/);
      assert.equal(
        (await f.app.services.files.read(workspaceId, 'main.sh')).content,
        second,
      );
      assert.equal(
        await page.getByRole('button', { name: /Save$/ }).isDisabled(),
        true,
      );
      await page
        .getByText('The file changed on disk. Your draft has been kept.', {
          exact: true,
        })
        .waitFor();
      const conflictShot = await f.screenshot(page, 'local-cas-conflict');
      gates.push(
        'LOCAL_WITHOUT_REPOSITORY',
        'ACTUAL_EDITOR_CAS_409_DRAFT_PRESERVED',
      );
      await page
        .getByRole('button', { name: 'Reload from disk', exact: true })
        .click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Confirm', exact: true })
        .click();
      await editor
        .getByText('printf "BROWSER_B_COMMITTED\\n"', { exact: true })
        .waitFor();
      const entriesReady = page.waitForResponse((r) =>
        r.url().endsWith(`/api/workspaces/${workspaceId}/entries`),
      );
      await page
        .getByRole('link', { name: 'Create task from file', exact: true })
        .click();
      assert.equal((await entriesReady).status(), 200);
      dialog = page.getByRole('dialog');
      await dialog
        .getByLabel('Name', { exact: true })
        .fill('Browser Shell task');
      const submitted = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname === '/api/tasks',
      );
      await dialog.getByRole('button', { name: /Save$/ }).click();
      const submittedResponse = await submitted;
      if (submittedResponse.status() !== 200) {
        const body = await submittedResponse.json();
        throw Object.assign(new Error('TASK_CREATE_REJECTED'), {
          code: body.error_code || 'TASK_CREATE_FAILED',
        });
      }
      await page.waitForURL(/\/tasks\/\d+$/);
      const taskId = Number(new URL(page.url()).pathname.split('/').pop());
      await page.getByRole('button', { name: 'Run now', exact: true }).click();
      await page.waitForURL(/\/runs\/\d+$/);
      const runId = Number(new URL(page.url()).pathname.split('/').pop());
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="run-log"]')
            ?.textContent?.includes('BROWSER_B_COMMITTED'),
        undefined,
        { timeout: 30000 },
      );
      const run = await f.app.services.execution.wait(runId, 30000);
      assert.equal(run.status, 'SUCCESS');
      assert.equal(run.task_id, taskId);
      assert.equal(run.workspace_id, workspaceId);
      assert.equal(
        (
          await f.app.services.store.all('SELECT COUNT(*) n FROM Repositories')
        )[0].n,
        0,
      );
      gates.push('UI_TASK_CREATION', 'REAL_SHELL_EXECUTION_LOGS');
      await page
        .locator('#v2-language-picker')
        .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
        .click();
      await page.getByText('简体中文', { exact: true }).last().click();
      await page
        .locator('.ant-menu')
        .getByText('脚本工作区', { exact: true })
        .waitFor();
      await page
        .getByRole('tab', { name: '历史源码快照', exact: true })
        .click();
      const chineseShot = await f.screenshot(page, 'run-snapshot-zh');
      gates.push('ZH_CN_PRODUCT_LOCALE');
      const storage = await page.evaluate(() => ({
        local: { ...localStorage },
        session: { ...sessionStorage },
        cookies: document.cookie,
      }));
      assert.equal(
        /Bearer |desktop-|mobile-|csrf_token|"token"/.test(
          JSON.stringify(storage),
        ),
        false,
      );
      assert.equal(f.pageErrors.length, 0);
      await page.reload();
      await page.getByLabel('用户名', { exact: true }).waitFor();
      gates.push('MEMORY_ONLY_PANEL_AUTH_RELOAD_REQUIRES_LOGIN');
      await page.getByLabel('用户名', { exact: true }).fill('s5-owner');
      await page.getByLabel('密码', { exact: true }).fill(f.password);
      await page.getByRole('button', { name: /^登\s*录$/ }).click();
      await page.getByTestId('run-log').waitFor();
      assert.equal(
        Number(new URL(page.url()).pathname.split('/').pop()),
        runId,
      );
      assert.equal((await f.app.services.execution.get(runId)).task_id, taskId);
      gates.push('RELOGIN_RELOAD_RETAINS_REAL_IDS_HISTORY');
      await f.scenario.record('s5-browser-local-core', {
        gates,
        workspaceId,
        taskId,
        runId,
        screenshots: [conflictShot, chineseShot],
        traffic: f.traffic,
        page_error_count: f.pageErrors.length,
        actual_browser: f.engine + ' / ' + f.browser.version(),
        production_application: true,
        mocked_http: false,
      });
    } catch (error) {
      await f.scenario.record('s5-browser-local-core-failure', {
        gates,
        traffic: f.traffic,
        page_errors: f.pageErrors,
        status: 'FAIL',
        error_name: error.name,
        error_code: error.code || 'BROWSER_CASE_FAILED',
        frames: String(error.stack || '')
          .split('\n')
          .filter((line) => line.trimStart().startsWith('at ')),
      });
      throw error;
    } finally {
      await f.close();
    }
  },
);
