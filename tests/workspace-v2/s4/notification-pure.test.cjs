const test = require('node:test'),
  assert = require('node:assert/strict'),
  { spawnSync } = require('node:child_process');
test('S4 notification adapter import has no legacy DB/cache/logger/global utility dependency and parsers retain behavior', () => {
  const script =
    'require("./back/applicationV2/notificationApi");const keys=Object.keys(require.cache),blocked=["/back/data/index.ts","/back/services/user.ts","/back/shared/store.ts","/back/config/util.ts","/back/loaders/logger.ts"];if(blocked.some(s=>keys.some(k=>k.endsWith(s))))throw Error("LEGACY_MODULE_LOADED");process.stdout.write("ISOLATED_IMPORT_PASS\\n");';
  const child = spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-e', script],
    {
      cwd: require('node:path').resolve(__dirname, '../../..'),
      env: { ...process.env, QL_DATA_DIR: '/dev/null' },
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0);
  assert.match(child.stdout, /ISOLATED_IMPORT_PASS/);
  const pure = require('../../../back/shared/notificationPayload'),
    legacy = require('../../../back/config/util');
  assert.equal(legacy.parseBody, pure.parseBody);
  assert.equal(legacy.parseHeaders, pure.parseHeaders);
  assert.deepEqual(pure.parseHeaders('X-Header: one\nX-Header: two'), {
    'x-header': 'one, two',
  });
  assert.deepEqual(
    pure.parseBody(
      'title: $title\ncount: 2\nok: true',
      'application/json',
      (value) => value.replace('$title', 'Actual'),
    ),
    { title: 'Actual', count: 2, ok: true },
  );
  assert.equal(
    pure.parseBody('$title', 'text/plain', (value) =>
      value.replace('$title', 'Actual'),
    ),
    'Actual',
  );
});
