const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { productionCli, until } = require('./production-cli.cjs');

test(
  'S5R production CLI closes an idle keep-alive peer and independently restarts',
  { timeout: 90000 },
  async (t) => {
    const f = await productionCli(t, 'S5R-CLI-IDLE-PEER');
    const agent = new http.Agent({ keepAlive: true });
    t.after(() => agent.destroy());
    await new Promise((resolve, reject) =>
      http
        .get(f.origin + '/api/health', { agent }, (response) => {
          response.resume();
          response.once('end', resolve);
        })
        .once('error', reject),
    );
    const lifetime = await f.shutdown();
    assert.ok(lifetime.shutdown_duration_ms < 5000);
    await f.launch();
    await f.login();
    assert.equal((await f.request('GET', '/system')).body.data.ready, true);
    await f.shutdown();
  },
);

test(
  'S5R production CLI bounds an authenticated incomplete backup upload and safely restarts',
  { timeout: 90000 },
  async (t) => {
    const f = await productionCli(t, 'S5R-CLI-ACTIVE-UPLOAD');
    const socket = net.createConnection(
      Number(new URL(f.origin).port),
      '127.0.0.1',
    );
    socket.on('error', () => undefined);
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    const boundary = 's5r-controlled-boundary';
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
    const lifetime = await f.shutdown();
    const admission = lifetime.events.find(
      (row) => row.phase === 'ADMISSION_CLOSED',
    );
    assert.ok(admission.requests >= 1);
    assert.ok(admission.handlers >= 1);
    assert.ok(
      lifetime.events.some((row) => row.phase === 'HTTP_TRANSPORT_DEADLINE'),
    );
    assert.ok(lifetime.shutdown_duration_ms < 15000);
    await f.launch();
    await f.login();
    assert.equal((await f.request('GET', '/restore/status')).body.data, null);
    const snapshot = await f.request('POST', '/backups', {});
    await f.operation(snapshot.body.data.id);
    await f.shutdown();
  },
);

test(
  'S5R production CLI drains an active shell run and an accepted pending snapshot',
  { timeout: 120000 },
  async (t) => {
    const f = await productionCli(t, 'S5R-CLI-TASK-AND-BACKUP');
    const run = await f.task(
      'printf "S5R_ACTIVE_CHILD=%s\\n" "$$"\nsleep 2\nprintf "S5R_COMPLETED\\n"\n',
    );
    await f.running(run.run_id);
    const log = await until(
      () => f.request('GET', `/task-runs/${run.run_id}/log`),
      (row) => row.body.data?.text?.includes('S5R_ACTIVE_CHILD='),
    );
    const childPid = Number(
      log.body.data.text.match(/S5R_ACTIVE_CHILD=(\d+)/)[1],
    );
    const snapshot = await f.request('POST', '/backups', {});
    assert.equal(snapshot.status, 200);
    const pending = await f.request(
      'GET',
      '/backups/operations/' + snapshot.body.data.id,
    );
    assert.ok(['QUEUED', 'RUNNING'].includes(pending.body.data.status));
    await f.shutdown();
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    await f.launch();
    await f.login();
    const finished = await f.terminal(run.run_id);
    assert.equal(finished.body.data.status, 'SUCCESS');
    assert.equal(finished.body.data.attempt_count, 1);
    await f.operation(snapshot.body.data.id);
    const complete = await f.request('GET', `/task-runs/${run.run_id}/log`);
    assert.ok(complete.body.data.text.includes('S5R_COMPLETED'));
    await f.shutdown();
  },
);
