const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const xml = (v) =>
  String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const digest = (v) => createHash('md5').update(v).digest('hex');
async function bytes(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function serve(handler) {
  const objects = new Map(),
    requests = [],
    multipart = new Map();
  let failure = null;
  const server = http.createServer(async (req, res) => {
    requests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      content_length: req.headers['content-length'],
    });
    if (failure) {
      const status = failure;
      failure = null;
      res.writeHead(status).end();
      req.resume();
      return;
    }
    try {
      await handler(req, res, { objects, requests, multipart });
    } catch (error) {
      res.writeHead(500).end('fixture failure');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    objects,
    requests,
    failNext(status = 503) {
      failure = status;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
async function startS3() {
  const instance = await serve(async (req, res, state) => {
    if (
      !/^AWS4-HMAC-SHA256 Credential=test-access\//.test(
        req.headers.authorization ?? '',
      )
    ) {
      res
        .writeHead(403, { 'content-type': 'application/xml' })
        .end('<Error><Code>AccessDenied</Code></Error>');
      req.resume();
      return;
    }
    const url = new URL(req.url, 'http://fixture'),
      path = decodeURIComponent(url.pathname);
    const key = path.replace(/^\/test-bucket\/?/, '');
    if (!path.startsWith('/test-bucket')) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const body = [...state.objects]
        .filter(([name]) => name.startsWith(prefix))
        .map(
          ([name, body]) =>
            `<Contents><Key>${xml(name)}</Key><Size>${
              body.length
            }</Size><LastModified>2030-01-01T00:00:00.000Z</LastModified><ETag>"${digest(
              body,
            )}"</ETag></Contents>`,
        )
        .join('');
      res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix>${xml(
            prefix,
          )}</Prefix><IsTruncated>false</IsTruncated>${body}</ListBucketResult>`,
        );
      return;
    }
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const id = randomUUID();
      state.multipart.set(id, new Map());
      res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<InitiateMultipartUploadResult><Bucket>test-bucket</Bucket><Key>${xml(
            key,
          )}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      return;
    }
    if (req.method === 'PUT' && url.searchParams.has('uploadId')) {
      const body = await bytes(req);
      state.multipart
        .get(url.searchParams.get('uploadId'))
        .set(Number(url.searchParams.get('partNumber')), body);
      res.writeHead(200, { etag: `"${digest(body)}"` }).end();
      return;
    }
    if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      await bytes(req);
      const parts = state.multipart.get(url.searchParams.get('uploadId'));
      const body = Buffer.concat(
        [...parts].sort((a, b) => a[0] - b[0]).map(([, value]) => value),
      );
      state.objects.set(key, body);
      state.multipart.delete(url.searchParams.get('uploadId'));
      res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<CompleteMultipartUploadResult><Bucket>test-bucket</Bucket><Key>${xml(
            key,
          )}</Key><ETag>"${digest(
            body,
          )}"</ETag></CompleteMultipartUploadResult>`,
        );
      return;
    }
    if (req.method === 'DELETE' && url.searchParams.has('uploadId')) {
      state.multipart.delete(url.searchParams.get('uploadId'));
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'PUT') {
      const body = await bytes(req);
      state.objects.set(key, body);
      res.writeHead(200, { etag: `"${digest(body)}"` }).end();
      return;
    }
    if (req.method === 'DELETE') {
      state.objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    const body = state.objects.get(key);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      res
        .writeHead(200, {
          'content-length': body.length,
          'last-modified': 'Tue, 01 Jan 2030 00:00:00 GMT',
          etag: `"${digest(body)}"`,
        })
        .end(req.method === 'GET' ? body : undefined);
      return;
    }
    res.writeHead(405).end();
  });
  instance.target = {
    id: randomUUID(),
    name: 'Controlled S3',
    type: 'S3',
    enabled: true,
    endpoint: instance.endpoint,
    region: 'us-east-1',
    bucket: 'test-bucket',
    prefix: 'zhixu',
    access_key_id: 'test-access',
    secret_access_key: 'test-secret',
    path_style: true,
  };
  return instance;
}
async function startWebdav() {
  const directories = new Set(['/dav/', '/']);
  const instance = await serve(async (req, res, state) => {
    if (
      req.headers.authorization !==
      'Basic ' + Buffer.from('test-user:test-password').toString('base64')
    ) {
      req.resume();
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url, 'http://fixture'),
      path = decodeURIComponent(url.pathname);
    if (req.method === 'MKCOL') {
      if (directories.has(path)) {
        res.writeHead(405).end();
        return;
      }
      directories.add(path);
      res.writeHead(201).end();
      return;
    }
    if (req.method === 'PROPFIND') {
      req.resume();
      if (!directories.has(path)) {
        res.writeHead(404).end();
        return;
      }
      const prop = (name, body) =>
        `<d:response><d:href>${xml(
          name.split('/').map(encodeURIComponent).join('/'),
        )}</d:href><d:propstat><d:prop><d:getcontentlength>${
          body.length
        }</d:getcontentlength><d:getlastmodified>Tue, 01 Jan 2030 00:00:00 GMT</d:getlastmodified><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      const rows =
        [...state.objects]
          .filter(
            ([name]) =>
              name.startsWith(path) && !name.slice(path.length).includes('/'),
          )
          .map(([name, body]) => prop(name, body))
          .join('') +
        [...directories]
          .filter(
            (name) =>
              name !== path &&
              name.startsWith(path) &&
              !name.slice(path.length).replace(/\/$/, '').includes('/'),
          )
          .map(
            (name) =>
              `<d:response><d:href>${xml(
                name,
              )}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          )
          .join('');
      res
        .writeHead(207, { 'content-type': 'application/xml' })
        .end(
          `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${xml(
            path,
          )}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>${rows}</d:multistatus>`,
        );
      return;
    }
    if (req.method === 'PUT') {
      if (!directories.has(path.slice(0, path.lastIndexOf('/') + 1))) {
        req.resume();
        res.writeHead(409).end();
        return;
      }
      state.objects.set(path, await bytes(req));
      res.writeHead(201).end();
      return;
    }
    if (req.method === 'DELETE') {
      state.objects.delete(path);
      res.writeHead(204).end();
      return;
    }
    const body = state.objects.get(path);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      res
        .writeHead(200, {
          'content-length': body.length,
          'last-modified': 'Tue, 01 Jan 2030 00:00:00 GMT',
        })
        .end(req.method === 'GET' ? body : undefined);
      return;
    }
    res.writeHead(405).end();
  });
  instance.target = {
    id: randomUUID(),
    name: 'Controlled WebDAV',
    type: 'WEBDAV',
    enabled: true,
    endpoint: instance.endpoint + '/dav/',
    directory: 'zhixu',
    username: 'test-user',
    password: 'test-password',
  };
  return instance;
}
module.exports = { startS3, startWebdav };
