'use strict';
// Repeatable current-source gate. The completed audit JSON remains historical evidence.
// Share the same checks as CI and the platform resource tests; never overwrite the audit.
const { check } = require('../../scripts/i18n/check.cjs');
const result = check();
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
