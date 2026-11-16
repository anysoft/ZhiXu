'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { manifestFile, catalogEntry } = require('../../diagnostics/phase14/node-catalog-fixture.cjs');
const { runtimeFixture } = require('../phase6/helpers.cjs');
const path = require('node:path');
test('Browser manifest uses current job root and all supported catalog platform identifiers', () => {
  assert.equal(manifestFile({QL_MANAGED_DIR:'/owned/current-job'}), '/owned/current-job/managed-node/result.json');
  for (const platform of ['linux','darwin']) for (const arch of ['x64','arm64']) {
    const manifest={status:'PASS',runtime:{version:'24.22.3',metadata:{platform,architecture:arch,npm_version:'11.19.1'}}};
    assert.deepEqual(catalogEntry(manifest,platform,arch).files,[platform==='darwin'?`osx-${arch}-tar`:`${platform}-${arch}`]);
    assert.throws(()=>catalogEntry(manifest,platform,arch==='x64'?'arm64':'x64'));
  }
});
test('Browser catalog refresh admits exact version/platform, rejects stale version/platform, then really installs and verifies Node', {timeout:180000}, async t => {
  const h=await runtimeFixture(t);
  const Distribution=h.load('back/services/nodeDistributionProvider.ts').default;
  const Paths=h.load('back/services/nodePaths.ts').default;
  const Operations=h.load('back/services/runtimeOperations.ts').default;
  // The exact same catalog fixture as the Browser backend; real official installer is inherited.
  const version='24.22.3';
  const prepared={status:'PASS',runtime:{version,metadata:{platform:process.platform,architecture:process.arch,npm_version:'11.19.1'}}};
  let entry=catalogEntry(prepared);
  class BrowserDistribution extends Distribution { async catalog(){return [entry];} }
  const ops=new Operations(h.provider,undefined,undefined,{provider:new BrowserDistribution(new Paths(h.root))});
  t.after(()=>ops.close());
  async function refresh(){const request=await ops.request('NODE_CATALOG_REFRESH');assert.equal((await ops.wait(request.id)).status,'SUCCESS');}
  await refresh();
  assert.equal((await ops.node.getProvider()).catalog[0].version,version);
  await assert.rejects(ops.request('NODE_RUNTIME_INSTALL',{node:{version:'24.21.0'}}),e=>e.error_code==='NODE_RUNTIME_ARTIFACT_UNAVAILABLE');
  entry={...entry,files:[process.platform==='linux'?'darwin-x64':'linux-x64']};
  await refresh();
  await assert.rejects(ops.request('NODE_RUNTIME_INSTALL',{node:{version}}),e=>e.error_code==='NODE_RUNTIME_ARTIFACT_UNAVAILABLE');
  entry=catalogEntry(prepared);await refresh();
  const request=await ops.request('NODE_RUNTIME_INSTALL',{node:{version},timeout_seconds:120});
  assert.ok(request.id);const done=await ops.wait(request.id);assert.equal(done.status,'SUCCESS',done.error_code);
  const runtime=(await ops.node.runtimes())[0];assert.equal(runtime.version,version);assert.equal(runtime.state,'READY');
  assert.equal(runtime.metadata.platform,process.platform);assert.equal(runtime.metadata.architecture,process.arch);
  assert.equal(runtime.metadata.distribution_source,'https://nodejs.org/dist');
  const verify=await ops.request('NODE_RUNTIME_VERIFY',{node:{runtime_id:runtime.id}});
  assert.equal((await ops.wait(verify.id)).status,'SUCCESS');
});
