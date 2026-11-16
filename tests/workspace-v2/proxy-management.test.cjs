const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { createFixture, insertTaskSource } = require('./fixture.cjs');
const {
  ProxyManagement,
  holdResolvedProxy,
  sanitizeProxyOutput,
} = require('../../back/services/proxyManagement');

const input = (name, port = 8080, protocol = 'HTTP') => ({
  name,
  protocol,
  host: '127.0.0.1',
  port,
  username: 'proxy-user',
  password: 'p@ss:word!',
});
async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  return server.address().port;
}
async function resources(f) {
  const {
    WorkspaceLifecycleService,
  } = require('../../back/services/workspaceV2/lifecycle');
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases);
  await lifecycle.createLocal({
    name: 'proxy workspace',
    requestKey: 'proxy-ws-1',
  });
  await lifecycle.createLocal({
    name: 'other workspace',
    requestKey: 'proxy-ws-2',
  });
  await f.store.run(
    "INSERT INTO Repositories(id,name,provider,remote_url,normalized_url) VALUES(1,'proxy repository','github','https://example.com/a.git','https://example.com/a.git')",
  );
  const task = await insertTaskSource(f.store, 1),
    other = await insertTaskSource(f.store, 2);
  return { task, other };
}

test('proxy CRUD keeps credential private, preserves secret edits, and atomically guards references', async (t) => {
  const f = await createFixture(t),
    manager = new ProxyManagement(f.store, f.barrier);
  const p = await manager.save(input('one'));
  assert.equal(p.has_password, true);
  assert.equal('password' in p, false);
  assert.equal(JSON.stringify(await manager.list()).includes('p@ss'), false);
  assert.equal(
    (
      await manager.resolve({ override: { mode: 'PROFILE', profile_id: p.id } })
    ).url.includes('p%40ss%3Aword!'),
    true,
  );
  await manager.save({ name: 'renamed' }, p.id);
  assert.equal(
    (
      await manager.resolve({ override: { mode: 'PROFILE', profile_id: p.id } })
    ).url.includes('p%40ss%3Aword!'),
    true,
  );
  await assert.rejects(manager.save({ password: 'unexpected' }, p.id), {
    error_code: 'PROXY_CONFIGURATION_INVALID',
  });
  await manager.saveSelection('platform', 0, {
    mode: 'PROFILE',
    profile_id: p.id,
  });
  await assert.rejects(manager.remove(p.id), {
    error_code: 'PROXY_PROFILE_IN_USE',
  });
  await manager.save({ status: 'disabled' }, p.id);
  await assert.rejects(manager.resolve(), {
    error_code: 'PROXY_PROFILE_DISABLED',
  });
  await manager.saveSelection('platform', 0, { mode: 'DIRECT' });
  await manager.remove(p.id);
  assert.deepEqual(await manager.list(), []);
  for (const patch of [
    { host: 'https://evil.invalid' },
    { host: 'bad host' },
    { port: 0 },
    { port: 65536 },
    { protocol: 'file' },
    { password: 'a\nb' },
  ])
    await assert.rejects(manager.save({ ...input('invalid'), ...patch }), {
      error_code: 'PROXY_CONFIGURATION_INVALID',
    });
});

test('one resolver applies platform/workspace/repository/task/operation precedence and DIRECT compatibility', async (t) => {
  const f = await createFixture(t),
    m = new ProxyManagement(f.store, f.barrier),
    { task, other } = await resources(f);
  assert.deepEqual(await m.getSelection('workspace', 1), { mode: 'INHERIT' });
  for (const override of [null, false, ''])
    await assert.rejects(m.resolve({ override }), {
      error_code: 'PROXY_CONFIGURATION_INVALID',
    });
  const initial = await m.resolve({ taskId: task });
  assert.equal(initial.profileId, null);
  assert.equal(initial.configured, false);
  const a = await m.save(input('platform', 8001)),
    b = await m.save(input('workspace', 8002)),
    c = await m.save(input('specific', 8003));
  await m.saveSelection('platform', 0, { mode: 'PROFILE', profile_id: a.id });
  assert.equal((await m.resolve({ taskId: task })).profileId, a.id);
  await m.saveSelection('workspace', 1, { mode: 'PROFILE', profile_id: b.id });
  assert.equal((await m.resolve({ taskId: task })).profileId, b.id);
  assert.equal((await m.resolve({ taskId: other })).profileId, a.id);
  await m.saveSelection('repository', 1, { mode: 'PROFILE', profile_id: c.id });
  assert.equal(
    (await m.resolve({ workspaceId: 1, repositoryId: 1 })).profileId,
    c.id,
  );
  await m.saveSelection('task', task, { mode: 'DIRECT' });
  const direct = await m.resolve({ taskId: task });
  assert.deepEqual(direct.env, {});
  assert.equal(direct.configured, true);
  assert.equal(
    (
      await m.resolve({
        taskId: task,
        override: { mode: 'PROFILE', profile_id: c.id },
      })
    ).profileId,
    c.id,
  );
  await assert.rejects(m.resolve({ workspaceId: 2, taskId: task }), {
    error_code: 'PROXY_SCOPE_INVALID',
  });
  await assert.rejects(m.saveSelection('task', 999, { mode: 'DIRECT' }), {
    error_code: 'PROXY_SCOPE_NOT_FOUND',
  });
  const pinned = await m.resolve({
    override: { mode: 'PROFILE', profile_id: b.id },
  });
  await m.save({ port: 8010 }, b.id);
  assert.equal(pinned.env.HTTPS_PROXY.includes(':8002'), true);
  assert.ok(Object.isFrozen(pinned.env));
  const output = sanitizeProxyOutput(
    `curl ${pinned.url} password p@ss:word!`,
    pinned.secretValues,
  );
  assert.equal(output.includes('p@ss'), false);
  assert.equal(output.includes('p%40ss'), false);
});

test('active operation holds prevent deletion after configuration is switched away', async (t) => {
  const f = await createFixture(t),
    m = new ProxyManagement(f.store, f.barrier),
    p = await m.save(input('held'));
  const resolved = await m.resolve({
      override: { mode: 'PROFILE', profile_id: p.id },
    }),
    release = holdResolvedProxy(f.store, resolved.profileId);
  await assert.rejects(m.remove(p.id), { error_code: 'PROXY_PROFILE_IN_USE' });
  assert.deepEqual((await m.list())[0].used_by, [
    { scope: 'in_flight', id: 0 },
  ]);
  release();
  release();
  await m.remove(p.id);
});

test('HTTP authenticated proxy connectivity test makes a real forwarded request and never returns authentication data', async (t) => {
  const f = await createFixture(t);
  let forwarded = 0;
  const origin = http.createServer((req, res) => res.end('proxy-test-ok')),
    originPort = await listen(t, origin);
  const proxy = http.createServer((req, res) => {
    if (
      req.headers['proxy-authorization'] !==
      'Basic ' + Buffer.from('proxy-user:p@ss:word!').toString('base64')
    ) {
      res.writeHead(407);
      res.end();
      return;
    }
    forwarded++;
    const target = new URL(req.url);
    const upstream = http.request(target, { method: req.method }, (r) => {
      res.writeHead(r.statusCode);
      r.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  const proxyPort = await listen(t, proxy),
    m = new ProxyManagement(f.store, f.barrier, {
      testTarget: `http://127.0.0.1:${originPort}/`,
    });
  const p = await m.save(input('http', proxyPort));
  const result = await m.test(p.id);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(forwarded, 1);
  assert.equal(JSON.stringify(result).includes('proxy-user'), false);
  await m.save({ password: 'wrong', replace_password: true }, p.id);
  const failed = await m.test(p.id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.diagnostic, 'PROXY_AUTHENTICATION_FAILED');
  assert.equal(forwarded, 1);
});

test('SOCKS5 authenticated proxy connectivity uses a real SOCKS handshake and forwards bytes', async (t) => {
  const f = await createFixture(t);
  let forwarded = 0;
  const sockets = new Set();
  t.after(() => {
    for (const s of sockets) s.destroy();
  });
  const origin = http.createServer((req, res) => res.end('socks-ok')),
    port = await listen(t, origin);
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let stage = 'greeting',
      pending = Buffer.alloc(0);
    const receive = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (stage === 'greeting') {
        if (pending.length < 2 + pending[1]) return;
        pending = pending.subarray(2 + pending[1]);
        socket.write(Buffer.from([5, 2]));
        stage = 'auth';
      }
      if (stage === 'auth') {
        if (pending.length < 2) return;
        const n = pending[1];
        if (pending.length < 3 + n + pending[2 + n]) return;
        const user = pending.subarray(2, 2 + n).toString(),
          password = pending.subarray(3 + n, 3 + n + pending[2 + n]).toString();
        assert.equal(user, 'proxy-user');
        assert.equal(password, 'p@ss:word!');
        pending = pending.subarray(3 + n + pending[2 + n]);
        socket.write(Buffer.from([1, 0]));
        stage = 'connect';
      }
      if (stage === 'connect') {
        if (pending.length < 5) return;
        let host, end;
        if (pending[3] === 1) {
          end = 8;
          host = [...pending.subarray(4, 8)].join('.');
        } else if (pending[3] === 3) {
          end = 5 + pending[4];
          if (pending.length < end + 2) return;
          host = pending.subarray(5, end).toString();
        } else {
          socket.destroy();
          return;
        }
        if (pending.length < end + 2) return;
        const targetPort = pending.readUInt16BE(end);
        pending = pending.subarray(end + 2);
        stage = 'forwarding';
        socket.removeListener('data', receive);
        const upstream = net.connect(targetPort, host, () => {
          forwarded++;
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (pending.length) upstream.write(pending);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
      }
    };
    socket.on('data', receive);
  });
  const proxyPort = await listen(t, proxy),
    m = new ProxyManagement(f.store, f.barrier, {
      testTarget: `http://127.0.0.1:${port}/`,
    });
  const p = await m.save(input('socks', proxyPort, 'SOCKS5'));
  assert.equal((await m.test(p.id)).status, 'SUCCESS');
  assert.equal(forwarded, 1);
});

test('proxy management HTTP routes preserve panel auth and return actionable disabled/in-use errors without secrets', async (t) => {
  const { httpFixture } = require('./s4/http-support.cjs');
  const f = await httpFixture(t, 'PROXY-MANAGEMENT-HTTP');
  const denied = await fetch(f.app.origin + '/api/proxy-profiles');
  assert.equal(denied.status, 401);
  const created = await f.request(
    'POST',
    '/api/proxy-profiles',
    input('HTTP API'),
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.equal(JSON.stringify(created.body).includes('p@ss'), false);
  assert.equal(
    (
      await f.request('PUT', '/api/proxy-selections/platform/0', {
        mode: 'PROFILE',
        profile_id: id,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request('PUT', '/api/proxy-profiles/' + id, {
        status: 'disabled',
      })
    ).status,
    200,
  );
  const selected = await f.request('GET', '/api/proxy-selections/platform/0');
  assert.equal(selected.status, 200);
  assert.equal(selected.body.data.selection.profile_id, id);
  assert.equal(
    selected.body.data.effective.error_code,
    'PROXY_PROFILE_DISABLED',
  );
  const referenced = await f.request('DELETE', '/api/proxy-profiles/' + id);
  assert.equal(referenced.status, 409);
  assert.equal(referenced.body.error_code, 'PROXY_PROFILE_IN_USE');
  assert.equal(
    (
      await f.request('PUT', '/api/proxy-selections/platform/0', {
        mode: 'DIRECT',
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request('DELETE', '/api/proxy-profiles/' + id)).status,
    200,
  );
  const invalid = await f.request(
    'PUT',
    '/api/proxy-selections/task/not-an-id',
    { mode: 'DIRECT' },
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error_code, 'PROXY_SCOPE_INVALID');
});

test('HTTPS proxy verifies its TLS certificate and forwards only when its test CA is trusted', async (t) => {
  const https = require('node:https'),
    fs = require('node:fs/promises'),
    path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const f = await createFixture(t);
  const key = path.join(f.root, 'proxy.key'),
    cert = path.join(f.root, 'proxy.crt');
  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  assert.equal(generated.status, 0, 'local HTTPS proxy fixture certificate');
  const origin = http.createServer((req, res) => res.end('https-proxy-ok')),
    originPort = await listen(t, origin);
  let forwarded = 0;
  const proxy = https.createServer(
    { key: await fs.readFile(key), cert: await fs.readFile(cert) },
    (req, res) => {
      assert.equal(
        req.headers['proxy-authorization'],
        'Basic ' + Buffer.from('proxy-user:p@ss:word!').toString('base64'),
      );
      forwarded++;
      const upstream = http.request(new URL(req.url), (r) => {
        res.writeHead(r.statusCode);
        r.pipe(res);
      });
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    },
  );
  const proxyPort = await listen(t, proxy),
    options = { testTarget: `http://127.0.0.1:${originPort}/` };
  const untrusted = new ProxyManagement(f.store, f.barrier, options),
    profile = await untrusted.save(input('https', proxyPort, 'HTTPS'));
  const denied = await untrusted.test(profile.id);
  assert.equal(denied.status, 'FAILED');
  assert.equal(denied.diagnostic, 'PROXY_TLS_VALIDATION_FAILED');
  assert.equal(forwarded, 0);
  const trusted = new ProxyManagement(f.store, f.barrier, {
    ...options,
    testProxyCaPath: cert,
  });
  assert.equal((await trusted.test(profile.id)).status, 'SUCCESS');
  assert.equal(forwarded, 1);
});
