// Explicit compiled candidate, real browser engine, immutable per-case frontend copy.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const {
  createS5Fixture,
  artifactModule,
  releaseRoot,
  assetManifest,
} = require('./artifact-support.cjs');
const { V2Application } = artifactModule('applicationV2/application');
async function withBrowserDeadline(promise, label, milliseconds = 30000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error('S5_BROWSER_DEADLINE'), { phase: label }),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function browserLibrary() {
  for (const id of [
    process.env.ZHIXU_S5_PLAYWRIGHT,
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
  const scenario = await createS5Fixture(null, { caseId });
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
  const sealed = assetManifest(frontend);
  if (sealed.sha256 !== scenario.identity.frontend_manifest_sha256)
    throw Error('S5_FRONTEND_COPY_HASH_MISMATCH');
  const artifact = {
    file_count: sealed.file_count,
    total_bytes: sealed.bytes,
    sha256: sealed.sha256,
  };
  await scenario.record(caseId + '-frontend-artifact', {
    artifact,
    files: sealed.files,
  });
  const app = await V2Application.launch({
    artifactRoot: path.join(
      releaseRoot(),
      'static/build/applicationV2/contracts',
    ),
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
  const engine = process.env.ZHIXU_S5_BROWSER_ENGINE;
  if (!['chromium', 'firefox', 'webkit'].includes(engine))
    throw Error('S5_EXPLICIT_BROWSER_ENGINE_REQUIRED');
  if (process.env.ZHIXU_S5_BROWSER_TOOLS_ROOT)
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
      process.env.ZHIXU_S5_BROWSER_TOOLS_ROOT,
      'engines',
    );
  let browser, browserServer;
  try {
    const options = { headless: true };
    if (engine === 'chromium')
      options.executablePath =
        process.env.ZHIXU_S5_CHROME ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browserServer = await browserLibrary()[engine].launchServer({
      ...options,
      host: '127.0.0.1',
      timeout: 30000,
    });
    browser = await withBrowserDeadline(
      browserLibrary()[engine].connect(browserServer.wsEndpoint()),
      'CONNECT',
    );
    await scenario.record('S5-BROWSER-IDENTITY', {
      engine,
      browser_version: browser.version(),
      artifact,
      mocked_business_http: false,
    });
  } catch (error) {
    await browserServer?.kill().catch(() => undefined);
    await app.close();
    await scenario.record('S5-BROWSER-LAUNCH-FAILED', {
      status: 'BLOCKED',
      engine,
      error_name: error.name,
      failure_message_sha256: createHash('sha256')
        .update(String(error.message))
        .digest('hex'),
    });
    await scenario.close();
    throw error;
  }
  const password = 'S5!' + randomBytes(24).toString('hex');
  scenario.registerSecret(password);
  const pages = [],
    traffic = [],
    pageErrors = [];
  async function context() {
    const result = await withBrowserDeadline(
      browser.newContext({
        locale: 'en-US',
        viewport: { width: 1440, height: 1000 },
      }),
      'NEW_CONTEXT',
    );
    const page = await withBrowserDeadline(result.newPage(), 'NEW_PAGE');
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
    await page.getByLabel('Username', { exact: true }).fill('s5-owner');
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
    engine,
    password,
    traffic,
    pageErrors,
    context,
    login,
    screenshot,
    async close() {
      try {
        await withBrowserDeadline(browser.close(), 'CLOSE', 10000);
      } finally {
        await browserServer.kill();
        await app.close();
        if (
          assetManifest(path.join(releaseRoot(), 'static/dist-v2')).sha256 !==
          scenario.identity.frontend_manifest_sha256
        )
          throw Error('S5_FRONTEND_CHANGED');
        await scenario.close();
      }
    },
  };
}
module.exports = { browserFixture, browserLibrary };
