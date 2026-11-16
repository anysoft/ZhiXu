const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http'),
  https = require('node:https'),
  net = require('node:net'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createFixture, seedRepository, git } = require('./fixture.cjs');
const { ProxyManagement } = require('../../back/services/proxyManagement');
const { applyGitProxy } = require('../../back/services/gitProxy');
const {
  WorkspaceLifecycleService,
} = require('../../back/services/workspaceV2/lifecycle');
const {
  WorkspaceFileService,
} = require('../../back/services/workspaceV2/files');
const { TaskService } = require('../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../back/services/taskExecutionV2/execution');
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        s.closeAllConnections();
        s.close(r);
      }),
  );
  return s;
}
function command(exe, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const c = spawn(exe, args, {
      env,
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {}
    }, 15000);
    let out = '',
      err = '';
    c.stdout.on('data', (b) => (out += b));
    c.stderr.on('data', (b) => (err += b));
    c.once('error', reject);
    c.once('close', (code) => {
      clearTimeout(timer);
      return code
        ? reject(Error(`${exe} failed (${code}): ${err}`))
        : resolve(out);
    });
  });
}
test('Task proxies are per-run, pinned during edits, actually route curl, redact secrets and honor DIRECT', async (t) => {
  const f = await createFixture(t),
    manager = new ProxyManagement(f.store);
  let a = 0,
    b = 0,
    first;
  const firstRequest = new Promise((r) => (first = r));
  let release;
  const gate = new Promise((r) => (release = r));
  t.after(() => release());
  const pa = await server(t, async (req, res) => {
    a++;
    if (a === 1) {
      first();
      await gate;
    }
    res.end('PROXY_A\n');
  });
  const pb = await server(t, (req, res) => {
    b++;
    res.end('PROXY_B\n');
  });
  const origin = await server(t, (_req, res) => res.end('DIRECT_OK\n'));
  const profileA = await manager.save({
    name: 'A',
    protocol: 'HTTP',
    host: '127.0.0.1',
    port: pa.address().port,
    username: 'fixture',
    password: 'proxy-pass-@-secret',
  });
  const profileB = await manager.save({
    name: 'B',
    protocol: 'HTTP',
    host: '127.0.0.1',
    port: pb.address().port,
  });
  await manager.saveSelection('platform', 0, {
    mode: 'PROFILE',
    profile_id: profileA.id,
  });
  const lifecycle = new WorkspaceLifecycleService(f.store, f.roots, f.leases),
    files = new WorkspaceFileService(f.store, f.roots, f.leases),
    tasks = new TaskService(f.store, f.roots, f.leases);
  const engine = f.track(new TaskExecutionService(f.store, f.roots, f.leases));
  async function task(name, code, proxy) {
    const ws = await lifecycle.createLocal({ name, requestKey: name });
    await files.create(ws.id, 'main.sh', code);
    return tasks.create({
      name,
      source: {
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: ws.id,
        relative_entrypoint: 'main.sh',
        language: 'SHELL',
        cwd_mode: 'WORKSPACE_ROOT',
        cwd_relative_path: null,
      },
      proxy,
      execution: { concurrency: 'ALLOW' },
    });
  }
  const ta = await task(
    'proxy-A',
    'printf "%s\\n" "$http_proxy"; curl -qfsS --max-time 15 http://proxy-target.invalid/one; curl -qfsS --max-time 15 http://proxy-target.invalid/two\n',
    { mode: 'INHERIT' },
  );
  const tb = await task(
    'proxy-B',
    'curl -qfsS --max-time 15 http://proxy-target.invalid/one\n',
    { mode: 'PROFILE', profile_id: profileB.id },
  );
  const ra = await engine.submit(ta.task.id);
  const waitingA = engine.wait(ra.id);
  await firstRequest;
  await manager.save({ port: pb.address().port }, profileA.id);
  const rb = await engine.submit(tb.task.id);
  const doneB = await engine.wait(rb.id);
  release();
  const doneA = await waitingA;
  assert.equal(doneA.status, 'SUCCESS');
  assert.equal(doneB.status, 'SUCCESS');
  assert.equal(a, 2);
  assert.equal(b, 1);
  const logA = await engine.logs(ra.id);
  assert.match(logA, /PROXY_A/);
  assert.ok(!logA.includes('proxy-pass'));
  assert.ok(!logA.includes('proxy-pass-%40-secret'));
  assert.match(await engine.logs(rb.id), /PROXY_B/);
  assert.equal(JSON.parse(doneA.source_snapshot).proxy_profile_id, profileA.id);
  const td = await task(
    'direct',
    `test -z "$http_proxy"; curl -qfsS --max-time 15 http://127.0.0.1:${
      origin.address().port
    }/\n`,
    { mode: 'DIRECT' },
  );
  assert.equal(
    (await engine.wait((await engine.submit(td.task.id)).id)).status,
    'SUCCESS',
  );
  assert.equal(a, 2);
  assert.equal(b, 1);
});
test('native Git HTTPS clones through authenticated CONNECT proxy while verifying TLS; SSH refuses proxy', async (t) => {
  const f = await createFixture(t),
    manager = new ProxyManagement(f.store),
    repo = await seedRepository(f, 1);
  git(['update-server-info'], repo.bare);
  const key = path.join(f.root, 'key.pem'),
    cert = path.join(f.root, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const origin = https.createServer(
    { key: await fs.readFile(key), cert: await fs.readFile(cert) },
    async (req, res) => {
      const file = path.join(
        repo.bare,
        new URL(req.url, 'https://localhost').pathname.replace(
          /^\/repo.git\//,
          '',
        ),
      );
      try {
        res.end(await fs.readFile(file));
      } catch {
        res.writeHead(404).end();
      }
    },
  );
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        origin.closeAllConnections();
        origin.close(r);
      }),
  );
  let connects = 0;
  const sockets = new Set();
  t.after(() => {
    for (const s of sockets) s.destroy();
  });
  const proxy = await server(t, (_req, res) => res.writeHead(405).end());
  proxy.on('connect', (req, client, head) => {
    connects++;
    if (!req.headers['proxy-authorization']) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    assert.equal(
      req.headers['proxy-authorization'],
      'Basic ' + Buffer.from('fixture:secret-auth').toString('base64'),
    );
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('error', () => {});
      s.on('close', () => sockets.delete(s));
    }
  });
  t.after(() => {
    for (const s of sockets) s.destroy();
  });
  const profile = await manager.save({
    name: 'Git proxy',
    protocol: 'HTTP',
    host: '127.0.0.1',
    port: proxy.address().port,
    username: 'fixture',
    password: 'secret-auth',
  });
  await manager.saveSelection('repository', 1, {
    mode: 'PROFILE',
    profile_id: profile.id,
  });
  const access = await applyGitProxy(
    {
      remote: `https://localhost:${origin.address().port}/repo.git`,
      env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0' },
      secrets: [],
      cleanup: async () => {},
      directory: f.root,
    },
    f.store,
    1,
  );
  access.env.GIT_SSL_CAINFO = cert;
  try {
    await command(
      'git',
      [
        'clone',
        '--quiet',
        '--',
        access.remote,
        path.join(f.root, 'proxy-clone'),
      ],
      access.env,
      f.root,
    );
    assert.ok(connects > 0);
    assert.equal(
      git(['rev-parse', 'HEAD'], path.join(f.root, 'proxy-clone')),
      repo.commit,
    );
  } finally {
    await access.cleanup();
  }
  await assert.rejects(
    applyGitProxy(
      {
        remote: 'git@github.com:fixture/repo.git',
        env: {},
        secrets: [],
        directory: f.root,
        cleanup: async () => {},
      },
      f.store,
      1,
    ),
    { error_code: 'PROXY_SSH_UNSUPPORTED' },
  );
});
