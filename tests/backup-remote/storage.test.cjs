const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const {
  createRemoteStorage,
  validateRemoteTarget,
} = require('../../back/services/backup/remoteStorage');
const { startS3, startWebdav } = require('./servers.cjs');
const sha = (value) => createHash('sha256').update(value).digest('hex');

for (const [name, start] of [
  ['S3', startS3],
  ['WebDAV', startWebdav],
]) {
  test(`${name}: authenticated actual streaming CRUD, nested listing, scoped deletion and write probe`, async (t) => {
    const server = await start();
    t.after(server.close);
    const storage = createRemoteStorage(server.target);
    t.after(() => storage.close());
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'zhixu-remote-storage-'),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await storage.testConnection();
    assert.equal(server.objects.size, 0, 'permission probe removed');
    const data = randomBytes(10 * 1024 * 1024 + 7),
      input = path.join(root, 'input');
    await fs.writeFile(input, data, { mode: 0o600 });
    const key = 'zhixu-v2/SCHEDULED/LIGHTWEIGHT/example.encrypted';
    let progress = 0;
    const uploaded = await storage.upload(key, input, (loaded) => {
      progress = Math.max(progress, loaded);
    });
    assert.equal(uploaded.size, data.length);
    assert.equal(progress, data.length);
    assert.equal((await storage.stat(key)).size, data.length);
    assert.equal(
      (await storage.list()).find((x) => x.key === key).size,
      data.length,
    );
    const output = path.join(root, 'download');
    await storage.download(key, output);
    assert.equal(sha(await fs.readFile(output)), sha(data));
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
    await assert.rejects(
      storage.download(key, output),
      /BACKUP_REMOTE_REQUEST_FAILED/,
    );
    assert.equal(
      sha(await fs.readFile(output)),
      sha(data),
      'existing output untouched',
    );
    const foreign =
      name === 'S3' ? 'another-app/keep' : '/dav/another-app/keep';
    server.objects.set(foreign, Buffer.from('keep'));
    await storage.delete(key);
    assert.equal(await storage.stat(key), null);
    assert.equal(server.objects.get(foreign).toString(), 'keep');
    await assert.rejects(
      storage.upload('../escape', input),
      /BACKUP_REMOTE_PATH_INVALID/,
    );
    assert.ok(server.requests.every((r) => r.authorization));
    if (name === 'S3')
      assert.ok(
        server.requests.some((r) => r.path.includes('uploadId=')),
        'large file uses real multipart',
      );
    if (name === 'WebDAV')
      assert.ok(
        server.requests.some(
          (r) => r.method === 'PUT' && Number(r.content_length) === data.length,
        ),
        'WebDAV streams with known content length',
      );
  });
  test(`${name}: authentication and unavailable endpoint are sanitized and retryable`, async (t) => {
    const server = await start();
    t.after(server.close);
    const bad = createRemoteStorage({
      ...server.target,
      ...(name === 'S3' ? { access_key_id: 'wrong' } : { password: 'wrong' }),
    });
    t.after(() => bad.close());
    await assert.rejects(
      bad.list(),
      (e) =>
        e.code === 'BACKUP_REMOTE_AUTHENTICATION_FAILED' &&
        !e.message.includes('wrong'),
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhixu-remote-auth-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const input = path.join(root, 'encrypted');
    await fs.writeFile(input, Buffer.alloc(64 * 1024), { mode: 0o600 });
    await assert.rejects(
      bad.upload('denied.encrypted', input),
      /BACKUP_REMOTE_AUTHENTICATION_FAILED/,
    );
    const normal = createRemoteStorage(server.target);
    t.after(() => normal.close());
    await normal.testConnection();
    // WebDAV has no SDK-internal request retry: caller can retry without altering the backup.
    if (name === 'WebDAV') {
      server.failNext();
      await assert.rejects(normal.list(), /BACKUP_REMOTE_UNAVAILABLE/);
    }
    assert.deepEqual(await normal.list(), []);
    const offline = createRemoteStorage({
      ...server.target,
      endpoint: 'http://127.0.0.1:1',
    });
    t.after(() => offline.close());
    await assert.rejects(offline.list(), /BACKUP_REMOTE_UNAVAILABLE/);
  });
}
test('target and proxy validation reject traversal, URL secrets and unsupported proxy protocols', () => {
  const base = { type: 'WEBDAV', endpoint: 'https://example.com/dav' };
  assert.equal(validateRemoteTarget(base).name, 'External');
  assert.throws(
    () =>
      validateRemoteTarget({
        ...base,
        endpoint: 'https://user:password@example.com',
      }),
    /BACKUP_REMOTE_TARGET_INVALID/,
  );
  assert.throws(
    () => validateRemoteTarget({ ...base, directory: '../outside' }),
    /BACKUP_REMOTE_PATH_INVALID/,
  );
  assert.throws(
    () =>
      createRemoteStorage(
        { ...base, id: 'a', name: 'a', enabled: true },
        'socks5://127.0.0.1:1080',
      ),
    /BACKUP_REMOTE_PROXY_UNSUPPORTED/,
  );
});
test('HTTP proxy tunnels actual S3 and WebDAV requests without process-global proxy changes', async (t) => {
  const http = require('node:http'),
    net = require('node:net');
  const destination = await startWebdav();
  t.after(destination.close);
  const s3 = await startS3();
  t.after(s3.close);
  const proxy = http.createServer();
  let connections = 0;
  const clients = new Set();
  proxy.on('connect', (req, client, head) => {
    assert.equal(
      req.headers['proxy-authorization'],
      'Basic ' + Buffer.from('proxy-user:proxy-password').toString('base64'),
    );
    connections++;
    clients.add(client);
    client.on('close', () => clients.delete(client));
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        proxy.close(resolve);
        for (const client of clients) client.destroy();
        proxy.closeAllConnections();
      }),
  );
  const before = process.env.HTTP_PROXY;
  const adapter = createRemoteStorage(
    destination.target,
    `http://proxy-user:proxy-password@127.0.0.1:${proxy.address().port}`,
  );
  t.after(() => adapter.close());
  const s3Adapter = createRemoteStorage(
    s3.target,
    `http://proxy-user:proxy-password@127.0.0.1:${proxy.address().port}`,
  );
  t.after(() => s3Adapter.close());
  await adapter.testConnection();
  await s3Adapter.testConnection();
  assert.ok(connections >= 2);
  assert.equal(process.env.HTTP_PROXY, before);
});
