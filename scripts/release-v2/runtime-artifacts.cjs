'use strict';
const fs = require('node:fs');
const path = require('node:path');
async function main(args = process.argv.slice(2)) {
  if (args.shift() !== 'import')
    throw Error('RUNTIME_ARTIFACT_IMPORT_ARGUMENT_INVALID');
  const values = Object.create(null);
  const allowed = [
    '--data-root',
    '--package',
    '--runtime-artifact-mode',
    '--runtime-artifact-store',
    '--runtime-artifact-trust-anchor',
    '--runtime-artifact-manifest',
  ];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !allowed.includes(key) ||
      values[key] ||
      !value ||
      (!path.isAbsolute(value) && key !== '--runtime-artifact-mode')
    )
      throw Error('RUNTIME_ARTIFACT_IMPORT_ARGUMENT_INVALID');
    values[key] = value;
  }
  if (
    allowed.some((key) => !values[key]) ||
    !['ONLINE_VERIFIED', 'OFFLINE_VERIFIED'].includes(
      values['--runtime-artifact-mode'],
    )
  )
    throw Error('RUNTIME_ARTIFACT_IMPORT_ARGUMENT_INVALID');
  const root = path.resolve(__dirname, '../..');
  const guard = require(path.join(
    root,
    'static/build/applicationV2/backendNode.js',
  ));
  guard.assertV2BackendNode(process.versions.node);
  const { VerifiedRuntimeArtifactStore } = require(path.join(
    root,
    'static/build/services/runtimeArtifacts.js',
  ));
  const store = await VerifiedRuntimeArtifactStore.open(
    {
      mode: values['--runtime-artifact-mode'],
      storeRoot: values['--runtime-artifact-store'],
      trustAnchorPath: values['--runtime-artifact-trust-anchor'],
      manifestPath: values['--runtime-artifact-manifest'],
    },
    values['--data-root'],
  );
  const receipt = await store.importPackage(values['--package']);
  process.stdout.write(
    JSON.stringify({ event: 'RUNTIME_ARTIFACT_IMPORT_COMPLETE', ...receipt }) +
      '\n',
  );
}
if (require.main === module)
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        event: 'RUNTIME_ARTIFACT_IMPORT_FAILED',
        error_code: /^RUNTIME_ARTIFACT_[A-Z_]+$/.test(error.error_code || '')
          ? error.error_code
          : 'RUNTIME_ARTIFACT_IMPORT_REJECTED',
      }) + '\n',
    );
    process.exitCode = 1;
  });
module.exports = { main };
