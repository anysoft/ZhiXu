// S5 reruns preserved UI/domain assertions against an explicit compiled release candidate.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  browserFixture,
  waitForDialogOpening,
} = require('./browser-support.cjs');

test(
  'S5 real browser: exact Task argument rows preserve empty strings, whitespace and embedded newlines across unrelated edits and execution',
  { timeout: 180000 },
  async () => {
    const f = await browserFixture('s5-browser-exact-arguments');
    const gates = [];
    try {
      const { page } = await f.context();
      await f.login(page, true);
      await page
        .locator('.ant-menu')
        .getByText('Script Workspaces', { exact: true })
        .click();
      await page.getByRole('button', { name: /New workspace$/ }).click();
      let dialog = page.getByRole('dialog');
      await dialog
        .getByLabel('Name', { exact: true })
        .fill('Exact argument workspace');
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await page.waitForURL(/\/workspaces\/\d+\?tab=files/);
      const workspaceId = Number(new URL(page.url()).pathname.split('/').pop());
      await page.getByRole('button', { name: 'New file', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog
        .getByLabel('Relative path', { exact: true })
        .fill('arguments.sh');
      await dialog
        .getByLabel('Content', { exact: true })
        .fill(
          '#!/bin/sh\nprintf "ARG_COUNT=%s\\n" "$#"\nfor value do printf "ARG=<%s>\\n" "$value"; done\n',
        );
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await page
        .locator('.v2-file-item span')
        .filter({ hasText: 'arguments.sh' })
        .click();
      await page.locator('[data-testid="source-editor"] .cm-content').waitFor();
      const entries = page.waitForResponse((r) =>
        r.url().endsWith(`/api/workspaces/${workspaceId}/entries`),
      );
      await page
        .getByRole('link', { name: 'Create task from file', exact: true })
        .click();
      assert.equal((await entries).status(), 200);
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name', { exact: true }).fill('Exact arguments');
      let response = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname === '/api/tasks',
      );
      await dialog.getByRole('button', { name: /Save$/ }).click();
      let saved = await response;
      assert.equal(saved.status(), 200);
      let task = (await saved.json()).data;
      assert.deepEqual(task.arguments, []);
      await page.waitForURL(new RegExp('/tasks/' + task.id + '$'));
      gates.push('EMPTY_ARGUMENT_LIST_PRESERVED');
      const taskId = task.id;
      const expected = [' leading space ', '', 'line one\nline two'];
      for (const stage of [
        'ONE_EMPTY_ARGUMENT',
        'EXACT_ARGUMENTS',
        'UNRELATED_NAME_EDIT',
      ]) {
        const detail = page.waitForResponse(
          (r) =>
            r.request().method() === 'GET' &&
            new URL(r.url()).pathname === '/api/tasks/' + taskId,
        );
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        dialog = page.getByRole('dialog');
        await waitForDialogOpening(dialog);
        await dialog.getByRole('tab', { name: 'Runtime', exact: true }).click();
        if (stage === 'ONE_EMPTY_ARGUMENT') {
          await dialog
            .getByRole('button', { name: 'Add argument', exact: true })
            .click();
        } else if (stage === 'EXACT_ARGUMENTS') {
          await dialog
            .getByLabel('Argument 1', { exact: true })
            .fill(expected[0]);
          await dialog
            .getByRole('button', { name: 'Add argument', exact: true })
            .click();
          await dialog
            .getByRole('button', { name: 'Add argument', exact: true })
            .click();
          await dialog
            .getByLabel('Argument 3', { exact: true })
            .fill(expected[2]);
        } else {
          for (let i = 0; i < expected.length; i++)
            assert.equal(
              await dialog
                .getByLabel('Argument ' + (i + 1), { exact: true })
                .inputValue(),
              expected[i],
            );
          await dialog
            .getByRole('tab', { name: 'Source', exact: true })
            .click();
          await dialog
            .getByLabel('Name', { exact: true })
            .fill('Exact arguments renamed');
        }
        response = page.waitForResponse(
          (r) =>
            r.request().method() === 'PUT' &&
            new URL(r.url()).pathname === '/api/tasks/' + taskId,
        );
        await dialog.getByRole('button', { name: /Save$/ }).click();
        saved = await response;
        assert.equal(saved.status(), 200);
        task = (await saved.json()).data;
        assert.deepEqual(
          task.arguments,
          stage === 'ONE_EMPTY_ARGUMENT' ? [''] : expected,
        );
        assert.equal((await detail).status(), 200);
        await dialog.waitFor({ state: 'hidden' });
        gates.push(stage);
      }
      await page.getByRole('button', { name: 'Run now', exact: true }).click();
      await page.waitForURL(/\/runs\/\d+$/);
      const runId = Number(new URL(page.url()).pathname.split('/').pop());
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="run-log"]')
            ?.textContent?.includes('ARG_COUNT=3'),
        undefined,
        { timeout: 30000 },
      );
      const run = await f.app.services.execution.wait(runId, 30000);
      assert.equal(run.status, 'SUCCESS');
      const logs = await page.getByTestId('run-log').textContent();
      for (const argument of expected)
        assert.ok(logs.includes('ARG=<' + argument + '>'));
      gates.push('REAL_CHILD_RECEIVES_EXACT_ARGV');
      await f.scenario.record('s5-browser-exact-arguments', {
        gates,
        workspaceId,
        taskId,
        runId,
        argument_count: expected.length,
        production_application: true,
        mocked_http: false,
        traffic: f.traffic,
        page_error_count: f.pageErrors.length,
      });
      assert.equal(f.pageErrors.length, 0);
    } catch (error) {
      await f.scenario.record('s5-browser-exact-arguments-failure', {
        gates,
        traffic: f.traffic,
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
