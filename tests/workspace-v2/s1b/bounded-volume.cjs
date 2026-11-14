// Test infrastructure only. Linux mounts are provisioned by the isolated
// namespace launcher (or an owned Docker tmpfs), never by the application.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const BUDGET = 32 * 1024 * 1024;
const MARKER = '.s1b-bounded-volume-owner.json';

async function prepareBoundedFilesystem(fixture) {
  if (process.platform === 'darwin') {
    const image = path.join(fixture.root, 'bounded-volume.dmg');
    const mount = path.join(fixture.root, 'bounded-mount');
    await fs.mkdir(mount, { mode: 0o700 });
    execFileSync(
      '/usr/bin/hdiutil',
      [
        'create',
        '-size',
        '32m',
        '-fs',
        'HFS+',
        '-volname',
        'ZhiXuS1B',
        '-type',
        'UDIF',
        image,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const attached = execFileSync(
      '/usr/bin/hdiutil',
      [
        'attach',
        '-nobrowse',
        '-owners',
        'on',
        '-mountpoint',
        mount,
        '-plist',
        image,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return {
      mount,
      input:
        '32MiB private file-backed HFS+ volume filled after official capacity admission',
      proof: {
        filesystem: 'HFS+',
        capacity_bytes: BUDGET,
        execution_uid: process.getuid(),
        attached_owned_mount: attached.includes(mount),
      },
      async close() {
        assert.equal(await fs.realpath(image), image);
        assert.equal(path.dirname(mount), fixture.root);
        execFileSync('/usr/bin/hdiutil', ['detach', mount], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      },
    };
  }
  if (process.platform !== 'linux')
    throw Error('S1B_BOUNDED_VOLUME_IMPLEMENTATION_REQUIRED_ON_THIS_PLATFORM');
  const root = process.env.ZHIXU_S1B_BOUNDED_FS_ROOT;
  const nonce = process.env.ZHIXU_S1B_BOUNDED_FS_NONCE;
  assert.ok(
    root && path.isAbsolute(root) && /^[a-f0-9]{32}$/.test(nonce || ''),
    'S1B_LINUX_OWNED_BOUNDED_MOUNT_REQUIRED: use linux-bounded-run.py or an owned 32MiB Docker tmpfs',
  );
  assert.equal(await fs.realpath(root), root);
  const stat = await fs.lstat(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o077, 0);
  const namespace = await fs.readlink('/proc/self/ns/mnt');
  const space = await fs.statfs(root);
  assert.equal(space.type, 0x01021994, 'Linux fixture must be an actual tmpfs');
  assert.equal(
    space.bsize * space.blocks,
    BUDGET,
    'actual kernel capacity must be 32MiB',
  );
  const markerPath = path.join(root, MARKER);
  if (process.env.ZHIXU_S1B_BOUNDED_FS_INIT === '1') {
    const existing = await fs.lstat(markerPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!existing) {
      // Explicit test-controller opt-in, for a newly created Docker --tmpfs.
      // An existing or populated filesystem is never claimed by this helper.
      assert.deepEqual(await fs.readdir(root), []);
      const out = await fs.open(markerPath, 'wx', 0o600);
      try {
        await out.writeFile(
          JSON.stringify({
            version: 1,
            purpose: 'S1B_OWNED_BOUNDED_TMPFS',
            root,
            nonce,
            uid: process.getuid(),
            dev: stat.dev,
            ino: stat.ino,
            namespace,
            capacity_bytes: BUDGET,
            provisioner: 'EXPLICIT_OWNED_DOCKER_TMPFS_INITIALIZER',
          }) + '\n',
        );
        await out.sync();
      } finally {
        await out.close();
      }
    }
  }
  const markerStat = await fs.lstat(markerPath);
  assert.ok(
    markerStat.isFile() &&
      !markerStat.isSymbolicLink() &&
      markerStat.nlink === 1,
  );
  assert.equal(markerStat.uid, process.getuid());
  assert.equal(markerStat.mode & 0o077, 0);
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  assert.equal(marker.purpose, 'S1B_OWNED_BOUNDED_TMPFS');
  assert.equal(marker.nonce, nonce);
  assert.equal(marker.root, root);
  assert.equal(marker.uid, process.getuid());
  assert.equal(marker.dev, stat.dev);
  assert.equal(marker.ino, stat.ino);
  assert.equal(marker.namespace, namespace);
  assert.equal(marker.capacity_bytes, BUDGET);
  const mount = await fs.mkdtemp(path.join(root, 's1b-enospc-'));
  await fs.chmod(mount, 0o700);
  const identity = await fs.lstat(mount);
  return {
    mount,
    input: '32MiB private Linux tmpfs filled after official capacity admission',
    proof: {
      filesystem: 'tmpfs',
      capacity_bytes: BUDGET,
      execution_uid: process.getuid(),
      mount_namespace: namespace,
      root_dev: stat.dev,
      root_ino: stat.ino,
      nonce,
    },
    async close() {
      const current = await fs.lstat(mount);
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, identity.dev);
      assert.equal(current.ino, identity.ino);
      assert.equal(await fs.realpath(mount), mount);
      assert.equal(path.dirname(mount), root);
      assert.equal(
        JSON.parse(await fs.readFile(markerPath, 'utf8')).nonce,
        nonce,
      );
      await fs.rm(mount, { recursive: true });
    },
  };
}

module.exports = { prepareBoundedFilesystem };
