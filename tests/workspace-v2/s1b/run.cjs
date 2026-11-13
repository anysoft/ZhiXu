// Run only against exclusive private test domains. Retain failure and success proof.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const base = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), 'zhixu-s1b-run-'),
);
fs.chmodSync(base, 0o700);
const st = fs.lstatSync(base);
fs.writeFileSync(
  path.join(base, '.s1b-run-owner.json'),
  JSON.stringify({
    version: 1,
    root: base,
    dev: st.dev,
    ino: st.ino,
    token: randomUUID(),
  }),
  { mode: 0o600 },
);
const logs = path.join(base, 'logs');
fs.mkdirSync(logs, { mode: 0o700 });
const bootstrap = path.join(base, 'bootstrap');
fs.mkdirSync(bootstrap, { mode: 0o700 });
fs.writeFileSync(
  path.join(bootstrap, '.env'),
  'JWT_SECRET=isolated-s1b-test-fixture\n',
  { mode: 0o600 },
);
for (const directory of ['shell', 'sample'])
  fs.cpSync(path.join(root, directory), path.join(bootstrap, directory), {
    recursive: true,
  });
fs.mkdirSync(path.join(bootstrap, 'state'), { mode: 0o700 });
const output = fs.createWriteStream(path.join(logs, 'qualification.log'), {
  mode: 0o600,
  flags: 'wx',
});
const files = process.argv.slice(2).length
  ? process.argv
      .slice(2)
      .map((x) => (x.includes('/') ? x : path.join(__dirname, x)))
  : fs
      .readdirSync(__dirname)
      .filter((x) => x.endsWith('.test.cjs'))
      .sort()
      .map((x) => path.join(__dirname, x));
if (!files.length) throw Error('S1B_QUALIFICATION_FILES_REQUIRED');
process.stdout.write('S1B retained sandbox: ' + base + '\n');
const started = process.hrtime.bigint();
const child = spawn(
  process.execPath,
  [
    '-r',
    'ts-node/register/transpile-only',
    '--test',
    '--test-concurrency=1',
    '--test-reporter=' + path.join(__dirname, 'reporter.mjs'),
    ...files,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ZHIXU_S1B_SANDBOX: base,
      QL_DIR: bootstrap,
      QL_DATA_DIR: path.join(bootstrap, 'state'),
      TS_NODE_PROJECT: path.join(root, 'back/tsconfig.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let peakRss = 0,
  sampleCount = 0;
const sampler = setInterval(() => {
  try {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .map((x) => x.trim().split(/\s+/).map(Number));
    const included = new Set([process.pid, child.pid]);
    let prior;
    do {
      prior = included.size;
      for (const [pid, ppid] of rows) if (included.has(ppid)) included.add(pid);
    } while (included.size !== prior);
    peakRss = Math.max(
      peakRss,
      rows.reduce(
        (sum, [pid, _ppid, rss]) => sum + (included.has(pid) ? rss * 1024 : 0),
        0,
      ),
    );
    sampleCount++;
  } catch {
    /* Individual ps sample unavailable; sample_count records coverage. */
  }
}, 250);
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (bytes) => {
    output.write(bytes);
    process.stdout.write(bytes);
  });
child.on('error', (error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  clearInterval(sampler);
  output.end(() => {
    const metrics = {
      command: [
        process.execPath,
        'tests/workspace-v2/s1b/run.cjs',
        ...process.argv.slice(2),
      ],
      files: files.map((x) => path.relative(root, x)),
      exit_code: code,
      signal,
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
      environment: {
        os: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      reporter:
        'safe status/code/location only; raw output and assertion values withheld',
      sampled_peak_process_tree_rss_bytes: peakRss,
      sample_interval_ms: 250,
      sample_count: sampleCount,
      log_sha256: createHash('sha256')
        .update(fs.readFileSync(path.join(logs, 'qualification.log')))
        .digest('hex'),
    };
    fs.writeFileSync(
      path.join(base, 'qualification-result.json'),
      JSON.stringify(metrics, null, 2) + '\n',
      { mode: 0o600 },
    );
    process.stdout.write(
      'S1B qualification receipt: ' +
        path.join(base, 'qualification-result.json') +
        '\n',
    );
    process.exitCode = code ?? 1;
  });
});
