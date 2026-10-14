import type { AppConfig } from '@pb/config/env';
import { ApiError, type ApiScope, isId, parseApiToken, type StaffRole } from '@pb/contracts';
import { jwtVerify } from 'jose';
import type pg from 'pg';
import { withTx } from './db.ts';
import { DEV_ISSUER } from './fixtures.ts';
import { type SessionKeys, sameDigest, sha256Hex } from './session.ts';

/** What an API token allows on top of its owner's own access (milestone 10, ADR-0017). */
export interface TokenGrant {
  id: string;
  name: string;
  orgId: string;
  scopes: ApiScope[];
  /** null: every client the owner can reach. */
  clientIds: string[] | null;
  /** null: every profile the owner can reach. */
  profileIds: string[] | null;
}

/**
 * Who is calling. `session` principals come from API session tokens (a signed-in device); `dev` principals from the
 * development-only HS256 tokens, which packages/config never enables outside dev/test; `token` principals from API
 * tokens (milestone 10): they act as the token's owner, limited by the token's organization, scopes and restrictions.
 */
export interface Principal {
  kind: 'session' | 'dev' | 'token' | 'staff';
  userId: string;
  deviceId: string | null;
  sessionId: string | null;
  /** Last real authentication at the identity provider (for operations that need a recent sign-in). */
  authTime: Date;
  token?: TokenGrant;
  /** Milestone 11: support console staff (only on /v1/support routes). */
  staff?: { roles: StaffRole[] };
}

export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<Principal>;
  /** Support routes only: a staff token whose session and staff membership are still active. */
  authenticateStaff(authorization: string | undefined): Promise<Principal>;
}

const DEV_AUDIENCE = 'pb-api';

export function createAuthenticator(config: AppConfig, pool: pg.Pool, keys: SessionKeys): Authenticator {
  const devKey = config.devAuth.enabled ? new TextEncoder().encode(config.devAuth.secret) : null;
  return {
    async authenticate(authorization) {
      const token = bearer(authorization);
      const api = parseApiToken(token);
      if (api) return apiTokenPrincipal(pool, api.tokenId, api.secret);
      const session = await keys.verify(token);
      if (session) {
        await assertSessionActive(pool, session.userId, session.sessionId, session.deviceId);
        return { kind: 'session', ...session };
      }
      if (devKey) return devPrincipal(pool, devKey, token);
      throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
    },
    async authenticateStaff(authorization) {
      const claims = await keys.verifyStaff(bearer(authorization));
      const { rows } = await withTx(pool, { orgId: null, userId: claims.userId }, (c) =>
        c.query<{ roles: StaffRole[] }>(
          `select p.roles from staff_sessions s join platform_staff p on p.user_id = s.user_id
             join users u on u.id = s.user_id
            where s.id = $1 and s.user_id = $2 and s.revoked_at is null and s.expires_at > now()
              and p.disabled_at is null and u.disabled_at is null`,
          [claims.staffSessionId, claims.userId],
        ),
      );
      const row = rows[0];
      if (!row) throw new ApiError('UNAUTHENTICATED', 'Sign in to the support console again');
      return {
        kind: 'staff',
        userId: claims.userId,
        deviceId: null,
        sessionId: claims.staffSessionId,
        authTime: claims.authTime,
        staff: { roles: row.roles },
      };
    },
  };
}

/**
 * Revocation is effective at the next request: the session, its device and the user must all still be active.
 * Runs under the user's own row-level-security context (a user can only see their own sessions and devices).
 */
async function assertSessionActive(pool: pg.Pool, userId: string, sessionId: string, deviceId: string) {
  const { rows } = await withTx(pool, { orgId: null, userId }, (c) =>
    c.query<{ session_ok: boolean; device_ok: boolean; user_ok: boolean }>(
      `select s.revoked_at is null and s.expires_at > now() as session_ok,
              d.revoked_at is null as device_ok,
              u.disabled_at is null as user_ok
         from device_sessions s
         join devices d on d.id = s.device_id
         join users u on u.id = s.user_id
        where s.id = $1 and s.user_id = $2 and s.device_id = $3`,
      [sessionId, userId, deviceId],
    ),
  );
  const row = rows[0];
  if (!row)
    throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials', { reason: 'session_revoked' });
  if (!row.device_ok) {
    throw new ApiError('UNAUTHENTICATED', 'This device was signed out', { reason: 'device_revoked' });
  }
  if (!row.user_ok)
    throw new ApiError('UNAUTHENTICATED', 'This account is disabled', { reason: 'user_disabled' });
  if (!row.session_ok) {
    throw new ApiError('UNAUTHENTICATED', 'This session has ended; sign in again', {
      reason: 'session_revoked',
    });
  }
}

/**
 * An API token: the digest must match (constant time) the current secret, or the previous one during a rotation's
 * grace period; the token must not be expired or revoked; its owner must be enabled and still a member. Every
 * failure answers the same UNAUTHENTICATED (a guessed id learns nothing).
 */
async function apiTokenPrincipal(pool: pg.Pool, tokenId: string, secret: string): Promise<Principal> {
  const invalid = () =>
    new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials', { reason: 'token_invalid' });
  const { rows } = await withTx(pool, { orgId: null, userId: null }, (c) =>
    c.query<{
      org_id: string;
      user_id: string;
      token_hash: string;
      previous_hash: string | null;
      previous_valid: boolean;
      scopes: ApiScope[];
      client_ids: string[] | null;
      profile_ids: string[] | null;
      expired: boolean;
      revoked: boolean;
      user_disabled: boolean;
      member: boolean;
      name: string;
    }>('select * from app.api_token_for_auth($1)', [tokenId]),
  );
  const t = rows[0];
  const digest = sha256Hex(secret);
  if (!t) throw invalid();
  const matches =
    sameDigest(digest, t.token_hash) ||
    (t.previous_valid && t.previous_hash !== null && sameDigest(digest, t.previous_hash));
  if (!matches) throw invalid();
  if (t.revoked)
    throw new ApiError('UNAUTHENTICATED', 'This API token was revoked', { reason: 'token_revoked' });
  if (t.expired)
    throw new ApiError('UNAUTHENTICATED', 'This API token has expired', { reason: 'token_expired' });
  if (t.user_disabled || !t.member) {
    throw new ApiError('UNAUTHENTICATED', 'The owner of this API token no longer has access', {
      reason: 'token_owner_inactive',
    });
  }
  await withTx(pool, { orgId: null, userId: null }, (c) =>
    c.query('select app.api_token_touch($1)', [tokenId]),
  );
  return {
    kind: 'token',
    userId: t.user_id,
    deviceId: null,
    sessionId: null,
    authTime: new Date(0),
    token: {
      id: tokenId,
      name: t.name,
      orgId: t.org_id,
      scopes: t.scopes,
      clientIds: t.client_ids,
      profileIds: t.profile_ids,
    },
  };
}

async function devPrincipal(pool: pg.Pool, key: Uint8Array, token: string): Promise<Principal> {
  let sub: string | undefined;
  let iat: number | undefined;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: DEV_ISSUER,
      audience: DEV_AUDIENCE,
      algorithms: ['HS256'],
    });
    sub = payload.sub;
    iat = payload.iat;
  } catch {
    throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
  }
  if (!isId('user', sub)) throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
  const { rows } = await withTx(pool, { orgId: null, userId: sub }, (c) =>
    c.query('select 1 from users where id = $1 and disabled_at is null', [sub]),
  );
  if (rows.length === 0) throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
  return { kind: 'dev', userId: sub, deviceId: null, sessionId: null, authTime: new Date((iat ?? 0) * 1000) };
}

function bearer(authorization: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{10,4096})$/.exec(authorization ?? '');
  if (!match?.[1]) throw new ApiError('UNAUTHENTICATED', 'Missing bearer token');
  return match[1];
}
