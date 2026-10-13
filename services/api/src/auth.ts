import type { AppConfig } from '@pb/config/env';
import { ApiError, isId } from '@pb/contracts';
import { jwtVerify } from 'jose';
import type pg from 'pg';
import { withTx } from './db.ts';
import { DEV_ISSUER } from './fixtures.ts';
import type { SessionKeys } from './session.ts';

/**
 * Who is calling. `session` principals come from API session tokens (a signed-in device); `dev` principals from the
 * development-only HS256 tokens, which packages/config never enables outside dev/test.
 */
export interface Principal {
  kind: 'session' | 'dev';
  userId: string;
  deviceId: string | null;
  sessionId: string | null;
  /** Last real authentication at the identity provider (for operations that need a recent sign-in). */
  authTime: Date;
}

export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<Principal>;
}

const DEV_AUDIENCE = 'pb-api';

export function createAuthenticator(config: AppConfig, pool: pg.Pool, keys: SessionKeys): Authenticator {
  const devKey = config.devAuth.enabled ? new TextEncoder().encode(config.devAuth.secret) : null;
  return {
    async authenticate(authorization) {
      const token = bearer(authorization);
      const session = await keys.verify(token);
      if (session) {
        await assertSessionActive(pool, session.userId, session.sessionId, session.deviceId);
        return { kind: 'session', ...session };
      }
      if (devKey) return devPrincipal(pool, devKey, token);
      throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
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
