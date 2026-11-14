'use strict';
const path = require('node:path');

function releaseArguments(environment, args) {
  if (args.some((argument) => argument !== '--initialize') || args.length > 1)
    throw Error('V2_RELEASE_ARGUMENT_INVALID');
  for (const key of ['ZHIXU_V2_DATA_ROOT', 'ZHIXU_V2_BACKUP_ROOT']) {
    const value = environment[key];
    if (
      !value ||
      !path.isAbsolute(value) ||
      path.resolve(value) !== value ||
      value === '/'
    )
      throw Error('V2_RELEASE_STORAGE_ROOT_REQUIRED');
  }
  const origin = environment.ZHIXU_V2_PUBLIC_ORIGIN;
  if (!origin) throw Error('V2_RELEASE_PUBLIC_ORIGIN_REQUIRED');
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw Error('V2_RELEASE_PUBLIC_ORIGIN_INVALID');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password
  )
    throw Error('V2_RELEASE_PUBLIC_ORIGIN_INVALID');
  return [
    '--data-root',
    environment.ZHIXU_V2_DATA_ROOT,
    '--backup-root',
    environment.ZHIXU_V2_BACKUP_ROOT,
    '--host',
    '0.0.0.0',
    '--port',
    '5600',
    '--frontend-root',
    '/app/static/dist-v2',
    '--public-origin',
    origin,
    ...args,
  ];
}

function main() {
  if (process.getuid?.() === 0) throw Error('V2_RELEASE_NON_ROOT_REQUIRED');
  const entry = '/app/static/build/appV2.js';
  process.argv = [
    process.execPath,
    entry,
    ...releaseArguments(process.env, process.argv.slice(2)),
  ];
  // The real CLI retains signal handlers and the backend FD owner in this process.
  // No root, HOME, credential or JWT file is created by the release wrapper.
  require(entry);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        event: 'V2_RELEASE_STARTUP_FAILED',
        error_code: /^V2_RELEASE_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'V2_RELEASE_STARTUP_REJECTED',
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
module.exports = { releaseArguments };
