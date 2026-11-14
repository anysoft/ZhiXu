// Explicit operator-controlled qualification input. Never imports trust from a
// package or changes process.env; an absent file keeps the ordinary configuration.
const fs = require('node:fs');
const path = require('node:path');
const MANAGED_NODE_VERSION = '24.22.3';
const MANAGED_TSX_VERSION = '4.23.15';
function runtimeArtifactOptions() {
  const file = process.env.ZHIXU_S5R_RUNTIME_ARTIFACT_CONFIG;
  if (!file) return undefined;
  if (
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    fs.realpathSync(file) !== file
  )
    throw Error('S5R_EXPLICIT_ARTIFACT_CONFIG_REQUIRED');
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 65536 ||
    stat.mode & 0o022 ||
    (process.getuid && ![0, process.getuid()].includes(stat.uid))
  )
    throw Error('S5R_ARTIFACT_CONFIG_UNPROTECTED');
  const options = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = ['mode', 'storeRoot', 'trustAnchorPath', 'manifestPath'];
  if (
    !options ||
    Object.keys(options).sort().join(',') !== [...keys].sort().join(',') ||
    !['ONLINE_VERIFIED', 'OFFLINE_VERIFIED'].includes(options.mode) ||
    keys
      .slice(1)
      .some(
        (k) =>
          typeof options[k] !== 'string' ||
          !path.isAbsolute(options[k]) ||
          path.resolve(options[k]) !== options[k],
      )
  )
    throw Error('S5R_ARTIFACT_CONFIG_INVALID');
  return Object.freeze({ ...options });
}
function runtimeArtifactCliArguments() {
  const options = runtimeArtifactOptions();
  if (!options) return [];
  return [
    '--runtime-artifact-mode',
    options.mode,
    '--runtime-artifact-store',
    options.storeRoot,
    '--runtime-artifact-trust-anchor',
    options.trustAnchorPath,
    '--runtime-artifact-manifest',
    options.manifestPath,
  ];
}
module.exports = {
  runtimeArtifactOptions,
  runtimeArtifactCliArguments,
  MANAGED_NODE_VERSION,
  MANAGED_TSX_VERSION,
};
