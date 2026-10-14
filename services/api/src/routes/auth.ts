/**
 * Sign-in, device enrollment and session tokens (milestone 06, ADR-0013).
 *
 * The desktop authenticates the person at the identity provider in the system browser (Authorization Code + PKCE,
 * state and nonce) and forwards the ID token here once. The API verifies it, claims it as used, finds or creates the
 * user by (issuer, subject) and issues its own session: a short-lived access token and a rotating refresh token bound
 * to one enrolled device. No password or credential is ever collected by the API or the desktop.
 */
import { ApiError, AuthConfig, DeviceEnroll, newId, Session, TokenRequest } from '@pb/contracts';
import type pg from 'pg';
import Type from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, auditAlone } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import type { VerifiedIdentity } from '../oidc.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { newRefreshSecret, parseRefreshToken, refreshToken, sha256Hex } from '../session.ts';
import { errors } from './common.ts';

const SIGN_IN_FAILED = 'The sign-in could not be verified';
const SESSION_ENDED = 'Your session has ended; sign in again';

export function authRoutes(app: App, deps: Deps): void {
  app.get(
    '/auth/config',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        security: [],
        description:
          'Identity provider settings for the desktop sign-in (system browser, Authorization Code + PKCE).',
        response: { 200: AuthConfig, ...errors },
      },
    },
    async () => {
      const oidc = deps.config.oidc;
      if (!oidc) throw new ApiError('UNAVAILABLE', 'Sign-in is not configured on this server');
      return {
        issuer: oidc.issuer,
        client_id: oidc.clientId,
        redirect_uri: oidc.redirectUri,
        scopes: oidc.scopes,
      };
    },
  );

  app.post(
    '/devices',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        security: [],
        description:
          'Enroll this device and start a session with a fresh ID token from the identity provider (used once). ' +
          'Returns the session tokens; keep the refresh token in the OS keychain.',
        body: DeviceEnroll,
        response: { 201: Session, ...errors },
      },
    },
    async (req, reply) => {
      await hit(deps.pool, LIMITS.signInPerIp, req.ip);
      const identity = await verifySignIn(deps, req.id, req.body.id_token, req.body.nonce);
      const userId = await upsertUser(deps, req.id, identity);
      const session = await withTx(deps.pool, { orgId: null, userId }, async (c) => {
        await claimOnce(c, deps, req.id, req.body.id_token, identity);
        const deviceId = newId('device');
        await c.query(
          'insert into devices (id, user_id, name, platform, last_seen_at) values ($1, $2, $3, $4, now())',
          [deviceId, userId, req.body.name, req.body.platform],
        );
        const issued = await startSession(c, deps, userId, deviceId, identity.authTime);
        await audit(c, {
          orgId: null,
          actorUserId: userId,
          actorDeviceId: deviceId,
          action: 'device.enrolled',
          targetType: 'device',
          targetId: deviceId,
          outcome: 'success',
          requestId: req.id,
          details: { platform: req.body.platform },
        });
        return sessionBody(c, deps, issued);
      });
      return reply.status(201).send(session);
    },
  );

  app.post(
    '/auth/token',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        security: [],
        description:
          'grant_type=refresh_token rotates the refresh token (presenting a previous one ends the session). ' +
          'grant_type=id_token signs in again on an enrolled device (for example to confirm a sensitive action).',
        body: TokenRequest,
        response: { 200: Session, ...errors },
      },
    },
    async (req) => {
      const body = req.body;
      if (body.grant_type === 'refresh_token') return refresh(deps, req.id, req.ip, body.refresh_token);

      await hit(deps.pool, LIMITS.signInPerIp, req.ip);
      const identity = await verifySignIn(deps, req.id, body.id_token, body.nonce);
      const userId = await upsertUser(deps, req.id, identity);
      return withTx(deps.pool, { orgId: null, userId }, async (c) => {
        const device = await c.query(
          'update devices set last_seen_at = now() where id = $1 and user_id = $2 and revoked_at is null returning id',
          [body.device_id, userId],
        );
        if (device.rowCount === 0) {
          // Unknown, revoked, or another account's device: one answer for all.
          throw new ApiError(
            'UNAUTHENTICATED',
            'This device is not signed in to this account; enroll it again',
            {
              reason: 'device_not_enrolled',
            },
          );
        }
        await claimOnce(c, deps, req.id, body.id_token, identity);
        await c.query(
          `update device_sessions set revoked_at = now(), revoke_reason = 'replaced'
            where device_id = $1 and user_id = $2 and revoked_at is null`,
          [body.device_id, userId],
        );
        const issued = await startSession(c, deps, userId, body.device_id, identity.authTime);
        await audit(c, {
          orgId: null,
          actorUserId: userId,
          actorDeviceId: body.device_id,
          action: 'auth.signed_in',
          targetType: 'device',
          targetId: body.device_id,
          outcome: 'success',
          requestId: req.id,
        });
        return sessionBody(c, deps, issued);
      });
    },
  );

  app.post(
    '/auth/sign-out',
    {
      schema: {
        tags: ['auth'],
        description:
          'Ends the current session (its refresh token stops working). The device stays enrolled; local data is untouched.',
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const principal = principalOf(req);
      if (principal.kind === 'session' && principal.sessionId) {
        await withTx(deps.pool, { orgId: null, userId: principal.userId }, async (c) => {
          await c.query(
            `update device_sessions set revoked_at = now(), revoke_reason = 'sign_out'
              where id = $1 and user_id = $2 and revoked_at is null`,
            [principal.sessionId, principal.userId],
          );
          await audit(c, {
            orgId: null,
            actorUserId: principal.userId,
            actorDeviceId: principal.deviceId,
            action: 'auth.signed_out',
            targetType: 'device',
            targetId: principal.deviceId,
            outcome: 'success',
            requestId: req.id,
          });
        });
      }
      return reply.status(204).send(null);
    },
  );
}

// ---------------------------------------------------------------- helpers

/** Verifies the ID token (signature, issuer, audience, age, nonce). Failures are audited without token material. */
async function verifySignIn(
  deps: Deps,
  requestId: string,
  idToken: string,
  nonce: string,
): Promise<VerifiedIdentity> {
  if (!deps.idTokens) throw new ApiError('UNAVAILABLE', 'Sign-in is not configured on this server');
  let identity: VerifiedIdentity;
  try {
    identity = await deps.idTokens.verify(idToken, nonce);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') {
      throw await signInFailed(deps, requestId, 'id_token_invalid');
    }
    throw err;
  }
  return identity;
}

/**
 * Claims the ID token inside the transaction that uses it: each token starts at most one session. A refused
 * request (for example an unknown device) rolls the claim back, so the same token can still enroll this device.
 */
export async function claimOnce(
  c: pg.PoolClient,
  deps: Deps,
  requestId: string,
  idToken: string,
  identity: VerifiedIdentity,
): Promise<void> {
  const { rows } = await c.query<{ first: boolean }>('select app.claim_id_token($1, $2) as first', [
    sha256Hex(idToken),
    identity.expiresAt,
  ]);
  if (!rows[0]?.first) throw await signInFailed(deps, requestId, 'id_token_reused');
}

async function signInFailed(deps: Deps, requestId: string, reason: string): Promise<ApiError> {
  await auditAlone(deps.pool, {
    orgId: null,
    actorUserId: null,
    actorDeviceId: null,
    action: 'auth.sign_in',
    outcome: 'failed',
    requestId,
    details: { reason },
  });
  return new ApiError('UNAUTHENTICATED', SIGN_IN_FAILED, { reason });
}

/** Finds or creates the user for this identity (matched by issuer and subject, never by e-mail). */
export async function upsertUser(deps: Deps, requestId: string, identity: VerifiedIdentity): Promise<string> {
  const { rows } = await withTx(deps.pool, { orgId: null, userId: null }, (c) =>
    c.query<{ user_id: string; disabled: boolean }>(
      'select * from app.upsert_oidc_user($1, $2, $3, $4, $5, $6)',
      [
        newId('user'),
        identity.issuer,
        identity.subject,
        identity.email,
        identity.emailVerified,
        identity.displayName,
      ],
    ),
  );
  const row = rows[0];
  if (!row) throw new ApiError('INTERNAL', 'Sign-in failed');
  if (row.disabled) {
    await auditAlone(deps.pool, {
      orgId: null,
      actorUserId: row.user_id,
      actorDeviceId: null,
      action: 'auth.sign_in',
      outcome: 'denied',
      requestId,
      details: { reason: 'user_disabled' },
    });
    throw new ApiError('UNAUTHENTICATED', 'This account is disabled', { reason: 'user_disabled' });
  }
  return row.user_id;
}

interface IssuedSession {
  userId: string;
  deviceId: string;
  sessionId: string;
  authTime: Date;
  refreshToken: string;
}

async function startSession(
  c: pg.PoolClient,
  deps: Deps,
  userId: string,
  deviceId: string,
  authTime: Date,
): Promise<IssuedSession> {
  const sessionId = newId('session');
  const secret = newRefreshSecret();
  const cfg = deps.config.session;
  await c.query(
    `insert into device_sessions (id, user_id, device_id, refresh_hash, auth_time, expires_at, idle_expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6),
             now() + make_interval(secs => least($6, $7)))`,
    [
      sessionId,
      userId,
      deviceId,
      sha256Hex(secret),
      authTime,
      cfg.refreshAbsoluteSeconds,
      cfg.refreshIdleSeconds,
    ],
  );
  return { userId, deviceId, sessionId, authTime, refreshToken: refreshToken(sessionId, secret) };
}

async function sessionBody(c: pg.PoolClient, deps: Deps, s: IssuedSession) {
  const accessToken = await deps.sessions.sign(
    { userId: s.userId, deviceId: s.deviceId, sessionId: s.sessionId, authTime: s.authTime },
    deps.config.session.accessTtlSeconds,
  );
  const { rows } = await c.query<{
    refresh_expires_at: string;
    device_id: string;
    device_name: string;
    platform: 'windows-x64' | 'macos-arm64' | 'macos-x64' | 'linux-x64';
    device_created_at: string;
    last_seen_at: string | null;
    display_name: string;
    email: string | null;
    email_verified: boolean;
  }>(
    `select ${ts('s.idle_expires_at')} as refresh_expires_at, d.id as device_id, d.name as device_name, d.platform,
            ${ts('d.created_at')} as device_created_at, ${ts('d.last_seen_at')} as last_seen_at,
            u.display_name, u.email, u.email_verified
       from device_sessions s join devices d on d.id = s.device_id join users u on u.id = s.user_id
      where s.id = $1 and s.user_id = $2`,
    [s.sessionId, s.userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('INTERNAL', 'Session lookup failed');
  return {
    access_token: accessToken,
    token_type: 'Bearer' as const,
    expires_in: deps.config.session.accessTtlSeconds,
    refresh_token: s.refreshToken,
    refresh_expires_at: row.refresh_expires_at,
    auth_time: s.authTime.toISOString(),
    device: {
      id: row.device_id,
      name: row.device_name,
      platform: row.platform,
      created_at: row.device_created_at,
      last_seen_at: row.last_seen_at,
      revoked_at: null,
      current: true,
    },
    user: {
      id: s.userId,
      display_name: row.display_name,
      email: row.email,
      email_verified: row.email_verified,
    },
  };
}

async function refresh(deps: Deps, requestId: string, ip: string, presented: string) {
  const parsed = parseRefreshToken(presented);
  if (!parsed) throw new ApiError('UNAUTHENTICATED', SESSION_ENDED, { reason: 'session_invalid' });
  await hit(deps.pool, LIMITS.refreshPerIp, ip);
  await hit(deps.pool, LIMITS.refreshPerSession, parsed.sessionId);
  const secret = newRefreshSecret();
  // The rotation commits on its own (including a reuse revocation) before any error is raised.
  const { rows } = await withTx(deps.pool, { orgId: null, userId: null }, (c) =>
    c.query<{ outcome: string; user_id: string | null; device_id: string | null; auth_time: Date | null }>(
      'select * from app.rotate_refresh_token($1, $2, $3, $4)',
      [parsed.sessionId, sha256Hex(parsed.secret), sha256Hex(secret), deps.config.session.refreshIdleSeconds],
    ),
  );
  const r = rows[0];
  if (r?.outcome !== 'rotated' || !r.user_id || !r.device_id || !r.auth_time) {
    const outcome = r?.outcome ?? 'invalid';
    if (outcome === 'reused' && r?.user_id) {
      await auditAlone(deps.pool, {
        orgId: null,
        actorUserId: r.user_id,
        actorDeviceId: r.device_id,
        action: 'session.refresh_reused',
        targetType: 'session',
        targetId: parsed.sessionId,
        outcome: 'denied',
        requestId,
      });
    }
    const reason =
      outcome === 'device_revoked'
        ? 'device_revoked'
        : outcome === 'user_disabled'
          ? 'user_disabled'
          : 'session_ended';
    const message =
      reason === 'device_revoked'
        ? 'This device was signed out; sign in again'
        : reason === 'user_disabled'
          ? 'This account is disabled'
          : SESSION_ENDED;
    throw new ApiError('UNAUTHENTICATED', message, { reason });
  }
  const userId = r.user_id;
  const deviceId = r.device_id;
  const authTime = new Date(r.auth_time);
  return withTx(deps.pool, { orgId: null, userId }, (c) =>
    sessionBody(c, deps, {
      userId,
      deviceId,
      sessionId: parsed.sessionId,
      authTime,
      refreshToken: refreshToken(parsed.sessionId, secret),
    }),
  );
}
