'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync,execFileSync} = require('node:child_process');
const {files, planVersion} = require('../../scripts/release/bump-version.cjs');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zhixu-version-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const file of [...files,'bump-version.sh','scripts/release/bump-version.cjs','scripts/release/metadata.cjs']) {
    fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.copyFileSync(file,path.join(root,file));
  }
  fs.symlinkSync(path.resolve('node_modules'),path.join(root,'node_modules'));
  execFileSync('git',['init','-q'],{cwd:root});
  return {root, run:(args,extra={})=>spawnSync('bash',[path.join(root,'bump-version.sh'),...args],{cwd:os.tmpdir(),encoding:'utf8',env:{...process.env,...extra}})};
}
test('version update changes all current surfaces, keeps history/dependencies and is idempotent',t=>{
  const {root,run}=fixture(t),before=fs.readFileSync(path.join(root,'version.yaml'),'utf8');
  fs.writeFileSync(path.join(root,'pnpm-lock.yaml'),'dependency-version: 1.0.0');
  const dry=run(['v2.3.4-rc.2','--dry-run']);assert.equal(dry.status,0,dry.stderr);
  assert.equal(fs.readFileSync(path.join(root,'version.yaml'),'utf8'),before);
  const update=run(['v2.3.4-rc.2']);assert.equal(update.status,0,update.stderr);
  assert.equal(planVersion(root,'2.3.4-rc.2').changed.length,0);
  assert.equal(fs.readFileSync(path.join(root,'version.yaml'),'utf8').split('changeLog:')[1],before.split('changeLog:')[1]);
  assert.equal(fs.readFileSync(path.join(root,'pnpm-lock.yaml'),'utf8'),'dependency-version: 1.0.0');
  assert.equal(run(['2.3.4-rc.2']).status,0);
  assert.equal(fs.readdirSync(path.join(root,'.git/zhixu-version-backups')).length,1);
  assert.equal(run(['--check']).status,0);
});
test('invalid tags, inconsistent inputs, unsafe paths and lock contention fail before mutation',t=>{
  const {root,run}=fixture(t),before=fs.readFileSync(path.join(root,'package.json'),'utf8');
  for(const version of ['1.02.3','1.0','1.0.0+build','1.0.0-01',';touch x'])assert.notEqual(run([version]).status,0);
  fs.mkdirSync(path.join(root,'.git/zhixu-version.lock'));
  assert.match(run(['2.0.0']).stderr,/VERSION_UPDATE_LOCKED/);
  fs.rmdirSync(path.join(root,'.git/zhixu-version.lock'));
  fs.writeFileSync(path.join(root,'version.yaml'),'version: 9.9.9\n');
  assert.notEqual(run(['2.0.0']).status,0);
  fs.unlinkSync(path.join(root,'version.yaml'));fs.symlinkSync(path.join(root,'package.json'),path.join(root,'version.yaml'));
  assert.match(run(['2.0.0']).stderr,/UNSAFE_VERSION_FILE/);
  assert.equal(fs.readFileSync(path.join(root,'package.json'),'utf8'),before);
});
test('mid-transaction write failure restores bytes and modes, releases lock and retains backups',t=>{
  const {root,run}=fixture(t),before=Object.fromEntries(files.map(f=>[f,fs.readFileSync(path.join(root,f),'utf8')]));
  fs.chmodSync(path.join(root,'package.json'),0o640);
  const hook=path.join(root,'fail.cjs');
  fs.writeFileSync(hook,`const fs=require('node:fs/promises');const rename=fs.rename;let count=0;fs.rename=async(...args)=>{if(++count===3)throw Error('INJECTED_WRITE_FAILURE');return rename(...args);};`);
  const result=run(['2.0.0'],{NODE_OPTIONS:'--require='+hook});
  assert.notEqual(result.status,0);assert.match(result.stderr,/INJECTED_WRITE_FAILURE/);
  for(const f of files)assert.equal(fs.readFileSync(path.join(root,f),'utf8'),before[f]);
  assert.equal(fs.statSync(path.join(root,'package.json')).mode&0o777,0o640);
  assert.equal(fs.existsSync(path.join(root,'.git/zhixu-version.lock')),false);
  assert.equal(fs.readdirSync(path.join(root,'.git/zhixu-version-backups')).length,1);
});
test('release downloads exact qualified image attempts and rejects missing archives',async()=>{
  const yaml=require('js-yaml'),workflow=yaml.load(fs.readFileSync('.github/workflows/release.yml','utf8'));
  assert.equal(workflow.jobs.qualification.permissions.actions,'read');
  assert.equal(workflow.jobs.publish.permissions.actions,'read');
  const script=workflow.jobs.publish.steps.find(step=>step.id==='images').with.script;
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const run=new AsyncFunction('require','github','context','core','process',script);
  const env={GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2',GITHUB_SHA:'a'.repeat(40)};
  const artifacts=[];
  for(const [arch,attempt] of [['amd64',2],['arm64',1]]) {
    for(const prefix of ['container-gates','container'])artifacts.push({id:artifacts.length+1,name:`${prefix}-${arch}-123-${attempt}-${env.GITHUB_SHA}`,expired:false});
  }
  const outputs={};
  const args=[id=>require(id.startsWith('./')?path.resolve(id):id),{paginate:async()=>artifacts,rest:{actions:{listWorkflowRunArtifacts:{}}}},{repo:{owner:'test',repo:'test'},runId:123},{info:()=>{},setOutput:(key,value)=>outputs[key]=value},{env}];
  await run(...args);assert.deepEqual(outputs,{amd64:'2',arm64:'4'});
  artifacts.pop();await assert.rejects(run(...args),/MISSING_OR_AMBIGUOUS_IMAGE/);
});
