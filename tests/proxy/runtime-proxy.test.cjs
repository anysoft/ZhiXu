const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const load = require('../../test/helpers/load-security-module.cjs');
const runFile = promisify(execFile),
  root = path.resolve(__dirname, '../..');
const keys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_noproxy',
];
async function fixture(
  t,
  resolved = { env: {}, secretValues: [], profileId: null },
) {
  const dir = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), 'zhixu-runtime-proxy-'),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cache = new Map();
  let context = { store: {} };
  const mocks = {
    '../config': {
      __esModule: true,
      default: { rootPath: root, dataPath: dir },
    },
    './runtimeDomainScope': { currentRuntimeDomain: () => context },
    './proxyManagement': {
      proxyEnvironmentKeys: keys,
      holdResolvedProxy: () => () => {},
      ProxyManagement: class {
        async resolve() {
          return resolved;
        }
      },
    },
  };
  return {
    dir,
    module: (file) => load(path.join(root, file), mocks, cache),
    setContext: (x) => (context = x),
  };
}
async function paths(dir) {
  const directory = async (relative) => {
    const p = path.join(dir, relative);
    await fs.mkdir(p, { recursive: true });
    return p;
  };
  return {
    operation: () => directory('operation'),
    directory,
    provider: () => directory('provider'),
    cache: () => directory('cache'),
  };
}
function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('runtime proxy snapshot pins values and never retains mutable profile environment', async (t) => {
  const selected = {
    env: { https_proxy: 'http://fixture:8080' },
    secretValues: ['fixture-password'],
    profileId: 'p1',
  };
  const f = await fixture(t, selected),
    { resolveRuntimeProxy } = f.module('back/services/runtimeProxy.ts');
  const snapshot = await resolveRuntimeProxy({
    mode: 'PROFILE',
    profile_id: 'p1',
  });
  selected.env.https_proxy = 'http://changed:8080';
  selected.secretValues[0] = 'changed';
  assert.equal(snapshot.env.https_proxy, 'http://fixture:8080');
  assert.equal(snapshot.secretValues[0], 'fixture-password');
  assert.ok(Object.isFrozen(snapshot.env));
  f.setContext(undefined);
  assert.deepEqual(await resolveRuntimeProxy(), {
    env: {},
    secretValues: [],
    profileId: null,
  });
  await assert.rejects(resolveRuntimeProxy({ mode: 'DIRECT' }), {
    error_code: 'PROXY_CONFIGURATION_UNAVAILABLE',
  });
});

test('clean Python build and Node package manager environments retain only operation-specific proxy values', async (t) => {
  const f = await fixture(t),
    p = await paths(f.dir),
    build = f.module('back/services/runtimeBuildEnvironment.ts').default;
  const a = await build(p, 1, 2, 1, { https_proxy: 'http://one:8001' }),
    b = await build(p, 2, 2, 1, { https_proxy: 'http://two:8002' }),
    direct = await build(p, 3, 2, 1);
  assert.equal(a.environment.https_proxy, 'http://one:8001');
  assert.equal(b.environment.https_proxy, 'http://two:8002');
  assert.equal(direct.environment.https_proxy, undefined);
  assert.notEqual(a.environment, b.environment);
  const nodeFile = path.join(f.dir, 'node');
  await fs.writeFile(nodeFile, 'not executed');
  const nodePaths = {
    dataRoot: f.dir,
    assertOwned: async () => f.dir,
    file: async () => nodeFile,
    root: async () => f.dir,
    directory: p.directory,
  };
  const Manager = f.module('back/services/nodePackageManager.ts').default,
    manager = new Manager(nodePaths);
  const runtime = {
    id: 1,
    language: 'NODE',
    state: 'READY',
    metadata: {
      executable_sha256: createHash('sha256')
        .update('not executed')
        .digest('hex'),
    },
  };
  const result = await manager.environment(
    {
      directory: f.dir,
      environment: {
        ...a.environment,
        UNRELATED_HOST_SECRET: 'must-not-inherit',
      },
    },
    runtime,
  );
  assert.equal(result.env.https_proxy, 'http://one:8001');
  assert.equal(result.env.UNRELATED_HOST_SECRET, undefined);
  assert.equal(result.env.npm_config_registry, 'https://registry.npmjs.org/');
});

test('operation logs redact proxy passwords, encoded credentials and split proxy URLs', async (t) => {
  const f = await fixture(t),
    Log = f.module('back/services/runtimeLog.ts').default;
  const password = 'proxy-password-with-symbols:@',
    url = 'http://fixture:' + encodeURIComponent(password) + '@127.0.0.1:8888';
  const logPaths = { log: async () => path.join(f.dir, 'operation.log') };
  const log = await Log.open(logPaths, 1, '/private/home', {}, [password, url]);
  await log.write(url.slice(0, 18));
  await log.write(
    url.slice(18) + ' ' + password + ' ' + encodeURIComponent(password),
  );
  await log.close();
  const text = (await Log.read(logPaths, 1)).text;
  assert.ok(text.includes('********'));
  for (const secret of [password, url, encodeURIComponent(password)])
    assert.ok(!text.includes(secret));
});

for (const protocol of ['HTTP', 'SOCKS5'])
  test(
    'Node distribution downloader makes a real request through ' +
      protocol +
      ' operation proxy',
    async (t) => {
      const f = await fixture(t),
        p = await paths(f.dir),
        build = f.module('back/services/runtimeBuildEnvironment.ts').default;
      let requests = 0;
      const target = http.createServer((req, res) =>
        res.end('controlled-runtime-archive'),
      );
      const targetPort = await listen(target);
      t.after(() => close(target));
      let proxy;
      if (protocol === 'HTTP')
        proxy = http.createServer((req, res) => {
          requests++;
          const u = new URL(req.url);
          const forwarded = http.request(
            {
              hostname: '127.0.0.1',
              port: targetPort,
              path: u.pathname,
              method: req.method,
            },
            (up) => {
              res.writeHead(up.statusCode);
              up.pipe(res);
            },
          );
          forwarded.on('error', () => res.destroy());
          req.pipe(forwarded);
        });
      else
        proxy = net.createServer((socket) => {
          let buffer = Buffer.alloc(0),
            stage = 0;
          const receive = (data) => {
            buffer = Buffer.concat([buffer, data]);
            if (stage === 0) {
              if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
              buffer = buffer.subarray(2 + buffer[1]);
              socket.write(Buffer.from([5, 0]));
              stage = 1;
            }
            if (stage === 1) {
              if (buffer.length < 5) return;
              const n =
                buffer[3] === 3 ? 5 + buffer[4] + 2 : buffer[3] === 1 ? 10 : 22;
              if (buffer.length < n) return;
              const rest = buffer.subarray(n);
              stage = 2;
              socket.removeListener('data', receive);
              requests++;
              const upstream = net.connect(targetPort, '127.0.0.1', () => {
                socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                if (rest.length) upstream.write(rest);
                socket.pipe(upstream);
                upstream.pipe(socket);
              });
              upstream.on('error', () => socket.destroy());
              socket.on('error', () => upstream.destroy());
            }
          };
          socket.on('data', receive);
        });
      const proxyPort = await listen(proxy);
      t.after(() => close(proxy));
      const proxyEnv =
        protocol === 'HTTP'
          ? { http_proxy: `http://127.0.0.1:${proxyPort}` }
          : { all_proxy: `socks5h://127.0.0.1:${proxyPort}` };
      const env = await build(p, 1, 2, 1, proxyEnv),
        filename = path.join(f.dir, 'download.bin');
      const Distribution = f.module(
        'back/services/nodeDistributionProvider.ts',
      ).default;
      const provider = new Distribution(
        { dataRoot: f.dir },
        `http://127.0.0.1:${targetPort}`,
      );
      await provider.download(
        {
          ...env,
          command: {
            run: async (program, args, cwd, environment) => {
              await runFile(program, args, {
                cwd,
                env: environment,
                timeout: 10000,
              });
              return '';
            },
          },
        },
        `http://127.0.0.1:${targetPort}/runtime.tar.xz`,
        filename,
        1024,
      );
      assert.equal(
        await fs.readFile(filename, 'utf8'),
        'controlled-runtime-archive',
      );
      assert.equal(requests, 1);
    },
  );

test('pip installs a real local wheel through the operation HTTP proxy and diagnoses missing SOCKS support', async (t) => {
  const f = await fixture(t),
    p = await paths(f.dir),
    build = f.module('back/services/runtimeBuildEnvironment.ts').default;
  const { wheelhouse } = require('../phase7/wheelhouse.cjs');
  const index = await wheelhouse(path.join(f.dir, 'wheels'));
  t.after(() => index.close());
  const indexPort = Number(new URL(index.index).port);
  let requests = 0;
  const proxy = http.createServer((req, res) => {
    requests++;
    const u = new URL(req.url);
    const up = http.request(
      {
        hostname: '127.0.0.1',
        port: indexPort,
        path: u.pathname + u.search,
        method: req.method,
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));
  await runFile('/usr/bin/python3', ['-m', 'venv', path.join(f.dir, 'venv')], {
    timeout: 30000,
  });
  const python = path.join(f.dir, 'venv/bin/python');
  const env = await build(p, 1, 2, 1, {
    http_proxy: `http://127.0.0.1:${proxyPort}`,
    https_proxy: `http://127.0.0.1:${proxyPort}`,
    NO_PROXY: '',
    no_proxy: '',
  });
  const Pip = f.module('back/services/pipPackageManager.ts').default,
    RuntimeError = f.module('back/shared/runtime.ts').RuntimeError;
  const manager = new Pip(
    { runtime: { dataRoot: f.dir }, cache: p.cache },
    index.index,
  );
  const ctx = {
    ...env,
    command: {
      run: async (program, args, cwd, environment) => {
        try {
          return (
            await runFile(program, args, {
              cwd,
              env: environment,
              timeout: 30000,
            })
          ).stdout;
        } catch (error) {
          throw new RuntimeError(
            'RUNTIME_COMMAND_FAILED',
            409,
            typeof error.code === 'number' ? error.code : 1,
          );
        }
      },
    },
  };
  await manager.install(ctx, python, [
    { requirement: 'ql-phase7-root==1.0.0' },
  ]);
  assert.equal(
    (
      await runFile(python, [
        '-I',
        '-c',
        'import ql_phase7_root; print(ql_phase7_root.__version__)',
      ])
    ).stdout.trim(),
    '1.0.0',
  );
  assert.ok(requests >= 2);
  await assert.rejects(
    manager.install(
      {
        ...ctx,
        environment: {
          ...env.environment,
          https_proxy: 'socks5h://127.0.0.1:1',
        },
      },
      python,
      [{ requirement: 'ql-phase7-root==2.0.0' }],
    ),
    { error_code: 'RUNTIME_PROXY_SOCKS_SUPPORT_REQUIRED' },
  );
});

function socksProxy(targetPort, onRequest, onConnection = () => {}) {
  return net.createServer((socket) => {
    let buffer = Buffer.alloc(0),
      stage = 0;
    const receive = (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (stage === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1) {
        if (buffer.length < 5) return;
        const size =
          buffer[3] === 3 ? 5 + buffer[4] + 2 : buffer[3] === 1 ? 10 : 22;
        if (buffer.length < size) return;
        const rest = buffer.subarray(size);
        stage = 2;
        socket.removeListener('data', receive);
        onRequest();
        const upstream = net.connect(targetPort, '127.0.0.1', () => {
          onConnection(upstream.localPort);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) upstream.write(rest);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
      }
    };
    socket.on('data', receive);
  });
}

for (const managerName of ['npm', 'pnpm'])
  for (const protocol of ['HTTP', 'SOCKS5'])
    test(
      managerName +
        ' installs a real local package through an operation ' +
        protocol +
        ' proxy',
      async (t) => {
        const f = await fixture(t),
          p = await paths(f.dir),
          build = f.module('back/services/runtimeBuildEnvironment.ts').default;
        const nodeRoot =
          process.env.ZHIXU_TEST_NODE_ROOT ||
          path.dirname(path.dirname(process.execPath));
        const cli =
          managerName === 'npm'
            ? path.join(nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js')
            : process.env.ZHIXU_TEST_PNPM_CLI;
        if (!cli) {
          t.skip('Set ZHIXU_TEST_PNPM_CLI to verify actual pnpm transport');
          return;
        }
        const node = path.join(nodeRoot, 'bin/node');
        await fs.access(cli);
        const archiveDir = path.join(f.dir, 'archive');
        await fs.mkdir(path.join(archiveDir, 'package'), { recursive: true });
        await fs.writeFile(
          path.join(archiveDir, 'package/package.json'),
          JSON.stringify({
            name: 'proxy-runtime-fixture',
            version: '1.0.0',
            main: 'index.js',
          }),
        );
        await fs.writeFile(
          path.join(archiveDir, 'package/index.js'),
          'module.exports=42;',
        );
        const tarball = path.join(f.dir, 'fixture.tgz');
        await runFile('/usr/bin/tar', [
          '-czf',
          tarball,
          '-C',
          archiveDir,
          'package',
        ]);
        const bytes = await fs.readFile(tarball);
        let registryPort,
          registryRequests = 0,
          directRequests = 0;
        const proxiedConnections = new Set();
        const registry = http.createServer((req, res) => {
          registryRequests++;
          if (
            protocol === 'SOCKS5' &&
            !proxiedConnections.has(req.socket.remotePort)
          ) {
            directRequests++;
            res.writeHead(403);
            res.end('proxy required');
            return;
          }
          if (req.url.endsWith('.tgz')) {
            res.end(bytes);
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              name: 'proxy-runtime-fixture',
              'dist-tags': { latest: '1.0.0' },
              versions: {
                '1.0.0': {
                  name: 'proxy-runtime-fixture',
                  version: '1.0.0',
                  dist: {
                    tarball: `http://127.0.0.1:${registryPort}/fixture.tgz`,
                    integrity:
                      'sha512-' +
                      createHash('sha512').update(bytes).digest('base64'),
                  },
                },
              },
            }),
          );
        });
        registryPort = await listen(registry);
        t.after(() => close(registry));
        let requests = 0;
        const proxy =
          protocol === 'HTTP'
            ? http.createServer((req, res) => {
                requests++;
                const u = new URL(req.url);
                const up = http.request(
                  {
                    hostname: '127.0.0.1',
                    port: registryPort,
                    path: u.pathname + u.search,
                    method: req.method,
                  },
                  (r) => {
                    res.writeHead(r.statusCode, r.headers);
                    r.pipe(res);
                  },
                );
                up.on('error', () => res.destroy());
                req.pipe(up);
              })
            : undefined;
        const proxyServer =
          protocol === 'HTTP'
            ? proxy
            : socksProxy(
                registryPort,
                () => requests++,
                (port) => proxiedConnections.add(port),
              );
        const proxyPort = await listen(proxyServer);
        t.after(() => close(proxyServer));
        const proxyUrl = `${
          protocol === 'HTTP' ? 'http' : 'socks5h'
        }://127.0.0.1:${proxyPort}`;
        const env = await build(p, 1, 2, 1, {
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          npm_config_proxy: proxyUrl,
          npm_config_https_proxy: proxyUrl,
          NO_PROXY: '',
          no_proxy: '',
          npm_config_noproxy: '',
        });
        const nodePaths = {
          dataRoot: f.dir,
          assertOwned: async () => nodeRoot,
          file: async (root, relative) => path.join(root, relative),
          root: async () => f.dir,
          directory: p.directory,
        };
        const Manager = f.module('back/services/nodePackageManager.ts').default;
        const manager = new Manager(
            nodePaths,
            `http://127.0.0.1:${registryPort}/`,
          ),
          metadata = {
            executable_sha256: createHash('sha256')
              .update(await fs.readFile(node))
              .digest('hex'),
          };
        const run = await manager.environment(
          { ...env, directory: f.dir },
          { id: 1, language: 'NODE', state: 'READY', metadata },
        );
        await fs.writeFile(
          path.join(f.dir, 'package.json'),
          JSON.stringify({
            name: 'proxy-consumer',
            version: '1.0.0',
            private: true,
            dependencies: { 'proxy-runtime-fixture': '1.0.0' },
          }),
        );
        await runFile(
          node,
          [
            cli,
            'install',
            '--ignore-scripts',
            ...(managerName === 'npm'
              ? ['--package-lock=false']
              : ['--store-dir', path.join(f.dir, 'pnpm-store')]),
          ],
          { cwd: f.dir, env: run.env, timeout: 30000, maxBuffer: 1024 * 1024 },
        );
        assert.equal(
          (
            await runFile(
              node,
              [
                '-e',
                `console.log(require(${JSON.stringify(
                  path.join(f.dir, 'node_modules/proxy-runtime-fixture'),
                )}))`,
              ],
              { env: run.env },
            )
          ).stdout.trim(),
          '42',
        );
        assert.ok(
          requests >= (protocol === 'HTTP' ? 2 : 1),
          `expected registry and tarball traffic through proxy, got ${requests}`,
        );
      },
    );
