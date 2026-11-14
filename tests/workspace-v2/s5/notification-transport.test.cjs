const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createS5Fixture, artifactModule } = require('./artifact-support.cjs');

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return 'http://127.0.0.1:' + server.address().port;
}

test(
  'S5 compiled notification transport preserves redirect rejection, response bound and actual network deadline',
  { timeout: 30000 },
  async function s5NotificationTransportQualification(t) {
    const h = await createS5Fixture(t, { caseId: 'S5-NOTIFICATION-TRANSPORT' });
    const { notificationTransport } = artifactModule(
      'services/notificationTransport',
    );
    const credential = 'S5_OWNED_' + randomUUID();
    h.registerSecret(credential);
    let receiverRequests = 0,
      redirectRequests = 0;
    const receiver = await listen(t, (req, res) => {
      receiverRequests++;
      req.resume();
      res.end('unexpected redirect');
    });
    const redirect = await listen(t, (req, res) => {
      redirectRequests++;
      req.resume();
      res.writeHead(307, { Location: receiver + '/delivery' });
      res.end('explicit redirect response');
    });
    const options = {
      json: { message: 'owned notification' },
      headers: { Authorization: 'Bearer ' + credential },
    };
    const result = await notificationTransport.request(redirect, options);
    assert.equal(result.statusCode, 307);
    assert.equal(await result.body.text(), 'explicit redirect response');
    await assert.rejects(notificationTransport.post(redirect, options), {
      code: 'PROVIDER_HTTP_FAILED',
    });
    assert.equal(redirectRequests, 2);
    assert.equal(
      receiverRequests,
      0,
      'redirect target must receive neither request nor credential',
    );
    const large = await listen(t, (req, res) => {
      req.resume();
      res.end(Buffer.alloc(70 * 1024, 65));
    });
    await assert.rejects(notificationTransport.post(large, options), {
      code: 'PROVIDER_RESPONSE_LIMIT',
    });
    const stalled = await listen(t, (req) => req.resume());
    const before = performance.now();
    await assert.rejects(notificationTransport.post(stalled, options), {
      code: 'PROVIDER_NETWORK_FAILED',
    });
    const elapsed = performance.now() - before;
    assert.ok(
      elapsed >= 9000 && elapsed < 25000,
      'configured network deadline must actually terminate the request',
    );
    await h.record('S5-NOTIFICATION-TRANSPORT', {
      status: 'PASS',
      http_statuses: [307],
      redirect_requests: redirectRequests,
      redirect_target_requests: receiverRequests,
      credentials_forwarded: false,
      response_limit_bytes: 65536,
      oversized_response_rejected: true,
      network_failure_code: 'PROVIDER_NETWORK_FAILED',
      actual_deadline_ms: elapsed,
    });
  },
);
