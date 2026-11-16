// Reuse verified official distributions; all HTTP, DB, dependency builds and UI are real.
require('../../tests/phase6/browser-provider.cjs');
const fs=require('node:fs/promises'),path=require('node:path');
const Python=require('../../static/build/services/pyenvProvider').default;
Python.prototype.catalog=async()=>['3.13.15'];
Python.prototype.install=async function(ctx,runtime){const manifest=require(path.join(process.env.QL_MANAGED_DIR||__dirname,'managed-runtime/result.json'));if(manifest.status!=='PASS'||runtime.version!=='3.13.15')throw Error('Official CPython artifact required');const target=await this.paths.createInstallation(runtime.version,runtime.id,ctx.providerId);await fs.cp(path.join(manifest.root,'runtime/python/pyenv/versions',runtime.version),target,{recursive:true,verbatimSymlinks:true});return this.verify(ctx,runtime,true);};
const { manifestFile, catalogEntry } = require('./node-catalog-fixture.cjs');
const manifest = require(manifestFile());
const Node = require('../../static/build/services/nodeDistributionProvider').default;
Node.prototype.catalog = async () => [catalogEntry(manifest)];
// Installation retains the real checksum/extraction/verification implementation.
const modulePath=require.resolve('../../static/build/services/runtimeOperations'),Base=require(modulePath).default;
require.cache[modulePath].exports.default=class BrowserOperations extends Base{constructor(provider,references){super(provider,references,process.env.QL_PHASE7_TEST_INDEX,{registry:process.env.QL_PHASE8_TEST_REGISTRY});}};
