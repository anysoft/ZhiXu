const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { git, assertOwnedInstance } = require('./fixture.cjs');
const {
  CandidateGitResources,
} = require('../../../back/applicationV2/repositoryResources');
const { browserFixture } = require('./browser-support.cjs');
async function eventually(read, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Object.assign(new Error('CONDITION_NOT_REACHED'), {
    code: 'CONDITION_NOT_REACHED',
  });
}
async function select(page, container, label, value) {
  await container
    .getByLabel(label, { exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText(value, { exact: true })
    .last()
    .click();
}
test(
  'S4 real browser Git repository/workspace Sync/Discovery and GitUpdate Outbox → actual TaskRun; NO_CHANGE adds no run',
  { timeout: 360000 },
  async () => {
    let remote, remoteUrl, access, instance;
    const name = 'Browser discovered',
      gates = [];
    const script = (marker) => `# name: ${name}\nprintf "${marker}\\n"\n`;
    const f = await browserFixture('s4-browser-git', {
      prepare: async (owned) => {
        instance = owned;
        remote = path.join(owned.root, 'controlled-remote');
        await fs.mkdir(remote, { mode: 0o700 });
        git(['init', '-b', 'main'], remote);
        git(['config', 'user.name', 'S4 fixture'], remote);
        git(['config', 'user.email', 'fixture@example.invalid'], remote);
        await fs.writeFile(
          path.join(remote, 'main.sh'),
          script('BROWSER_GIT_INITIAL'),
          { mode: 0o600 },
        );
        git(['add', 'main.sh'], remote);
        git(['commit', '-m', 'actual initial remote'], remote);
        remoteUrl = pathToFileURL(remote).href;
        const initial = await fs.lstat(remote);
        access = async (row) => {
          await assertOwnedInstance(owned.root);
          const now = await fs.lstat(remote);
          assert.equal(row.remote_url, remoteUrl);
          assert.equal(await fs.realpath(remote), remote);
          assert.equal(now.dev, initial.dev);
          assert.equal(now.ino, initial.ino);
          assert.equal(now.mode & 0o077, 0);
          return {
            remote: remoteUrl,
            directory: remote,
            secrets: [],
            cleanup: async () => {},
            env: {
              GIT_ALLOW_PROTOCOL: 'file',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_TERMINAL_PROMPT: '0',
            },
          };
        };
      },
      git: { accessResolver: (row) => access(row) },
      createGitResources: (s) =>
        new CandidateGitResources(s, {
          accessResolver: (row) => access(row),
          normalizeRemote: async (value) => {
            assert.equal(value, remoteUrl);
            await assertOwnedInstance(instance.root);
            return {
              remote_url: value,
              normalized_url: value,
              provider: 'generic',
              host: 'owned-fixture.invalid',
              path: 'browser/scripts',
              owner: 'browser',
              repository_name: 'scripts',
            };
          },
        }),
    });
    try {
      const { page } = await f.context();
      await f.login(page, true);
      await page
        .locator('.ant-menu')
        .getByText('Git Repositories', { exact: true })
        .click();
      await page
        .getByRole('button', { name: 'New repository', exact: true })
        .click();
      let dialog = page.getByRole('dialog');
      await dialog
        .getByLabel('Name', { exact: true })
        .fill('Browser controlled repository');
      await dialog
        .getByLabel('Repository URL', { exact: true })
        .fill(remoteUrl);
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await page
        .getByRole('button', {
          name: 'Browser controlled repository',
          exact: true,
        })
        .click();
      const initialized = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/repositories/1/initialize'),
      );
      await page
        .getByRole('button', { name: 'Initialize repository', exact: true })
        .click();
      assert.equal((await initialized).status(), 200);
      await page.waitForFunction(
        () => !document.querySelector('.ant-drawer .ant-btn-loading'),
      );
      await page.locator('.ant-drawer-close').click();
      gates.push('UI_REPOSITORY_CREATE_REAL_INITIALIZE_FETCH');
      await page
        .locator('.ant-menu')
        .getByText('Script Workspaces', { exact: true })
        .click();
      await page.getByRole('button', { name: /New workspace$/ }).click();
      dialog = page.getByRole('dialog');
      await select(page, dialog, 'Type', 'Git');
      await dialog.getByLabel('Name', { exact: true }).fill('Browser GIT');
      await select(page, dialog, 'Repository', 'Browser controlled repository');
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await page.waitForURL(/\/workspaces\/\d+\?tab=files/);
      const wsId = Number(new URL(page.url()).pathname.split('/').pop());
      await page.getByRole('tab', { name: 'Sync policy', exact: true }).click();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Enabled', { exact: true }).check();
      await dialog.getByRole('button', { name: /Save$/ }).click();
      async function syncNow() {
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        const response = page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            new URL(r.url()).pathname === `/api/workspaces/${wsId}/sync`,
        );
        await page
          .getByRole('button', { name: 'Sync now', exact: true })
          .click();
        const http = await response;
        assert.equal(http.status(), 202);
        const row = (await http.json()).data;
        return eventually(async () => {
          const current = await f.app.services.sync.get(row.id);
          return (
            [
              'SUCCESS',
              'NO_CHANGE',
              'BLOCKED',
              'FAILED',
              'RECOVERY_REQUIRED',
            ].includes(current.status) && current
          );
        });
      }
      const initialSync = await syncNow();
      assert.ok(['SUCCESS', 'NO_CHANGE'].includes(initialSync.status));
      gates.push('UI_GIT_WORKSPACE_CONFIGURE_SYNC_REAL_MANUAL_SYNC');
      await page.getByRole('tab', { name: 'Discovery', exact: true }).click();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Enabled', { exact: true }).check();
      await dialog.getByRole('button', { name: /Save$/ }).click();
      const previewResponse = page.waitForResponse((r) =>
        r.url().endsWith(`/workspaces/${wsId}/discovery/preview`),
      );
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      assert.equal((await previewResponse).status(), 200);
      assert.equal(
        (await f.app.services.store.all('SELECT COUNT(*) n FROM Tasks'))[0].n,
        0,
      );
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await page
        .locator('.ant-popover:visible')
        .locator('.ant-popover-buttons button.ant-btn-primary')
        .click();
      const task = await eventually(async () => {
        const rows = await f.app.services.store.all(
          'SELECT * FROM Tasks WHERE origin=?',
          ['DISCOVERED'],
        );
        return rows[0];
      });
      assert.equal(task.discovery_state, 'ACTIVE');
      gates.push('UI_READONLY_DISCOVERY_PREVIEW_AND_CONFIRMED_APPLY');
      await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
      await page.getByRole('link', { name, exact: true }).click();
      const entryOptions = page.waitForResponse((r) =>
        r.url().endsWith(`/api/workspaces/${wsId}/entries`),
      );
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      assert.equal((await entryOptions).status(), 200);
      dialog = page.getByRole('dialog');
      await dialog
        .getByRole('tab', { name: 'Execution policy', exact: true })
        .click();
      await dialog.getByLabel('Enabled', { exact: true }).check();
      const enabledTask = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          new URL(r.url()).pathname === `/api/tasks/${task.id}`,
      );
      const refreshedTask = page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          new URL(r.url()).pathname === `/api/tasks/${task.id}`,
      );
      await dialog.getByRole('button', { name: /Save$/ }).click();
      const enabledResponse = await enabledTask;
      assert.equal(enabledResponse.status(), 200);
      assert.equal((await enabledResponse.json()).data.enabled, true);
      assert.equal((await refreshedTask).status(), 200);
      await dialog.waitFor({ state: 'hidden' });
      gates.push('UI_EXPLICITLY_ENABLE_DISCOVERED_TASK');
      await page.getByRole('tab', { name: 'Triggers', exact: true }).click();
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      dialog = page.getByRole('dialog');
      await select(page, dialog, 'Type', 'Git update');
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await page.getByRole('button', { name: 'Run now', exact: true }).click();
      await page.waitForURL(/\/runs\/\d+$/);
      const manualRunId = Number(new URL(page.url()).pathname.split('/').pop());
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="run-log"]')
          ?.textContent?.includes('BROWSER_GIT_INITIAL'),
      );
      assert.equal(
        (
          await eventually(async () => {
            const row = await f.app.services.execution.get(manualRunId);
            return row.status === 'SUCCESS' && row;
          })
        ).status,
        'SUCCESS',
      );
      gates.push('UI_CONFIGURE_DISCOVERED_TASK_AND_REAL_EXECUTION');
      await fs.writeFile(
        path.join(remote, 'main.sh'),
        script('BROWSER_GIT_CHANGED'),
      );
      git(['add', 'main.sh'], remote);
      git(['commit', '-m', 'actual remote source changed'], remote);
      const changed = git(['rev-parse', 'HEAD'], remote);
      await page
        .locator('.ant-menu')
        .getByText('Script Workspaces', { exact: true })
        .click();
      await page
        .getByRole('link', { name: 'Browser GIT', exact: true })
        .click();
      const updated = await syncNow();
      assert.equal(updated.status, 'SUCCESS');
      assert.equal(updated.after_commit, changed);
      const automatic = await eventually(async () => {
        const rows = await f.app.services.store.all(
          "SELECT * FROM TaskRuns WHERE task_id=? AND trigger_type='GIT_UPDATE' ORDER BY id",
          [task.id],
        );
        return rows[0]?.status === 'SUCCESS' && rows[0];
      });
      assert.equal(automatic.attempt_count, 1);
      const snapshot = JSON.parse(automatic.source_snapshot);
      assert.equal(snapshot.git.commit, changed);
      assert.match(
        await f.app.services.execution.logs(automatic.id),
        /BROWSER_GIT_CHANGED/,
      );
      const dispatch = await f.app.services.store.all(
        'SELECT * FROM WorkspaceUpdateOutbox WHERE workspace_id=? AND sync_run_id=?',
        [wsId, updated.id],
      );
      assert.equal(dispatch.length, 1);
      assert.equal(dispatch[0].status, 'DISPATCHED');
      const outboxCount = (
        await f.app.services.store.all(
          'SELECT COUNT(*) n FROM WorkspaceUpdateOutbox WHERE workspace_id=?',
          [wsId],
        )
      )[0].n;
      gates.push('REMOTE_REAL_COMMIT_SYNC_OUTBOX_ACTUAL_GIT_UPDATE_TASKRUN');
      const count = (
        await f.app.services.store.all(
          'SELECT COUNT(*) n FROM TaskRuns WHERE task_id=?',
          [task.id],
        )
      )[0].n;
      const unchanged = await syncNow();
      assert.equal(unchanged.status, 'NO_CHANGE');
      assert.equal(
        (
          await f.app.services.store.all(
            'SELECT COUNT(*) n FROM TaskRuns WHERE task_id=?',
            [task.id],
          )
        )[0].n,
        count,
      );
      assert.equal(
        (
          await f.app.services.store.all(
            'SELECT COUNT(*) n FROM WorkspaceUpdateOutbox WHERE workspace_id=?',
            [wsId],
          )
        )[0].n,
        outboxCount,
      );
      gates.push('NO_CHANGE_NO_SECOND_OUTBOX_OR_RUN');
      await page
        .getByRole('tab', { name: 'Sync history', exact: true })
        .click();
      const screenshot = await f.screenshot(page, 'git-sync-history');
      assert.equal(f.pageErrors.length, 0);
      await f.scenario.record('s4-browser-git', {
        gates,
        workspace_id: wsId,
        task_id: task.id,
        manual_run_id: manualRunId,
        git_update_run_id: automatic.id,
        after_commit: changed,
        sync_ids: [initialSync.id, updated.id, unchanged.id],
        outbox_id: dispatch[0].id,
        screenshot,
        traffic: f.traffic,
        actual_git: true,
        mocked_http: false,
        production_application: true,
      });
    } catch (error) {
      const view =
        f.pages[0] && !f.pages[0].isClosed()
          ? {
              screenshot: await f.screenshot(f.pages[0], 'git-failure-view'),
              buttons: await f.pages[0].getByRole('button').allTextContents(),
            }
          : undefined;
      await f.scenario.record('s4-browser-git-failure', {
        gates,
        status: 'FAIL',
        view,
        error_name: error.name,
        error_code: error.code || 'BROWSER_CASE_FAILED',
        traffic: f.traffic,
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
module.exports = { eventually, select };
