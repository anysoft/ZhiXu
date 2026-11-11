const root = process.cwd(),
  path = require('node:path'),
  fs = require('node:fs'),
  assert = require('node:assert/strict');
const target = require.resolve(
  path.join(root, 'scripts/i18n/browser-qualification.cjs'),
);
require.cache[target] = {
  id: target,
  filename: target,
  loaded: true,
  exports: async ({ page, base, evidenceDirectory }) => {
    const create = async (endpoint, body) =>
      page.evaluate(
        async ({ endpoint, body }) => {
          const r = await fetch('/api/' + endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              Authorization: 'Bearer ' + localStorage.getItem('token'),
            },
            body: JSON.stringify(body),
          });
          return r.json();
        },
        { endpoint, body },
      );
    const repo = await create('repositories', {
      name: 'Toast repository fixture',
      remote_url: 'https://example.invalid/toast.git',
    });
    assert.equal(repo.code, 200, JSON.stringify(repo));
    const credential = await create('git-credentials', {
      name: 'Toast credential fixture',
      provider: 'generic',
      auth_type: 'anonymous',
      capability: 'READ',
      status: 'enabled',
    });
    assert.equal(credential.code, 200, JSON.stringify(credential));
    let status = 'available';
    await page.route(
      /\/api\/(repositories|git-credentials)\/\d+\/test/,
      (route) =>
        route.fulfill({
          json: {
            code: 200,
            data: { status, message: 'UNTRANSLATED_BACKEND_CANARY' },
          },
        }),
    );
    const results = [];
    for (const locale of ['zh-CN', 'en-US']) {
      const messages = require(path.join(
        root,
        'src/locales',
        locale + '.json',
      ));
      await page.evaluate(
        (locale) => localStorage.setItem('zhixu.language', locale),
        locale,
      );
      await page.goto(base + '/repository');
      await page.waitForFunction(
        (locale) => document.documentElement.lang === locale,
        locale,
      );
      for (const kind of ['repository', 'credential']) {
        const pane = await require(path.join(
          root,
          'scripts/ci/browser-tab.cjs',
        )).activateTab(
          page,
          messages[
            kind === 'repository' ? 'ui.repositories' : 'ui.credentials'
          ],
        );
        for (const value of ['available', 'unreachable']) {
          status = value;
          const row = pane
            .getByRole('row')
            .filter({
              hasText:
                kind === 'repository'
                  ? 'Toast repository fixture'
                  : 'Toast credential fixture',
            });
          await row
            .getByRole('button', {
              name: messages['ui.testAccess'],
              exact: true,
            })
            .click();
          if (kind === 'credential') {
            const modal = page.getByRole('dialog');
            await modal
              .getByPlaceholder('https://host/team/repo.git')
              .fill('https://example.invalid/toast.git');
            await modal.locator('.ant-modal-footer .ant-btn-primary').click();
          }
          const text =
            messages[
              value === 'available'
                ? 'ui.repositoryAccessSucceeded'
                : 'ui.repositoryAccessFailed'
            ];
          const toast = page
            .locator('.ant-message-notice-content')
            .filter({ hasText: text });
          await toast.waitFor();
          assert.equal(
            await page
              .getByText('UNTRANSLATED_BACKEND_CANARY', { exact: true })
              .count(),
            0,
          );
          results.push({ locale, kind, status: value, text, result: 'PASS' });
          await toast.waitFor({ state: 'hidden' });
        }
      }
    }
    fs.writeFileSync(
      path.join(evidenceDirectory, 'toast-browser.json'),
      JSON.stringify({ status: 'PASS', cases: results }, null, 2),
    );
    console.log('TOAST_BROWSER_PASS', results.length);
  },
};
