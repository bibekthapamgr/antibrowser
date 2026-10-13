/**
 * Milestone 06 against a real identity provider: Keycloak (the reference deployment, ADR-0013) runs in CI and this
 * test performs what the desktop does — Authorization Code + PKCE with state and nonce, the login form, the redirect
 * to `projectbrowser://auth/callback`, the code exchange — and then signs in to the API with the ID token.
 *
 * Runs only when PB_KEYCLOAK_URL and PB_KEYCLOAK_ADMIN_PASSWORD are set (the CI job starts Keycloak and generates the
 * admin password). The realm, client and users are created here with random passwords: nothing secret is in the
 * repository.
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadConfig } from '@pb/config/env';
import type { Session } from '@pb/contracts';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type App, buildApp } from '../src/app.ts';
import { createPool } from '../src/db.ts';

const KC = process.env.PB_KEYCLOAK_URL ?? '';
const ADMIN_PASSWORD = process.env.PB_KEYCLOAK_ADMIN_PASSWORD ?? '';
const REDIRECT = 'projectbrowser://auth/callback';
const CLIENT = 'pb-desktop';
const b64url = (b: Buffer) => b.toString('base64url');
const random = (n = 32) => b64url(randomBytes(n));

// In CI the provider must be there: a silently skipped suite would hide a broken sign-in.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs against Keycloak in CI', () => {
  expect(KC && ADMIN_PASSWORD, 'PB_KEYCLOAK_URL / PB_KEYCLOAK_ADMIN_PASSWORD').toBeTruthy();
});

describe.skipIf(!KC || !ADMIN_PASSWORD)('Keycloak sign-in (reference identity provider)', () => {
  const realm = `pb-test-${randomBytes(4).toString('hex')}`;
  const issuer = `${KC}/realms/${realm}`;
  const people = {
    alice: { username: 'alice', email: 'alice@example.test', verified: true, password: random(18) },
    uma: { username: 'uma', email: 'uma@example.test', verified: false, password: random(18) },
  };
  let app: App;
  let pool: pg.Pool;
  let owner: pg.Pool;
  let version = 'unknown';
  let passed = 0;

  beforeAll(async () => {
    const admin = await form(`${KC}/realms/master/protocol/openid-connect/token`, {
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'admin',
      password: ADMIN_PASSWORD,
    });
    expect(admin.status).toBe(200);
    const adminToken = ((await admin.json()) as { access_token: string }).access_token;
    const created = await fetch(`${KC}/admin/realms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        realm,
        enabled: true,
        registrationAllowed: false,
        clients: [
          {
            clientId: CLIENT,
            protocol: 'openid-connect',
            publicClient: true,
            standardFlowEnabled: true,
            implicitFlowEnabled: false,
            directAccessGrantsEnabled: false,
            redirectUris: [REDIRECT],
            webOrigins: [],
            attributes: { 'pkce.code.challenge.method': 'S256' },
          },
        ],
        users: Object.values(people).map((p) => ({
          username: p.username,
          email: p.email,
          emailVerified: p.verified,
          enabled: true,
          firstName: p.username,
          lastName: 'Example',
          credentials: [{ type: 'password', value: p.password, temporary: false }],
        })),
      }),
    });
    expect(created.status).toBe(201);
    const info = await fetch(`${KC}/admin/serverinfo`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    version = ((await info.json()) as { systemInfo?: { version?: string } }).systemInfo?.version ?? 'unknown';

    const config = loadConfig({ ...process.env, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT });
    pool = createPool(config.databaseUrl, 5);
    owner = new pg.Pool({
      connectionString: process.env.MIGRATION_DATABASE_URL,
      options: '-c search_path=app',
      max: 1,
    });
    await owner.query("delete from rate_limit_counters where bucket = 'signin.ip'");
    app = await buildApp(config, pool, { logger: false });
    await app.ready();
  }, 60_000);

  afterEach((ctx) => {
    if (ctx.task.result?.state !== 'fail') passed++;
  });

  afterAll(async () => {
    // Evidence for the CI run summary: ci.yml turns this file into an annotation (and fails if it is missing).
    if (process.env.PB_KEYCLOAK_RESULT) {
      writeFileSync(
        process.env.PB_KEYCLOAK_RESULT,
        `Keycloak ${version}: ${passed} of 5 sign-in checks passed (PKCE, state, iss, nonce, one-time ID token, unverified e-mail, re-authentication)`,
      );
    }
    await app?.close();
    await pool?.end();
    await owner?.end();
  });

  /** The desktop's half of a sign-in, with a scripted browser filling in the provider's login form. */
  async function browserSignIn(
    person: (typeof people)['alice'],
    opts: { prompt?: string; cookies?: Map<string, string> } = {},
  ) {
    const state = random();
    const nonce = random(24);
    const verifier = random();
    const auth = new URL(`${issuer}/protocol/openid-connect/auth`);
    auth.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      ...(opts.prompt ? { prompt: opts.prompt, max_age: '0' } : {}),
    }).toString();
    const cookies = opts.cookies ?? new Map<string, string>();
    const page = await fetch(auth, { redirect: 'manual', headers: { cookie: cookieHeader(cookies) } });
    keepCookies(page, cookies);
    expect(page.status).toBe(200);
    const html = await page.text();
    const action = /id="kc-form-login"[^>]*action="([^"]+)"/s.exec(html)?.[1]?.replaceAll('&amp;', '&');
    expect(action, 'login form').toBeTruthy();
    const login = await fetch(action ?? '', {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: cookieHeader(cookies), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: person.username, password: person.password, credentialId: '' }),
    });
    keepCookies(login, cookies);
    expect(login.status).toBe(302);
    const callback = new URL(login.headers.get('location') ?? '');
    expect(`${callback.protocol}//${callback.host}${callback.pathname}`).toBe(REDIRECT);
    // What the desktop checks before using the code: its own state, and the provider naming itself (RFC 9207).
    expect(callback.searchParams.get('state')).toBe(state);
    expect(callback.searchParams.get('iss')).toBe(issuer);
    const code = callback.searchParams.get('code') ?? '';
    return { code, nonce, verifier, cookies };
  }

  const exchange = (code: string, verifier: string) =>
    form(`${issuer}/protocol/openid-connect/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT,
      code_verifier: verifier,
    });

  async function idTokenFor(
    person: (typeof people)['alice'],
    opts: { prompt?: string; cookies?: Map<string, string> } = {},
  ) {
    const s = await browserSignIn(person, opts);
    const res = await exchange(s.code, s.verifier);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id_token: string };
    return { idToken: body.id_token, nonce: s.nonce, cookies: s.cookies };
  }

  const enroll = (idToken: string, nonce: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/devices',
      payload: { id_token: idToken, nonce, name: 'CI device', platform: 'linux-x64' },
    });

  it('signs in with Authorization Code + PKCE, enrolls the device and creates an organization', async () => {
    const { idToken, nonce } = await idTokenFor(people.alice);
    const res = await enroll(idToken, nonce);
    expect(res.statusCode, res.body).toBe(201);
    const session = res.json() as Session;
    expect(session.user).toMatchObject({ email: 'alice@example.test', email_verified: true });
    const headers = { authorization: `Bearer ${session.access_token}` };
    const org = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers,
      payload: { name: 'Keycloak Org' },
    });
    expect(org.statusCode).toBe(201);
    const { rows } = await owner.query('select oidc_issuer from users where id = $1', [session.user.id]);
    expect(rows[0].oidc_issuer).toBe(issuer);
    // The same ID token cannot start a second session.
    expect((await enroll(idToken, nonce)).statusCode).toBe(401);
    // Nor with another nonce than the one the desktop generated for it.
    const other = await idTokenFor(people.alice);
    expect((await enroll(other.idToken, random(24))).statusCode).toBe(401);
  });

  it('the provider refuses a wrong PKCE verifier and a reused code', async () => {
    const s = await browserSignIn(people.alice);
    const wrong = await exchange(s.code, random());
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_grant');
    const s2 = await browserSignIn(people.alice);
    expect((await exchange(s2.code, s2.verifier)).status).toBe(200);
    expect((await exchange(s2.code, s2.verifier)).status).toBe(400);
  });

  it('the provider refuses requests without PKCE or with an unregistered redirect', async () => {
    const noPkce = new URL(`${issuer}/protocol/openid-connect/auth`);
    noPkce.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: random(),
    }).toString();
    const res = await fetch(noPkce, { redirect: 'manual' });
    if (res.status === 302) {
      expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_request');
    } else {
      expect(res.status).toBe(400);
    }

    const evil = new URL(`${issuer}/protocol/openid-connect/auth`);
    evil.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: 'https://evil.example.test/callback',
      scope: 'openid',
      state: random(),
      code_challenge: b64url(createHash('sha256').update(random()).digest()),
      code_challenge_method: 'S256',
    }).toString();
    const refused = await fetch(evil, { redirect: 'manual' });
    expect(refused.status).toBe(400);
    expect(refused.headers.get('location') ?? '').not.toContain('evil.example.test');
  });

  it('an unverified e-mail address cannot create organizations', async () => {
    const { idToken, nonce } = await idTokenFor(people.uma);
    const res = await enroll(idToken, nonce);
    expect(res.statusCode).toBe(201);
    const session = res.json() as Session;
    expect(session.user.email_verified).toBe(false);
    const org = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { authorization: `Bearer ${session.access_token}` },
      payload: { name: 'Nope' },
    });
    expect(org.json().code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('a fresh login (prompt=login) re-authenticates the enrolled device', async () => {
    const first = await idTokenFor(people.alice);
    const enrolled = (await enroll(first.idToken, first.nonce)).json() as Session;
    // With the provider's session cookie a normal request would sign in silently; prompt=login shows the form again.
    const again = await idTokenFor(people.alice, { prompt: 'login', cookies: first.cookies });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: {
        grant_type: 'id_token',
        id_token: again.idToken,
        nonce: again.nonce,
        device_id: enrolled.device.id,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const session = res.json() as Session;
    expect(session.device.id).toBe(enrolled.device.id);
    expect(Date.parse(session.auth_time)).toBeGreaterThanOrEqual(Date.parse(enrolled.auth_time));
  });
});

function form(url: string, fields: Record<string, string>) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

function keepCookies(res: Response, jar: Map<string, string>) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair?.indexOf('=') ?? -1;
    if (pair && i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
