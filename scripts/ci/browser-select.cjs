'use strict';

// Wait for modal focus/animation before opening rc-select. Its popup is portaled
// into body, so scope it through the combobox's list ID, not all visible popups.
async function chooseSelect(page, scope, label, text, { timeout = 20000 } = {}) {
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  // Ant Design's required-marker CSS can alter the accessible name used by
  // getByRole. Resolve the associated form label instead, as the UI exposes it.
  const input = scope.getByLabel(label, { exact: true });
  await input.waitFor({ state: 'visible', timeout: remaining() });
  // The selected label intentionally covers rc-select's readonly input.
  // Test pointer actionability on the same wrapper used for the real click.
  await input.locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .click({ trial: true, timeout: remaining() });
  const handle = await input.elementHandle();
  try {
    await page.waitForFunction(el => {
      if (!el.isConnected) return false;
      for (let node = el; node; node = node.parentElement) {
        if (node.getAnimations().some(a => a.playState === 'running' || a.pending)) return false;
      }
      return true;
    }, handle, { timeout: remaining() });
  } finally { await handle.dispose(); }
  await input.focus({ timeout: remaining() });
  if (await input.getAttribute('aria-expanded') !== 'true') {
    await input.locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
      .click({ timeout: remaining() });
  }
  const listId = await input.getAttribute('aria-controls');
  if (!listId) throw new Error('SELECT_LIST_MISSING');
  const popup = page.locator(`[id=${JSON.stringify(listId)}]`)
    .locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," ant-select-dropdown ")]');
  await popup.locator('.ant-select-item-option-content').getByText(text, { exact: true })
    .click({ timeout: remaining() });
  await input.locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]')
    .locator('.ant-select-selection-item').getByText(text, { exact: true })
    .waitFor({ state: 'visible', timeout: remaining() });
}

module.exports = { chooseSelect };
