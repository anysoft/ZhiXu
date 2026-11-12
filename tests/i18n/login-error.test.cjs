'use strict';
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  ts = require('typescript');
const {
  translateError,
  setLanguagePreference,
} = require('../../src/utils/i18n.ts');
// Execute the production method body with isolated auth storage and notifications.
const source = ts.createSourceFile(
  'user.ts',
  fs.readFileSync('back/services/user.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
let method;
function visit(n) {
  if (ts.isMethodDeclaration(n) && n.name.getText(source) === 'authenticate')
    method = n;
  ts.forEachChild(n, visit);
}
visit(source);
const code = ts.transpileModule(
  'exports.authenticate=async function(payloads,req,needTwoFactor=true)' +
    method.body.getText(source),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;
async function rejectedLogin(username, retries = 0) {
  const exports = {},
    updates = [],
    logs = [];
  vm.runInNewContext(code, {
    exports,
    Date,
    Math,
    isDefaultAuthInfo: () => false,
    getClientIp: () => '',
    IP2Region: class {
      search() {
        return null;
      }
    },
    verifyPassword: async () => false,
    dayjs: () => ({ format: () => '' }),
    t: (v) => v,
    tf: (v) => v,
    AuthDataType: { loginLog: 'loginLog' },
    LoginStatus: { fail: 'fail' },
  });
  const context = {
    getAuthInfo: async () => ({
      username: 'admin-user',
      password: 'hash',
      retries,
      lastlogon: Date.now(),
    }),
    updateAuthInfo: async (...a) => updates.push(a),
    notificationService: { notify: () => {} },
    insertDb: async (a) => logs.push(a),
    getLoginLog: () => {},
  };
  return {
    response: await exports.authenticate.call(
      context,
      { username, password: 'incorrect' },
      { platform: 'desktop' },
    ),
    updates,
    logs,
  };
}
test('wrong username and wrong password return the same stable localized error and retain failure accounting', async () => {
  for (const username of ['admin-user', 'missing-user']) {
    const { response, updates, logs } = await rejectedLogin(username);
    assert.equal(response.code, 400);
    assert.equal(response.error_code, 'AUTH_INVALID_CREDENTIALS');
    assert.equal(updates[0][1].retries, 1);
    assert.equal(logs.length, 1);
    setLanguagePreference('zh-CN');
    assert.equal(translateError(response.error_code), '账号或密码错误，请重试');
    setLanguagePreference('en-US');
    assert.equal(
      translateError(response.error_code),
      'Incorrect username or password. Please try again.',
    );
  }
});
test('login throttling remains distinct from invalid credentials', async () => {
  const { response, updates } = await rejectedLogin('admin-user', 3);
  assert.equal(response.code, 410);
  assert.ok(response.data > 0);
  assert.equal(response.error_code, undefined);
  assert.equal(updates.length, 0);
});
