// Frontend regression with controlled API responses, not a transport or deployment qualification.
// Build the v2 frontend first. Set ZHIXU_PLAYWRIGHT_MODULE / ZHIXU_BROWSER_EXECUTABLE if needed.
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
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(root, 'index.html');
    res.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'application/javascript'
        : file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.html')
        ? 'text/html'
        : 'application/octet-stream',
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
    const context = await browser.newContext({ locale: 'en-US' }),
      page = await context.newPage();
    page.setDefaultTimeout(15000);
    let cleanupFailure = false;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const queries = [],
      previews = [],
      cleans = [],
      saved = [];
    let settings = {
      auto_enabled: true,
      task_days: 90,
      runtime_days: 30,
      cache_days: 30,
      last_automatic_attempt_at: '2026-11-16T00:00:00Z',
      last_automatic_result: {
        status: 'FAILED',
        error_code: 'MAINTENANCE_PARTIAL_FAILURE',
        errors: 2,
      },
    };
    const taskItems = [
      {
        id: 1,
        task_id: 10,
        workspace_id: 1,
        status: 'SUCCESS',
        started_at: '2026-11-15T00:00:00Z',
        attempt_count: 1,
      },
      {
        id: 2,
        task_id: 11,
        workspace_id: 1,
        status: 'RUNNING',
        started_at: '2026-11-16T00:00:00Z',
      },
    ];
    const opItems = [
      {
        id: 101,
        operation_type: 'PROVIDER_INSTALL',
        status: 'SUCCESS',
        stage: 'COMPLETE',
        log_cleaned: true,
      },
      {
        id: 102,
        operation_type: 'RUNTIME_INSTALL',
        status: 'RUNNING',
        stage: 'BUILDING',
      },
    ];
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        u = new URL(request.url()),
        p = u.pathname,
        body = request.postDataJSON();
      let data = [];
      if (p === '/api/env.js') {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: '',
        });
        return;
      }
      if (p === '/api/system')
        data = { mode: 'v2', initialized: true, ready: true, version: '2.0.0' };
      else if (p === '/api/user') data = { username: 'fixture' };
      else if (p === '/api/workspaces')
        data = { items: [{ id: 1, name: 'fixture' }] };
      else if (p === '/api/task-runs') {
        queries.push({ kind: 'task', ...Object.fromEntries(u.searchParams) });
        data = { items: taskItems, total: 100 };
      } else if (p === '/api/runtime/operations') {
        queries.push({
          kind: 'runtime',
          ...Object.fromEntries(u.searchParams),
        });
        data = { items: opItems, total: 100 };
      } else if (p === '/api/runtime/python/provider')
        data = { state: 'READY', provider_version: 'v2.8.5' };
      else if (p.endsWith('/catalog')) data = { versions: ['3.13.15'] };
      else if (p === '/api/runtime/python/operations/101') data = opItems[0];
      else if (p === '/api/runtime/python/operations/101/log')
        data = { text: '', log_cleaned: true };
      else if (p === '/api/maintenance/settings') {
        if (body) {
          settings = body;
          saved.push(body);
        }
        data = settings;
      } else if (p === '/api/maintenance/usage')
        data = {
          categories: Object.fromEntries(
            [
              'task_logs',
              'runtime_logs',
              'download_cache',
              'temporary',
              'database',
            ].map((key) => [
              key,
              {
                files: 5,
                bytes: 8192,
                ...(key === 'download_cache'
                  ? { skipped: 2, truncated: true }
                  : {}),
              },
            ]),
          ),
          disk: { free_bytes: 1024 ** 3, total_bytes: 100 * 1024 ** 3 },
        };
      else if (p === '/api/maintenance/preview') {
        previews.push(body);
        data = {
          preview_id: 'plan-' + previews.length,
          count: 3,
          bytes: 4096,
          skipped: 1,
          has_more: false,
        };
      } else if (p === '/api/maintenance/clean') {
        cleans.push(body);
        data = {
          deleted: previews.at(-1).mode === 'logs' ? 0 : 3,
          logs_deleted: 3,
          files_deleted: 3,
          freed_bytes: 4096,
          skipped: 1,
          errors: cleanupFailure
            ? [{ kind: 'task', id: 99, code: 'MAINTENANCE_FILE_BUSY' }]
            : [],
        };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 200, data }),
      });
    });
    async function go(p) {
      await page.goto('http://127.0.0.1:' + server.address().port + p);
    }
    async function choose(label, text) {
      const combo = page.getByRole('combobox', { name: label, exact: true });
      await combo.focus();
      await combo.press('ArrowDown');
      await page
        .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
        .filter({ hasText: new RegExp('^' + text + '$') })
        .click();
    }
    await go('/runs');
    await page.locator('a[href="/runs/1"]').waitFor();
    let taskQuery = queries.find((q) => q.kind === 'task');
    assert.equal(taskQuery.page, '1');
    assert.equal(taskQuery.size, '20');
    assert.ok(
      Math.abs(Date.now() - Date.parse(taskQuery.from) - 7 * 86400000) < 60000,
    );
    assert.ok(
      await page
        .locator('tr[data-row-key="2"] input[type=checkbox]')
        .isDisabled(),
    );
    const presetChanged = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/task-runs',
    );
    await choose('Time range', 'Last 24 hours');
    await presetChanged;
    taskQuery = queries.filter((q) => q.kind === 'task').at(-1);
    assert.ok(
      Math.abs(Date.now() - Date.parse(taskQuery.from) - 86400000) < 60000,
    );
    const statusChanged = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/task-runs' &&
        new URL(r.url()).searchParams.get('status') === 'FAILED',
    );
    await choose('Status', 'Failed');
    await statusChanged;
    const pageChanged = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/task-runs' &&
        new URL(r.url()).searchParams.get('page') === '2',
    );
    await page.locator('.ant-pagination-next button').click();
    await pageChanged;
    await page
      .getByRole('button', { name: 'Scan current filters', exact: true })
      .click();
    const modal = page.getByRole('dialog');
    await modal
      .getByText('Estimated cleanup count: 3', { exact: true })
      .waitFor();
    assert.equal(cleans.length, 0);
    assert.equal(previews.at(-1).status, 'FAILED');
    assert.ok(previews.at(-1).from);
    await modal
      .getByRole('button', { name: 'Confirm cleanup', exact: true })
      .click();
    await page
      .getByText('Space freed: 4.0 KB; Skipped: 1', { exact: true })
      .waitFor();
    assert.equal(cleans.at(-1).preview_id, 'plan-1');
    await choose('Time range', 'Custom range');
    assert.ok(await page.locator('.ant-picker-range').isVisible());
    assert.ok(
      queries.filter((q) => q.kind === 'task').at(-1).to ||
        (await page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === '/api/task-runs' &&
            !!new URL(r.url()).searchParams.get('to'),
        )),
    );
    console.log(
      'PASS Task history default seven days, presets/custom UTC bounds, status, server page, terminal selection and preview confirmation',
    );
    await go('/runtime-python');
    await page.getByRole('tab', { name: 'Operations', exact: true }).click();
    await page.getByRole('button', { name: '#101', exact: true }).waitFor();
    assert.ok(
      queries.some(
        (q) =>
          q.kind === 'runtime' && q.page === '1' && q.size === '20' && q.from,
      ),
    );
    assert.ok(
      await page
        .locator('tr[data-row-key="102"] input[type=checkbox]')
        .isDisabled(),
    );
    await page.getByRole('button', { name: '#101', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByText('Log has been cleaned', { exact: true })
      .waitFor();
    await page.getByRole('dialog').locator('.ant-drawer-close').click();
    const runtimeStatus = page.getByRole('combobox', {
      name: 'Status',
      exact: true,
    });
    await runtimeStatus.focus();
    await runtimeStatus.press('ArrowDown');
    assert.equal(
      await page
        .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
        .filter({ hasText: 'Recovery required' })
        .count(),
      0,
    );
    await runtimeStatus.press('Escape');
    await choose('Cleanup mode', 'Delete logs only; keep records');
    await page.locator('tr[data-row-key="101"] input[type=checkbox]').check();
    await page
      .getByRole('button', { name: 'Clean selected records (1)', exact: true })
      .click();
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(previews.at(-1).ids, [101]);
    assert.equal(previews.at(-1).mode, 'logs');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm cleanup', exact: true })
      .click();
    await page
      .getByText('Records deleted: 0; Logs cleaned: 3; Files deleted: 3', {
        exact: true,
      })
      .waitFor();
    console.log(
      'PASS Runtime paginated history, active-row guard, cleaned-log message and logs-only cleanup',
    );
    await go('/setting');
    await page
      .getByRole('tab', { name: 'Storage maintenance', exact: true })
      .click();
    await page.getByText('Less than 2 GiB free', { exact: true }).waitFor();
    await page
      .getByText(
        'The latest automatic cleanup did not complete fully. Review the error and retry.',
        { exact: true },
      )
      .waitFor();
    assert.equal(await page.getByText('8.0 KB', { exact: true }).count(), 5);
    await page
      .getByText('Partial scan; some data is not included (Skipped: 2)', {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page
        .getByText('Partial scan; some data is not included (Skipped: 2)', {
          exact: true,
        })
        .count(),
      1,
    );
    await page
      .getByRole('button', { name: 'Edit automatic cleanup', exact: true })
      .click();
    const policy = page.getByRole('dialog');
    await policy
      .getByRole('checkbox', { name: 'Keep forever', exact: true })
      .first()
      .check();
    await policy.getByRole('switch').uncheck();
    await policy.getByRole('button', { name: 'Save', exact: true }).click();
    await policy.waitFor({ state: 'hidden' });
    assert.equal(saved.at(-1).task_days, null);
    assert.equal(saved.at(-1).auto_enabled, false);
    assert.equal(saved.at(-1).runtime_days, 30);
    await page
      .getByRole('button', { name: /Scan cleanup candidates$/ })
      .click();
    await page.getByRole('dialog').waitFor();
    assert.equal(previews.at(-1).kind, 'storage');
    const before = cleans.length;
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    assert.equal(cleans.length, before);
    console.log(
      'PASS Storage usage, low-space warning, retention forever/disabled settings, scan without deletion and cancellation',
    );
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    cleanupFailure = true;
    await page
      .getByRole('button', { name: /Scan cleanup candidates$/ })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm cleanup', exact: true })
      .click();
    await page
      .getByText('task #99: MAINTENANCE_FILE_BUSY', { exact: true })
      .waitFor();
    cleanupFailure = false;
    await page
      .getByRole('button', { name: /Scan cleanup candidates$/ })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm cleanup', exact: true })
      .click();
    await page
      .getByText('task #99: MAINTENANCE_FILE_BUSY', { exact: true })
      .waitFor({ state: 'hidden' });
    assert.deepEqual(pageErrors, []);
    console.log(
      'PASS cleanup partial failure is explicit and the user can scan and retry',
    );
    await context.close();
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
