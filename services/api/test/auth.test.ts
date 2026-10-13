/**
 * Milestone 06: sign-in with an identity-provider ID token, device enrollment, session tokens, refresh rotation and
 * reuse detection, device revocation and sign-out, rate limits, and no tokens in logs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness, idemKey } from './helpers.ts';
import { nonce, TEST_CLIENT_ID, TEST_ISSUER } from './idp.ts';

let h: Harness;
const logLines: string[] = [];
beforeAll(async () => {
  h = await harness({ logLines });
});
afterAll(async () => {
  await h.close();
});

const enroll = (idToken: string, n: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/devices',
    payload: { id_token: idToken, nonce: n, name: 'Laptop', platform: 'windows-x64' },
  });

const refresh = (token: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/auth/token',
    payload: { grant_type: 'refresh_token', refresh_token: token },
  });

const clearLimits = () => h.owner.query('delete from rate_limit_counters');

describe('sign-in configuration', () => {
  it('publishes the identity provider settings without authentication', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/auth/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      issuer: TEST_ISSUER,
      client_id: TEST_CLIENT_ID,
      redirect_uri: 'projectbrowser://auth/callback',
      scopes: ['openid', 'email', 'profile'],
    });
  });
});

describe('device enrollment with an ID token', () => {
  it('creates the user and device and returns session tokens', async () => {
    const { session, person } = await h.signIn({ name: 'Alice Example' });
    expect(session.token_type).toBe('Bearer');
    expect(session.expires_in).toBe(600);
    expect(session.refresh_token).toMatch(/^ses_[0-9A-Z]{26}\.[A-Za-z0-9_-]{43}$/);
    expect(session.device).toMatchObject({
      name: 'Test device',
      platform: 'linux-x64',
      current: true,
      revoked_at: null,
    });
    expect(session.user).toMatchObject({
      display_name: 'Alice Example',
      email: person.email,
      email_verified: true,
    });

    const me = await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user_id: session.user.id, memberships: [] });

    // Only digests are stored.
    const { rows } = await h.owner.query('select refresh_hash from device_sessions where user_id = $1', [
      session.user.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].refresh_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(session.refresh_token.split('.')[1]);
  });

  it('matches returning people by issuer and subject, not by e-mail', async () => {
    const first = await h.signIn({ sub: 'stable-subject-1', email: 'first@people.test' });
    const again = await h.signIn({ sub: 'stable-subject-1', email: 'changed@people.test' });
    expect(again.session.user.id).toBe(first.session.user.id);
    expect(again.session.user.email).toBe('changed@people.test');
    const other = await h.signIn({ sub: 'stable-subject-2', email: 'changed@people.test' });
    expect(other.session.user.id).not.toBe(first.session.user.id);
  });

  it.each([
    ['a token for another client', { aud: 'some-other-client' }, {}],
    ['a token from another issuer', { iss: 'https://evil.example.test' }, {}],
    [
      'an expired token',
      { iat: Math.floor(Date.now() / 1000) - 4000, exp: Math.floor(Date.now() / 1000) - 3000 },
      {},
    ],
    ['a token issued too long ago', { iat: Math.floor(Date.now() / 1000) - 3000 }, {}],
    ['a token signed by another key', {}, { foreignKey: true }],
    ['an HMAC-signed token', {}, { alg: 'HS256' as const }],
    ['several audiences without our authorized party', { aud: [TEST_CLIENT_ID, 'other'] }, {}],
  ])('refuses %s', async (_label, claims, opts) => {
    await clearLimits();
    const n = nonce();
    const token = await h.idp.idToken({ sub: 'attacker', nonce: n, ...claims }, opts);
    const res = await enroll(token, n);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      code: 'UNAUTHENTICATED',
      safe_details: { reason: 'id_token_invalid' },
    });
  });

  it('refuses a nonce that does not match this sign-in', async () => {
    await clearLimits();
    const token = await h.idp.idToken({ sub: 'nonce-check', nonce: nonce() });
    const res = await enroll(token, nonce());
    expect(res.statusCode).toBe(401);
  });

  it('accepts each ID token once (replay is refused and audited)', async () => {
    await clearLimits();
    const n = nonce();
    const token = await h.idp.idToken({ sub: 'replay-check', nonce: n, email: 'replay@people.test' });
    expect((await enroll(token, n)).statusCode).toBe(201);
    const replay = await enroll(token, n);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().safe_details).toEqual({ reason: 'id_token_reused' });
    const { rows } = await h.owner.query(
      `select outcome, details from audit_events where action = 'auth.sign_in' and request_id = $1`,
      [replay.json().request_id],
    );
    expect(rows).toEqual([{ outcome: 'failed', details: { reason: 'id_token_reused' } }]);
  });

  it('refuses disabled accounts', async () => {
    const alice = await h.signIn();
    await h.owner.query('update users set disabled_at = now() where id = $1', [alice.session.user.id]);
    const me = await h.app.inject({ method: 'GET', url: '/v1/me', headers: alice.headers });
    expect(me.statusCode).toBe(401);
    expect(me.json().safe_details).toEqual({ reason: 'user_disabled' });
    await expect(h.signIn(alice.person)).rejects.toThrow(/401/);
    expect((await refresh(alice.session.refresh_token)).statusCode).toBe(401);
  });

  it('rate-limits sign-in attempts per client address', async () => {
    await clearLimits();
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const res = await enroll('x.y.z-not-a-real-token-at-all', nonce());
      last = res.statusCode;
      if (i < 30) expect(res.statusCode).toBe(401); // not a valid token, but counted
    }
    expect(last).toBe(429);
    await clearLimits();
  });
});

describe('session tokens', () => {
  it('rotate on refresh; the previous refresh token ends the session when replayed', async () => {
    await clearLimits();
    const alice = await h.signIn();
    const first = await refresh(alice.session.refresh_token);
    expect(first.statusCode).toBe(200);
    const rotated = first.json();
    expect(rotated.refresh_token).not.toBe(alice.session.refresh_token);
    expect(rotated.refresh_token.split('.')[0]).toBe(alice.session.refresh_token.split('.')[0]);
    expect(rotated.auth_time).toBe(alice.session.auth_time);

    // The old access token still names a live session; the new one works too.
    const ok = await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${rotated.access_token}` },
    });
    expect(ok.statusCode).toBe(200);

    const replay = await refresh(alice.session.refresh_token);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().safe_details).toEqual({ reason: 'session_ended' });
    // Reuse detection revoked the whole session: the current refresh token and access token stop working.
    expect((await refresh(rotated.refresh_token)).statusCode).toBe(401);
    const after = await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${rotated.access_token}` },
    });
    expect(after.statusCode).toBe(401);
    const { rows } = await h.owner.query('select revoke_reason from device_sessions where id = $1', [
      alice.session.refresh_token.split('.')[0],
    ]);
    expect(rows[0].revoke_reason).toBe('refresh_reuse');
  });

  it('refuses malformed and unknown refresh tokens with the same answer', async () => {
    await clearLimits();
    const alice = await h.signIn();
    const [sessionId] = alice.session.refresh_token.split('.');
    const wrongSecret = `${sessionId}.${'A'.repeat(43)}`;
    const unknownSession = `ses_01J9ZSEED0ZZZZ000000000000.${'A'.repeat(43)}`;
    for (const token of [wrongSecret, unknownSession]) {
      const res = await refresh(token);
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHENTICATED');
    }
    // A wrong secret does not end a live session.
    expect((await refresh(alice.session.refresh_token)).statusCode).toBe(200);
  });

  it('refuses access tokens that were tampered with or are not ours', async () => {
    const alice = await h.signIn();
    const [header, payload, signature] = alice.session.access_token.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
    const forged = [
      header,
      Buffer.from(JSON.stringify({ ...claims, sub: 'usr_01J9ZSEED0B1000000000000000' })).toString(
        'base64url',
      ),
      signature,
    ].join('.');
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
    // An ID token is not an API token.
    const n = nonce();
    const idToken = await h.idp.idToken({ sub: 'confused-deputy', nonce: n });
    const res2 = await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${idToken}` },
    });
    expect(res2.statusCode).toBe(401);
  });

  it('sign-out ends the session at the next request and keeps the device enrolled', async () => {
    await clearLimits();
    const alice = await h.signIn();
    const out = await h.app.inject({ method: 'POST', url: '/v1/auth/sign-out', headers: alice.headers });
    expect(out.statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: alice.headers })).statusCode).toBe(
      401,
    );
    expect((await refresh(alice.session.refresh_token)).statusCode).toBe(401);
    const { rows } = await h.owner.query('select revoked_at from devices where id = $1', [
      alice.session.device.id,
    ]);
    expect(rows[0].revoked_at).toBeNull();
  });

  it('signs in again on an enrolled device (id_token grant) and replaces the old session', async () => {
    await clearLimits();
    const alice = await h.signIn();
    const n = nonce();
    const idToken = await h.idp.idToken({ sub: alice.person.sub, nonce: n, email: alice.person.email });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { grant_type: 'id_token', id_token: idToken, nonce: n, device_id: alice.session.device.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().device.id).toBe(alice.session.device.id);
    expect((await refresh(alice.session.refresh_token)).statusCode).toBe(401);

    // Someone else's device id is refused like an unknown one.
    const bob = await h.signIn();
    const n2 = nonce();
    const bobToken = await h.idp.idToken({ sub: bob.person.sub, nonce: n2 });
    const steal = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { grant_type: 'id_token', id_token: bobToken, nonce: n2, device_id: alice.session.device.id },
    });
    expect(steal.statusCode).toBe(401);
    expect(steal.json().safe_details).toEqual({ reason: 'device_not_enrolled' });
    // The refused request did not use up the token: the desktop can enroll this device with it instead.
    expect((await enroll(bobToken, n2)).statusCode).toBe(201);
    expect((await enroll(bobToken, n2)).statusCode).toBe(401);
  });
});

describe('devices', () => {
  it('lists the caller’s devices and revokes one (its tokens stop at the next request)', async () => {
    await clearLimits();
    const laptop = await h.signIn();
    const n = nonce();
    const token = await h.idp.idToken({ sub: laptop.person.sub, nonce: n, email: laptop.person.email });
    const phone = (await enroll(token, n)).json();

    const list = await h.app.inject({ method: 'GET', url: '/v1/devices', headers: laptop.headers });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as { id: string; current: boolean }[];
    expect(items.map((d) => d.id).sort()).toEqual([laptop.session.device.id, phone.device.id].sort());
    expect(items.find((d) => d.id === laptop.session.device.id)?.current).toBe(true);

    const revoke = await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${phone.device.id}/revoke`,
      headers: laptop.headers,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revoked_at).not.toBeNull();

    const phoneHeaders = { authorization: `Bearer ${phone.access_token}` };
    const denied = await h.app.inject({ method: 'GET', url: '/v1/me', headers: phoneHeaders });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().safe_details).toEqual({ reason: 'device_revoked' });
    const refreshed = await refresh(phone.refresh_token);
    expect(refreshed.statusCode).toBe(401);
    expect(refreshed.json().safe_details).toEqual({ reason: 'device_revoked' });
    // The laptop keeps working.
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: laptop.headers })).statusCode).toBe(
      200,
    );
  });

  it('cannot revoke another person’s device (same answer as an unknown id)', async () => {
    const alice = await h.signIn();
    const bob = await h.signIn();
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${alice.session.device.id}/revoke`,
      headers: bob.headers,
    });
    const unknown = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/dev_01J9ZSEED0ZZZZ000000000000/revoke',
      headers: bob.headers,
    });
    expect(res.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(res.json().message).toBe(unknown.json().message);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: alice.headers })).statusCode).toBe(
      200,
    );
  });

  it('a signed-in device can only take profile leases for itself', async () => {
    const alice = await h.signIn();
    const org = await h.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: alice.headers,
      payload: { name: 'Lease device check' },
    });
    const orgId = org.json().id;
    const profile = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/profiles`,
      headers: alice.headers,
      payload: { name: 'p' },
    });
    const other = await h.signIn(alice.person); // same person, second device
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/profiles/${profile.json().id}/lease`,
      headers: { ...alice.headers, 'idempotency-key': idemKey() },
      payload: { device_id: other.session.device.id },
    });
    expect(res.statusCode).toBe(403);
    const own = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/profiles/${profile.json().id}/lease`,
      headers: { ...alice.headers, 'idempotency-key': idemKey() },
      payload: { device_id: alice.session.device.id },
    });
    expect(own.statusCode).toBe(201);
  });
});

describe('logs', () => {
  it('never contain tokens, refresh secrets or invitation tokens', async () => {
    await clearLimits();
    const alice = await h.signIn();
    const rotated = (await refresh(alice.session.refresh_token)).json();
    const org = await h.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: alice.headers,
      payload: { name: 'Log check' },
    });
    const invite = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${org.json().id}/invitations`,
      headers: alice.headers,
      payload: { email: 'someone@people.test', role: 'viewer' },
    });
    const inviteToken = invite.json().token as string;
    await h.app.inject({ method: 'GET', url: `/v1/invitations/${inviteToken}`, headers: alice.headers });
    await h.app.inject({
      method: 'POST',
      url: `/v1/invitations/${inviteToken}/accept`,
      headers: alice.headers,
    });

    const all = logLines.join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).toContain('/invitations/[redacted]');
    for (const secret of [
      alice.session.access_token,
      alice.session.refresh_token,
      alice.session.refresh_token.split('.')[1] ?? '',
      rotated.refresh_token,
      inviteToken,
    ]) {
      expect(secret.length).toBeGreaterThan(20);
      expect(all).not.toContain(secret);
    }
    // Nor in the audit trail or the outbox.
    const audit = await h.owner.query('select details::text as d, target_id from audit_events');
    const outbox = await h.owner.query('select redacted_payload::text as p from outbox_events');
    const stored = JSON.stringify([audit.rows, outbox.rows]);
    expect(stored).not.toContain(inviteToken);
    expect(stored).not.toContain(alice.session.refresh_token.split('.')[1]);
  });
});
