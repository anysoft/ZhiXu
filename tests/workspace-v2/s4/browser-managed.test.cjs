const test = require('node:test');
const assert = require('node:assert/strict');
const { browserFixture } = require('./browser-support.cjs');
const { MANAGED_NODE_VERSION } = require('../s5r-offline-options.cjs');
async function choose(page, container, label, value) {
  await container
    .getByLabel(label, { exact: true })
    .locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click();
  if (label === 'Runtime version')
    await container
      .getByLabel(label, { exact: true })
      .fill(MANAGED_NODE_VERSION);
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText(value, { exact: typeof value === 'string' })
    .last()
    .click();
}
async function until(read, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const row = await read();
    if (row) return row;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Object.assign(new Error('CONDITION_NOT_REACHED'), {
    code: 'CONDITION_NOT_REACHED',
  });
}
test(
  'S4 E2E-01 real browser provisions managed Node runtime/NPM/build, selects it for LOCAL JavaScript Task and executes pinned runtime',
  { timeout: 360000 },
  async () => {
    const f = await browserFixture('s4-browser-managed'),
      gates = [],
      operations = [];
    try {
      const { page } = await f.context();
      await f.login(page, true);
      await page
        .locator('.ant-menu')
        .getByText('Runtime', { exact: true })
        .click();
      await page.getByRole('tab', { name: 'Node.js', exact: true }).click();
      async function operationClick(action, path) {
        const response = page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            new URL(r.url()).pathname === path,
        );
        await action();
        const http = await response;
        assert.ok([200, 202].includes(http.status()));
        const submitted = (await http.json()).data;
        const done = await until(async () => {
          const row = await f.app.runtime.operations.operation(submitted.id);
          return (
            ['SUCCESS', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(
              row.status,
            ) && row
          );
        });
        assert.equal(done.status, 'SUCCESS');
        operations.push({
          id: done.id,
          type: done.operation_type,
          status: done.status,
        });
        await page
          .locator('.ant-drawer:visible')
          .getByText('Success', { exact: true })
          .waitFor();
        await page.locator('.ant-drawer-close').click();
      }
      await operationClick(
        () =>
          page
            .getByRole('button', { name: 'Refresh catalog', exact: true })
            .click(),
        '/api/runtime/node/catalog',
      );
      await page.getByRole('button', { name: /Refresh$/ }).click();
      await page
        .getByRole('tab', { name: 'Installed runtimes', exact: true })
        .click();
      await page.getByRole('button', { name: 'Install', exact: true }).click();
      let dialog = page.getByRole('dialog');
      await choose(page, dialog, 'Runtime version', MANAGED_NODE_VERSION);
      await operationClick(
        () => dialog.getByRole('button', { name: /Save$/ }).click(),
        '/api/runtime/node/installations',
      );
      const runtime = (await f.app.runtime.node.runtimes()).find(
        (r) => r.version === MANAGED_NODE_VERSION,
      );
      assert.ok(runtime);
      assert.equal(runtime.state, 'READY');
      gates.push('REAL_BROWSER_PINNED_NODE_INSTALL');
      await page
        .getByRole('tab', { name: 'Package manager', exact: true })
        .click();
      await page.getByRole('button', { name: 'Install', exact: true }).click();
      dialog = page.getByRole('dialog');
      await choose(
        page,
        dialog,
        'Runtime',
        `${MANAGED_NODE_VERSION} · #${runtime.id}`,
      );
      await choose(page, dialog, 'Package manager', 'npm');
      await operationClick(
        () => dialog.getByRole('button', { name: /Save$/ }).click(),
        '/api/runtime/node/toolchains',
      );
      const tool = (await f.app.runtime.node.toolchains()).find(
        (r) => r.runtime_id === runtime.id && r.manager_type === 'NPM',
      );
      assert.equal(tool.state, 'READY');
      await page.getByRole('button', { name: /Refresh$/ }).click();
      await page
        .getByRole('tab', { name: 'Managed environments', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'New environment', exact: true })
        .click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name', { exact: true }).fill('Browser Node');
      await choose(
        page,
        dialog,
        'Runtime',
        `${MANAGED_NODE_VERSION} · #${runtime.id}`,
      );
      await choose(
        page,
        dialog,
        'Package manager',
        `NPM ${tool.version} · #${tool.id}`,
      );
      const created = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/runtime/node/environments'),
      );
      await dialog.getByRole('button', { name: /Save$/ }).click();
      const envHttp = await created;
      assert.equal(envHttp.status(), 200);
      const env = (await envHttp.json()).data;
      const row = page.locator('tr').filter({ hasText: 'Browser Node' });
      await operationClick(
        () => row.getByRole('button', { name: 'Build', exact: true }).click(),
        `/api/runtime/node/environments/${env.id}/build`,
      );
      const environment = await f.app.runtime.node.environment(env.id);
      assert.equal(environment.state, 'READY');
      assert.ok(environment.current_build_id);
      gates.push('REAL_BROWSER_NPM_ENVIRONMENT_PHYSICAL_BUILD');
      await page
        .locator('.ant-menu')
        .getByText('Script Workspaces', { exact: true })
        .click();
      await page.getByRole('button', { name: /New workspace$/ }).click();
      dialog = page.getByRole('dialog');
      await dialog
        .getByLabel('Name', { exact: true })
        .fill('Browser managed LOCAL');
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await page.waitForURL(/\/workspaces\/\d+\?tab=files/);
      const workspaceId = Number(new URL(page.url()).pathname.split('/').pop());
      await page.getByRole('button', { name: 'New file', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Relative path', { exact: true }).fill('main.js');
      await dialog
        .getByLabel('Content', { exact: true })
        .fill('console.log("S4_BROWSER_MANAGED_NODE", process.version);\n');
      await dialog.getByRole('button', { name: /Save$/ }).click();
      await page
        .locator('.v2-file-item span')
        .filter({ hasText: 'main.js' })
        .click();
      await page
        .locator('[data-testid="source-editor"] .cm-content')
        .fill(
          'console.log("S4_BROWSER_MANAGED_NODE_EXECUTED", process.version);\n',
        );
      const saved = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().endsWith(`/workspaces/${workspaceId}/files`),
      );
      await page.getByRole('button', { name: /Save$/ }).click();
      assert.equal((await saved).status(), 200);
      const entries = page.waitForResponse((r) =>
        r.url().endsWith(`/workspaces/${workspaceId}/entries`),
      );
      await page
        .getByRole('link', { name: 'Create task from file', exact: true })
        .click();
      assert.equal((await entries).status(), 200);
      dialog = page.getByRole('dialog');
      await dialog
        .getByLabel('Name', { exact: true })
        .fill('Browser managed JavaScript');
      await dialog.getByRole('tab', { name: 'Runtime', exact: true }).click();
      await choose(
        page,
        dialog,
        'Task runtime override',
        'Browser Node · Ready',
      );
      const taskResponse = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname === '/api/tasks',
      );
      await dialog.getByRole('button', { name: /Save$/ }).click();
      assert.equal((await taskResponse).status(), 200);
      await page.waitForURL(/\/tasks\/\d+$/);
      const taskId = Number(new URL(page.url()).pathname.split('/').pop());
      gates.push('LOCAL_SCRIPT_EDITOR_SAVE_REAL_RUNTIME_SELECTOR_TASK_CREATE');
      await page.getByRole('button', { name: 'Run now', exact: true }).click();
      await page.waitForURL(/\/runs\/\d+$/);
      const runId = Number(new URL(page.url()).pathname.split('/').pop());
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="run-log"]')
          ?.textContent?.includes('S4_BROWSER_MANAGED_NODE_EXECUTED'),
      );
      const run = await until(async () => {
        const row = await f.app.services.execution.get(runId);
        return row.status === 'SUCCESS' && row;
      });
      assert.equal(run.attempt_count, 1);
      const source = JSON.parse(run.source_snapshot);
      assert.equal(
        source.effective_resource_versions.node.environment_id,
        env.id,
      );
      assert.equal(
        source.effective_resource_versions.node.build_id,
        environment.current_build_id,
      );
      assert.equal(
        source.effective_resource_versions.node.runtime_id,
        runtime.id,
      );
      assert.match(
        await f.app.services.execution.logs(runId),
        new RegExp('v' + MANAGED_NODE_VERSION.replaceAll('.', '\\.')),
      );
      await page
        .getByRole('tab', { name: 'Historical source snapshot', exact: true })
        .click();
      await page
        .getByText('Effective resource versions', { exact: true })
        .waitFor();
      const screenshot = await f.screenshot(
        page,
        'managed-runtime-source-snapshot',
      );
      gates.push('REAL_MANAGED_CHILD_LOGS_AND_IMMUTABLE_HISTORY_RUNTIME_PINS');
      assert.equal(f.pageErrors.length, 0);
      await f.scenario.record('s4-browser-managed', {
        gates,
        operations,
        workspace_id: workspaceId,
        task_id: taskId,
        run_id: runId,
        provider_runtime_version: runtime.version,
        runtime_id: runtime.id,
        toolchain_id: tool.id,
        environment_id: env.id,
        build_id: environment.current_build_id,
        source_snapshot_runtime: source.effective_resource_versions.node,
        screenshot,
        traffic: f.traffic,
        host_fallback: false,
        mocked_http: false,
        production_application: true,
      });
    } catch (error) {
      const failedPage = f.pages.at(-1);
      const screenshot = failedPage
        ? await f.screenshot(failedPage, 'managed-failure').catch(() => null)
        : null;
      await f.scenario.record('s4-browser-managed-failure', {
        gates,
        operations,
        status: 'FAIL',
        error_name: error.name,
        error_code: error.code || 'BROWSER_CASE_FAILED',
        traffic: f.traffic,
        page_errors: f.pageErrors,
        screenshot,
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
