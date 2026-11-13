import fs from 'fs/promises';
import path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import {
  initializeFreshDatabase,
  artifactPath,
  V2BootOptions,
} from './bootstrap';
import { createV2Services } from './container';
import { WorkspaceStore } from '../services/workspaceV2/store';
import { privateDirectory, privateJson } from '../services/backup/files';
import { fail } from '../services/workspaceV2/errors';

/** Current executable must round-trip a fresh LOCAL source before product writes. */
export async function qualifyLocalStorage(options: V2BootOptions) {
  const control = options.dataRoot + '.platform-control';
  const base = path.join(
    await privateDirectory(path.join(control, 'storage-admission'), true),
    randomUUID(),
  );
  await fs.mkdir(base, { mode: 0o700 });
  const stat = await fs.lstat(base),
    token = randomUUID();
  await privateJson(path.join(base, '.owner.json'), {
    version: 1,
    token,
    dev: stat.dev,
    ino: stat.ino,
  });
  const aRoot = path.join(base, 'A'),
    bRoot = path.join(base, 'B');
  await fs.mkdir(aRoot, { mode: 0o700 });
  await fs.mkdir(bRoot, { mode: 0o700 });
  const aIdentity = await fs.lstat(aRoot);
  await privateDirectory(aRoot + '.platform-control', true);
  await privateDirectory(bRoot + '.platform-control', true);
  await initializeFreshDatabase(aRoot, artifactPath('fresh-v2.sql', options));
  await initializeFreshDatabase(bRoot, artifactPath('fresh-v2.sql', options));
  const a = createV2Services(
    await WorkspaceStore.open(path.join(aRoot, 'db/database.sqlite'), aRoot),
    path.join(base, 'A-backups'),
  );
  const b = createV2Services(
    await WorkspaceStore.open(path.join(bRoot, 'db/database.sqlite'), bRoot),
    path.join(base, 'B-backups'),
  );
  let restored: ReturnType<typeof createV2Services> | undefined;
  let qualified = false;
  try {
    const workspace = await a.lifecycle.createLocal({
      name: 'Current application storage admission',
      requestKey: token,
    });
    const content =
      'CURRENT_BUILD_STORAGE_' + randomBytes(48).toString('hex') + '\n';
    await a.files.create(workspace.id, 'unique-source.sh', content);
    const snapshot = await a.backup.create(30000),
      phrase = randomBytes(32).toString('base64');
    const encrypted = await a.backup.exportPortable(
      snapshot,
      Buffer.from(phrase),
    );
    const imported = await b.backup.importPortable(
      encrypted,
      Buffer.from(phrase),
    );
    await a.close();
    const again = await fs.lstat(aRoot),
      baseNow = await fs.lstat(base),
      proof = JSON.parse(
        await fs.readFile(path.join(base, '.owner.json'), 'utf8'),
      );
    if (
      aIdentity.dev !== again.dev ||
      aIdentity.ino !== again.ino ||
      again.isSymbolicLink() ||
      baseNow.dev !== stat.dev ||
      baseNow.ino !== stat.ino ||
      baseNow.isSymbolicLink() ||
      proof.token !== token ||
      proof.dev !== stat.dev ||
      proof.ino !== stat.ino
    )
      fail('BACKUP_RECOVERY_REQUIRED');
    // Only this just-allocated, inaccessible qualification root is destroyed.
    await fs.rm(aRoot, { recursive: true });
    const target = await b.restore.restore(imported.id, 'imports');
    restored = createV2Services(target, path.join(base, 'B-backups'));
    const read = await restored.files.read(workspace.id, 'unique-source.sh');
    if (!('content' in read) || read.content !== content)
      fail('BACKUP_SOURCE_INCOMPLETE');
    if (
      (
        await target.all<{ n: number }>('SELECT COUNT(*) n FROM Repositories')
      )[0].n !== 0
    )
      fail('BACKUP_SOURCE_INCOMPLETE');
    const build = createHash('sha256');
    const project = options.projectRoot ?? path.resolve(__dirname, '../..'),
      prefixes = [
        path.join(project, 'back') + path.sep,
        path.join(project, 'static/build') + path.sep,
      ];
    const executableFiles = Object.keys(require.cache)
      .filter(
        (file) =>
          prefixes.some((prefix) => file.startsWith(prefix)) &&
          /\.(?:ts|js)$/.test(file),
      )
      .sort();
    for (const file of executableFiles) {
      build
        .update(path.relative(project, file))
        .update('\0')
        .update(await fs.readFile(file));
    }
    for (const name of [
      'fresh-v2.sql',
      'api-contracts.json',
      'error-codes.json',
    ])
      build
        .update(name)
        .update('\0')
        .update(await fs.readFile(artifactPath(name, options)));
    build.update(process.versions.node);
    const result = {
      status: 'PASS',
      build_id: build.digest('hex'),
      checked_at: new Date().toISOString(),
      roundtrip_sha256: createHash('sha256').update(content).digest('hex'),
      schema_identity: 'zhixu.workspace.v2.s0.1',
      portable_backup_verified: true,
      original_probe_source_destroyed: true,
      independent_restore_verified: true,
      repository_required: false,
    };
    await privateJson(
      path.join(control, 'storage-admission-current.json'),
      result,
    );
    qualified = true;
    return result;
  } finally {
    await a.close().catch(() => undefined);
    await b.close().catch(() => undefined);
    await restored?.close().catch(() => undefined);
    if (qualified) {
      const current = await fs.lstat(base),
        proof = JSON.parse(
          await fs.readFile(path.join(base, '.owner.json'), 'utf8'),
        );
      const allowed = new Set([
        '.owner.json',
        'A',
        'A.platform-control',
        'A-backups',
        'B',
        'B.platform-control',
        'B-backups',
      ]);
      if (
        current.isSymbolicLink() ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        proof.token !== token ||
        proof.dev !== stat.dev ||
        proof.ino !== stat.ino ||
        (await fs.readdir(base)).some((name) => !allowed.has(name))
      )
        fail('BACKUP_RECOVERY_REQUIRED');
      await fs.rm(base, { recursive: true });
    }
  }
}
