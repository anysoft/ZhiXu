const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve('static/build/backupCliV2.js');
const { parseBackupCliArguments, readBackupPassphrase } = require(cli);
const roots = {
  ZHIXU_V2_DATA_ROOT: '/data/state',
  ZHIXU_V2_BACKUP_ROOT: '/backup/state',
};

test('compiled backup CLI strictly separates restore sources, passwords and storage roots', () => {
  const selected = parseBackupCliArguments(
    ['restore', '--snapshot', 'snapshot-id'],
    roots,
  );
  assert.equal(selected.dataRoot, '/data/state');
  assert.equal(selected.backupRoot, '/backup/state');
  assert.equal(selected.snapshot, 'snapshot-id');
  assert.equal(
    parseBackupCliArguments(['--data-root', '/other/state', 'status'], {})
      .backupRoot,
    '/other/state-backups',
  );
  assert.equal(
    parseBackupCliArguments(['restore', '--resume'], roots).resume,
    true,
  );
  for (const args of [
    [],
    ['unknown'],
    ['list', 'extra'],
    ['info'],
    ['restore'],
    ['restore', '--file', 'input'],
    ['restore', '--snapshot', 'a', '--resume'],
    ['restore', '--snapshot', 'a', '--passphrase-stdin'],
    [
      'restore',
      '--file',
      'input',
      '--passphrase-file',
      'secret',
      '--passphrase-stdin',
    ],
    ['list', '--data-root', '/a', '--data-root', '/b'],
    ['list', '--passphrase', 'do-not-log-this'],
  ])
    assert.throws(() => parseBackupCliArguments(args, roots));
  for (const root of ['relative', '/', '/data/../state'])
    assert.throws(() =>
      parseBackupCliArguments(['list', '--data-root', root], roots),
    );
});

test('passphrase files preserve existing short Portable passwords, strip one newline and reject unsafe or oversized files', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'zhixu-backup-cli-arguments-'),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'phrase');
  await fs.writeFile(file, 'short\r\n', { mode: 0o600 });
  const phrase = await readBackupPassphrase({ passphraseFile: file });
  assert.equal(phrase.toString(), 'short');
  phrase.fill(0);
  await fs.writeFile(file, '\n');
  await assert.rejects(
    readBackupPassphrase({ passphraseFile: file }),
    /BACKUP_PASSPHRASE_INVALID/,
  );
  await fs.writeFile(file, 'x'.repeat(4099));
  await assert.rejects(
    readBackupPassphrase({ passphraseFile: file }),
    /BACKUP_PASSPHRASE_INVALID/,
  );
  await fs.writeFile(file, 'private');
  await fs.chmod(file, 0o644);
  await assert.rejects(
    readBackupPassphrase({ passphraseFile: file }),
    /BACKUP_FILE_INVALID/,
  );
  await fs.chmod(file, 0o600);
  const link = path.join(root, 'link');
  await fs.symlink(file, link);
  await assert.rejects(readBackupPassphrase({ passphraseFile: link }));
});

test('production CLI help needs no storage and malformed secret arguments never echo their values', () => {
  const environment = { ...process.env };
  for (const key of [
    'NODE_OPTIONS',
    'ZHIXU_V2_DATA_ROOT',
    'ZHIXU_V2_BACKUP_ROOT',
  ])
    delete environment[key];
  const help = spawnSync(process.execPath, [cli, '--help'], {
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /restore --resume/);
  assert.match(help.stdout, /--passphrase-file/);
  const secret = 'must-never-appear-in-output';
  const rejected = spawnSync(
    process.execPath,
    [cli, 'restore', '--file', '/invalid', '--passphrase', secret],
    { env: environment, encoding: 'utf8' },
  );
  assert.equal(rejected.status, 2);
  assert.equal((rejected.stdout + rejected.stderr).includes(secret), false);
  assert.equal(
    JSON.parse(rejected.stderr).error_code,
    'BACKUP_CLI_ARGUMENT_INVALID',
  );
});
