// Deliberately failing child suite: its nonzero result must remain observable,
// while neither raw output nor assertion actual/expected reaches public logs.
const test = require('node:test');
const assert = require('node:assert/strict');
test('deliberate secret-bearing failure for qualification reporter', () => {
  const secret = process.env.S1B_REPORTER_TEST_SENTINEL;
  console.log(secret);
  console.error(secret);
  assert.equal('controlled different value', secret);
});
