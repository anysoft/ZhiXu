'use strict';
// This module must stay free of application/config/SQLite imports. Admission runs
// before release secrets, directories, leases, recovery or model initialization.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const NAMES = ['database.sqlite', 'database.sqlite-wal', 'database.sqlite-shm', 'database.sqlite-journal'];
const OWNER = '.v9-preflight-owner.json';
const TEMPORARY_MAX_BYTES = 32 * 1024 * 1024 * 1024;
const MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const DEADLINE_MS = 120000;
const proofs = new Map();

function reject(reason = 'UNSUPPORTED_OR_CORRUPTED_SCHEMA') {
  const error = new Error('UNSUPPORTED_DATABASE_SCHEMA: ' + reason);
  error.code = 'UNSUPPORTED_DATABASE_SCHEMA';
  throw error;
}
function stat(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function identity(value) {
  if (!value) return null;
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink', 'uid'].map(key => String(value[key])).join(':');
}
function privateDirectory(file) {
  const value = stat(file);
  if (!value || !value.isDirectory() || value.isSymbolicLink() || (value.mode & 0o077n) || (process.getuid && value.uid !== BigInt(process.getuid()))) reject('SOURCE_INVALID');
  return value;
}
function privateFile(value) {
  if (!value?.isFile() || value.nlink !== 1n || (value.mode & 0o077n) || (process.getuid && value.uid !== BigInt(process.getuid()))) reject('SOURCE_INVALID');
}
function directoryChain(file) {
  let current = path.parse(file).root;
  for (const component of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const value = stat(current);
    if (!value) return;
    if (!value.isDirectory() || value.isSymbolicLink()) reject('SOURCE_INVALID');
  }
}
function unchanged(proof) {
  directoryChain(proof.root);
  if (identity(stat(proof.root)) !== proof.rootIdentity || identity(stat(proof.directory)) !== proof.directoryIdentity) reject('SOURCE_CHANGED');
  for (const [name, expected] of [['rootFd', proof.rootIdentity], ['directoryFd', proof.directoryIdentity]]) if (proof[name] !== undefined && identity(fs.fstatSync(proof[name], { bigint: true })) !== expected) reject('SOURCE_CHANGED');
  if (proof.directoryIdentity && JSON.stringify(fs.readdirSync(proof.directory).sort()) !== proof.names) reject('SOURCE_CHANGED');
  for (const file of proof.files) {
    const value = stat(path.join(proof.directory, file.name));
    if (value) privateFile(value);
    if (identity(value) !== file.identity || (file.fd !== undefined && identity(fs.fstatSync(file.fd, { bigint: true })) !== file.identity)) reject('SOURCE_CHANGED');
  }
}
function removeOwnedClone(clone) {
  const current = privateDirectory(clone.root);
  if (String(current.dev) !== clone.dev || String(current.ino) !== clone.ino || !path.basename(clone.root).startsWith('zhixu-v9-schema-')) reject('TEMP_OWNERSHIP_REQUIRED');
  const fd = fs.openSync(path.join(clone.root, OWNER), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const value = fs.fstatSync(fd, { bigint: true }); privateFile(value);
    if (value.size > 2048n) reject('TEMP_OWNERSHIP_REQUIRED');
    const owner = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (owner.nonce !== clone.nonce || owner.dev !== clone.dev || owner.ino !== clone.ino) reject('TEMP_OWNERSHIP_REQUIRED');
  } finally { fs.closeSync(fd); }
  if (fs.readdirSync(clone.root).some(name => name !== OWNER && name !== 'db')) reject('TEMP_OWNERSHIP_REQUIRED');
  const directory = path.join(clone.root, 'db'), value = privateDirectory(directory);
  if (String(value.dev) !== clone.dbDev || String(value.ino) !== clone.dbIno) reject('TEMP_OWNERSHIP_REQUIRED');
  for (const name of fs.readdirSync(directory)) {
    if (!NAMES.includes(name)) reject('TEMP_OWNERSHIP_REQUIRED');
    privateFile(stat(path.join(directory, name)));
  }
  fs.rmSync(clone.root, { recursive: true });
}

/** Bounded descriptor copies only. SQLite never receives an original pathname.
 * Total main/WAL/SHM/journal bytes plus 2x scratch must fit the existing 32 GiB
 * temporary ceiling and leave 2 GiB free. Large or changing roots fail closed.
 */
function assertV9DataIdentity(root) {
  if (!root || !path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root) reject('SOURCE_INVALID');
  const cached = proofs.get(root);
  if (cached) { unchanged(cached); return; }
  const deadline = Date.now() + DEADLINE_MS;
  const checkDeadline = () => { if (Date.now() >= deadline) reject('PREFLIGHT_DEADLINE'); };
  directoryChain(root);
  const directory = path.join(root, 'db');
  directoryChain(directory);
  const rootStat = stat(root), directoryStat = stat(directory);
  if (rootStat) privateDirectory(root);
  if (directoryStat) privateDirectory(directory);
  const proof = { root, directory, rootIdentity: identity(rootStat), directoryIdentity: identity(directoryStat), names: directoryStat ? JSON.stringify(fs.readdirSync(directory).sort()) : null, files: [] };
  let clone;
  try {
    for (const [name, file, expected] of [['rootFd', root, proof.rootIdentity], ['directoryFd', directory, proof.directoryIdentity]]) if (expected) {
      proof[name] = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      if (identity(fs.fstatSync(proof[name], { bigint: true })) !== expected) reject('SOURCE_CHANGED');
    }
    let total = 0;
    for (const name of NAMES) {
      const source = path.join(directory, name), before = stat(source);
      const item = { name, identity: identity(before) }; proof.files.push(item);
      if (!before) continue;
      privateFile(before);
      item.fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (identity(fs.fstatSync(item.fd, { bigint: true })) !== item.identity) reject('SOURCE_CHANGED');
      const size = Number(before.size);
      if (!Number.isSafeInteger(size) || size < 0) reject('CAPACITY_EXCEEDED');
      item.size = size;
      total += size;
    }
    if (proof.files[0].fd === undefined) {
      if (proof.files.some(file => file.fd !== undefined) || (directoryStat && fs.readdirSync(directory).length)) reject('SOURCE_INVALID');
      unchanged(proof);
      proofs.set(root, proof);
      return;
    }
    const required = total * 3 + 1024 * 1024;
    if (!Number.isSafeInteger(required) || required > TEMPORARY_MAX_BYTES) reject('CAPACITY_EXCEEDED');
    const temporaryParent = fs.realpathSync(os.tmpdir());
    for (const forbidden of [root, root + '.platform-control', process.env.BACKUP_DIR, process.env.HOME].filter(Boolean)) {
      const value = path.resolve(forbidden);
      if (temporaryParent === value || temporaryParent.startsWith(value + path.sep)) reject('TEMP_ROOT_INVALID');
    }
    const space = fs.statfsSync(temporaryParent, { bigint: true });
    if (space.bavail * space.bsize < BigInt(required + MINIMUM_FREE_BYTES)) reject('CAPACITY_EXCEEDED');
    const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, 'zhixu-v9-schema-'));
    fs.chmodSync(temporaryRoot, 0o700);
    const temporaryStat = privateDirectory(temporaryRoot), nonce = crypto.randomUUID();
    clone = { root: temporaryRoot, nonce, dev: String(temporaryStat.dev), ino: String(temporaryStat.ino) };
    fs.writeFileSync(path.join(temporaryRoot, OWNER), JSON.stringify(clone), { flag: 'wx', mode: 0o600 });
    const destination = path.join(temporaryRoot, 'db'); fs.mkdirSync(destination, { mode: 0o700 });
    const destinationStat = privateDirectory(destination); clone.dbDev = String(destinationStat.dev); clone.dbIno = String(destinationStat.ino);
    const buffer = Buffer.alloc(1024 * 1024);
    for (const source of proof.files) {
      if (source.fd === undefined) continue;
      const target = fs.openSync(path.join(destination, source.name), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_WRONLY, 0o600);
      try {
        if (identity(fs.fstatSync(source.fd, { bigint: true })) !== source.identity) reject('SOURCE_CHANGED');
        const length = source.size;
        for (let offset = 0; offset < length;) {
          checkDeadline();
          const count = fs.readSync(source.fd, buffer, 0, Math.min(buffer.length, length - offset), offset);
          if (!count) reject('SOURCE_CHANGED');
          let written = 0;
          while (written < count) { const next = fs.writeSync(target, buffer, written, count - written, offset + written); if (!next) reject('COPY_FAILED'); written += next; }
          offset += count;
        }
        fs.fsyncSync(target);
      } finally { fs.closeSync(target); }
    }
    unchanged(proof); checkDeadline();
    const result = spawnSync(process.execPath, [path.join(__dirname, 'v9IdentityProbe.js'), temporaryRoot], {
      cwd: temporaryRoot,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', QL_DATA_DIR: temporaryRoot, QL_DIR: path.resolve(__dirname, '../../..'), JWT_SECRET: 'v9-owned-schema-probe', NODE_ENV: 'production', HOME: temporaryRoot, TMPDIR: temporaryRoot },
      timeout: Math.max(1, deadline - Date.now()), maxBuffer: 16384, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    unchanged(proof); checkDeadline();
    if (result.error || result.signal || result.status !== 0 || result.stdout.trim() !== 'V9_IDENTITY_ACCEPTED') reject();
    proofs.set(root, proof);
  } catch (error) {
    if (error.code === 'UNSUPPORTED_DATABASE_SCHEMA') throw error;
    reject();
  } finally {
    for (const file of proof.files) if (file.fd !== undefined) { fs.closeSync(file.fd); delete file.fd; }
    for (const name of ['rootFd', 'directoryFd']) if (proof[name] !== undefined) { fs.closeSync(proof[name]); delete proof[name]; }
    if (clone) removeOwnedClone(clone);
  }
}

/** Match config's dotenv precedence without importing application configuration.
 * Freeze the checked DATA selection before later dotenv reads can change it.
 */
function assertV9StartupIdentity(appDirectory) {
  const values = { ...process.env }, parse = require('dotenv').parse;
  const defaults = path.basename(appDirectory) === 'build' && path.basename(path.dirname(appDirectory)) === 'static' ? path.resolve(appDirectory, '../..') : path.resolve(appDirectory, '..');
  const load = file => {
    try { for (const [key, value] of Object.entries(parse(fs.readFileSync(file)))) if (values[key] === undefined) values[key] = value; }
    catch (error) { if (error.code !== 'ENOENT') reject('STARTUP_CONFIG_INVALID'); }
  };
  load(path.resolve(appDirectory, '../.env'));
  const project = values.QL_DIR || defaults;
  load(path.join(project, '.env'));
  const root = path.resolve(values.QL_DATA_DIR || path.join(project, 'data'));
  assertV9DataIdentity(root);
  process.env.QL_DATA_DIR = root;
}
module.exports = { assertV9DataIdentity, assertV9StartupIdentity };
