const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const release = process.env.ZHIXU_S5_RELEASE_ROOT;
process.env.QL_DIR = release || path.resolve(__dirname, '../../..');
process.env.QL_DATA_DIR = '/dev/null';
process.env.JWT_SECRET = randomUUID();
const modulePath = (name) =>
  release
    ? path.join(release, 'static/build', name + '.js')
    : path.resolve(__dirname, '../../../back', name + '.ts');
const dependencies = release
  ? path.join(release, 'node_modules')
  : path.resolve(__dirname, '../../../node_modules');
const express = require(path.join(dependencies, 'express'));
const sqlite3 = require(path.join(dependencies, 'sqlite3'));
const { V2HttpLifetime } = require(modulePath('applicationV2/httpLifetime'));
const { BackupPaths } = require(modulePath('services/backup/paths'));
const { BackupOperations } = require(modulePath('services/backup/operations'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t, routes) {
  const events = [],
    app = express(),
    lifetime = new V2HttpLifetime((row) => events.push(row));
  app.use(lifetime.admission);
  routes?.(app, lifetime);
  const server = http.createServer(app);
  lifetime.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(() => lifetime.close(server, 25));
  return {
    app,
    server,
    lifetime,
    events,
    port,
    origin: 'http://127.0.0.1:' + port,
  };
}
async function socketTo(t, port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => undefined);
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  return socket;
}
function noOpenTransports(events) {
  const drained = events.find((row) => row.phase === 'HTTP_HANDLERS_DRAINED');
  assert.ok(drained);
  assert.equal(drained.connections, 0);
  assert.equal(drained.requests, 0);
  assert.equal(drained.handlers, 0);
}

test('S5R idle HTTP keep-alive drains without waiting for the peer', async (t) => {
  const f = await fixture(t, (app) =>
    app.get('/health', (_req, res) => res.json({ ok: true })),
  );
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  await new Promise((resolve, reject) =>
    http
      .get(f.origin + '/health', { agent }, (response) => {
        response.resume();
        response.once('end', resolve);
      })
      .once('error', reject),
  );
  await f.lifetime.close(f.server, 100);
  assert.equal(
    f.events.some((row) => row.phase === 'HTTP_TRANSPORT_DEADLINE'),
    false,
  );
  noOpenTransports(f.events);
});

test('S5R half-written headers are bounded without waiting for request admission', async (t) => {
  const f = await fixture(t),
    socket = await socketTo(t, f.port);
  socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  await delay(20);
  await f.lifetime.close(f.server, 50);
  assert.ok(f.events.some((row) => row.phase === 'HTTP_TRANSPORT_DEADLINE'));
  noOpenTransports(f.events);
});

test('S5R a half-written JSON body is aborted before database shutdown', async (t) => {
  let called = false;
  const f = await fixture(t, (app, lifetime) => {
    app.use(express.json());
    app.post(
      '/submit',
      lifetime.handle(async (_req, res) => {
        called = true;
        res.end();
      }),
    );
    app.use((error, _req, res, _next) => {
      if (!res.destroyed) res.status(400).end();
    });
  });
  const socket = await socketTo(t, f.port);
  socket.write(
    'POST /submit HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 65536\r\n\r\n{"unfinished":',
  );
  await delay(20);
  await f.lifetime.close(f.server, 50);
  assert.equal(called, false);
  noOpenTransports(f.events);
});

test('S5R disconnecting an admitted async handler does not close its database early', async (t) => {
  const admitted = gate(),
    releaseAction = gate();
  const database = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (error) =>
      error ? reject(error) : resolve(db),
    );
  });
  let closed = false;
  t.after(() => {
    releaseAction.resolve();
    if (!closed) database.close();
  });
  const f = await fixture(t, (app, lifetime) => {
    app.get(
      '/accepted',
      lifetime.handle(async (_req, res) => {
        admitted.resolve();
        await releaseAction.promise;
        await new Promise((resolve, reject) =>
          database.run('CREATE TABLE completed(id INTEGER)', (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        if (!res.destroyed) res.end('done');
      }),
    );
  });
  const socket = await socketTo(t, f.port);
  socket.write('GET /accepted HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  await admitted.promise;
  const shutdown = f.lifetime.close(f.server, 50).then(async () => {
    const row = await new Promise((resolve, reject) =>
      database.get(
        "SELECT name FROM sqlite_master WHERE name='completed'",
        (error, value) => (error ? reject(error) : resolve(value)),
      ),
    );
    assert.equal(row.name, 'completed');
    await new Promise((resolve, reject) =>
      database.close((error) => (error ? reject(error) : resolve())),
    );
    closed = true;
  });
  await delay(100);
  assert.equal(
    closed,
    false,
    'closing the transport cannot discard the pending operation',
  );
  releaseAction.resolve();
  await shutdown;
  noOpenTransports(f.events);
});

test('S5R async HTTP rejection retains the Express error handler', async (t) => {
  const f = await fixture(t, (app, lifetime) => {
    app.get(
      '/error',
      lifetime.handle(async () => {
        throw Error('controlled');
      }),
    );
    app.use((_error, _req, res, _next) => res.status(409).json({ code: 409 }));
  });
  const response = await fetch(f.origin + '/error');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: 409 });
  await f.lifetime.close(f.server, 50);
  noOpenTransports(f.events);
});

test('S5R accepted backup work drains through terminal journal publication and lease release', async (t) => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), 's5r-backup-lifetime-'),
  );
  await fs.chmod(root, 0o700);
  const stat = await fs.lstat(root);
  await fs.writeFile(
    path.join(root, '.s5r-owner.json'),
    JSON.stringify({
      stage: 'S5.R',
      root,
      dev: stat.dev,
      ino: stat.ino,
      token: randomUUID(),
    }),
    { mode: 0o600, flag: 'wx' },
  );
  process.stdout.write('S5R retained scenario: ' + root + '\n');
  const paths = new BackupPaths(
    path.join(root, 'data'),
    path.join(root, 'backups'),
  );
  const operations = new BackupOperations(paths),
    releaseAction = gate();
  let closed = false;
  const operation = await operations.start('LIFETIME_TEST', async () => {
    await releaseAction.promise;
    return { durable_test: true };
  });
  const shutdown = operations.close().then(() => {
    closed = true;
  });
  t.after(() => releaseAction.resolve());
  await delay(25);
  assert.equal(closed, false);
  await assert.rejects(
    operations.start('LATE_TEST', async () => undefined),
    /BACKUP_OPERATION_BUSY/,
  );
  releaseAction.resolve();
  await shutdown;
  const terminal = await operations.get(operation.id);
  assert.equal(terminal.status, 'SUCCESS');
  assert.ok(terminal.finished_at);
  const independent = new BackupOperations(paths);
  await independent.exclusive(async () => undefined);
  await independent.close();
});
