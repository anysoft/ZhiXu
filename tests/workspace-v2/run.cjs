// S1.A internal qualification runner. No user's .env, database or data directory.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const projectRoot = path.resolve(__dirname, '../..');
const runRoot = fs.mkdtempSync(
  path.join(fs.realpathSync(os.tmpdir()), 's1a-run-'),
);
try {
  fs.writeFileSync(
    path.join(runRoot, '.env'),
    'JWT_SECRET=isolated-s1a-test-fixture\n',
    { mode: 0o600 },
  );
  for (const directory of ['shell', 'sample'])
    fs.cpSync(
      path.join(projectRoot, directory),
      path.join(runRoot, directory),
      { recursive: true },
    );
  fs.mkdirSync(path.join(runRoot, 'state'), { mode: 0o700 });
  const requested = process.argv.slice(2);
  const files = requested.length
    ? requested.map((name) =>
        name.includes('/')
          ? path.resolve(projectRoot, name)
          : path.join(__dirname, name),
      )
    : fs
        .readdirSync(__dirname)
        .filter((name) => name.endsWith('.test.cjs') && !name.startsWith('s2-'))
        .sort()
        .map((name) => path.join(__dirname, name));
  if (!files.length) throw Error('S1A_TEST_FILES_REQUIRED');
  const env = {
    ...process.env,
    QL_DIR: runRoot,
    QL_DATA_DIR: path.join(runRoot, 'state'),
    TS_NODE_PROJECT: path.join(projectRoot, 'back/tsconfig.json'),
  };
  const result = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '--test',
      '--test-concurrency=1',
      ...files,
    ],
    { cwd: projectRoot, env, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(runRoot, { recursive: true, force: true });
}
