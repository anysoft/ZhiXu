// A/B backend controllers intentionally use separate OS processes and private pipes.
const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[2],
  existingRoot = process.argv[3];
const { releaseRoot, candidateIdentity } = require('./artifact-support.cjs');
const projectRoot = releaseRoot();
if (
  !['A', 'B'].includes(mode) ||
  !existingRoot ||
  process.platform !== 'linux' ||
  !process.env.ZHIXU_S5_DISASTER_SANDBOX ||
  !process.env.QL_DIR ||
  !process.env.QL_DATA_DIR
) {
  throw Error('S1B_WORKER_ISOLATION_REQUIRED');
}
const { createS1BFixture } = require('./linux-disaster-fixture.cjs');
const { runInstanceA, runInstanceB } = require('./linux-disaster-flow.cjs');

(async () => {
  const sandbox = await createS1BFixture(null, { existingRoot });
  let key;
  try {
    await sandbox.record('full-controller-' + mode + '-start', {
      status: 'PASS',
      controller_pid: process.pid,
      parent_pid: process.ppid,
      mode,
      fresh_controller: true,
      explicit_candidate_roots: true,
      candidate: candidateIdentity(),
      compiled_application: true,
    });
    if (mode === 'A') {
      const result = await runInstanceA(sandbox);
      key = result.key;
      if (
        !Buffer.isBuffer(key) ||
        key.length !== 48 ||
        result.baselinePath !==
          path.join(sandbox.transferRoot, 'full-baseline.json') ||
        result.archivePath !==
          path.join(sandbox.transferRoot, 'full-asset.encrypted')
      )
        throw Error('S1B_WORKER_RESULT_INVALID');
      // Close all instance services before publishing the key and exiting.
      await sandbox.close();
      let offset = 0;
      while (offset < key.length)
        offset += fs.writeSync(3, key, offset, key.length - offset);
      fs.closeSync(3);
    } else {
      const chunks = [];
      let size = 0;
      try {
        for await (const bytes of process.stdin) {
          size += bytes.length;
          if (size > 48) {
            bytes.fill(0);
            throw Error('S1B_KEY_INPUT_LENGTH_INVALID');
          }
          chunks.push(bytes);
        }
        if (size !== 48) throw Error('S1B_KEY_INPUT_LENGTH_INVALID');
        key = Buffer.concat(chunks, size);
      } finally {
        for (const bytes of chunks) bytes.fill(0);
      }
      await runInstanceB(sandbox, key);
    }
    await sandbox.close();
    const sourceImports = Object.keys(require.cache).filter(
      (file) =>
        /[\\/]back[\\/].*\.tsx?$/.test(file) ||
        /ts-node[\\/].*register/.test(file),
    );
    if (sourceImports.length)
      throw Error('S5_SOURCE_APPLICATION_MODULE_FORBIDDEN');
    await sandbox.record('full-controller-' + mode + '-complete', {
      status: 'PASS',
      controller_pid: process.pid,
      parent_pid: process.ppid,
      mode,
      exit_code: 0,
      source_application_modules_loaded: 0,
      candidate: candidateIdentity(),
    });
  } finally {
    key?.fill(0);
    await sandbox.close();
  }
})().catch((error) => {
  // Error messages/AssertionError values can contain private restored values.
  // Emit only a bounded typed code and stack locations, never arbitrary payloads.
  const candidate = error?.error_code ?? error?.code;
  const code =
    typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(candidate)
      ? candidate
      : 'S1B_CONTROLLER_FAILED';
  const locations =
    typeof error?.stack === 'string'
      ? error.stack
          .split('\n')
          .filter((line) => /^\s+at /.test(line))
          .slice(0, 12)
      : [];
  process.stderr.write(
    JSON.stringify({
      mode,
      controller_pid: process.pid,
      status: 'FAIL',
      error_code: code,
      locations,
    }) + '\n',
  );
  process.exitCode = 1;
});
