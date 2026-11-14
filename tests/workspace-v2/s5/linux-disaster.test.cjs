const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createS1BFixture } = require('./linux-disaster-fixture.cjs');

/** Workers share only a verified case and authenticated archive, never a backend process or FD. */
async function runDisasterWorker(sandbox, mode, key, signal) {
  const env = { ...process.env };
  delete env.ZHIXU_S2_MANAGED_RECEIPT;
  delete env.TS_NODE_PROJECT;
  delete env.NODE_OPTIONS;
  env.ZHIXU_S5_DISASTER_SANDBOX = sandbox.runRoot;
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'linux-disaster-worker.cjs'), mode, sandbox.root],
    {
      cwd: sandbox.projectRoot,
      env,
      stdio:
        mode === 'A'
          ? ['ignore', 'pipe', 'pipe', 'pipe']
          : ['pipe', 'pipe', 'pipe', 'ignore'],
    },
  );
  const started = new Date().toISOString();
  const stdout = createHash('sha256'),
    stderr = createHash('sha256');
  const chunks = [];
  let received = 0,
    protocolError,
    input;
  const stop = () => child.kill('SIGTERM');
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  for (const [stream, hash, sink] of [
    [child.stdout, stdout, process.stdout],
    [child.stderr, stderr, process.stderr],
  ])
    stream.on('data', (bytes) => {
      hash.update(bytes);
      sink.write(bytes);
    });
  if (mode === 'A') {
    child.stdio[3].on('data', (bytes) => {
      received += bytes.length;
      if (received > 48) {
        protocolError = 'S1B_KEY_PIPE_LENGTH_INVALID';
        bytes.fill(0);
        stop();
      } else chunks.push(bytes);
    });
    child.stdio[3].on('error', () => {
      protocolError = 'S1B_KEY_PIPE_FAILED';
      stop();
    });
  } else {
    assert.ok(
      Buffer.isBuffer(key) && key.length === 48,
      'B requires the private 48-byte pipe key',
    );
    input = Buffer.from(key);
    child.stdin.on('error', () => {
      protocolError = 'S1B_KEY_INPUT_FAILED';
      stop();
    });
    child.stdin.end(input, () => input.fill(0));
  }
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exit_code, childSignal) =>
        resolve({ exit_code, signal: childSignal }),
      );
    });
    const facts = {
      status: result.exit_code === 0 && !protocolError ? 'PASS' : 'FAIL',
      mode,
      controller_pid: child.pid,
      parent_pid: process.pid,
      started_at: started,
      closed_at: new Date().toISOString(),
      exit_code: result.exit_code,
      signal: result.signal,
      stdout_sha256: stdout.digest('hex'),
      stderr_sha256: stderr.digest('hex'),
      protocol_error: protocolError ?? null,
      explicit_stdio_only: true,
    };
    await sandbox.record('full-worker-' + mode + '-exit', facts);
    assert.equal(
      protocolError,
      undefined,
      'private key transport must complete without a protocol error',
    );
    assert.equal(
      result.signal,
      null,
      'the instance controller must exit normally',
    );
    assert.equal(
      result.exit_code,
      0,
      mode + ' controller must finish the actual qualification phase',
    );
    if (mode === 'A') {
      assert.equal(
        received,
        48,
        'A returns exactly one private key after completing destruction',
      );
      const transported = Buffer.concat(chunks, received);
      for (const bytes of chunks) bytes.fill(0);
      return { facts, key: transported };
    }
    return { facts };
  } finally {
    signal?.removeEventListener('abort', stop);
    input?.fill(0);
    for (const bytes of chunks) bytes.fill(0);
  }
}

async function qualifyFullDisaster(t) {
  assert.equal(
    process.platform,
    'linux',
    'this gate requires an actual Linux target',
  );
  const sandbox = await createS1BFixture(t, {
    caseId: 'full-disaster-eight-original-tasks',
  });
  let key;
  const started = Date.now();
  try {
    const A = await runDisasterWorker(sandbox, 'A', undefined, t.signal);
    key = A.key;
    assert.notEqual(A.facts.controller_pid, process.pid);
    assert.throws(
      () => process.kill(A.facts.controller_pid, 0),
      { code: 'ESRCH' },
      'A controller must no longer exist',
    );
    const destroyed = path.join(sandbox.root, 'instance-A');
    for (const relative of [
      '',
      'data',
      'data/runtime',
      'data.platform-control',
      'backups',
      'remote-1',
    ])
      await assert.rejects(fs.lstat(path.join(destroyed, relative)), {
        code: 'ENOENT',
      });
    const baselinePath = path.join(sandbox.transferRoot, 'full-baseline.json');
    const archivePath = path.join(sandbox.transferRoot, 'full-asset.encrypted');
    for (const file of [baselinePath, archivePath]) {
      const stat = await fs.lstat(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
      assert.equal(stat.mode & 0o077, 0);
      if (process.getuid) assert.equal(stat.uid, process.getuid());
      assert.equal(await fs.realpath(file), file);
    }
    const absentBeforeB = new Date().toISOString();
    await sandbox.record('full-independent-B-admission', {
      status: 'PASS',
      A_controller_pid: A.facts.controller_pid,
      A_controller_exited: true,
      A_exit_code: A.facts.exit_code,
      A_root_absent: true,
      A_data_absent: true,
      A_runtime_absent: true,
      A_control_absent: true,
      verified_before_B_spawn_at: absentBeforeB,
      baseline_sha256: await sandbox.hashFile(baselinePath),
      encrypted_archive_sha256: await sandbox.hashFile(archivePath),
      key_transport:
        'raw private FD3 A-to-parent, private stdin parent-to-B; never a file, JSON, argv or environment',
    });
    const B = await runDisasterWorker(sandbox, 'B', key, t.signal);
    assert.notEqual(B.facts.controller_pid, A.facts.controller_pid);
    assert.notEqual(B.facts.controller_pid, process.pid);
    assert.ok(B.facts.started_at >= absentBeforeB);
    await sandbox.record('full-disaster-process-boundary', {
      status: 'PASS',
      input: 'fresh A and independent B OS controller processes',
      expected: 'A exits zero and all A assets are absent before B starts',
      actual: 'distinct controllers and independent restored execution passed',
      assertions: [
        'A_CONTROLLER_EXIT_0',
        'A_ALL_ROOTS_ABSENT_BEFORE_B',
        'DISTINCT_A_B_PIDS',
        'NO_INHERITED_A_FDS',
        'PIPE_ONLY_KEY',
      ],
      A_controller_pid: A.facts.controller_pid,
      B_controller_pid: B.facts.controller_pid,
      A_closed_at: A.facts.closed_at,
      absent_before_B_at: absentBeforeB,
      B_started_at: B.facts.started_at,
      B_closed_at: B.facts.closed_at,
      duration_ms: Date.now() - started,
      exit_code: 0,
    });
  } finally {
    key?.fill(0);
  }
}

test(
  'S5 Linux compiled application destroys A before independent B cold-rebuilds and executes all eight original Task IDs',
  { timeout: 3600000 },
  qualifyFullDisaster,
);
