'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {backupOperation} = require('../../scripts/release/backup-operation.cjs');
const wait = async fn => { for (let i=0;i<4;i++) {const value=await fn();if(value)return value;}throw Error('QUALIFICATION_DEADLINE'); };

test('backup diagnostics retain operation identity and last state without secrets or result payloads', async () => {
  const report = {}; let calls=0;
  const result = await backupOperation({report,wait,api:async () => {
    calls++;
    if(calls===1)return {id:'operation-id',status:'QUEUED'};
    return {kind:'REBUILD',phase:'REBUILD',status:calls===2?'RUNNING':'SUCCESS',result:'PRIVATE_RESULT'};
  }}, '/restore/rebuild', {passphrase:'PRIVATE_PASSPHRASE'});
  assert.equal(result,'PRIVATE_RESULT');
  assert.equal(report.backup_operations[0].operation_id,'operation-id');
  assert.equal(report.backup_operations[0].kind,'REBUILD');
  assert.equal(report.backup_operations[0].stage,'COMPLETE');
  assert.equal(report.backup_operations[0].last_status,'SUCCESS');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);
});

test('poll HTTP failure is preserved with last status, exact operation and no API retries', async () => {
  const report={}; let calls=0;
  const error=Error('API_REJECTED:GET:/backups/operations/op:409:BACKUP_FILE_INVALID');
  await assert.rejects(backupOperation({report,wait,api:async()=>{
    calls++;
    if(calls===1)return {id:'op',status:'QUEUED'};
    if(calls===2)return {kind:'REBUILD',status:'RUNNING'};
    throw error;
  }},'/restore/rebuild',{}), e=>e===error);
  assert.equal(calls,3);
  assert.equal(report.backup_operations[0].error_code,'BACKUP_FILE_INVALID');
  assert.equal(report.backup_operations[0].failed_stage,'POLL');
  assert.equal(report.backup_operations[0].last_status,'RUNNING');
});

test('terminal failure and submission failure cannot pass and identify their stage', async () => {
  for(const stage of ['SUBMIT','POLL']) {
    const report={};let calls=0;
    await assert.rejects(backupOperation({report,wait,api:async()=>{
      if(stage==='SUBMIT')throw Error('BACKUP_OPERATION_BUSY');
      if(++calls===1)return {id:'op',status:'QUEUED'};
      return {status:'FAILED',error_code:'RESTORE_FAILED'};
    }},'/restores/import',{file:'PRIVATE_BYTES'}));
    assert.equal(report.backup_operations[0].failed_stage,stage);
    assert.equal(report.backup_operations[0].stage,'FAILED');
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_BYTES/);
  }
});
