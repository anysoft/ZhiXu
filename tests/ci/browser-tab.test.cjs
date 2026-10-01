'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { activateTab } = require('../../scripts/ci/browser-tab.cjs');
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
  const page = await browser.newPage();
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
  const page = await browser.newPage();
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
