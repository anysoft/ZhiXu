'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const resources = {
  'zh-CN': require('../../src/locales/zh-CN.json'),
  'en-US': require('../../src/locales/en-US.json'),
};
const { buttonName } = require('../ci/browser-locale.cjs');
const { chooseSelect } = require('../ci/browser-select.cjs');
const { activateTab } = require('../ci/browser-tab.cjs');
const message = (locale, key) => resources[locale][key];
async function waitLocale(page, locale) {
  await page.waitForFunction(
    (expected) => document.documentElement.lang === expected,
    locale,
  );
}
module.exports = async function qualify({
  page,
  browser,
  base,
  locale,
  login,
  evidenceDirectory,
  mark,
}) {
  const report = { status: 'RUNNING', locale, checks: [] };
  const check = (name) => {
    report.checks.push(name);
    mark('i18n-' + name);
  };
  try {
    assert.equal(
      await page.evaluate(() => localStorage.getItem('lang')),
      locale,
    );
    await waitLocale(page, locale);
    await page.reload();
    await waitLocale(page, locale);
    check('reload-preference-and-html-lang');
    // Open a real unsaved form. A second tab changes the user preference through Settings.
    await page.goto(base + '/repository');
    await page
      .getByRole('button', {
        name: message(locale, 'ui.createRepository'),
        exact: true,
      })
      .click();
    let modal = page.getByRole('dialog');
    await modal
      .getByLabel(message(locale, 'ui.name'), { exact: true })
      .fill('UNSAVED_I18N_中文_English');
    const originalTime = await page.evaluate(() => performance.timeOrigin);
    const settings = await page.context().newPage();
    await settings.goto(base + '/setting');
    await activateTab(settings, message(locale, '其他设置'));
    const logPage = await page.context().newPage();
    await logPage.goto(base + '/log');
    for (const target of [locale === 'zh-CN' ? 'en-US' : 'zh-CN', locale]) {
      await chooseSelect(
        settings,
        settings,
        new RegExp(
          '^(?:' +
            message('zh-CN', '语言') +
            '|' +
            message('en-US', '语言') +
            ')$',
        ),
        target === 'zh-CN' ? '简体中文' : 'English',
      );
      await waitLocale(settings, target);
      await waitLocale(page, target);
      assert.equal(
        await page.evaluate(() => performance.timeOrigin),
        originalTime,
      );
      modal = page.getByRole('dialog');
      await modal
        .getByLabel(message(target, 'ui.name'), { exact: true })
        .waitFor();
      assert.equal(
        await modal
          .getByLabel(message(target, 'ui.name'), { exact: true })
          .inputValue(),
        'UNSAVED_I18N_中文_English',
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem('lang')),
        target,
      );
      await logPage
        .getByText(message(target, '请选择日志文件'), { exact: true })
        .first()
        .waitFor();
    }
    await logPage.close();
    await settings.close();
    check('immediate-switch-no-reload-mounted-unsaved-form');
    await modal
      .getByRole('button', {
        name: buttonName('取消'),
        exact: true,
      })
      .click();
    // Logout through the existing menu and sign back in; language preference is independent of auth.
    const user = page.locator('.side-menu-user-wrapper:visible').first();
    await user.hover();
    await page
      .getByRole('menuitem', {
        name: new RegExp(message(locale, '退出登录') + '$'),
      })
      .click();
    await page.waitForURL('**/login');
    assert.equal(
      await page.evaluate(() => localStorage.getItem('lang')),
      locale,
    );
    await waitLocale(page, locale);
    await login();
    await waitLocale(page, locale);
    check('logout-login-preserves-preference');
    await page.goto(base + '/dashboard');
    await page
      .getByText(message(locale, 'ui.observability'), { exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(evidenceDirectory, 'i18n-dashboard.png'),
      fullPage: true,
    });
    check('dashboard-chrome');
    await page.goto(base + '/repository');
    const credentialsPane = await activateTab(
      page,
      message(locale, 'ui.credentials'),
    );
    await credentialsPane
      .getByRole('button', {
        name: message(locale, 'ui.createCredential'),
        exact: true,
      })
      .click();
    const credentialModal = page.getByRole('dialog');
    for (const capability of ['WRITE', 'READ']) {
      await chooseSelect(
        page,
        credentialModal,
        message(locale, 'ui.capability'),
        message(locale, 'status.credentialCapability.' + capability),
      );
    }
    await credentialModal
      .getByRole('button', { name: buttonName('取消'), exact: true })
      .click();
    await page.goto(base + '/env');
    const globalPane = await activateTab(page, message(locale, 'ui.global'));
    await globalPane
      .getByRole('button', {
        name: message(locale, 'ui.addVariable'),
        exact: true,
      })
      .click();
    const variableModal = page.getByRole('dialog');
    await variableModal
      .getByLabel(message(locale, 'ui.variableName'), { exact: true })
      .fill('I18N_UNSET_PROBE');
    await chooseSelect(
      page,
      variableModal,
      message(locale, 'ui.action'),
      message(locale, 'ui.removeFromEnvironment'),
    );
    await variableModal
      .getByRole('button', { name: buttonName('确定'), exact: true })
      .click();
    await variableModal.waitFor({ state: 'hidden' });
    await globalPane
      .getByRole('row')
      .filter({ hasText: 'I18N_UNSET_PROBE' })
      .getByText(message(locale, 'status.envOperation.UNSET'), { exact: true })
      .waitFor();
    check('credential-capability-and-unset-presentation');
    for (const system of ['zh-CN', 'zh-SG', 'en-US', 'fr-FR']) {
      const context = await browser.newContext({
        locale: system,
        viewport: { width: 1280, height: 900 },
      });
      await context.addCookies([{ name: 'lang', value: 'ja', url: base }]);
      await context.addInitScript(
        ({ system }) => {
          localStorage.setItem('lang', 'system');
          localStorage.setItem('umi_locale', 'ja-JP');
          Object.defineProperty(navigator, 'language', {
            configurable: true,
            get: () => window.__testSystemLanguage || system,
          });
        },
        { system },
      );
      const probe = await context.newPage();
      await probe.goto(base + '/login?lang=ja');
      const effective = system.startsWith('zh') ? 'zh-CN' : 'en-US';
      await waitLocale(probe, effective);
      await probe.reload();
      await waitLocale(probe, effective);
      assert.equal(
        await probe.evaluate(() => localStorage.getItem('lang')),
        'system',
      );
      await probe.evaluate(() => {
        window.__testSystemLanguage = 'zh-Hans';
        window.dispatchEvent(new Event('languagechange'));
      });
      await waitLocale(probe, 'zh-CN');
      const start = await probe.evaluate(() => performance.timeOrigin);
      await probe.evaluate(() => {
        window.__testSystemLanguage = 'fr-FR';
        window.dispatchEvent(new Event('languagechange'));
      });
      await waitLocale(probe, 'en-US');
      assert.equal(await probe.evaluate(() => performance.timeOrigin), start);
      // Storage event is the documented cross-tab update path, including legacy browser preferences.
      await probe.evaluate(() => {
        localStorage.setItem('lang', 'zh-CN');
        window.dispatchEvent(new StorageEvent('storage', { key: 'lang' }));
      });
      await waitLocale(probe, 'zh-CN');
      await probe.evaluate(() => {
        window.__testSystemLanguage = 'en-US';
        window.dispatchEvent(new Event('languagechange'));
      });
      await waitLocale(probe, 'zh-CN');
      await context.close();
      check('system-' + system + '-and-explicit-isolation');
    }
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL';
    report.error = String(error);
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(evidenceDirectory, 'i18n-browser.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  }
};
