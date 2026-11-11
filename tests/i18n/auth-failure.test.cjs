'use strict';
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const {
  authFailureMessage,
  unauthorizedDecision,
} = require('../../src/utils/authFailure.ts');
const jwt = (exp) =>
  'eyJhbGciOiJIUzM4NCJ9.' +
  Buffer.from(JSON.stringify({ exp })).toString('base64url') +
  '.signature';
const base = {
  pathname: '/dashboard',
  publicRequest: false,
  loginRequest: false,
  requestToken: null,
  currentToken: null,
};
test('401 wording distinguishes missing, expired and rejected credentials', () => {
  assert.equal(authFailureMessage(null), 'ui.auth.loginRequired');
  assert.equal(authFailureMessage(jwt(10), 10000), 'ui.auth.expired');
  assert.equal(authFailureMessage(jwt(11), 10000), 'ui.auth.invalid');
  for (const token of ['broken', 'a.%%%.c', jwt('10')])
    assert.equal(authFailureMessage(token, 10000), 'ui.auth.invalid');
});
test('initialization never reports expired sessions or redirects on 401', () => {
  for (const token of [null, 'broken', jwt(1)])
    for (const loginRequest of [false, true])
      assert.equal(
        unauthorizedDecision({
          ...base,
          pathname: '/initialization',
          requestToken: token,
          currentToken: token,
          loginRequest,
        }),
        null,
      );
});
test('login rejection preserves existing session and background requests stay quiet', () => {
  assert.deepEqual(
    unauthorizedDecision({
      ...base,
      pathname: '/login',
      publicRequest: true,
      loginRequest: true,
      currentToken: 'existing',
    }),
    { reason: 'ui.auth.loginRejected', clear: false, redirect: false },
  );
  assert.equal(unauthorizedDecision({ ...base, pathname: '/login' }), null);
  assert.equal(unauthorizedDecision({ ...base, publicRequest: true }), null);
  assert.deepEqual(unauthorizedDecision(base), {
    reason: 'ui.auth.loginRequired',
    clear: false,
    redirect: true,
  });
});
test('stale 401 cannot clear a new login or duplicate a handled session failure', () => {
  assert.equal(
    unauthorizedDecision({ ...base, requestToken: 'old', currentToken: 'new' }),
    null,
  );
  assert.equal(
    unauthorizedDecision({ ...base, pathname: '/login', requestToken: 'old' }),
    null,
  );
  assert.deepEqual(
    unauthorizedDecision({
      ...base,
      requestToken: 'invalid',
      currentToken: 'invalid',
    }),
    { reason: 'ui.auth.invalid', clear: true, redirect: true },
  );
});

test('actual Axios interceptor suppresses initialization and protects a newer login', async () => {
  const ts = require('typescript'),
    vm = require('node:vm'),
    fs = require('node:fs');
  let rejected, fulfilled, sent;
  const tokens = new Map(),
    notices = [],
    redirects = [];
  const browser = { location: { pathname: '/initialization' } };
  const axios = {
    create: () => ({
      interceptors: {
        request: {
          use: (f) => {
            sent = f;
          },
        },
        response: {
          use: (ok, fail) => {
            fulfilled = ok;
            rejected = fail;
          },
        },
      },
    }),
  };
  const mocks = {
    './i18n': { t: (key) => key, translateError: (key) => key },
    './authFailure': require('../../src/utils/authFailure.ts'),
    './config': { baseUrl: '/', authKey: 'token' },
    './httpError': { getErrorDetails: () => [] },
    '@umijs/max': {
      history: {
        push: (p) => {
          redirects.push(p);
          browser.location.pathname = p;
        },
      },
    },
    antd: {
      message: { config: () => {}, error: (v) => notices.push(v) },
      notification: { error: (v) => notices.push(v) },
    },
    axios,
  };
  const code = ts.transpileModule(
    fs.readFileSync('src/utils/http.tsx', 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    exports: {},
    require: (n) => mocks[n],
    window: browser,
    localStorage: {
      getItem: (k) => tokens.get(k) || null,
      removeItem: (k) => tokens.delete(k),
    },
  });
  const failure = (config) =>
    rejected({ response: { status: 401, data: {} }, config });
  await assert.rejects(failure({ url: '/api/user', headers: {} }));
  assert.equal(notices.length, 0);
  assert.equal(redirects.length, 0);
  browser.location.pathname = '/dashboard';
  tokens.set('token', 'old');
  const request = sent({ url: '/api/user', headers: {} });
  assert.equal(request.headers.Authorization, 'Bearer old');
  tokens.set('token', 'new');
  await assert.rejects(failure(request));
  assert.equal(tokens.get('token'), 'new');
  assert.equal(notices.length, 0);
  tokens.set('token', 'old');
  await assert.rejects(failure(request));
  assert.equal(tokens.has('token'), false);
  assert.equal(notices[0].content, 'ui.auth.invalid');
  assert.deepEqual(redirects, ['/login']);
  await assert.rejects(failure(request));
  assert.equal(notices.length, 1);
  await fulfilled({
    status: 401,
    config: { url: '/api/user/login', headers: {} },
  });
  assert.equal(notices.at(-1).content, 'ui.auth.loginRejected');
});
