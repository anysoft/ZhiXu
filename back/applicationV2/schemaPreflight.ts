import fs, { FileHandle } from 'fs/promises';
import { constants, BigIntStats } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { WorkspaceStore, assertPrivatePath, WORKSPACE_SCHEMA_SIGNATURE } from '../services/workspaceV2/store';
import { DEFAULT_LIMITS } from '../services/workspaceV2/limits';
import { requireDiskBudget } from '../services/workspaceV2/inventory';

/** No SQLite connection may touch an unqualified source, including its SHM. */
export class SchemaPreflightError extends Error {
  readonly error_code = 'STARTUP_REJECTED';
  constructor(readonly reason: string) { super('STARTUP_REJECTED'); }
}
interface FileIdentity {
  dev: string;
  ino: string;
  size: string;
  mtime_ns: string;
  ctime_ns: string;
  mode: string;
  nlink: string;
  uid: string;
}
interface SourceFile {
  name: string;
  identity: FileIdentity | null;
}
export interface SchemaSourceProof {
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly rootIdentity: FileIdentity;
  readonly directoryIdentity: FileIdentity;
  readonly names: readonly string[];
  readonly files: readonly SourceFile[];
}
interface SourceHandle extends SourceFile { handle: FileHandle | null; }
const NAMES = ['database.sqlite', 'database.sqlite-wal', 'database.sqlite-shm', 'database.sqlite-journal'];
const OWNER = '.schema-preflight-owner.json';
const CHUNK_BYTES = 1024 * 1024;
function reject(reason = 'SCHEMA_PREFLIGHT_SOURCE_CHANGED'): never { throw new SchemaPreflightError(reason); }
function identity(stat: BigIntStats): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtime_ns: String(stat.mtimeNs), ctime_ns: String(stat.ctimeNs), mode: String(stat.mode), nlink: String(stat.nlink), uid: String(stat.uid) };
}
function equal(a: FileIdentity | null, b: FileIdentity | null) { return JSON.stringify(a) === JSON.stringify(b); }
function privateFile(stat: BigIntStats) {
  if (!stat.isFile() || stat.nlink !== BigInt(1) || (stat.mode & BigInt(0o077)) !== BigInt(0) || (process.getuid && stat.uid !== BigInt(process.getuid()))) reject('SCHEMA_PREFLIGHT_SOURCE_INVALID');
}
async function statOrMissing(file: string) {
  return fs.lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
}
async function names(directory: string) {
  const entries = (await fs.readdir(directory)).sort();
  if (entries.some(name => !NAMES.includes(name)) || !entries.includes(NAMES[0])) reject('SCHEMA_PREFLIGHT_SOURCE_INVALID');
  return entries;
}
/** Rechecked after the application owner FD is acquired, immediately before RW. */
export async function assertSchemaSourceUnchanged(proof: SchemaSourceProof) {
  await assertPrivatePath(proof.dataRoot, true);
  await assertPrivatePath(path.dirname(proof.databasePath), true);
  if (!equal(identity(await fs.lstat(proof.dataRoot, { bigint: true })), proof.rootIdentity) || !equal(identity(await fs.lstat(path.dirname(proof.databasePath), { bigint: true })), proof.directoryIdentity)) reject();
  if (JSON.stringify(await names(path.dirname(proof.databasePath))) !== JSON.stringify(proof.names)) reject();
  for (const file of proof.files) {
    const actual = await statOrMissing(path.join(path.dirname(proof.databasePath), file.name));
    if (actual) privateFile(actual);
    if (!equal(actual ? identity(actual) : null, file.identity)) reject();
  }
}
async function copyOpened(source: SourceHandle, destination: string) {
  if (!source.handle || !source.identity) return;
  const length = Number(source.identity.size);
  const target = await fs.open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    for (let position = 0; position < length;) {
      const { bytesRead } = await source.handle.read(buffer, 0, Math.min(buffer.length, length - position), position);
      if (!bytesRead) reject();
      let written = 0;
      while (written < bytesRead) {
        const next = await target.write(buffer, written, bytesRead - written, position + written);
        if (!next.bytesWritten) reject('SCHEMA_PREFLIGHT_COPY_FAILED');
        written += next.bytesWritten;
      }
      position += bytesRead;
    }
    await target.sync();
    if (!equal(identity(await source.handle.stat({ bigint: true })), source.identity)) reject();
  } finally { await target.close(); }
}
async function validateClone(databasePath: string, root: string) {
  let store: WorkspaceStore | undefined;
  try {
    store = await WorkspaceStore.open(databasePath, root);
    const integrity = await store.all<{integrity_check:string}>('PRAGMA integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || (await store.all('PRAGMA foreign_key_check')).length) reject('UNSUPPORTED_OR_CORRUPTED_SCHEMA');
    const metadata = await store.all<{schema_signature:string}>('SELECT schema_signature FROM PlatformMetadata');
    if (metadata.length !== 1 || metadata[0].schema_signature !== WORKSPACE_SCHEMA_SIGNATURE) reject('UNSUPPORTED_OR_CORRUPTED_SCHEMA');
  } catch (error) {
    if (error instanceof SchemaPreflightError) throw error;
    reject('UNSUPPORTED_OR_CORRUPTED_SCHEMA');
  } finally { await store?.close(); }
}
async function removeOwnedClone(root: string, nonce: string, expected: FileIdentity, databaseIdentity: FileIdentity) {
  const current = await fs.lstat(root, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || String(current.dev) !== expected.dev || String(current.ino) !== expected.ino || (current.mode & BigInt(0o077)) !== BigInt(0) || (process.getuid && current.uid !== BigInt(process.getuid())) || !path.basename(root).startsWith('zhixu-v2-schema-')) reject('SCHEMA_PREFLIGHT_TEMP_OWNERSHIP_REQUIRED');
  const handle = await fs.open(path.join(root, OWNER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const markerStat = await handle.stat({ bigint: true }); privateFile(markerStat);
    if (markerStat.size > BigInt(2048)) reject('SCHEMA_PREFLIGHT_TEMP_OWNERSHIP_REQUIRED');
    const marker = JSON.parse(await handle.readFile('utf8'));
    if (marker.version !== 1 || marker.nonce !== nonce || marker.dev !== expected.dev || marker.ino !== expected.ino) reject('SCHEMA_PREFLIGHT_TEMP_OWNERSHIP_REQUIRED');
  } finally { await handle.close(); }
  const directory = path.join(root, 'db'), actual = await fs.lstat(directory, { bigint: true });
  if (!actual.isDirectory() || actual.isSymbolicLink() || String(actual.dev) !== databaseIdentity.dev || String(actual.ino) !== databaseIdentity.ino) reject('SCHEMA_PREFLIGHT_TEMP_OWNERSHIP_REQUIRED');
  if ((await fs.readdir(root)).some(name => name !== OWNER && name !== 'db')) reject('SCHEMA_PREFLIGHT_TEMP_OWNERSHIP_REQUIRED');
  for (const name of await fs.readdir(directory)) {
    if (!NAMES.includes(name)) reject('SCHEMA_PREFLIGHT_TEMP_OWNERSHIP_REQUIRED');
    privateFile(await fs.lstat(path.join(directory, name), { bigint: true }));
  }
  await fs.rm(root, { recursive: true });
}

/** FD-copy even DELETE sources: an original READONLY SQLite connection can change
 * WAL SHM read marks if a writer enables WAL between inspection and open. */
export async function preflightV2Schema(databasePath: string, dataRoot: string, forbiddenTemporaryRoots:readonly string[]=[dataRoot]): Promise<SchemaSourceProof> {
  if (databasePath !== path.join(dataRoot, 'db/database.sqlite')) reject('SCHEMA_PREFLIGHT_SOURCE_INVALID');
  await assertPrivatePath(dataRoot, true);
  await assertPrivatePath(path.dirname(databasePath), true);
  const sourceFiles: SourceHandle[] = [];
  let clone: {root:string;nonce:string;identity:FileIdentity;databaseIdentity:FileIdentity} | undefined;
  try {
    const proof: SchemaSourceProof = {
      dataRoot, databasePath,
      rootIdentity: identity(await fs.lstat(dataRoot, { bigint: true })),
      directoryIdentity: identity(await fs.lstat(path.dirname(databasePath), { bigint: true })),
      names: await names(path.dirname(databasePath)), files: sourceFiles,
    };
    let total = 0;
    for (const name of NAMES) {
      const file = path.join(path.dirname(databasePath), name), before = await statOrMissing(file);
      if (!before) { sourceFiles.push({name,identity:null,handle:null}); continue; }
      privateFile(before);
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const item: SourceHandle = { name, identity: identity(before), handle };
      sourceFiles.push(item);
      const opened = await handle.stat({ bigint: true }); privateFile(opened);
      if (!equal(identity(opened), item.identity)) reject();
      const size = Number(opened.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > DEFAULT_LIMITS.temporaryMaxBytes) reject('SCHEMA_PREFLIGHT_CAPACITY_EXCEEDED');
      total += size;
    }
    const main = sourceFiles[0];
    if (!main.handle || !main.identity || Number(main.identity.size) < 100) reject('UNSUPPORTED_OR_CORRUPTED_SCHEMA');
    const header = Buffer.alloc(100), read = await main.handle.read(header, 0, header.length, 0);
    if (read.bytesRead !== header.length || !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) || ![1, 2].includes(header[18]) || ![1, 2].includes(header[19])) reject('UNSUPPORTED_OR_CORRUPTED_SCHEMA');
    const temporaryBytes = total * 3 + CHUNK_BYTES;
    if (!Number.isSafeInteger(temporaryBytes) || temporaryBytes > DEFAULT_LIMITS.temporaryMaxBytes) reject('SCHEMA_PREFLIGHT_CAPACITY_EXCEEDED');
    const temporaryParent = await fs.realpath(os.tmpdir());
    if (forbiddenTemporaryRoots.some(root => temporaryParent === root || temporaryParent.startsWith(root + path.sep))) reject('SCHEMA_PREFLIGHT_TEMP_ROOT_INVALID');
    try { await requireDiskBudget(temporaryParent, temporaryBytes, { ...DEFAULT_LIMITS }); }
    catch { reject('SCHEMA_PREFLIGHT_CAPACITY_EXCEEDED'); }
    const root = await fs.mkdtemp(path.join(temporaryParent, 'zhixu-v2-schema-'));
    const rootIdentity = identity(await fs.lstat(root, { bigint: true })), nonce = randomUUID();
    const owner = await fs.open(path.join(root, OWNER), constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
    try { await owner.writeFile(JSON.stringify({version:1,nonce,dev:rootIdentity.dev,ino:rootIdentity.ino})); await owner.sync(); }
    finally { await owner.close(); }
    const directory = path.join(root, 'db'); await fs.mkdir(directory, {mode:0o700});
    clone = {root,nonce,identity:rootIdentity,databaseIdentity:identity(await fs.lstat(directory, {bigint:true}))};
    for (const source of sourceFiles) await copyOpened(source, path.join(directory, source.name));
    for (const source of sourceFiles) if (source.handle && !equal(identity(await source.handle.stat({bigint:true})), source.identity)) reject();
    await assertSchemaSourceUnchanged(proof);
    await validateClone(path.join(directory, 'database.sqlite'), root);
    await assertSchemaSourceUnchanged(proof);
    return { ...proof, files: sourceFiles.map(({name,identity:sourceIdentity}) => ({name,identity:sourceIdentity})) };
  } catch (error) {
    if (error instanceof SchemaPreflightError) throw error;
    return reject('UNSUPPORTED_OR_CORRUPTED_SCHEMA');
  } finally {
    for (const file of sourceFiles) await file.handle?.close();
    if (clone) await removeOwnedClone(clone.root, clone.nonce, clone.identity, clone.databaseIdentity);
  }
}
