// S5 reruns preserved UI/domain assertions against an explicit compiled release candidate.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { browserFixture } = require('./browser-support.cjs');
test(
  'S5 protocol negative: actual non-v2 HTTP health service cannot trigger login, setup, user reads or business writes',
  { timeout: 90000 },
  async () => {
    const f = await browserFixture('s5-browser-mode-guard'),
      requests = [];
    let initialized = false;
    const frontend = path.join(f.scenario.root, 'frontend-artifact');
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/env.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end('window.__ENV__QlBaseUrl="/";');
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        requests.push({ method: req.method, path: url.pathname });
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/api/system') {
          res.end(
            JSON.stringify({
              code: 200,
              data: {
                mode: 'external-health-service',
                initialized,
                ready: true,
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 404, error_code: 'NOT_FOUND' }));
        return;
      }
      const selected = path.resolve(frontend, '.' + url.pathname);
      if (!selected.startsWith(frontend + path.sep) && selected !== frontend) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const file =
        url.pathname === '/' ? path.join(frontend, 'index.html') : selected;
      try {
        const bytes = await fs.readFile(file);
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
        res.end(bytes);
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = 'http://127.0.0.1:' + server.address().port;
      const context = await f.browser.newContext({ locale: 'en-US' }),
        page = await context.newPage();
      await page.goto(origin);
      await page
        .getByText(
          'This interface requires the isolated v2 application. Connect to a v2 backend before signing in.',
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: 'Create administrator', exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page.getByLabel('Username', { exact: true }).isDisabled(),
        true,
      );
      initialized = true;
      await page.getByRole('button', { name: /Refresh$/ }).click();
      await page
        .getByRole('button', { name: 'Sign in', exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: 'Sign in', exact: true })
          .isDisabled(),
        true,
      );
      await page.evaluate(() =>
        document.querySelector('form')?.requestSubmit(),
      );
      assert.equal(
        requests.filter(
          (req) => req.method !== 'GET' || req.path !== '/api/system',
        ).length,
        0,
      );
      assert.ok(requests.length >= 2);
      await f.scenario.record('s5-browser-mode-guard', {
        classification: 'WRONG_SERVICE_PROTOCOL_NEGATIVE',
        actual_http_service: true,
        production_v2_business_qualification: false,
        browser_version: f.browser.version(),
        requests,
        mutations: 0,
        user_reads: 0,
        setup_and_login_disabled: true,
        frontend_artifact: f.artifact,
      });
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await f.close();
    }
  },
);
