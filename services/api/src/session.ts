/**
 * API session tokens (ADR-0013).
 *
 * Access token: a short-lived ES256 JWT naming the user (`sub`), device (`did`) and session (`sid`) plus the time of
 * the last real authentication (`auth_time`). Every request also checks in the database that the session and device
 * are still active, so revocation takes effect at the next request, not at expiry.
 *
 * Refresh token: `<session id>.<43 base64url characters>` (256 random bits). Only its SHA-256 digest is stored. Each
 * use rotates it; presenting the previous value again revokes the whole session (reuse detection).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError, isId } from '@pb/contracts';
import {
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from 'jose';

export const API_AUDIENCE = 'pb-api';

export interface AccessClaims {
  userId: string;
  deviceId: string;
  sessionId: string;
  authTime: Date;
}

export interface SessionKeys {
  issuer: string;
  sign(claims: AccessClaims, ttlSeconds: number): Promise<string>;
  /** Returns null when the token is not one of ours (wrong issuer); throws UNAUTHENTICATED when ours but invalid. */
  verify(token: string): Promise<AccessClaims | null>;
}

interface KeyEntry {
  kid: string;
  key: CryptoKey | Uint8Array;
}

export async function createSessionKeys(opts: {
  issuer: string;
  signingKeyJwk: string | null;
  previousPublicKeysJwk: string | null;
}): Promise<SessionKeys> {
  let signing: KeyEntry;
  const verifying: KeyEntry[] = [];
  if (opts.signingKeyJwk) {
    const jwk = JSON.parse(opts.signingKeyJwk) as JWK;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d)
      throw new Error('SESSION_SIGNING_KEY must be a P-256 private JWK');
    const kid = jwk.kid ?? thumbprintId(jwk);
    signing = { kid, key: await importJWK(ecKey(jwk, true), 'ES256') };
    verifying.push({ kid, key: await importJWK(ecKey(jwk, false), 'ES256') });
  } else {
    // dev/test only (packages/config requires a configured key elsewhere): one key per process.
    const pair = await generateKeyPair('ES256', { extractable: true });
    const kid = thumbprintId(await exportJWK(pair.publicKey));
    signing = { kid, key: pair.privateKey };
    verifying.push({ kid, key: pair.publicKey });
  }
  for (const jwk of opts.previousPublicKeysJwk ? (JSON.parse(opts.previousPublicKeysJwk) as JWK[]) : []) {
    if (jwk.d) throw new Error('SESSION_PREVIOUS_PUBLIC_KEYS must not contain private keys');
    verifying.push({ kid: jwk.kid ?? thumbprintId(jwk), key: await importJWK(ecKey(jwk, false), 'ES256') });
  }

  return {
    issuer: opts.issuer,
    async sign(claims, ttlSeconds) {
      return new SignJWT({ did: claims.deviceId, sid: claims.sessionId, auth_time: seconds(claims.authTime) })
        .setProtectedHeader({ alg: 'ES256', kid: signing.kid, typ: 'at+jwt' })
        .setIssuer(opts.issuer)
        .setAudience(API_AUDIENCE)
        .setSubject(claims.userId)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(signing.key);
    },
    async verify(token) {
      const header = decodeSegment(token, 0);
      const payload = decodeSegment(token, 1);
      if (!header || !payload || payload.iss !== opts.issuer) return null;
      const entry = verifying.find((k) => k.kid === header.kid);
      if (!entry) throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
      let verified: JWTPayload;
      try {
        ({ payload: verified } = await jwtVerify(token, entry.key, {
          issuer: opts.issuer,
          audience: API_AUDIENCE,
          algorithms: ['ES256'],
          typ: 'at+jwt',
          requiredClaims: ['sub', 'exp', 'iat'],
        }));
      } catch {
        throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials', { reason: 'token_invalid' });
      }
      const { sub, did, sid, auth_time } = verified as JWTPayload & {
        did?: unknown;
        sid?: unknown;
        auth_time?: unknown;
      };
      if (
        !isId('user', sub) ||
        !isId('device', did) ||
        !isId('session', sid) ||
        typeof auth_time !== 'number'
      ) {
        throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credentials');
      }
      return { userId: sub, deviceId: did, sessionId: sid, authTime: new Date(auth_time * 1000) };
    },
  };
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

/** The P-256 key material only (exported JWKs may also carry `key_ops`/`ext`, which do not fit the public half). */
function ecKey(jwk: JWK, withPrivate: boolean): JWK {
  const { x, y, d } = jwk;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !x || !y || (withPrivate && !d)) {
    throw new Error('Session keys must be P-256 JWKs');
  }
  return withPrivate && d ? { kty: 'EC', crv: 'P-256', x, y, d } : { kty: 'EC', crv: 'P-256', x, y };
}

function decodeSegment(token: string, index: number): Record<string, unknown> | null {
  try {
    const part = token.split('.')[index];
    if (!part) return null;
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function thumbprintId(jwk: JWK): string {
  return createHash('sha256').update(`${jwk.crv}:${jwk.x}:${jwk.y}`).digest('base64url').slice(0, 16);
}

// ---------------------------------------------------------------- refresh tokens
export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export function newRefreshSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function refreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

export function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const [sessionId, secret, ...rest] = token.split('.');
  if (rest.length || !isId('session', sessionId) || !secret || !/^[A-Za-z0-9_-]{43}$/.test(secret))
    return null;
  return { sessionId, secret };
}

/** Constant-time comparison of two hex digests. */
export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Random opaque token for invitations (256 bits, base64url). */
export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}
