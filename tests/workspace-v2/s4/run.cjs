const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = process.argv.slice(2).length
  ? process.argv
      .slice(2)
      .map((file) =>
        file.includes('/') ? path.resolve(file) : path.join(__dirname, file),
      )
  : fs
      .readdirSync(__dirname)
      .filter((file) => file.endsWith('.test.cjs'))
      .sort()
      .map((file) => path.join(__dirname, file));
if (!files.length) throw Error('S4_TESTS_REQUIRED');
const result = spawnSync(
  process.execPath,
  [path.join(__dirname, '../s1b/run.cjs'), ...files],
  { stdio: 'inherit', env: process.env },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
