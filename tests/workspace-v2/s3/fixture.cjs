// Reuse the verified private-domain/ownership harness, not v9 model initialization.
const base = require('../s1b/fixture.cjs');
module.exports = { ...base, createS3Fixture: base.createS1BFixture };
