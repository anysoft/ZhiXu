const test = require('node:test');
const assert = require('node:assert/strict');
const { createS5Fixture, artifactModule } = require('./artifact-support.cjs');

test('S5 compiled backend Node security floor rejects old patches and unsupported majors', async function s5BackendNodePolicy(t) {
  const h = await createS5Fixture(t, { caseId: 'S5-BACKEND-NODE-POLICY' });
  const { assertV2BackendNode } = artifactModule('applicationV2/backendNode');
  const rejected = [
    '20.20.0',
    '22.23.2',
    '22.23.4',
    '24.21.0',
    '24.22.2',
    '23.1.0',
    '25.0.0',
    '26.3.1',
    '22.23.5-rc.1',
    'v22.23.5',
    '',
    '22.23',
  ];
  for (const version of rejected)
    assert.throws(
      () => assertV2BackendNode(version),
      /BACKEND_NODE_VERSION_UNSUPPORTED/,
    );
  const accepted = ['22.23.5', '22.24.0', '24.22.3', '24.23.0'];
  for (const version of accepted)
    assert.doesNotThrow(() => assertV2BackendNode(version));
  assert.doesNotThrow(() => assertV2BackendNode(process.versions.node));
  await h.record('S5-BACKEND-NODE-POLICY', {
    status: 'PASS',
    rejected_versions: rejected,
    accepted_policy_versions: accepted,
    current_application_version: process.versions.node,
    policy_examples_are_not_claims_of_executing_other_versions: true,
  });
});
