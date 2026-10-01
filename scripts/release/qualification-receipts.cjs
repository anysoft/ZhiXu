'use strict';
const assert = require('node:assert/strict');

// Only reuse receipts from this run and SHA; never hide a newer failed/expired receipt.
function selectReceipts(artifacts, env) {
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sha } = env;
  assert.match(runId || '', /^[1-9]\d*$/);
  assert.match(attempt || '', /^[1-9]\d*$/);
  assert.match(sha || '', /^[a-f0-9]{40}$/);
  return ['amd64', 'arm64'].map(architecture => {
    const pattern = new RegExp(`^container-gates-${architecture}-${runId}-([1-9]\\d*)-${sha}$`);
    const candidates = artifacts.flatMap(artifact => {
      const match = pattern.exec(artifact.name);
      return match && Number(match[1]) <= Number(attempt)
        ? [{ artifact, attempt: Number(match[1]) }] : [];
    }).sort((a, b) => b.attempt - a.attempt);
    assert.ok(candidates.length, `MISSING_ARCHITECTURE_RECEIPT:${architecture}`);
    const selected = candidates[0];
    assert.ok(!candidates[1] || candidates[1].attempt !== selected.attempt,
      `AMBIGUOUS_ARCHITECTURE_RECEIPT:${architecture}`);
    assert.equal(selected.artifact.expired, false, `EXPIRED_ARCHITECTURE_RECEIPT:${architecture}`);
    assert.ok(Number.isSafeInteger(selected.artifact.id) && selected.artifact.id > 0);
    return { architecture, run_id: runId, source_attempt: selected.attempt,
      artifact_id: selected.artifact.id, artifact_name: selected.artifact.name, commit: sha };
  });
}

module.exports = { selectReceipts };
