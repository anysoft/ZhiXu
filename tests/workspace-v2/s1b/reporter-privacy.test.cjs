const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createS1BFixture, sha256 } = require('./fixture.cjs');
test('qualification reporter preserves a real failure exit code without exposing stdout stderr or secret assertion values', async (t) => {
  const s = await createS1BFixture(t, { caseId: 'reporter-privacy' });
  const secret = s.registerSecret(
    'S1B_REPORTER_' + randomBytes(24).toString('hex'),
  );
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=' + path.join(__dirname, 'reporter.mjs'),
      path.join(__dirname, 'reporter-privacy-worker.cjs'),
    ],
    {
      env: { PATH: '/usr/bin:/bin', S1B_REPORTER_TEST_SENTINEL: secret },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  const log = result.stdout + result.stderr;
  assert.equal(
    log.includes(secret),
    false,
    'the reporter must withhold all sentinel-bearing diagnostics',
  );
  assert.match(log, /failure_code: ERR_ASSERTION/);
  assert.match(log, /fail 1/);
  await fs.writeFile(
    path.join(s.evidenceRoot, 'expected-failure-redacted.log'),
    log,
    { mode: 0o600, flag: 'wx' },
  );
  await s.record('reporter-privacy', {
    status: 'PASS',
    input:
      'real nested Node test emits sentinel to stdout/stderr and assertion expected value',
    expected:
      'nested exit1 preserved with safe failure code, sentinel absent from all recorded/public output',
    actual: 'nested exit1; ERR_ASSERTION; no sentinel',
    exit_code: 0,
    assertions: [
      'real failing child exits1',
      'raw stdout and stderr withheld',
      'assertion actual/expected withheld',
      'safe failure code and count retained',
    ],
    sentinel_sha256: sha256(secret),
    redacted_log_sha256: sha256(log),
    nested_exit_code: result.status,
  });
});
