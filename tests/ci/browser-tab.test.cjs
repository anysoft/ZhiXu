'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { activateTab } = require('../../scripts/ci/browser-tab.cjs');
const { chooseSelect } = require('../../scripts/ci/browser-select.cjs');
const { chromium } = require(path.join(process.env.QL_BROWSER_RUNTIME || '/tmp/qinglong-phase45b-browser/node_modules', 'playwright'));
let browser;
before(async () => { browser = await chromium.launch({ headless: true,
  ...(process.env.QL_BROWSER_EXECUTABLE ? { executablePath: process.env.QL_BROWSER_EXECUTABLE } :
    process.platform === 'darwin' ? { channel: 'chrome' } : {}) }); });
after(async () => { await browser?.close(); });

async function fixture(page, broken = false) {
  await page.setContent(`<div role="dialog"><div role="tablist">
    <div role="tab" tabindex="0" aria-selected="false" aria-controls="runtime" style="width:100px;height:40px">Runtime</div>
    </div><div id="runtime" style="display:none">SAFE PANEL</div><input value="PRIVATE_CANARY"></div>`);
  await page.evaluate(broken => {
    const tab = document.querySelector('[role=tab]');
    window.clicks = 0;
    tab.onfocus = () => { tab.style.transform = 'translateX(180px)'; };
    tab.onclick = () => {
      window.clicks++;
      if (broken) return;
      tab.setAttribute('aria-selected', 'true');
      const pane = document.getElementById('runtime');
      pane.className = 'ant-tabs-tabpane-active'; pane.style.display = 'block';
    };
  }, broken);
}

test('focus-time layout shift loses the old click; focus-before-click activates with one click', async () => {
  const page = await browser.newPage({ locale: 'en-US' });
  await page.addInitScript(() => localStorage.setItem('zhixu.language', 'en-US'));
  try {
    await fixture(page);
    const tab = page.getByRole('tab', { name: 'Runtime' });
    await tab.click();
    assert.equal(await tab.getAttribute('aria-selected'), 'false');
    await fixture(page);
    const pane = await activateTab(page.getByRole('dialog'), 'Runtime', { timeout: 3000 });
    assert.equal(await pane.innerText(), 'SAFE PANEL');
    assert.equal(await page.evaluate(() => window.clicks), 1);
  } finally { await page.close(); }
});

test('broken activation still fails, reports selected stage, excludes form values and never retries click', async () => {
  const page = await browser.newPage({ locale: 'en-US' });
  try {
    await fixture(page, true);
    await assert.rejects(activateTab(page.getByRole('dialog'), 'Runtime', { timeout: 700 }), error => {
      assert.match(error.message, /BROWSER_TAB_ACTIVATION_FAILED:Runtime:stage=selected:state=/);
      assert.doesNotMatch(error.message, /PRIVATE_CANARY/);
      return true;
    });
    assert.equal(await page.evaluate(() => window.clicks), 1);
  } finally { await page.close(); }
});

test('real Ant Design modal with overflowing tabs switches Source, Runtime and Settings repeatedly', async () => {
  const page = await browser.newPage({ viewport: {width: 1440, height: 1100} });
  try {
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({path: require.resolve('antd/dist/antd.css')});
    for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js', 'moment/min/moment.min.js', 'antd/dist/antd.min.js']) {
      // React's package exports hide its UMD directory from require.resolve.
      const parts = file.split('/');
      await page.addScriptTag({path: path.join(path.dirname(require.resolve(parts.shift() + '/package.json')), ...parts)});
    }
    await page.evaluate(() => {
      const labels = ['General', 'Source', 'Runtime', 'Runs', 'Health', 'Notifications', 'ENV', 'Config', 'Hooks', 'Triggers', 'Execution Settings', 'Resource Preview'];
      function Fixture() {
        const [active, setActive] = React.useState('General');
        return React.createElement(antd.Modal, {open: true, width: 960, title: 'Fixture'},
          React.createElement(antd.Tabs, {activeKey: active, onChange: setActive,
            items: labels.map(label => ({key: label, label, forceRender: true, children: label + ' content'}))}));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    });
    for (let round = 0; round < 10; round++) {
      for (const name of ['Source', 'Runtime', 'Execution Settings']) {
        const pane = await activateTab(page.getByRole('dialog'), name, {timeout: 5000});
        assert.equal(await pane.innerText(), name + ' content');
      }
    }
  } finally { await page.close(); }
});

test('select in animated nested Ant Design modal picks its own option and fails for missing options', async () => {
  const page = await browser.newPage({ locale: 'en-US' });
  try {
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({path: require.resolve('antd/dist/antd.css')});
    for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js', 'moment/min/moment.min.js', 'antd/dist/antd.min.js']) {
      const parts = file.split('/');
      await page.addScriptTag({path: path.join(path.dirname(require.resolve(parts.shift() + '/package.json')), ...parts)});
    }
    await page.evaluate(() => {
      const h = React.createElement;
      function Fixture() {
        const [open, setOpen] = React.useState(false);
        return h(antd.Modal, {open: true, title: 'Task'},
          h('button', {onClick: () => setOpen(true)}, 'Add binding'),
          h(antd.Modal, {open, title: 'Config Binding', destroyOnClose: true, onCancel: () => setOpen(false)},
            h(antd.Form, {layout: 'vertical', initialValues: {auth: 'anonymous'}},
              h('div', {role: 'tabpanel', 'aria-label': 'Repository'},
                h(antd.Select, {'aria-label': 'Repository', options: [{value: 1, label: 'E2E Repo'}]})),
              h(antd.Form.Item, {name: 'entry', label: 'Entrypoint', rules: [{required: true}]},
                h(antd.Select, {showSearch: true, options: [{value: 'job.py', label: 'job.py'}]})),
              h(antd.Form.Item, {name: 'auth', label: '认证方式'},
                h(antd.Select, {options: [{value: 'anonymous', label: 'anonymous'}, {value: 'ssh_key', label: 'ssh_key'}]})),
              h(antd.Form.Item, {name: 'asset', label: 'Config Asset'},
                h(antd.Select, {options: [{value: 42, label: 'Task Config'}]})))));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture));
    });
    for (let round = 0; round < 5; round++) {
      await page.getByRole('button', {name: 'Add binding'}).click();
      const modal = page.getByRole('dialog', {name: 'Config Binding', exact: true});
      await modal.getByRole('combobox', {name: 'Repository', exact: true}).waitFor();
      assert.equal(await modal.getByLabel('Repository', {exact: true}).count(), 3);
      await chooseSelect(page, modal, 'Repository', 'E2E Repo', {timeout: 5000});
      await chooseSelect(page, modal, 'Entrypoint', 'job.py', {timeout: 5000});
      await chooseSelect(page, modal, 'Config Asset', 'Task Config', {timeout: 5000});
      await chooseSelect(page, modal, '认证方式', 'ssh_key', {timeout: 5000});
      await chooseSelect(page, modal, '认证方式', 'anonymous', {timeout: 5000});
      assert.deepEqual(await modal.locator('.ant-select-selection-item').allInnerTexts(), ['E2E Repo', 'job.py', 'anonymous', 'Task Config']);
      if (round === 4) {
        await assert.rejects(chooseSelect(page, modal, 'Config Asset', 'Missing option', {timeout: 700}));
        break;
      }
      await modal.getByRole('button', {name: 'Close', exact: true}).click();
      await modal.waitFor({state: 'hidden'});
    }
  } finally { await page.close(); }
});
