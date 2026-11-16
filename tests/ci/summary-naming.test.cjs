'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('current summary naming preserves counts and failed Browser despite successful artifact uploads', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zhixu-summary-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const core={status:'PASS',tests:{tests:7,pass:7,fail:0,skipped:0},typecheck:{mode:'STRICT_ZERO',status:'PASS',errors:0,raw_failed:false}};
  fs.mkdirSync(path.join(root,'ci-downloaded/core-fixture'),{recursive:true});
  fs.writeFileSync(path.join(root,'ci-downloaded/core-fixture/core-summary.json'),JSON.stringify(core));
  for(const browser of ['success','failure']) {
    const needs=Object.fromEntries(['preflight','core','managed-runtime','browser'].map(name=>[name,{result:name==='browser'?browser:'success',outputs:{upload:'success',artifact:name==='core'?'core-fixture':name+'-fixture'}}]));
    const summary=path.join(root,'step-summary.md');fs.rmSync(summary,{force:true});
    const r=spawnSync(process.execPath,[path.resolve('scripts/ci/summary.cjs')],{cwd:root,encoding:'utf8',env:{...process.env,CI_NEEDS:JSON.stringify(needs),CI_FINAL_UPLOAD:'success',CI_DOWNLOAD_OUTCOME:'success',GITHUB_STEP_SUMMARY:summary}});
    assert.equal(r.status,browser==='success'?0:1,r.stderr);
    const value=JSON.parse(r.stdout);assert.equal(value.phase,'LINUX_CI');assert.equal(value.qualification,'NOT_RELEASE_QUALIFICATION');
    assert.deepEqual(value.tests,core.tests);assert.equal(value.typecheck.errors,0);
    assert.equal(value.status,browser==='success'?'PASS':'FAIL');
    const markdown=fs.readFileSync(summary,'utf8');assert.match(markdown,/# ZhiXu Linux CI Summary/);
    assert.match(markdown,/This report summarizes Linux CI results\. It is not a release qualification report\./);
    assert.doesNotMatch(markdown,/Phase16A|Phase15/);
  }
});
