// S4 owns new cases while retaining the established exclusive private-domain proof.
const base = require('../s1b/fixture.cjs');
module.exports = { ...base, createS4Fixture: base.createS1BFixture };
