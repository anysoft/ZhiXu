const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const requested = process.argv.slice(2);
const files = requested.length
  ? requested.map((x) =>
      x.includes('/') ? path.resolve(x) : path.join(__dirname, x),
    )
  : fs
      .readdirSync(__dirname)
      .filter((x) => x.endsWith('.test.cjs'))
      .sort()
      .map((x) => path.join(__dirname, x));
if (!files.length) throw Error('S3_TESTS_REQUIRED');
const result = spawnSync(
  process.execPath,
  [path.join(__dirname, '../s1b/run.cjs'), ...files],
  { stdio: 'inherit', env: process.env },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
