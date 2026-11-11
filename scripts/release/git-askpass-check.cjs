'use strict';
// Executed inside the shipped image; no network or real credentials required.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const GitCredentialResolver = require('/app/static/build/services/gitCredentialResolver.js').default;

(async () => {
  const username = 'qualification-user';
  const token = 'qualification-token';
  const context = await new GitCredentialResolver().resolve(
    { auth_type: 'https_token', username, status: 'enabled', capability: 'READ' },
    { token },
    'https://example.invalid/qualification.git',
  );
  try {
    for (const [prompt, expected] of [['Username', username], ['Password', token]]) {
      const output = execFileSync(context.env.GIT_ASKPASS, [prompt], {
        env: context.env,
        cwd: context.directory,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(output, expected + '\n', 'GIT_ASKPASS_RESPONSE_MISMATCH');
    }
    console.log('GIT_ASKPASS_EXECUTION_PASS');
  } finally {
    await context.cleanup();
  }
})().catch(() => {
  console.error('GIT_ASKPASS_EXECUTION_FAILED: check /tmp exec mount option');
  process.exitCode = 1;
});
