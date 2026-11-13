const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createS4Fixture } = require('./fixture.cjs');

test('S4 isolated actual application, LOCAL TaskRun and public catalog exclude retired global modules and namespaces', { timeout: 180000 }, async (t) => {
  const h = await createS4Fixture(t, { caseId: 's4-architecture-boundaries' });
  const child = fork(path.join(__dirname, 'architecture-boundaries-worker.cjs'), [h.root], {
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: { ...process.env, QL_DATA_DIR: '/dev/null' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); });
  let message;
  child.on('message', (value) => { message = value; });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (!message?.success) {
    await h.record('S4-ARCHITECTURE-BOUNDARIES-FAILURE', {
      status: 'FAILED', exit,
      error_code: message?.error_code ?? 'WORKER_RESULT_MISSING',
      assertion: message?.assertion,
      cache_observations: message?.cache_observations ?? [],
    });
  }
  assert.equal(exit.code, 0, message?.assertion ?? message?.error_code ?? 'ARCHITECTURE_WORKER_FAILED');
  assert.equal(exit.signal, null);
  assert.equal(message.success, true);
  await h.record('S4-ARCHITECTURE-BOUNDARIES', message.result);
});
