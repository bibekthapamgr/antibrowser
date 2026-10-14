/**
 * R2 web portal session (backend-for-frontend, ADR-0021) against a local identity provider over HTTP: Authorization
 * Code + PKCE with state and nonce run by the API, an opaque HttpOnly cookie (no token in the browser), CSRF token
 * and Origin checks on changes, deny-by-default routes, a new session id at sign-in and after a privilege change,
 * sign-out of one browser and "sign out everywhere", and the same account as the desktop.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdTokenVerifier } from '../src/oidc.ts';
import { type Harness, harness } from './helpers.ts';

const ORIGIN = 'http://127.0.0.1:8080';
const WEB_CLIENT = 'pb-web-test';
const DESKTOP_CLIENT = 'pb-desktop-web-test';
const TERMS = '2026-10-14';

let h: Harness;
let idp: Server;
let issuer = '';
let sign: (claims: Record<string, unknown>, aud: string) => Promise<string>;
/** code -> what the provider issues for it (registered when the "person" signs in at the provider). */
const codes = new Map<
  string,
  { sub: string; email: string; nonce: string; challenge: string; verified: boolean }
>();
const tokenRequests: URLSearchParams[] = [];
const logLines: string[] = [];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${issuer}/protocol/openid-connect/token`,
          jwks_uri: `${issuer}/protocol/openid-connect/certs`,
        }),
      );
      return;
    }
    if (url.pathname.endsWith('/token') && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      tokenRequests.push(form);
      const grant = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      res.setHeader('content-type', 'application/json');
      if (!grant || grant.challenge !== challenge || form.get('client_id') !== WEB_CLIENT) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const idToken = await sign(
        {
          sub: grant.sub,
          email: grant.email,
          email_verified: grant.verified,
          nonce: grant.nonce,
          name: 'Web Person',
        },
        WEB_CLIENT,
      );
      res.end(JSON.stringify({ id_token: idToken, access_token: 'unused', token_type: 'Bearer' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/realms/pb`;
  sign = async (claims, aud) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: issuer,
      aud,
      iat: now,
      exp: now + 300,
      auth_time: now,
      jti: randomBytes(6).toString('hex'),
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .sign(pair.privateKey);
  };
  const keys = createLocalJWKSet({ keys: [jwk] });
  h = await harness({
    logLines,
    env: {
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: DESKTOP_CLIENT,
      OIDC_WEB_CLIENT_ID: WEB_CLIENT,
      WEB_ORIGIN: ORIGIN,
      TERMS_VERSION: TERMS,
      WEB_DIR: new URL('../../../apps/web-portal/public', import.meta.url).pathname,
      // R2: e-mail is set up, so invitations and welcomes are queued (as the application role).
      EMAIL_TASK_KEY: randomBytes(32).toString('base64'),
    },
    idTokens: createIdTokenVerifier({ issuer, clientId: DESKTOP_CLIENT, allowLoopbackHttp: true, keys }),
    webIdTokens: createIdTokenVerifier({ issuer, clientId: WEB_CLIENT, allowLoopbackHttp: true, keys }),
  });
});
afterAll(async () => {
  if (process.env.PB_DEBUG_LOG)
    (await import('node:fs')).writeFileSync(process.env.PB_DEBUG_LOG, logLines.join(''));
  await h.close();
  await new Promise((r) => idp.close(r));
});

const cookieOf = (setCookie: string | string[] | undefined) => {
  const line = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return { line: line ?? '', value: /^pb_web=([^;]*)/.exec(line ?? '')?.[1] ?? '' };
};

/** The whole portal sign-in as a browser does it; returns the cookie value and where it landed. */
async function webSignIn(person: { sub: string; email: string; verified?: boolean }, query = '') {
  await h.owner.query("delete from rate_limit_counters where bucket in ('web.signin.ip', 'signin.ip')");
  const start = await h.app.inject({ method: 'GET', url: `/v1/web/auth/login${query}` });
  expect(start.statusCode, start.body).toBe(302);
  const to = new URL(start.headers.location as string);
  const q = to.searchParams;
  const code = randomBytes(16).toString('base64url');
  codes.set(code, {
    sub: person.sub,
    email: person.email,
    verified: person.verified ?? true,
    nonce: q.get('nonce') ?? '',
    challenge: q.get('code_challenge') ?? '',
  });
  const back = await h.app.inject({
    method: 'GET',
    url: `/v1/web/auth/callback?code=${code}&state=${q.get('state')}&iss=${encodeURIComponent(issuer)}`,
  });
  return { start: to, back, cookie: cookieOf(back.headers['set-cookie']) };
}

const withCookie = (cookie: string, extra: Record<string, string> = {}) => ({
  cookie: `pb_web=${cookie}`,
  ...extra,
});
async function session(cookie: string) {
  const res = await h.app.inject({ method: 'GET', url: '/v1/web/auth/session', headers: withCookie(cookie) });
  return res;
}
const person = () => {
  const tag = randomBytes(5).toString('hex');
  return { sub: `web-${tag}`, email: `${tag}@web.test` };
};

describe('sign-in through the API (no token reaches the browser)', () => {
  it('redirects with PKCE S256, state, nonce and the exact redirect address; signup asks the provider to register', async () => {
    const { start, back, cookie } = await webSignIn(
      person(),
      '?mode=signup&return_to=%2Fapp%2F%23%2Fwelcome',
    );
    expect(start.origin + start.pathname).toBe(`${issuer}/protocol/openid-connect/auth`);
    const q = start.searchParams;
    expect(q.get('client_id')).toBe(WEB_CLIENT);
    expect(q.get('redirect_uri')).toBe(`${ORIGIN}/v1/web/auth/callback`);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('prompt')).toBe('create');
    expect(q.get('state')?.length).toBeGreaterThanOrEqual(43);
    expect(q.get('nonce')?.length).toBeGreaterThanOrEqual(43);
    // The provider got the verifier from the API (server side), never from the browser.
    expect(tokenRequests.at(-1)?.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);

    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(`${ORIGIN}/app/#/welcome`);
    expect(cookie.line).toMatch(/^pb_web=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    // Nothing token-like in the redirect, and the database keeps only digests.
    expect(back.headers.location).not.toContain('token');
    const stored = await h.owner.query('select id_hash, csrf_hash from web_sessions');
    expect(JSON.stringify(stored.rows)).not.toContain(cookie.value);
    const s = await session(cookie.value);
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json()).toMatchObject({
      user: { email_verified: true },
      csrf_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('a state is used once and expires; a provider error or a foreign issuer goes back to the sign-in page', async () => {
    const p = person();
    const start = await h.app.inject({ method: 'GET', url: '/v1/web/auth/login' });
    const q = new URL(start.headers.location as string).searchParams;
    const code = randomBytes(16).toString('base64url');
    codes.set(code, {
      ...p,
      verified: true,
      nonce: q.get('nonce') ?? '',
      challenge: q.get('code_challenge') ?? '',
    });
    const first = await h.app.inject({
      method: 'GET',
      url: `/v1/web/auth/callback?code=${code}&state=${q.get('state')}`,
    });
    expect(first.headers['set-cookie']).toBeDefined();
    const replay = await h.app.inject({
      method: 'GET',
      url: `/v1/web/auth/callback?code=${code}&state=${q.get('state')}`,
    });
    expect(replay.headers.location).toBe(`${ORIGIN}/app/#/signin?failed=expired`);
    expect(replay.headers['set-cookie']).toBeUndefined();
    const cancelled = await h.app.inject({
      method: 'GET',
      url: '/v1/web/auth/callback?error=access_denied&state=x',
    });
    expect(cancelled.headers.location).toBe(`${ORIGIN}/app/#/signin?failed=cancelled`);
    const foreign = await h.app.inject({
      method: 'GET',
      url: `/v1/web/auth/callback?code=c&state=s&iss=${encodeURIComponent('https://evil.test')}`,
    });
    expect(foreign.headers.location).toBe(`${ORIGIN}/app/#/signin?failed=invalid`);
    // The provider's one-time code and state never reach the logs.
    expect(logLines.join('\n')).not.toContain(code);
  });

  it('never redirects outside the portal', async () => {
    for (const bad of ['//evil.test/x', 'https://evil.test/', '/v1/me', '/app/../v1']) {
      const { back } = await webSignIn(person(), `?return_to=${encodeURIComponent(bad)}`);
      expect(back.headers.location?.startsWith(`${ORIGIN}/app/`)).toBe(true);
      expect(back.headers.location).not.toContain('evil');
    }
  });
});

describe('the cookie session', () => {
  it('changes need the CSRF token and the portal origin; reads do not', async () => {
    const { cookie } = await webSignIn(person());
    const csrf = (await session(cookie.value)).json().csrf_token as string;
    const read = await h.app.inject({
      method: 'GET',
      url: '/v1/onboarding/status',
      headers: withCookie(cookie.value),
    });
    expect(read.statusCode, read.body).toBe(200);
    const post = (headers: Record<string, string>) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/onboarding/complete',
        headers: withCookie(cookie.value, headers),
        payload: {},
      });
    expect((await post({})).json().code).toBe('CSRF_FAILED');
    expect((await post({ 'x-csrf-token': csrf })).json().code).toBe('CSRF_FAILED'); // no Origin
    expect((await post({ 'x-csrf-token': csrf, origin: 'https://evil.test' })).json().code).toBe(
      'CSRF_FAILED',
    );
    expect((await post({ 'x-csrf-token': 'A'.repeat(43), origin: ORIGIN })).json().code).toBe('CSRF_FAILED');
    expect(
      (await post({ 'x-csrf-token': csrf, origin: ORIGIN, 'sec-fetch-site': 'cross-site' })).json().code,
    ).toBe('CSRF_FAILED');
    const ok = await post({ 'x-csrf-token': csrf, origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('only routes meant for the portal accept the cookie; staff routes never do', async () => {
    const { cookie } = await webSignIn(person());
    for (const url of ['/v1/me', '/v1/me/workspaces', '/v1/me/capabilities', '/v1/onboarding/status']) {
      expect(
        (await h.app.inject({ method: 'GET', url, headers: withCookie(cookie.value) })).statusCode,
        url,
      ).toBe(200);
    }
    const devices = await h.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: withCookie(cookie.value),
    });
    expect(devices.json()).toMatchObject({
      code: 'UNAUTHENTICATED',
      safe_details: { reason: 'not_for_web' },
    });
    const staff = await h.app.inject({
      method: 'GET',
      url: '/v1/support/audit/export',
      headers: withCookie(cookie.value),
    });
    expect(staff.statusCode).toBe(401);
    // An unknown or ended cookie is just signed out.
    const fake = await h.app.inject({ method: 'GET', url: '/v1/me', headers: withCookie('A'.repeat(43)) });
    expect(fake.statusCode).toBe(401);
  });

  it('web and desktop are the same account with separate sessions; onboarding done on one shows on the other', async () => {
    const p = person();
    const { cookie } = await webSignIn(p);
    const web = (await session(cookie.value)).json();
    // The desktop signs the same person in (same issuer and subject).
    const nonce = randomBytes(24).toString('base64url');
    const idToken = await sign(
      { sub: p.sub, email: p.email, email_verified: true, nonce, name: 'Web Person' },
      DESKTOP_CLIENT,
    );
    const dev = await h.app.inject({
      method: 'POST',
      url: '/v1/devices',
      payload: { id_token: idToken, nonce, name: 'Laptop', platform: 'macos-arm64' },
    });
    expect(dev.statusCode, dev.body).toBe(201);
    expect(dev.json().user.id).toBe(web.user.id);
    const desktop = { authorization: `Bearer ${dev.json().access_token}` };
    const done = await h.app.inject({
      method: 'POST',
      url: '/v1/onboarding/complete',
      headers: desktop,
      payload: { accept_terms_version: TERMS },
    });
    expect(done.json().outcome).toBe('created');
    const seen = await h.app.inject({
      method: 'GET',
      url: '/v1/onboarding/status',
      headers: withCookie(cookie.value),
    });
    expect(seen.json().default_org_id).toBe(done.json().status.default_org_id);
    // Signing out of the browser leaves the desktop signed in.
    const csrf = web.csrf_token;
    const out = await h.app.inject({
      method: 'POST',
      url: '/v1/web/auth/logout',
      headers: withCookie(cookie.value, { 'x-csrf-token': csrf, origin: ORIGIN }),
    });
    expect(out.statusCode).toBe(204);
    expect(cookieOf(out.headers['set-cookie']).line).toContain('Max-Age=0');
    expect((await session(cookie.value)).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: desktop })).statusCode).toBe(200);
  });

  it('a privilege change gives the session a new id; the old cookie stops working', async () => {
    const { cookie } = await webSignIn(person());
    const csrf = (await session(cookie.value)).json().csrf_token;
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/onboarding/complete',
      headers: withCookie(cookie.value, { 'x-csrf-token': csrf, origin: ORIGIN }),
      payload: { accept_terms_version: TERMS },
    });
    expect(res.json().outcome).toBe('created');
    const fresh = cookieOf(res.headers['set-cookie']).value;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(cookie.value);
    expect((await session(cookie.value)).statusCode).toBe(401);
    expect((await session(fresh)).statusCode).toBe(200);
    // Signing in again also replaces the browser's previous session.
    const again = await h.app.inject({ method: 'GET', url: '/v1/me', headers: withCookie(fresh) });
    expect(again.statusCode).toBe(200);
  });

  it('"sign out everywhere" ends every portal and desktop session of the account', async () => {
    const p = person();
    const a = await webSignIn(p);
    const b = await webSignIn(p);
    const nonce = randomBytes(24).toString('base64url');
    const idToken = await sign({ sub: p.sub, email: p.email, email_verified: true, nonce }, DESKTOP_CLIENT);
    const dev = await h.app.inject({
      method: 'POST',
      url: '/v1/devices',
      payload: { id_token: idToken, nonce, name: 'Laptop', platform: 'windows-x64' },
    });
    const desktop = { authorization: `Bearer ${dev.json().access_token}` };
    const csrf = (await session(a.cookie.value)).json().csrf_token;
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/web/auth/revoke-all',
      headers: withCookie(a.cookie.value, { 'x-csrf-token': csrf, origin: ORIGIN }),
    });
    expect(res.statusCode).toBe(204);
    expect((await session(a.cookie.value)).statusCode).toBe(401);
    expect((await session(b.cookie.value)).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/v1/me', headers: desktop })).statusCode).toBe(401);
  });

  it('a disabled account loses its portal session at the next request', async () => {
    const { cookie } = await webSignIn(person());
    const id = (await session(cookie.value)).json().user.id;
    await h.owner.query('update users set disabled_at = now() where id = $1', [id]);
    expect((await session(cookie.value)).statusCode).toBe(401);
  });
});

describe('the portal page', () => {
  it('is served at /app/ with a strict policy and no inline code; its settings are public and secret-free', async () => {
    const page = await h.app.inject({ method: 'GET', url: '/app/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.body).not.toMatch(/<script>|\sstyle=|\son[a-z]+=/i);
    const deep = await h.app.inject({ method: 'GET', url: '/app/welcome' });
    expect(deep.body).toBe(page.body);
    expect((await h.app.inject({ method: 'GET', url: '/app/portal.js' })).headers['content-type']).toContain(
      'javascript',
    );
    expect((await h.app.inject({ method: 'GET', url: '/app/../package.json' })).statusCode).not.toBe(200);
    const cfg = await h.app.inject({ method: 'GET', url: '/v1/web/config' });
    expect(cfg.json()).toEqual({
      brand: 'Project Browser',
      terms_version: TERMS,
      terms_url: null,
      download_url: null,
      sign_in: true,
    });
  });
});

describe('e-mail tasks queued by the application role', () => {
  it('a new workspace queues its welcome, an invitation its link (sealed, once)', async () => {
    const p = person();
    const { cookie } = await webSignIn(p);
    const csrf = (await session(cookie.value)).json().csrf_token;
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/onboarding/complete',
      headers: withCookie(cookie.value, { 'x-csrf-token': csrf, origin: ORIGIN }),
      payload: { accept_terms_version: TERMS },
    });
    expect(created.json().outcome).toBe('created');
    const orgId = created.json().status.default_org_id as string;
    expect(created.json().status.pending_tasks).toEqual([{ kind: 'welcome', state: 'pending' }]);
    // The owner invites someone from the desktop: the link is queued for e-mail as well as shown once.
    const nonce = randomBytes(24).toString('base64url');
    const idToken = await sign({ sub: p.sub, email: p.email, email_verified: true, nonce }, DESKTOP_CLIENT);
    const dev = await h.app.inject({
      method: 'POST',
      url: '/v1/devices',
      payload: { id_token: idToken, nonce, name: 'Laptop', platform: 'linux-x64' },
    });
    const inv = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/invitations`,
      headers: { authorization: `Bearer ${dev.json().access_token}` },
      payload: { email: 'mate@web.test', role: 'operator' },
    });
    expect(inv.statusCode, inv.body).toBe(201);
    expect(inv.json().email_delivery).toBe('queued');
    const tasks = await h.owner.query(
      'select kind, to_email, state, payload_enc from email_tasks where org_id = $1 order by created_at',
      [orgId],
    );
    expect(tasks.rows.map((t) => [t.kind, t.state])).toEqual([
      ['welcome', 'pending'],
      ['invitation', 'pending'],
    ]);
    // The link is sealed: the token is not readable in the database.
    expect(Buffer.from(tasks.rows[1]?.payload_enc).toString('latin1')).not.toContain(inv.json().token);
  });
});
