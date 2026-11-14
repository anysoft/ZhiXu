// S5 reruns preserved UI/domain assertions against an explicit compiled release candidate.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { authenticator } = require('@otplib/preset-default');
const { httpFixture } = require('./http-support.cjs');

test(
  'S5 invalid HTTP authentication reset leaves password, sessions and 2FA unchanged',
  { timeout: 180000 },
  async (t) => {
    const f = await httpFixture(t, 'S5-AUTH-RESET-INVALID-001'),
      r = f.request;
    const newPassword = 'S5_REJECTED_RESET_' + randomUUID();
    f.h.registerSecret(newPassword);
    for (const invalid of [
      { retries: -1 },
      { twoFactorActivated: true },
      { password: null },
      { username: null },
    ]) {
      const before = (await f.app.auth.info()).info;
      const rejected = await r('PUT', '/api/system/auth/reset', {
        password: newPassword,
        ...invalid,
      });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error_code, 'INVALID_REQUEST');
      const after = (await f.app.auth.info()).info;
      assert.equal(after.username, before.username);
      assert.equal(after.password, before.password);
      assert.equal(after.retries, before.retries);
      assert.equal(after.twoFactorActivated, before.twoFactorActivated);
      assert.equal(after.twoFactorSecret, before.twoFactorSecret);
      assert.deepEqual(after.tokens, before.tokens);
      assert.equal((await r('GET', '/api/user')).status, 200);
      assert.equal(
        (
          await r('POST', '/api/user/login', {
            username: 'owner',
            password: newPassword,
          })
        ).status,
        401,
      );
      const original = await r('POST', '/api/user/login', {
        username: 'owner',
        password: f.password,
      });
      assert.equal(original.status, 200);
      assert.ok(original.body.data.token);
      f.h.registerSecret(original.body.data.token);
      f.h.registerSecret(original.body.data.csrf_token);
      assert.equal((await r('GET', '/api/user')).status, 200);
    }
    await f.h.record('S5-AUTH-RESET-INVALID-001', {
      status: 'PASS',
      invalid_reset_http: 400,
      invalid_fields: [
        'retries',
        'twoFactorActivated',
        'password:null',
        'username:null',
      ],
      password_hash_unchanged: true,
      session_membership_unchanged: true,
      previous_session_valid: true,
      old_password_login_http: 200,
      rejected_new_password_login_http: 401,
      partial_authentication_mutation: false,
      http: f.statuses,
    });
  },
);

test(
  'S5 username-only and combined authentication reset publish coherent state and revoke every prior session',
  { timeout: 180000 },
  async (t) => {
    const f = await httpFixture(t, 'S5-AUTH-RESET-VALID-002'),
      r = f.request;
    const second = await r('POST', '/api/user/login', {
      username: 'owner',
      password: f.password,
    });
    assert.equal(second.status, 200);
    f.h.registerSecret(second.body.data.token);
    f.h.registerSecret(second.body.data.csrf_token);
    const secondHeaders = {
      Authorization: 'Bearer ' + second.body.data.token,
      'X-CSRF-Token': second.body.data.csrf_token,
    };
    assert.equal(
      (await r('GET', '/api/user', undefined, secondHeaders)).status,
      200,
    );
    const before = (await f.app.auth.info()).info;
    const renamed = await r('PUT', '/api/system/auth/reset', {
      username: 'renamed-owner',
    });
    assert.equal(renamed.status, 200);
    const renamedInfo = (await f.app.auth.info()).info;
    assert.equal(renamedInfo.username, 'renamed-owner');
    assert.equal(renamedInfo.password, before.password);
    assert.deepEqual(renamedInfo.tokens, {});
    assert.equal((await r('GET', '/api/user')).status, 401);
    assert.equal(
      (await r('GET', '/api/user', undefined, secondHeaders)).status,
      401,
    );
    assert.equal(
      (
        await r('POST', '/api/user/login', {
          username: 'owner',
          password: f.password,
        })
      ).status,
      401,
    );
    const renamedLogin = await r('POST', '/api/user/login', {
      username: 'renamed-owner',
      password: f.password,
    });
    assert.equal(renamedLogin.status, 200);
    f.h.registerSecret(renamedLogin.body.data.token);
    f.h.registerSecret(renamedLogin.body.data.csrf_token);
    const renamedSession = {
      Authorization: 'Bearer ' + renamedLogin.body.data.token,
      'X-CSRF-Token': renamedLogin.body.data.csrf_token,
    };
    const initialized = await r(
      'GET',
      '/api/user/two-factor/init',
      undefined,
      renamedSession,
    );
    assert.equal(initialized.status, 200);
    const secret = initialized.body.data.secret;
    f.h.registerSecret(secret);
    assert.equal(
      (
        await r(
          'PUT',
          '/api/user/two-factor/active',
          { code: authenticator.generate(secret) },
          renamedSession,
        )
      ).status,
      200,
    );
    const challenge = await r('POST', '/api/user/login', {
      username: 'renamed-owner',
      password: f.password,
    });
    assert.equal(challenge.body.code, 420);
    const verified = await r('PUT', '/api/user/two-factor/login', {
      username: 'renamed-owner',
      password: f.password,
      code: authenticator.generate(secret),
    });
    assert.equal(verified.status, 200);
    f.h.registerSecret(verified.body.data.token);
    f.h.registerSecret(verified.body.data.csrf_token);
    const verifiedSession = {
      Authorization: 'Bearer ' + verified.body.data.token,
      'X-CSRF-Token': verified.body.data.csrf_token,
    };
    assert.equal(
      (await r('GET', '/api/user', undefined, verifiedSession)).body.data
        .twoFactorActivated,
      true,
    );
    const newPassword = 'S5_COMBINED_RESET_' + randomUUID();
    f.h.registerSecret(newPassword);
    const combined = await r(
      'PUT',
      '/api/system/auth/reset',
      {
        username: 'final-owner',
        password: newPassword,
        retries: 0,
        twoFactorActivated: false,
      },
      verifiedSession,
    );
    assert.equal(combined.status, 200);
    const finalInfo = (await f.app.auth.info()).info;
    assert.equal(finalInfo.username, 'final-owner');
    assert.notEqual(finalInfo.password, before.password);
    assert.equal(finalInfo.retries, 0);
    assert.equal(finalInfo.twoFactorActivated, false);
    assert.equal(finalInfo.twoFactorSecret, '');
    assert.deepEqual(finalInfo.tokens, {});
    assert.equal(finalInfo.isTwoFactorChecking, false);
    assert.equal(
      (await r('GET', '/api/user', undefined, verifiedSession)).status,
      401,
    );
    assert.equal(
      (
        await r('POST', '/api/user/login', {
          username: 'renamed-owner',
          password: f.password,
        })
      ).status,
      401,
    );
    const finalLogin = await r('POST', '/api/user/login', {
      username: 'final-owner',
      password: newPassword,
    });
    assert.equal(finalLogin.status, 200);
    assert.ok(finalLogin.body.data.token);
    f.h.registerSecret(finalLogin.body.data.token);
    f.h.registerSecret(finalLogin.body.data.csrf_token);
    await f.h.record('S5-AUTH-RESET-VALID-002', {
      status: 'PASS',
      username_only_reset_http: 200,
      username_only_preserves_password: true,
      every_previous_session_revoked: true,
      combined_reset_http: 200,
      combined_credentials_and_2fa_state_coherent: true,
      real_2fa_disabled: true,
      old_credentials_login_http: 401,
      new_credentials_login_http: 200,
      http: f.statuses,
    });
  },
);
