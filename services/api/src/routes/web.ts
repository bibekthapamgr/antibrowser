/**
 * R2 (ADR-0021): the customer web portal's backend-for-frontend session. The browser never holds an access or
 * refresh token: the API runs Authorization Code + PKCE (state, nonce) with the portal's own public client, verifies
 * the ID token exactly like a desktop sign-in, and gives the browser one opaque cookie:
 *
 *   - HttpOnly, SameSite=Lax, Path=/, Secure on https (`__Host-` name there), bounded by an idle and an absolute
 *     lifetime; the database keeps only its SHA-256;
 *   - changes (any method but GET/HEAD) need the session's CSRF token in `x-csrf-token` and an Origin header equal
 *     to WEB_ORIGIN; the CSRF token is derived from the cookie secret, so it is never stored either;
 *   - only routes marked `web: true` accept the cookie (deny by default, like API tokens);
 *   - a new session id at sign-in and after a privilege change (onboarding created or joined a workspace);
 *   - signing out ends this browser's session; "sign out everywhere" ends every web and desktop session.
 *
 * Web and desktop principals are the same user (issuer + subject) with separate session records.
 */
import { randomBytes } from 'node:crypto';
import { ApiError, WebSession } from '@pb/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Type from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { auditAlone } from '../audit.ts';
import type { Principal } from '../auth.ts';
import { ts, withTx } from '../db.ts';
import { discoverEndpoints } from '../oidc.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { sameDigest, sha256Hex } from '../session.ts';
import { claimOnce, upsertUser } from './auth.ts';
import { errors } from './common.ts';

const random = (n = 32) => randomBytes(n).toString('base64url');
const csrfOf = (secret: string) => sha256Base64url(`csrf:${secret}`);
function sha256Base64url(text: string): string {
  return Buffer.from(sha256Hex(text), 'hex').toString('base64url');
}

/** Where a sign-in may return to: the portal's own pages only. */
const RETURN_TO = /^\/app\/[A-Za-z0-9/_.#?=&%-]{0,500}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function webCookieName(deps: Deps): string {
  return deps.config.web.origin?.startsWith('https://') ? '__Host-pb_web' : 'pb_web';
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      const value = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

function setCookie(reply: FastifyReply, deps: Deps, value: string | null): void {
  const secure = deps.config.web.origin?.startsWith('https://') ? '; Secure' : '';
  const life = value ? deps.config.web.sessionAbsoluteSeconds : 0;
  reply.header(
    'set-cookie',
    `${webCookieName(deps)}=${value ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${life}${secure}`,
  );
}

/** Whether this request carries a portal cookie (the hook then authenticates it instead of a bearer token). */
export function hasWebCookie(req: FastifyRequest, deps: Deps): boolean {
  return Boolean(deps.config.web.origin) && readCookie(req.headers.cookie, webCookieName(deps)) !== null;
}

/** The portal cookie -> principal, with the CSRF and Origin checks for changes. */
export async function authenticateWeb(req: FastifyRequest, deps: Deps): Promise<Principal> {
  const secret = readCookie(req.headers.cookie, webCookieName(deps));
  if (!secret) throw new ApiError('UNAUTHENTICATED', 'Sign in again');
  const idHash = sha256Hex(secret);
  const { rows } = await withTx(deps.pool, { orgId: null, userId: null }, (c) =>
    c.query<{ user_id: string; csrf_hash: string; auth_time: Date }>(
      'select * from app.web_session_for_auth($1, $2)',
      [idHash, deps.config.web.sessionIdleSeconds],
    ),
  );
  const row = rows[0];
  if (!row)
    throw new ApiError('UNAUTHENTICATED', 'Your session has ended; sign in again', {
      reason: 'session_ended',
    });
  if (!SAFE_METHODS.has(req.method)) {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    const token = req.headers['x-csrf-token'];
    const tokenOk = typeof token === 'string' && sameDigest(sha256Hex(token), row.csrf_hash);
    if (origin !== deps.config.web.origin || (site !== undefined && site !== 'same-origin') || !tokenOk) {
      throw new ApiError('CSRF_FAILED', 'This change was not sent by the portal; reload the page');
    }
  }
  return {
    kind: 'web',
    userId: row.user_id,
    deviceId: null,
    sessionId: null,
    authTime: new Date(row.auth_time),
    web: { idHash },
  };
}

/** A fresh session id for the same sign-in (after a privilege change). The old cookie stops working at once. */
export async function rotateWebSession(req: FastifyRequest, reply: FastifyReply, deps: Deps): Promise<void> {
  const principal = principalOf(req);
  if (principal.kind !== 'web' || !principal.web) return;
  const secret = random();
  await withTx(deps.pool, { orgId: null, userId: principal.userId }, async (c) => {
    await c.query(
      `update web_sessions set revoked_at = now(), revoke_reason = 'rotated'
        where id_hash = $1 and user_id = $2 and revoked_at is null`,
      [principal.web?.idHash, principal.userId],
    );
    await insertSession(c, deps, principal.userId, secret, principal.authTime);
  });
  setCookie(reply, deps, secret);
}

async function insertSession(
  c: import('pg').PoolClient,
  deps: Deps,
  userId: string,
  secret: string,
  authTime: Date,
): Promise<void> {
  await c.query(
    `insert into web_sessions (id_hash, user_id, csrf_hash, auth_time, idle_expires_at, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(secs => least($5::int, $6::int)),
             now() + make_interval(secs => $6::int))`,
    [
      sha256Hex(secret),
      userId,
      sha256Hex(csrfOf(secret)),
      authTime,
      deps.config.web.sessionIdleSeconds,
      deps.config.web.sessionAbsoluteSeconds,
    ],
  );
}

export function webRoutes(app: App, deps: Deps): void {
  const web = deps.config.web;
  const oidc = deps.config.oidc;
  const verifier = deps.webIdTokens;
  if (!web.origin || !web.oidcClientId || !oidc || !verifier) return;
  const origin = web.origin;
  const clientId = web.oidcClientId;
  const callback = `${origin}/v1/web/auth/callback`;
  const loopback = deps.config.appEnv === 'dev' || deps.config.appEnv === 'test' || /^http:\/\//.test(origin);
  const portal = (fragment: string) => `${origin}/app/#/${fragment}`;

  app.get(
    '/web/auth/login',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        security: [],
        description:
          'Customer portal sign-in (or `mode=signup`: create an account) at the identity provider. Redirects; the ' +
          'portal never sees a token.',
        querystring: Type.Object(
          {
            return_to: Type.Optional(Type.String({ maxLength: 512 })),
            mode: Type.Optional(Type.Enum(['signin', 'signup'])),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      await hit(deps.pool, LIMITS.webSignInPerIp, req.ip);
      const returnTo =
        req.query.return_to && RETURN_TO.test(req.query.return_to) ? req.query.return_to : '/app/';
      const state = random();
      const codeVerifier = random(48);
      const nonce = random();
      await withTx(deps.pool, { orgId: null, userId: null }, (c) =>
        c.query('select app.web_auth_begin($1, $2, $3, $4)', [
          sha256Hex(state),
          codeVerifier,
          nonce,
          returnTo,
        ]),
      );
      const endpoints = await discoverEndpoints(oidc.issuer, loopback);
      const url = new URL(endpoints.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: callback,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: sha256Base64url(codeVerifier),
        code_challenge_method: 'S256',
        ...(req.query.mode === 'signup' ? { prompt: 'create' } : {}),
      }).toString();
      return reply.header('cache-control', 'no-store').redirect(url.toString(), 302);
    },
  );

  app.get(
    '/web/auth/callback',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        security: [],
        description:
          'Where the identity provider returns to after a portal sign-in. Sets the session cookie.',
        querystring: Type.Object(
          {
            code: Type.Optional(Type.String({ maxLength: 2048 })),
            state: Type.Optional(Type.String({ maxLength: 128 })),
            iss: Type.Optional(Type.String({ maxLength: 512 })),
            session_state: Type.Optional(Type.String({ maxLength: 256 })),
            error: Type.Optional(Type.String({ maxLength: 64 })),
            error_description: Type.Optional(Type.String({ maxLength: 512 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await hit(deps.pool, LIMITS.webSignInPerIp, req.ip);
      const q = req.query;
      if (q.error) return reply.redirect(portal('signin?failed=cancelled'), 302);
      if (!q.code || !q.state) return reply.redirect(portal('signin?failed=invalid'), 302);
      if (q.iss !== undefined && q.iss !== oidc.issuer)
        return reply.redirect(portal('signin?failed=invalid'), 302);
      const pending = await withTx(deps.pool, { orgId: null, userId: null }, (c) =>
        c.query<{ verifier: string; nonce: string; return_to: string }>(
          'select * from app.web_auth_take($1)',
          [sha256Hex(q.state ?? '')],
        ),
      );
      const p = pending.rows[0];
      if (!p) return reply.redirect(portal('signin?failed=expired'), 302);

      const endpoints = await discoverEndpoints(oidc.issuer, loopback);
      let idToken: string | undefined;
      try {
        const res = await fetch(endpoints.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: q.code,
            redirect_uri: callback,
            client_id: clientId,
            code_verifier: p.verifier,
          }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        const body = (await res.json()) as { id_token?: unknown };
        if (res.ok && typeof body.id_token === 'string') idToken = body.id_token;
      } catch {
        idToken = undefined;
      }
      if (!idToken) return reply.redirect(portal('signin?failed=provider'), 302);
      let identity: Awaited<ReturnType<typeof verifier.verify>>;
      try {
        identity = await verifier.verify(idToken, p.nonce);
      } catch {
        return reply.redirect(portal('signin?failed=invalid'), 302);
      }
      let userId: string;
      try {
        userId = await upsertUser(deps, req.id, identity);
      } catch {
        return reply.redirect(portal('signin?failed=disabled'), 302);
      }
      const secret = random();
      const previous = readCookie(req.headers.cookie, webCookieName(deps));
      const token = idToken;
      await withTx(deps.pool, { orgId: null, userId }, async (c) => {
        await claimOnce(c, deps, req.id, token, identity);
        if (previous) {
          await c.query(
            `update web_sessions set revoked_at = now(), revoke_reason = 'rotated'
              where id_hash = $1 and user_id = $2 and revoked_at is null`,
            [sha256Hex(previous), userId],
          );
        }
        await insertSession(c, deps, userId, secret, identity.authTime);
      });
      await auditAlone(deps.pool, {
        orgId: null,
        actorUserId: userId,
        actorDeviceId: null,
        action: 'auth.web_signed_in',
        outcome: 'success',
        requestId: req.id,
      });
      setCookie(reply, deps, secret);
      return reply.redirect(`${origin}${p.return_to}`, 302);
    },
  );

  app.get(
    '/web/auth/session',
    {
      config: { web: true },
      schema: {
        tags: ['auth'],
        description: 'The portal session: who is signed in, and the CSRF token to send with changes.',
        response: { 200: WebSession, ...errors },
      },
    },
    async (req, reply) => {
      const principal = principalOf(req);
      if (principal.kind !== 'web' || !principal.web) {
        throw new ApiError('UNAUTHENTICATED', 'This is the web portal session; sign in on the portal');
      }
      const secret = readCookie(req.headers.cookie, webCookieName(deps)) ?? '';
      const { rows } = await withTx(deps.pool, { orgId: null, userId: principal.userId }, (c) =>
        c.query<{
          id: string;
          display_name: string;
          email: string | null;
          email_verified: boolean;
          expires_at: string;
        }>(
          `select u.id, u.display_name, u.email, u.email_verified, ${ts('w.expires_at')} as expires_at
             from web_sessions w join users u on u.id = w.user_id where w.id_hash = $1`,
          [principal.web?.idHash],
        ),
      );
      const r = rows[0];
      if (!r) throw new ApiError('UNAUTHENTICATED', 'Your session has ended; sign in again');
      reply.header('cache-control', 'no-store');
      return {
        user: { id: r.id, display_name: r.display_name, email: r.email, email_verified: r.email_verified },
        csrf_token: csrfOf(secret),
        expires_at: r.expires_at,
      };
    },
  );

  app.post(
    '/web/auth/logout',
    {
      config: { web: true },
      schema: {
        tags: ['auth'],
        description: 'Ends this browser’s portal session (desktop sessions are not affected).',
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const principal = principalOf(req);
      if (principal.kind === 'web' && principal.web) {
        await withTx(deps.pool, { orgId: null, userId: principal.userId }, (c) =>
          c.query(
            `update web_sessions set revoked_at = now(), revoke_reason = 'sign_out'
              where id_hash = $1 and user_id = $2 and revoked_at is null`,
            [principal.web?.idHash, principal.userId],
          ),
        );
      }
      setCookie(reply, deps, null);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/web/auth/revoke-all',
    {
      config: { web: true },
      schema: {
        tags: ['auth'],
        description:
          'Signs this account out everywhere: every portal session and every desktop session (devices stay enrolled).',
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const principal = principalOf(req);
      await withTx(deps.pool, { orgId: null, userId: principal.userId }, async (c) => {
        await c.query(
          `update web_sessions set revoked_at = now(), revoke_reason = 'revoke_all'
            where user_id = $1 and revoked_at is null`,
          [principal.userId],
        );
        await c.query(
          `update device_sessions set revoked_at = now(), revoke_reason = 'sign_out'
            where user_id = $1 and revoked_at is null`,
          [principal.userId],
        );
      });
      await auditAlone(deps.pool, {
        orgId: null,
        actorUserId: principal.userId,
        actorDeviceId: principal.deviceId,
        action: 'auth.revoked_all',
        outcome: 'success',
        requestId: req.id,
      });
      setCookie(reply, deps, null);
      return reply.status(204).send(null);
    },
  );
}
