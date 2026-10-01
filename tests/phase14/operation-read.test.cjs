'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
process.env.TS_NODE_PROJECT = path.resolve('back/tsconfig.json');
require('ts-node/register/transpile-only');
const {privateJson, readJson, openRegular} = require('../../back/services/backup/files.ts');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'operation-read-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'operation');
  await privateJson(file, {status: 'RUNNING'});
  return {root, file};
}

// Replace the real inode after open but before fstat, with no timing assumptions.
function race(t, file, replace) {
  const original = fs.open;
  const handles = [];
  t.mock.method(fs, 'open', async function(name, ...args) {
    const handle = await original.call(fs, name, ...args);
    if (name === file) {
      handles.push(handle);
      await replace(handles.length);
    }
    return handle;
  });
  return handles;
}

test('operation JSON read reopens an atomically replaced inode and closes every descriptor', async t => {
  const {file} = await fixture(t);
  const handles = race(t, file, async count => {
    if (count === 1) await privateJson(file, {status: 'SUCCESS'});
  });
  assert.deepEqual(await readJson(file, undefined, true), {status: 'SUCCESS'});
  assert.equal(handles.length, 2);
  assert.ok(handles.every(handle => handle.fd === -1));
});

test('replacement reopening is opt-in and bounded', async t => {
  const {file} = await fixture(t);
  const handles = race(t, file, () => privateJson(file, {status: 'RUNNING'}));
  await assert.rejects(readJson(file), {code: 'BACKUP_FILE_INVALID'});
  assert.equal(handles.length, 1);
  await assert.rejects(readJson(file, undefined, true), {code: 'BACKUP_FILE_INVALID'});
  assert.equal(handles.length, 4);
  assert.ok(handles.every(handle => handle.fd === -1));
});

test('replacement path is revalidated: symlink, hardlink, permissions and deletion fail closed', async t => {
  for (const kind of ['symlink', 'hardlink', 'permissions', 'deleted']) {
    await t.test(kind, async t => {
      const {root, file} = await fixture(t);
      const target = path.join(root, 'target');
      await privateJson(target, {status: 'SUCCESS'});
      const handles = race(t, file, async count => {
        if (count !== 1) return;
        await fs.unlink(file);
        if (kind === 'symlink') await fs.symlink(target, file);
        if (kind === 'hardlink') await fs.link(target, file);
        if (kind === 'permissions') await fs.writeFile(file, '{}', {mode: 0o644});
      });
      await assert.rejects(readJson(file, undefined, true));
      assert.ok(handles.every(handle => handle.fd === -1));
    });
  }
});

test('unsafe owner and nonregular descriptors are not retried, and JSON limits remain enforced', async t => {
  const {root, file} = await fixture(t);
  await assert.rejects(openRegular(root), {code: 'BACKUP_FILE_INVALID'});
  await assert.rejects(readJson(file, 1, true), {code: 'BACKUP_LIMIT'});
  await fs.writeFile(file, '{', {mode: 0o600});
  await assert.rejects(readJson(file, undefined, true), SyntaxError);
  const original = fs.open;
  let opens = 0;
  t.mock.method(fs, 'open', async (...args) => {
    opens++;
    const handle = await original(...args), stat = handle.stat.bind(handle);
    handle.stat = async () => ({...await stat(), uid: process.getuid() + 1, nlink: 0, isFile: () => true});
    return handle;
  });
  await assert.rejects(readJson(file, undefined, true), {code: 'BACKUP_FILE_INVALID'});
  assert.equal(opens, 1);
});
