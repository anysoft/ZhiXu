const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { authenticator } = require('@otplib/preset-default');
const { httpFixture } = require('./http-support.cjs');

test('S4 actual 2FA HTTP activation fences a session commit that captured the previous authentication configuration', async (t) => {
  const f = await httpFixture(t, 'S4-AUTH-CONFIG-CAS-003');
  const before = (await f.app.auth.info()).info;
  assert.equal(before.twoFactorActivated, false);
  const initialized = await f.request('GET', '/api/user/two-factor/init');
  assert.equal(initialized.status, 200);
  const secret = initialized.body.data.secret;
  f.h.registerSecret(secret);
  assert.equal(
    (
      await f.request('PUT', '/api/user/two-factor/active', {
        code: authenticator.generate(secret),
      })
    ).status,
    200,
  );
  // Exercise the real commit boundary deterministically with the previous DB
  // snapshot. HTTP responses, passwords, JWT validation and rows are unmodified.
  await assert.rejects(
    f.app.auth.issue(before, 'desktop'),
    (error) => error.error_code === 'AUTHENTICATION_REQUIRED',
  );
  const current = (await f.app.auth.info()).info;
  assert.equal(current.twoFactorActivated, true);
  assert.deepEqual(current.tokens, {});
  await f.h.record('S4-AUTH-CONFIG-CAS-003', {
    status: 'PASS',
    actual_http_2fa_activation: true,
    previous_auth_configuration_session_commit_rejected: true,
    revoked_sessions_stay_revoked: true,
    scope:
      'real HTTP activation plus deterministic actual authentication transaction commit boundary',
  });
});

test(
  'S4 retained account and settings HTTP validates DTOs, proxy trust and session revocation',
  { timeout: 120000 },
  async (t) => {
    const f = await httpFixture(t, 'S4-AUTH-SETTINGS-001'),
      r = f.request;
    const initial = await r('GET', '/api/system/config');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.data.info.timezone, 'UTC');
    assert.equal(
      (await r('PUT', '/api/system/config/lang', { lang: 'zh-CN' })).status,
      200,
    );
    assert.equal(
      (await r('PUT', '/api/system/config/lang', { lang: 'arbitrary' })).status,
      400,
    );
    assert.equal(
      (
        await r('PUT', '/api/system/config/lang', {
          lang: 'en-US',
          unknown: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await r('PUT', '/api/system/config/timezone', {
          timezone: 'Invalid/Zone',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await r('PUT', '/api/system/config/timezone', {
          timezone: 'Asia/Singapore',
        })
      ).status,
      200,
    );
    assert.equal(
      (await r('PUT', '/api/system/client-ip/config', { trustProxy: '999' }))
        .status,
      400,
    );
    const direct = await r('GET', '/api/system/client-ip/diagnose', undefined, {
      'X-Forwarded-For': '203.0.113.7',
    });
    assert.equal(direct.status, 200);
    assert.equal(direct.body.data.clientIp, '127.0.0.1');
    assert.equal(
      (await r('PUT', '/api/system/client-ip/config', { trustProxy: '1' }))
        .status,
      200,
    );
    const proxied = await r(
      'GET',
      '/api/system/client-ip/diagnose',
      undefined,
      { 'X-Forwarded-For': '203.0.113.7' },
    );
    assert.equal(proxied.status, 200);
    assert.equal(proxied.body.data.clientIp, '203.0.113.7');
    assert.equal(
      (await r('PUT', '/api/system/client-ip/config', { trustProxy: 'false' }))
        .status,
      200,
    );
    assert.equal(
      (await r('PUT', '/api/user', { username: 'owner', password: 'admin' }))
        .status,
      400,
    );
    assert.equal(
      (
        await r('PUT', '/api/system/auth/reset', {
          username: 'owner',
          password: null,
        })
      ).status,
      400,
    );
    const newPassword = 'S4_REVOKE_' + randomUUID();
    f.h.registerSecret(newPassword);
    assert.equal(
      (
        await r('PUT', '/api/user', {
          username: 'renamed-owner',
          password: newPassword,
        })
      ).status,
      200,
    );
    assert.equal((await r('GET', '/api/user')).status, 401);
    assert.equal(
      (
        await r('POST', '/api/user/login', {
          username: 'owner',
          password: f.password,
        })
      ).status,
      401,
    );
    const login = await r('POST', '/api/user/login', {
      username: 'renamed-owner',
      password: newPassword,
    });
    assert.equal(login.status, 200);
    const { token, csrf_token } = login.body.data;
    f.h.registerSecret(token);
    f.h.registerSecret(csrf_token);
    const session = {
      Authorization: 'Bearer ' + token,
      'X-CSRF-Token': csrf_token,
    };
    assert.equal(
      (
        await r('GET', '/api/user', undefined, {
          ...session,
          Authorization: 'Bearer mobile-' + token,
        })
      ).status,
      401,
    );
    const profile = await r('GET', '/api/user', undefined, session);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.data.username, 'renamed-owner');
    for (const key of ['password', 'twoFactorSecret', 'tokens', 'secret'])
      assert.equal(key in profile.body.data, false);
    const settings = await r('GET', '/api/system/config', undefined, session);
    assert.equal(settings.body.data.info.lang, 'zh-CN');
    assert.equal(settings.body.data.info.timezone, 'Asia/Singapore');
    assert.equal(
      (await r('POST', '/api/user/logout', {}, session)).status,
      200,
    );
    assert.equal((await r('GET', '/api/user', undefined, session)).status, 401);
    await f.h.record('S4-AUTH-SETTINGS-001', {
      status: 'PASS',
      profile_change_revokes_sessions: true,
      old_credentials_rejected: true,
      weak_default_password_rejected: true,
      logout_revokes_session: true,
      platform_membership_enforced: true,
      trust_proxy_opt_in: true,
      settings_dto_unknown_fields_rejected: true,
      http: f.statuses,
    });
  },
);

test(
  'S4 retained 2FA HTTP revokes prior sessions and admits a one-time code once under concurrent replay',
  { timeout: 120000 },
  async (t) => {
    const f = await httpFixture(t, 'S4-AUTH-2FA-002'),
      r = f.request;
    assert.equal(
      (
        await r('GET', '/api/user/two-factor/init', undefined, {
          Authorization: '',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await r('GET', '/api/user/two-factor/init', undefined, {
          'X-CSRF-Token': 'wrong',
        })
      ).status,
      403,
    );
    const initialized = await r('GET', '/api/user/two-factor/init');
    assert.equal(initialized.status, 200);
    const secret = initialized.body.data.secret;
    f.h.registerSecret(secret);
    assert.equal(
      (
        await r('PUT', '/api/user/two-factor/active', {
          code: authenticator.generate(secret),
        })
      ).status,
      200,
    );
    assert.equal((await r('GET', '/api/user')).status, 401);
    const challenge = await r('POST', '/api/user/login', {
      username: 'owner',
      password: f.password,
    });
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body.code, 420);
    assert.equal(challenge.body.error_code, 'TWO_FACTOR_REQUIRED');
    assert.equal('data' in challenge.body, false);
    const code = authenticator.generate(secret);
    const replies = await Promise.all(
      [1, 2].map(() =>
        r('PUT', '/api/user/two-factor/login', {
          username: 'owner',
          password: f.password,
          code,
        }),
      ),
    );
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 401]);
    const login = replies.find((reply) => reply.status === 200).body.data;
    f.h.registerSecret(login.token);
    f.h.registerSecret(login.csrf_token);
    const session = {
      Authorization: 'Bearer ' + login.token,
      'X-CSRF-Token': login.csrf_token,
    };
    const current = await r('GET', '/api/user', undefined, session);
    assert.equal(current.status, 200);
    assert.equal(current.body.data.twoFactorActivated, true);
    assert.equal(JSON.stringify(current.body).includes(secret), false);
    const newChallenge = await r('POST', '/api/user/login', {
      username: 'owner',
      password: f.password,
    });
    assert.equal(newChallenge.body.code, 420);
    assert.equal(
      (
        await r('PUT', '/api/user/two-factor/login', {
          username: 'owner',
          password: f.password,
          code,
        })
      ).status,
      401,
    );
    assert.equal(
      (await r('PUT', '/api/user/two-factor/deactivate', {}, session)).status,
      200,
    );
    assert.equal((await r('GET', '/api/user', undefined, session)).status, 401);
    const ordinaryLogin = await r('POST', '/api/user/login', {
      username: 'owner',
      password: f.password,
    });
    assert.equal(ordinaryLogin.status, 200);
    assert.ok(ordinaryLogin.body.data.token);
    f.h.registerSecret(ordinaryLogin.body.data.token);
    await f.h.record('S4-AUTH-2FA-002', {
      status: 'PASS',
      actual_totp: true,
      old_sessions_revoked_on_activate: true,
      concurrent_same_code_statuses: [200, 401],
      replay_after_new_challenge_status: 401,
      deactivate_revokes_session: true,
      secret_not_in_current_profile: true,
      http: f.statuses,
    });
  },
);
