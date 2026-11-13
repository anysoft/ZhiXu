import fs from 'fs/promises';
import path from 'path';
import { constants } from 'fs';
import { createHash, randomBytes } from 'crypto';
import sqlite3 from 'sqlite3';
import {
  WorkspaceStore,
  assertPrivatePath,
  WORKSPACE_SCHEMA_SIGNATURE,
} from '../services/workspaceV2/store';
import { BackupPaths } from '../services/backup/paths';
import {
  WorkspaceRestoreService,
  readWorkspaceRestoreJournal,
} from '../services/workspaceV2/restore';
import {
  privateDirectory,
  privateJson,
  syncDirectory,
} from '../services/backup/files';
import {
  preflightV2Schema,
  assertSchemaSourceUnchanged,
  SchemaPreflightError,
} from './schemaPreflight';

export class V2StartupError extends Error {
  constructor(readonly reason: string) {
    super('STARTUP_REJECTED');
  }
  readonly error_code = 'STARTUP_REJECTED';
}
export interface V2BootOptions {
  dataRoot: string;
  backupRoot?: string;
  initialize?: boolean;
  projectRoot?: string;
  artifactRoot?: string;
  host?: string;
  port?: number;
  baseUrl?: string;
  frontendRoot?: string;
  background?: boolean;
  legacyDataRoots?: string[];
}
export function artifactPath(name: string, options: V2BootOptions) {
  const project = options.projectRoot ?? path.resolve(__dirname, '../..');
  return options.artifactRoot
    ? path.join(options.artifactRoot, name)
    : path.join(project, 'docs/architecture/v2/contracts', name);
}
export function validateV2DataRoot(options: V2BootOptions) {
  const root = options.dataRoot;
  if (
    !root ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    root === path.parse(root).root
  )
    throw new V2StartupError('EXPLICIT_CANONICAL_DATA_ROOT_REQUIRED');
  const project = options.projectRoot ?? path.resolve(__dirname, '../..');
  const forbidden = [
    path.join(project, 'data'),
    process.env.QL_DATA_DIR,
    ...(options.legacyDataRoots ?? []),
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p!));
  const domains = [
    root,
    root + '.platform-control',
    options.backupRoot ?? root + '-backups',
  ];
  if (
    domains.some(
      (p) =>
        !path.isAbsolute(p) ||
        path.resolve(p) !== p ||
        p === path.parse(p).root,
    )
  )
    throw new V2StartupError('EXPLICIT_CANONICAL_STORAGE_ROOT_REQUIRED');
  if (
    forbidden.some((p) =>
      domains.some(
        (d) =>
          d === p || d.startsWith(p + path.sep) || p.startsWith(d + path.sep),
      ),
    )
  )
    throw new V2StartupError('LEGACY_DATA_DOMAIN_FORBIDDEN');
}
export async function initializeFreshDatabase(
  dataRoot: string,
  schemaPath: string,
) {
  const ddl = await fs.readFile(schemaPath, 'utf8');
  if (
    createHash('sha256').update(ddl).digest('hex') !==
    'ffa7b469ff5844fab2fc49b6046447b542f0cf6fc2a7a6dc50246ae47b501655'
  )
    throw new V2StartupError('FROZEN_DDL_MISMATCH');
  const dbDirectory = path.join(dataRoot, 'db');
  await fs.mkdir(dbDirectory, { mode: 0o700 });
  const file = path.join(dbDirectory, 'database.sqlite');
  const descriptor = await fs.open(
    file,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_RDWR |
      constants.O_NOFOLLOW,
    0o600,
  );
  await descriptor.close();
  const connection = await new Promise<sqlite3.Database>((resolve, reject) => {
    const db: sqlite3.Database = new sqlite3.Database(
      file,
      sqlite3.OPEN_READWRITE,
      (e) => (e ? reject(e) : resolve(db)),
    );
  });
  try {
    await new Promise<void>((resolve, reject) =>
      connection.exec(ddl, (e) => (e ? reject(e) : resolve())),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      connection.close((e) => (e ? reject(e) : resolve())),
    );
  }
  const opened = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await opened.sync();
  } finally {
    await opened.close();
  }
  await syncDirectory(dbDirectory);
}
/** Validate before touching any control/catalog or unknown nonempty root. */
export async function openV2Store(
  options: V2BootOptions,
  beforeWritableOpen?: () => Promise<void>,
) {
  validateV2DataRoot(options);
  const root = options.dataRoot;
  if (
    !root ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    root === path.parse(root).root
  )
    throw new V2StartupError('EXPLICIT_CANONICAL_DATA_ROOT_REQUIRED');
  const project = options.projectRoot ?? path.resolve(__dirname, '../..');
  const forbidden = [
    path.join(project, 'data'),
    process.env.QL_DATA_DIR,
    ...(options.legacyDataRoots ?? []),
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p!));
  if (
    forbidden.some(
      (p) =>
        root === p ||
        root.startsWith(p + path.sep) ||
        p.startsWith(root + path.sep),
    )
  )
    throw new V2StartupError('LEGACY_DATA_DOMAIN_FORBIDDEN');
  const existing = await fs.lstat(root).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!existing) {
    if (!options.initialize)
      throw new V2StartupError('INITIALIZATION_NOT_AUTHORIZED');
    const parent = path.dirname(root);
    if ((await fs.realpath(parent)) !== parent)
      throw new V2StartupError('CANONICAL_PARENT_REQUIRED');
    await fs.mkdir(root, { mode: 0o700 });
  }
  await assertPrivatePath(root, true);
  if ((await fs.realpath(root)) !== root)
    throw new V2StartupError('SYMLINK_ROOT_FORBIDDEN');
  let names = await fs.readdir(root);
  if (!names.length) {
    if (!options.initialize)
      throw new V2StartupError('INITIALIZATION_NOT_AUTHORIZED');
    // A concurrent initializer wins mkdir/exclusive DB creation. Never replace it.
    await initializeFreshDatabase(root, artifactPath('fresh-v2.sql', options));
  }
  names = await fs.readdir(root);
  const allowed = new Set([
    'db',
    'workspaces',
    'git',
    '.locks',
    'tmp',
    'runtime',
    'config-assets',
    'config',
    'log',
    'syslog',
    'cache',
    'upload',
  ]);
  if (names.some((name) => !allowed.has(name)) || !names.includes('db'))
    throw new V2StartupError('UNKNOWN_NONEMPTY_ROOT');
  const databasePath = path.join(root, 'db/database.sqlite');
  // Unknown SQLite inputs never get a source connection: even a READONLY WAL
  // connection can alter SHM read marks, and closing RW may checkpoint it.
  try {
    const proof = await preflightV2Schema(databasePath, root);
    await beforeWritableOpen?.();
    await assertSchemaSourceUnchanged(proof);
  } catch (error) {
    if (error instanceof SchemaPreflightError)
      throw new V2StartupError(error.reason);
    throw error;
  }
  // WorkspaceStore independently verifies the complete normalized catalog, not only metadata.
  let store: WorkspaceStore;
  try {
    store = await WorkspaceStore.open(databasePath, root);
  } catch {
    throw new V2StartupError('UNSUPPORTED_OR_CORRUPTED_SCHEMA');
  }
  try {
    const integrity = await store.all<{ integrity_check: string }>(
      'PRAGMA integrity_check',
    );
    if (
      integrity.length !== 1 ||
      integrity[0].integrity_check !== 'ok' ||
      (await store.all('PRAGMA foreign_key_check')).length
    )
      throw new V2StartupError('DATABASE_INTEGRITY_FAILED');
    const signature = (
      await store.all<{ schema_signature: string }>(
        'SELECT schema_signature FROM PlatformMetadata',
      )
    )[0];
    if (signature.schema_signature !== WORKSPACE_SCHEMA_SIGNATURE)
      throw new V2StartupError('SCHEMA_IDENTITY_MISMATCH');
    return store;
  } catch (e) {
    await store.close();
    throw e;
  }
}
export async function recoverV2RestoreBeforeOpen(options: V2BootOptions) {
  validateV2DataRoot(options);
  const paths = new BackupPaths(
    options.dataRoot,
    options.backupRoot ?? options.dataRoot + '-backups',
  );
  const file = path.join(paths.control, 'workspace-restore-journal.json');
  const exists = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!exists) return;
  const journal = await readWorkspaceRestoreJournal(paths);
  if (journal?.stage === 'ROLLED_BACK')
    throw new V2StartupError('RESTORE_ROLLED_BACK_REQUIRES_REVIEW');
  if (journal?.stage === 'COMPLETE') {
    const current = await fs.lstat(options.dataRoot).catch(() => null),
      expected = journal.candidate_identity;
    if (
      !current ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !expected ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    )
      throw new V2StartupError('RESTORE_PUBLISHED_ROOT_IDENTITY_MISMATCH');
  }
  if (journal) {
    // Directory identity alone does not qualify an SQLite file. Validate every
    // matching recovery source without letting SQLite open the original first.
    const proofs = [];
    for (const candidate of [
      {
        root: journal.target,
        identities: [journal.old_identity, journal.candidate_identity],
      },
      { root: journal.old_root, identities: [journal.old_identity] },
      { root: journal.candidate, identities: [journal.candidate_identity] },
    ]) {
      const actual = await fs
        .lstat(candidate.root)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      if (!actual) continue;
      if (!actual.isDirectory() || actual.isSymbolicLink())
        throw new V2StartupError('RESTORE_RECOVERY_ROOT_IDENTITY_INVALID');
      if (
        !candidate.identities.some(
          (expected) =>
            expected &&
            expected.dev === actual.dev &&
            expected.ino === actual.ino,
        )
      )
        continue;
      try {
        proofs.push(
          await preflightV2Schema(
            path.join(candidate.root, 'db/database.sqlite'),
            candidate.root,
            [options.dataRoot, paths.control, paths.root],
          ),
        );
      } catch (error) {
        if (error instanceof SchemaPreflightError)
          throw new V2StartupError(error.reason);
        throw error;
      }
    }
    for (const proof of proofs) {
      try {
        await assertSchemaSourceUnchanged(proof);
      } catch (error) {
        if (error instanceof SchemaPreflightError)
          throw new V2StartupError(error.reason);
        throw error;
      }
    }
    const recovered = await WorkspaceRestoreService.recoverAt(
      paths.data,
      paths.root,
    );
    await recovered.close();
  }
}
export async function sessionSigningKey(control: string) {
  await privateDirectory(control, true);
  const file = path.join(control, 'panel-session.key');
  let fd;
  try {
    fd = await fs.open(
      file,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    await fd.writeFile(randomBytes(64).toString('hex'));
    await fd.sync();
    await fd.close();
    fd = undefined;
    await syncDirectory(control);
  } catch (e) {
    await fd?.close();
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  await assertPrivatePath(file, false);
  const key = await fs.readFile(file, 'utf8');
  if (!/^[a-f0-9]{128}$/.test(key))
    throw new V2StartupError('SESSION_KEY_INVALID');
  return key;
}
