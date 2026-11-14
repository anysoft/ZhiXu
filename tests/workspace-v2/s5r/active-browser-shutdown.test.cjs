// Explicit browser job only: real engine + sealed production CLI, no API interception.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { productionCli, until } = require('./production-cli.cjs');
const engine = process.env.ZHIXU_S5_BROWSER_ENGINE;
assert.ok(
  ['chromium', 'firefox', 'webkit'].includes(engine),
  'explicit real engine required',
);
assert.ok(
  process.env.ZHIXU_S5_PLAYWRIGHT,
  'explicit independently acquired browser SDK required',
);
const playwright = require(process.env.ZHIXU_S5_PLAYWRIGHT);
const samples = Number(process.env.ZHIXU_S5R_BROWSER_SHUTDOWN_SAMPLES || 3);
assert.ok(Number.isInteger(samples) && samples >= 2 && samples <= 10);
const scenarios = [
  'IDLE_KEEP_ALIVE',
  'AUTHENTICATED_UPLOAD',
  'LOG_POLLING',
  'ACTIVE_TASK',
  'BACKUP_PENDING',
  'RESTORE_PENDING',
  'CONTEXT_ALREADY_CLOSED',
];

for (const scenario of scenarios)
  for (let sample = 1; sample <= samples; sample++)
    test(
      `S5R ${engine} production shutdown ${scenario} independent sample ${sample}`,
      { timeout: 180000 },
      async (t) => {
        const caseId = `S5R-BROWSER-${engine.toUpperCase()}-${scenario}-${sample}`;
        const f = await productionCli(t, caseId);
        const launch = { headless: true };
        if (engine === 'chromium' && process.env.ZHIXU_S5_CHROME)
          launch.executablePath = process.env.ZHIXU_S5_CHROME;
        const browser = await playwright[engine].launch(launch);
        let context = await browser.newContext({
          locale: 'en-US',
          viewport: { width: 1440, height: 1000 },
        });
        let closedBeforeSignal = false,
          socket,
          run,
          snapshotOperation,
          snapshotId,
          postSnapshotWorkspace;
        t.after(async () => {
          socket?.destroy();
          await browser.close();
        });
        const page = await context.newPage(),
          traffic = [];
        page.on('response', (response) => {
          const url = new URL(response.url());
          if (url.origin === f.origin && url.pathname.startsWith('/api/'))
            traffic.push({
              method: response.request().method(),
              path: url.pathname,
              status: response.status(),
            });
        });
        await page.goto(f.origin);
        await page.getByLabel('Username', { exact: true }).fill('owner');
        await page.getByLabel('Password', { exact: true }).fill(f.password);
        const login = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/user/login' &&
            response.request().method() === 'POST',
        );
        await page
          .getByRole('button', { name: 'Sign in', exact: true })
          .click();
        f.adoptSession((await (await login).json()).data);
        await page.waitForURL('**/dashboard');
      let childPid, releaseTask;
        if (
          [
            'LOG_POLLING',
            'ACTIVE_TASK',
            'BACKUP_PENDING',
            'RESTORE_PENDING',
          ].includes(scenario)
        ) {
        releaseTask = path.join(f.h.root, 'release-task');
        const quoted = "'" + releaseTask.replace(/'/g, "'\\''") + "'";
        run = await f.task('printf "S5R_BROWSER_CHILD=%s\\n" "$$"\nwhile [ ! -f ' + quoted + ' ]; do sleep 0.05; done\nprintf "S5R_BROWSER_SUCCESS\\n"\n');
          await f.running(run.run_id);
          const log = await until(
            () => f.request('GET', `/task-runs/${run.run_id}/log`),
            (row) => row.body.data?.text?.includes('S5R_BROWSER_CHILD='),
          );
          childPid = Number(
            log.body.data.text.match(/S5R_BROWSER_CHILD=(\d+)/)[1],
          );
        }
        if (scenario === 'AUTHENTICATED_UPLOAD') {
          socket = net.createConnection(
            Number(new URL(f.origin).port),
            '127.0.0.1',
          );
          socket.on('error', () => undefined);
          await once(socket, 'connect');
          const boundary = 's5r-browser-stream';
          socket.write(
            [
              'POST /api/restores/import HTTP/1.1',
              'Host: ' + new URL(f.origin).host,
              'Origin: ' + f.origin,
              'Authorization: Bearer ' + f.session.token,
              'X-CSRF-Token: ' + f.session.csrf,
              'Content-Type: multipart/form-data; boundary=' + boundary,
              'Content-Length: 65536',
              'Connection: keep-alive',
              '',
              '--' +
                boundary +
                '\r\nContent-Disposition: form-data; name="file"; filename="controlled.platform-backup"\r\nContent-Type: application/octet-stream\r\n\r\nunfinished',
            ].join('\r\n'),
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (scenario === 'LOG_POLLING') {
          const observed = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname ===
              `/api/task-runs/${run.run_id}/log`,
          );
          await page.goto(f.origin + '/runs/' + run.run_id);
          assert.equal((await observed).status(), 200);
          await page.getByTestId('run-log').waitFor();
        }
        if (scenario === 'BACKUP_PENDING') {
          const snapshot = await f.request('POST', '/backups', {});
          snapshotOperation = snapshot.body.data.id;
          const status = await f.request(
            'GET',
            '/backups/operations/' + snapshotOperation,
          );
          assert.ok(['QUEUED', 'RUNNING'].includes(status.body.data.status));
        }
        if (scenario === 'RESTORE_PENDING') {
        await fs.writeFile(releaseTask, 'complete before the snapshot\n', { mode: 0o600, flag: 'wx' });
          assert.equal(
            (await f.terminal(run.run_id)).body.data.status,
            'SUCCESS',
          );
          const snapshot = await f.request('POST', '/backups', {});
          snapshotId = (await f.operation(snapshot.body.data.id)).result;
          assert.equal(typeof snapshotId, 'string');
          const after = await f.request(
            'POST',
            '/workspaces',
            { type: 'LOCAL', name: 'after snapshot' },
            'after-snapshot',
          );
          assert.equal(after.status, 202);
          postSnapshotWorkspace = after.body.data.workspace.id;
          const staged = await f.request(
            'POST',
            '/restores/' + snapshotId + '/stage',
            { source: 'snapshots', confirmation: 'RESTORE' },
          );
          assert.equal(staged.status, 202);
        }
        const screenshot = path.join(
          f.h.evidenceRoot,
          caseId + '-before-signal.png',
        );
        // RESTORE must be signalled directly after its durable-admission response;
        // waiting for a screenshot here could silently turn pending into COMPLETE.
        let screenshotSha;
        if (scenario !== 'RESTORE_PENDING') {
          await page.screenshot({ path: screenshot });
          screenshotSha = createHash('sha256')
            .update(await fs.readFile(screenshot))
            .digest('hex');
        }
        if (scenario === 'CONTEXT_ALREADY_CLOSED') {
          await context.close();
          context = undefined;
          closedBeforeSignal = true;
        }
      if (run && scenario !== 'RESTORE_PENDING')
        assert.equal((await f.request('GET', `/task-runs/${run.run_id}`)).body.data.status, 'RUNNING');
      const stopping = f.shutdown();
      if (releaseTask && scenario !== 'RESTORE_PENDING') {
        // Release this specific child's natural-completion gate after SIGTERM.
        // The owned control file is outside user source and Runtime domains.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await fs.writeFile(releaseTask, 'natural completion during graceful stop\n', { mode: 0o600, flag: 'wx' });
      }
      const lifetime = await stopping;
        assert.equal(closedBeforeSignal, scenario === 'CONTEXT_ALREADY_CLOSED');
        if (scenario === 'AUTHENTICATED_UPLOAD') {
          const admission = lifetime.events.find(
            (event) => event.phase === 'ADMISSION_CLOSED',
          );
          assert.ok(admission.requests >= 1);
          assert.ok(admission.handlers >= 1);
          assert.ok(
            lifetime.events.some(
              (event) => event.phase === 'HTTP_TRANSPORT_DEADLINE',
            ),
          );
        }
        if (childPid)
          assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
        if (context) {
          await context.close();
          context = undefined;
        }
        const oldPid = lifetime.pid;
        const next = await f.launch();
        assert.notEqual(next.pid, oldPid);
        await f.login();
        assert.equal((await f.request('GET', '/system')).body.data.ready, true);
        if (run)
          assert.equal(
            (await f.terminal(run.run_id)).body.data.status,
            'SUCCESS',
          );
        if (snapshotOperation) await f.operation(snapshotOperation);
        if (scenario === 'RESTORE_PENDING') {
          assert.equal(
            (await f.request('GET', '/restore/status')).body.data.stage,
            'COMPLETE',
          );
          assert.equal(
            (await f.request('GET', '/workspaces/' + postSnapshotWorkspace))
              .status,
            404,
          );
        }
        await f.h.record(caseId, {
          status: 'PASS',
          engine,
          browser_version: browser.version(),
          sample,
          scenario,
          application_pid: oldPid,
          independent_restart_pid: next.pid,
          browser_context_closed_before_sigterm: closedBeforeSignal,
          mocked_business_http: false,
          shutdown_duration_ms: lifetime.shutdown_duration_ms,
          shutdown_events: lifetime.events,
          traffic,
          screenshot_sha256: screenshotSha,
          original_run_id: run?.run_id,
          original_task_id: run?.task_id,
          task_terminal_status: run ? 'SUCCESS' : undefined,
          active_authenticated_request_source:
            scenario === 'AUTHENTICATED_UPLOAD'
              ? 'CONTROLLED_REAL_HTTP_MULTIPART_WITH_LIVE_AUTHENTICATED_BROWSER_CONTEXT'
              : undefined,
          actual_log_transport:
            scenario === 'LOG_POLLING'
              ? 'PAGINATED_HTTP_POLLING_NO_SSE_OR_WEBSOCKET_ENDPOINT'
              : undefined,
        });
        await f.shutdown();
      },
    );
