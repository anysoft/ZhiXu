'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

/** Content and relative-link identity, deliberately independent of mode/UID.
 * Shared by approved acquisition and read-only readiness. Executable permissions
 * and path ownership remain separate application checks, not claims of this hash.
 */
async function runtimeTreeDigest(root) {
  const invalid = () => {
    throw Error('RUNTIME_TREE_INVALID');
  };
  if (typeof root !== 'string' || !path.isAbsolute(root)) invalid();
  const decode = (bytes) => {
    let value;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      invalid();
    }
    if (!Buffer.from(value).equals(bytes)) invalid();
    return value;
  };
  const namesIn = async (directory) => {
    const names = (await fs.readdir(directory, { encoding: 'buffer' })).map(
      decode,
    );
    if (new Set(names).size !== names.length) invalid();
    return names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  };
  const linkIn = async (file) =>
    decode(await fs.readlink(file, { encoding: 'buffer' }));
  const canonical = await fs.realpath(root);
  const initial = await fs.lstat(root, { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink()) invalid();
  const entries = new Map();
  let bytes = 0;
  const unchanged = (before, after) => {
    for (const key of [
      'dev',
      'ino',
      'mode',
      'nlink',
      'size',
      'mtimeNs',
      'ctimeNs',
    ])
      if (before[key] !== after[key]) invalid();
  };
  const visit = async (relative, depth) => {
    if (depth > 100 || entries.size >= 100000) invalid();
    const file = relative ? path.join(canonical, relative) : canonical;
    const before = await fs.lstat(file, { bigint: true });
    const entry = { before, file };
    entries.set(relative, entry);
    if (before.isDirectory() && !before.isSymbolicLink()) {
      entry.type = 'directory';
      entry.names = await namesIn(file);
      for (const name of entry.names) {
        if (!name || /[\\\0]/.test(name)) invalid();
        await visit(relative ? relative + '/' + name : name, depth + 1);
      }
    } else if (before.isFile() && !before.isSymbolicLink()) {
      if (before.nlink !== 1n || before.size > 536870912n) invalid();
      bytes += Number(before.size);
      if (bytes > 1073741824) invalid();
      const handle = await fs.open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        unchanged(before, await handle.stat({ bigint: true }));
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false }))
          hash.update(chunk);
        unchanged(before, await handle.stat({ bigint: true }));
        entry.type = 'file';
        entry.sha256 = hash.digest('hex');
      } finally {
        await handle.close();
      }
    } else if (before.isSymbolicLink()) {
      entry.type = 'symlink';
      entry.target = await linkIn(file);
      if (
        !entry.target ||
        path.isAbsolute(entry.target) ||
        /[\\\0]/.test(entry.target)
      )
        invalid();
      const target = await fs.realpath(file); // rejects dangling links and link loops
      if (target !== canonical && !target.startsWith(canonical + path.sep))
        invalid();
      entry.resolved = path
        .relative(canonical, target)
        .split(path.sep)
        .join('/');
    } else invalid();
    unchanged(before, await fs.lstat(file, { bigint: true }));
  };
  await visit('', 0);
  unchanged(initial, entries.get('').before);
  // Never traverse a link while hashing. Also reject directory aliases that
  // would create cycles if a consumer subsequently traversed the installed tree.
  const active = new Set(),
    done = new Set();
  const checkDirectory = (relative) => {
    if (active.has(relative)) invalid();
    if (done.has(relative)) return;
    active.add(relative);
    const entry = entries.get(relative);
    for (const name of entry.names) {
      const childName = relative ? relative + '/' + name : name;
      const child = entries.get(childName);
      if (child.type === 'directory') checkDirectory(childName);
      else if (child.type === 'symlink') {
        const target = entries.get(child.resolved);
        if (!target) invalid();
        if (target.type === 'directory') checkDirectory(child.resolved);
      }
    }
    active.delete(relative);
    done.add(relative);
  };
  checkDirectory('');
  const rows = [];
  for (const [relative, entry] of [...entries].sort(([a], [b]) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    unchanged(entry.before, await fs.lstat(entry.file, { bigint: true }));
    if (entry.type === 'directory') {
      const names = await namesIn(entry.file);
      if (JSON.stringify(names) !== JSON.stringify(entry.names)) invalid();
      if (relative) rows.push(['directory', relative]);
    } else if (entry.type === 'file')
      rows.push(['file', relative, Number(entry.before.size), entry.sha256]);
    else {
      if ((await linkIn(entry.file)) !== entry.target) invalid();
      rows.push(['symlink', relative, entry.target]);
    }
  }
  if ((await fs.realpath(root)) !== canonical) invalid();
  unchanged(initial, await fs.lstat(root, { bigint: true }));
  return {
    sha256: createHash('sha256')
      .update(JSON.stringify({ schema: 1, entries: rows }))
      .digest('hex'),
    entry_count: rows.length,
    bytes,
  };
}
module.exports = { runtimeTreeDigest };
