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
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    let profiles = [],
      createdSecret,
      editedBody,
      repositoryBody,
      taskBody,
      operationBody;
    let selections = {
      'platform/0': { mode: 'DIRECT' },
      'workspace/1': { mode: 'INHERIT' },
    };
    const workspace = {
      id: 1,
      name: 'fixture-workspace',
      type: 'LOCAL',
      version: 1,
      lifecycle_state: 'READY',
      storage_state: 'PRESENT',
      capabilities: {
        write_files: true,
        read_files: true,
        create_task: true,
        run_task: true,
      },
    };
    await page.route('**/api/**', async (route) => {
      const r = route.request(),
        p = new URL(r.url()).pathname,
        body = r.method() === 'GET' ? null : r.postDataJSON();
      if (p === '/api/env.js') {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: 'window.__ENV__QlBaseUrl = "/";',
        });
        return;
      }
      let data = [];
      if (p === '/api/system')
        data = { mode: 'v2', initialized: true, ready: true };
      else if (p === '/api/user') data = { username: 'fixture' };
      else if (p === '/api/proxy-profiles' && body) {
        createdSecret = body.password;
        profiles = [
          {
            ...body,
            id: 'proxy-1',
            has_password: true,
            used_by: [{ scope: 'task', id: 7 }],
          },
        ].map(({ password, replace_password, ...v }) => v);
        data = profiles[0];
      } else if (p === '/api/proxy-profiles') data = profiles;
      else if (p === '/api/proxy-profiles/proxy-1' && r.method() === 'PUT') {
        editedBody = body;
        profiles = [{ ...profiles[0], ...body }];
        data = profiles[0];
      } else if (p === '/api/proxy-profiles/proxy-1/test')
        data = { status: 'SUCCESS', elapsed_ms: 1 };
      else if (p.startsWith('/api/proxy-selections/')) {
        const key = p.slice('/api/proxy-selections/'.length);
        if (body) selections[key] = body;
        data = {
          selection: selections[key] || { mode: 'INHERIT' },
          effective: { profile_id: selections[key]?.profile_id || null },
        };
      } else if (p === '/api/repositories' && body) {
        repositoryBody = body;
        data = { ...body, id: 1 };
      } else if (p === '/api/repositories') data = [];
      else if (p === '/api/tasks' && body) {
        taskBody = body;
        data = { ...body, id: 7 };
      } else if (p === '/api/tasks') data = { items: [] };
      else if (p === '/api/tasks/7') data = { ...taskBody, id: 7, version: 1 };
      else if (p === '/api/workspaces') data = { items: [workspace] };
      else if (p === '/api/workspaces/1') data = workspace;
      else if (p === '/api/workspaces/1/entries')
        data = [{ kind: 'FILE', path: 'main.sh' }];
      else if (p.endsWith('/provider'))
        data = {
          state: 'READY',
          health: 'HEALTHY',
          provider_version: 'v2.8.5',
        };
      else if (p === '/api/runtime/python/installations' && body) {
        operationBody = body;
        data = { id: 8, status: 'QUEUED' };
      } else if (p.endsWith('/catalog')) data = { versions: ['3.13.15'] };
      else if (p.endsWith('/operations/8'))
        data = { id: 8, status: 'SUCCESS', operation_type: 'RUNTIME_INSTALL' };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 200, data }),
      });
    });
    const go = async (path) =>
      page.goto(`http://127.0.0.1:${server.address().port}${path}`);
    const select = async (label, option, scope = page) => {
      await scope
        .getByRole('combobox', { name: label, exact: true })
        .locator(
          'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")]',
        )
        .locator('.ant-select-selector')
        .click();
      await page
        .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
        .filter({ hasText: option })
        .first()
        .click();
    };
    const setProxy = async (scope = page) => {
      await select('Proxy mode', 'Use proxy profile', scope);
      await select('Use proxy profile', 'fixture-proxy', scope);
    };
    const save = async () => {
      await page
        .getByRole('dialog')
        .locator('.ant-modal-footer .ant-btn-primary')
        .click();
      await page.locator('.ant-modal:visible').waitFor({ state: 'hidden' });
    };
    await go('/setting');
    await page
      .getByRole('tab', { name: 'Proxy management', exact: true })
      .click();
    await page
      .getByText('Direct connection', { exact: true })
      .first()
      .waitFor();
    await page.getByRole('button', { name: 'New proxy', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Name', { exact: true }).fill('fixture-proxy');
    await modal.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await modal.getByLabel('Username', { exact: true }).fill('fixture-user');
    await modal
      .getByLabel('Password', { exact: true })
      .fill('synthetic-proxy-secret');
    await save();
    assert.equal(createdSecret, 'synthetic-proxy-secret');
    assert.ok(
      !(await page.locator('body').innerText()).includes(createdSecret),
    );
    await page
      .getByRole('row')
      .filter({ hasText: 'fixture-proxy' })
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    assert.equal(
      await page
        .getByRole('dialog')
        .getByLabel('Password', { exact: true })
        .count(),
      0,
    );
    await save();
    assert.ok(!('password' in editedBody));
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await page
      .getByText('Test: fixture-proxy · Connection successful', { exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'References (1)', exact: true })
      .click();
    await page.getByRole('dialog').getByText('task', { exact: true }).waitFor();
    await page.getByRole('dialog').locator('.ant-drawer-close').click();
    await page
      .getByRole('row')
      .filter({ hasText: 'fixture-proxy' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    const deletePopup = page.locator('.ant-popover:visible');
    await deletePopup
      .getByText(
        'This proxy is referenced by configuration. Change those references before deleting it.',
        { exact: true },
      )
      .waitFor();
    assert.ok(await deletePopup.locator('.ant-btn-primary').isDisabled());
    await deletePopup
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    console.log(
      'PASS proxy profile create/edit/test/references and hidden retained password',
    );
    await page
      .getByRole('button', { name: 'Edit', exact: true })
      .first()
      .click();
    await setProxy(page.getByRole('dialog'));
    await save();
    assert.deepEqual(selections['platform/0'], {
      mode: 'PROFILE',
      profile_id: 'proxy-1',
    });
    assert.equal(
      await page
        .locator('.ant-descriptions-item-content')
        .filter({ hasText: /^fixture-proxy$/ })
        .count(),
      2,
    );
    await go('/workspaces/1?tab=proxy');
    await page
      .getByText('Inherit parent configuration', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await select('Proxy mode', 'Direct connection', page.getByRole('dialog'));
    await save();
    assert.equal(selections['workspace/1'].mode, 'DIRECT');
    console.log('PASS platform selection and workspace direct override');
    await go('/repository');
    await page
      .getByRole('button', { name: 'New repository', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByLabel('Name', { exact: true })
      .fill('proxy-repository');
    await page
      .getByRole('dialog')
      .getByLabel('Repository URL', { exact: true })
      .fill('https://github.com/example/fixture.git');
    await setProxy(page.getByRole('dialog'));
    await save();
    assert.equal(repositoryBody.proxy.profile_id, 'proxy-1');
    console.log('PASS repository creation includes selected proxy');
    await go('/tasks?workspace_id=1&entrypoint=main.sh');
    await page
      .getByRole('dialog')
      .getByLabel('Name', { exact: true })
      .fill('proxy-task');
    await setProxy(page.getByRole('dialog'));
    await save();
    assert.equal(taskBody.proxy.profile_id, 'proxy-1');
    console.log('PASS task creation includes selected proxy');
    await go('/runtime-python');
    await page
      .getByRole('tab', { name: 'Installed runtimes', exact: true })
      .waitFor();
    await setProxy();
    await page
      .getByRole('button', { name: 'Install', exact: true })
      .first()
      .click();
    await page.getByRole('dialog').locator('.ant-select-selector').click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
      .filter({ hasText: '3.13.15' })
      .click();
    await save();
    assert.equal(operationBody.proxy.profile_id, 'proxy-1');
    console.log('PASS runtime operation includes selected proxy');
    assert.deepEqual(pageErrors, []);
    await context.close();
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
