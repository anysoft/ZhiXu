const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { createS4Fixture } = require('./fixture.cjs');
const { V2Application } = require('../../../back/applicationV2/application');
const { runtimeArtifactOptions } = require('../s5r-offline-options.cjs');
function browserLibrary() {
  for (const id of [
    process.env.ZHIXU_S4_PLAYWRIGHT,
    '/tmp/zhixu-notifications-browser-tools/node_modules/playwright',
    'playwright',
  ]) {
    if (!id) continue;
    try {
      return require(id);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw Object.assign(new Error('BROWSER_DEPENDENCY_REQUIRED'), {
    code: 'BROWSER_DEPENDENCY_REQUIRED',
  });
}
async function browserFixture(caseId, options = {}) {
  const scenario = await createS4Fixture(null, { caseId });
  const instance = await scenario.createInstance('A');
  const { prepare, ...applicationOptions } = options;
  const prepared = await prepare?.(instance, scenario);
  await instance.close();
  const frontend = path.join(scenario.root, 'frontend-artifact');
  await fs.cp(
    applicationOptions.frontendRoot ||
      path.join(instance.projectRoot, 'static/dist-v2'),
    frontend,
    { recursive: true, errorOnExist: true, force: false },
  );
  await fs.chmod(frontend, 0o700);
  const manifest = [];
  async function assets(directory) {
    for (const entry of (
      await fs.readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await assets(file);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(file);
        manifest.push({
          path: path.relative(frontend, file),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } else
        throw Object.assign(new Error('INVALID_FRONTEND_ASSET'), {
          code: 'INVALID_FRONTEND_ASSET',
        });
    }
  }
  await assets(frontend);
  if (
    !manifest.some((entry) => entry.path === 'index.html') ||
    !manifest.some((entry) => /^umi\..+\.js$/.test(entry.path))
  )
    throw Object.assign(new Error('FRONTEND_BUILD_REQUIRED'), {
      code: 'FRONTEND_BUILD_REQUIRED',
    });
  const artifact = {
    file_count: manifest.length,
    total_bytes: manifest.reduce((n, entry) => n + entry.bytes, 0),
    sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  };
  await scenario.record(caseId + '-frontend-artifact', {
    artifact,
    files: manifest,
  });
  const app = await V2Application.launch({
    runtimeArtifacts: runtimeArtifactOptions(),
    dataRoot: instance.dataRoot,
    backupRoot: instance.backupRoot,
    initialize: true,
    projectRoot: instance.projectRoot,
    frontendRoot: frontend,
    port: 0,
    ...applicationOptions,
    frontendRoot: frontend,
  }).catch(async (error) => {
    await scenario.record(caseId + '-boot-failure', {
      status: 'FAIL',
      error_code: error.error_code || error.code || 'BOOT_FAILED',
      frames: String(error.stack || '')
        .split('\n')
        .filter((line) => line.trimStart().startsWith('at ')),
    });
    await scenario.close();
    throw error;
  });
  let browser;
  try {
    browser = await browserLibrary().chromium.launch({
      headless: true,
      executablePath:
        process.env.ZHIXU_S4_CHROME ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
  } catch (error) {
    await app.close();
    await scenario.close();
    throw error;
  }
  const password = 'S4!' + randomBytes(24).toString('hex');
  scenario.registerSecret(password);
  const pages = [],
    traffic = [],
    pageErrors = [];
  async function context() {
    const result = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 1000 },
    });
    const page = await result.newPage();
    pages.push(page);
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', (error) => pageErrors.push({ name: error.name }));
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (url.origin === app.origin && url.pathname.startsWith('/api/')) {
        const entry = {
          method: response.request().method(),
          path: url.pathname,
          status: response.status(),
        };
        traffic.push(entry);
        if (response.status() >= 400) {
          const body = await response.json().catch(() => null);
          if (/^[A-Z][A-Z0-9_]+$/.test(body?.error_code || ''))
            entry.error_code = body.error_code;
        }
      }
    });
    await page.goto(app.origin);
    return { context: result, page };
  }
  async function login(page, setup = false) {
    await page.getByLabel('Username', { exact: true }).fill('s4-owner');
    await page.getByLabel('Password', { exact: true }).fill(password);
    if (setup)
      await page.getByLabel('Confirm password', { exact: true }).fill(password);
    await page
      .getByRole('button', {
        name: setup ? 'Create administrator' : 'Sign in',
        exact: true,
      })
      .click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });
  }
  async function screenshot(page, name) {
    const file = path.join(scenario.evidenceRoot, name + '.png');
    await page.screenshot({ path: file, fullPage: true });
    const bytes = await fs.readFile(file);
    return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  return {
    app,
    pages,
    artifact,
    prepared,
    scenario,
    instance,
    browser,
    password,
    traffic,
    pageErrors,
    context,
    login,
    screenshot,
    async close() {
      await browser.close();
      await app.close();
      await scenario.close();
    },
  };
}
module.exports = { browserFixture, browserLibrary };
