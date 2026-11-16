const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseBackupCliArguments } = require(path.resolve(
  'static/build/backupCliV2.js',
));

const roots = {
  ZHIXU_V2_DATA_ROOT: '/data/state',
  ZHIXU_V2_BACKUP_ROOT: '/backup/state',
};
test('compiled CLI defaults creation to FULL and accepts explicit full/lightweight modes', () => {
  assert.equal(parseBackupCliArguments(['create'], roots).mode, 'FULL');
  assert.equal(
    parseBackupCliArguments(['create', '--mode', 'full'], roots).mode,
    'FULL',
  );
  assert.equal(
    parseBackupCliArguments(['--mode', 'lightweight', 'create'], roots).mode,
    'LIGHTWEIGHT',
  );
  for (const args of [
    ['create', '--mode', 'unknown'],
    ['create', '--mode'],
    ['create', '--mode', 'full', '--mode', 'lightweight'],
    ['list', '--mode', 'lightweight'],
    ['verify', 'snapshot', '--mode', 'full'],
    ['restore', '--snapshot', 'snapshot', '--mode', 'lightweight'],
  ])
    assert.throws(() => parseBackupCliArguments(args, roots), {
      error_code: 'BACKUP_CLI_ARGUMENT_INVALID',
    });
});
