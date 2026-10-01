'use strict';
const assert = require('node:assert/strict');

async function backupOperation({api, wait, report}, route, body) {
  const receipt = {route, operation_id: null, kind: null, last_status: null,
    stage: 'SUBMIT', started_at: new Date().toISOString()};
  (report.backup_operations ??= []).push(receipt);
  try {
    const op = await api(route, 'POST', body);
    receipt.operation_id = op.id;
    receipt.last_status = op.status ?? null;
    receipt.stage = 'POLL';
    const result = await wait(async () => {
      const value = await api('/backups/operations/' + op.id);
      receipt.kind = value.kind ?? null;
      receipt.last_status = value.status;
      receipt.operation_phase = value.phase ?? null;
      // Never copy bodies, passphrases, uploaded bytes or operation results.
      if (value.error_code && /^(BACKUP|RESTORE|PLATFORM)_[A-Z_]+$/.test(value.error_code))
        receipt.error_code = value.error_code;
      return ['SUCCESS', 'FAILED'].includes(value.status) ? value : false;
    }, 3600);
    assert.equal(result.status, 'SUCCESS', result.error_code || 'BACKUP_OPERATION');
    receipt.stage = 'COMPLETE';
    return result.result;
  } catch (error) {
    const code = String(error.message).match(/\b(?:BACKUP|RESTORE|PLATFORM)_[A-Z_]+\b/);
    receipt.error_code ??= code ? code[0] : 'BACKUP_OPERATION_FAILED';
    receipt.failed_stage = receipt.stage;
    receipt.stage = 'FAILED';
    throw error;
  } finally {
    receipt.finished_at = new Date().toISOString();
  }
}
module.exports = {backupOperation};
