'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { createS1BFixture, treeUsage } = require('../s5/linux-disaster-fixture.cjs');

test('S5 watchdog metrics narrowly count owned runtime GNU make jobserver FIFOs', async (t) => {
  const fixture = await createS1BFixture(null, { caseId: 'metrics-fifo' });
  const original = await fs.lstat(fixture.runRoot);
  t.after(async () => {
    await fixture.close();
    const current = await fs.lstat(fixture.runRoot);
    assert.equal(current.dev, original.dev);
    assert.equal(current.ino, original.ino);
    await fs.rm(fixture.runRoot, { recursive: true });
  });
  const instance = await fixture.createInstance('A');
  const temp = path.join(instance.dataRoot, 'tmp/runtime/python/operation-2/tmp');
  await fs.mkdir(temp, { recursive: true, mode: 0o700 });
  const fifo = path.join(temp, 'GMfifo1234');
  const metrics = { runtimeBuildMetrics: true };
  const mkfifo = (file) => execFileSync('/usr/bin/mkfifo', ['-m', '600', file]);
  const rejected = () => assert.rejects(treeUsage(fixture.root, metrics), /S1B_/);
  await t.test('real FIFO contributes an object and allocated bytes only under opt-in metrics', async () => {
    const before = await treeUsage(fixture.root, metrics);
    mkfifo(fifo);
    const physical = await fs.lstat(fifo);
    assert.ok(physical.isFIFO());
    const actual = await treeUsage(fixture.root, metrics);
    assert.equal(actual.files, before.files + 1);
    assert.equal(actual.temporary_fifo_count, 1);
    assert.ok(actual.allocated_bytes >= physical.blocks * 512);
    await assert.rejects(treeUsage(fixture.root), /S1B_UNKNOWN_SPECIAL_FILE/);
    await fixture.measure('fifo-stat-only', async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
    const files = await fs.readdir(fixture.evidenceRoot);
    const receipt = JSON.parse(await fs.readFile(path.join(fixture.evidenceRoot, files.find((name) => name.includes('metric-fifo-stat-only'))), 'utf8'));
    assert.equal(receipt.sampled_peak_temporary_fifo_count, 1);
    assert.ok(receipt.sampled_peak_file_count >= before.files + 1);
    await fs.unlink(fifo);
  });
  await t.test('FIFOs in assets or with an unrecognized runtime name remain rejected', async () => {
    for (const file of [path.join(instance.root, 'asset.fifo'), path.join(temp, 'unrecognized-pipe')]) {
      mkfifo(file);
      try { await rejected(); } finally { await fs.unlink(file); }
    }
  });
  await t.test('an actual Unix socket at even the approved-looking filename is rejected', async () => {
    const server = net.createServer();
    const previousDirectory = process.cwd();
    // Relative bind avoids the OS Unix-domain sockaddr length limit in long
    // private fixture roots; the physical object remains at the exact path.
    process.chdir(fixture.root);
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.relative(fixture.root, fifo), resolve); });
      assert.ok((await fs.lstat(fifo)).isSocket());
      await rejected();
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      process.chdir(previousDirectory);
    }
  });
  await t.test('symlink ancestors are not followed and are not accepted as runtime scratch', async () => {
    const actual = path.join(instance.root, 'other-tmp');
    await fs.mkdir(actual, { mode: 0o700 });
    mkfifo(path.join(actual, 'GMfifo1234'));
    await fs.rmdir(temp);
    await fs.symlink(actual, temp);
    try {
      // The normal walker accounts for the link itself, never its target.
      const usage = await treeUsage(path.join(instance.dataRoot, 'tmp'), metrics);
      assert.equal(usage.temporary_fifo_count, 0);
      await rejected(); // the real FIFO at unknown other-tmp remains prohibited
    } finally { await fs.unlink(temp); await fs.unlink(path.join(actual, 'GMfifo1234')); await fs.rmdir(actual); await fs.mkdir(temp, { mode: 0o700 }); }
  });
  await t.test('a missing or mismatched instance marker never authorizes the FIFO', async () => {
    const file = path.join(instance.root, '.s5-linux-instance-owner.json');
    const bytes = await fs.readFile(file);
    mkfifo(fifo);
    await fs.unlink(file);
    try { await assert.rejects(treeUsage(fixture.root, metrics)); }
    finally { await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' }); await fs.unlink(fifo); }
  });
});
