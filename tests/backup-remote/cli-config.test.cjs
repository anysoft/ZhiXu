const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runRemoteBackupCli } = require('../../back/services/backup/remoteCli');

test('database-independent remote CLI requires an explicit URL for a saved proxy profile', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'zhixu-remote-cli-config-'),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = {
    type: 'WEBDAV',
    endpoint: 'https://example.invalid/dav',
    proxy: { mode: 'PROFILE', profile_id: 'saved-in-lost-database' },
  };
  for (const value of [target, { target }]) {
    const file = path.join(root, 'remote.json');
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(
      runRemoteBackupCli(['list', '--config', file]),
      (error) => error.code === 'BACKUP_REMOTE_CONFIG_INVALID',
    );
  }
});
