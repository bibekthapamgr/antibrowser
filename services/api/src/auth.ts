import type { AppConfig } from '@pb/config/env';
import { ApiError, isId } from '@pb/contracts';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type pg from 'pg';
import { withTx } from './db.ts';
import { DEV_ISSUER } from './fixtures.ts';

export interface Principal {
  userId: string;
}

export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<Principal>;
}

const DEV_AUDIENCE = 'pb-api';

/**
 * Development-only HS256 tokens (sub = user id). packages/config guarantees this is never enabled
 * outside dev/test. Production authentication is OIDC (ADR-0004), implemented in milestone 06.
 */
export function devAuthenticator(secret: string, pool: pg.Pool): Authenticator {
  const key = new TextEncoder().encode(secret);
  return {
    async authenticate(authorization) {
      const token = bearer(authorization);
      let sub: string | undefined;
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: DEV_ISSUER,
          audience: DEV_AUDIENCE,
          algorithms: ['HS256'],
        });
        sub = payload.sub;
      } catch {
        throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
      }
      if (!isId('user', sub)) throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
      await assertUserExists(pool, 'id = $1', [sub]);
      return { userId: sub };
    },
  };
}

/** OIDC access-token verification against the provider's JWKS. User provisioning arrives in milestone 06. */
export function oidcAuthenticator(issuer: string, audience: string, pool: pg.Pool): Authenticator {
  let jwks: JWTVerifyGetKey | undefined;
  return {
    async authenticate(authorization) {
      const token = bearer(authorization);
      jwks ??= createRemoteJWKSet(await discoverJwksUri(issuer));
      let sub: string | undefined;
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer, audience });
        sub = payload.sub;
      } catch {
        throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
      }
      if (!sub) throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
      const userId = await assertUserExists(pool, 'oidc_issuer = $1 and oidc_subject = $2', [issuer, sub]);
      return { userId };
    },
  };
}

export function createAuthenticator(config: AppConfig, pool: pg.Pool): Authenticator {
  if (config.devAuth.enabled) return devAuthenticator(config.devAuth.secret, pool);
  if (config.oidc) return oidcAuthenticator(config.oidc.issuer, config.oidc.audience, pool);
  throw new Error('No authenticator configured');
}

async function discoverJwksUri(issuer: string): Promise<URL> {
  try {
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    });
    const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
    if (!res.ok || doc.issuer !== issuer || !doc.jwks_uri?.startsWith('https://'))
      throw new Error('bad discovery');
    return new URL(doc.jwks_uri);
  } catch {
    throw new ApiError('UNAVAILABLE', 'Identity provider is unavailable');
  }
}

function bearer(authorization: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{10,4096})$/.exec(authorization ?? '');
  if (!match?.[1]) throw new ApiError('UNAUTHENTICATED', 'Missing bearer token');
  return match[1];
}

async function assertUserExists(pool: pg.Pool, where: string, params: string[]): Promise<string> {
  const rows = await withTx(pool, { orgId: null, userId: null }, (c) =>
    c.query<{ id: string }>(`select id from users where ${where}`, params),
  );
  const id = rows.rows[0]?.id;
  if (!id) throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
  return id;
}
