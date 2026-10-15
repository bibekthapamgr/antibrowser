/**
 * ID-token verification for sign-in (ADR-0004, ADR-0013). The desktop runs Authorization Code + PKCE against the
 * identity provider in the system browser and hands the resulting ID token to the API, which verifies it here:
 * signature against the provider's published keys, issuer, audience (the desktop client id), expiry, issue time,
 * the nonce the desktop generated for this sign-in, and an allow-listed signature algorithm.
 *
 * The provider only authenticates people. Organizations, roles and grants live in our database.
 */
import { ApiError } from '@pb/contracts';
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  /** When the person last actually authenticated at the provider (falls back to the token's issue time). */
  authTime: Date;
  /** The ID token's own expiry (used to keep its one-time-use record exactly as long as needed). */
  expiresAt: Date;
  /**
   * R5: the provider's authentication method references (`amr`), e.g. `["pwd", "otp"]` — the staff console flow
   * sets them on its password and one-time-code steps. Empty when the provider does not send the claim.
   */
  amr: string[];
}

export interface IdTokenVerifier {
  verify(idToken: string, nonce: string): Promise<VerifiedIdentity>;
}

const ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'];
/** ID tokens older than this are refused even if not expired (they are exchanged right after sign-in). */
const MAX_ID_TOKEN_AGE_SECONDS = 600;

export interface OidcOptions {
  issuer: string;
  clientId: string;
  /** Allows http:// discovery and keys on loopback addresses (dev/test identity providers only). */
  allowLoopbackHttp: boolean;
  /** Tests may inject keys instead of discovery. */
  keys?: JWTVerifyGetKey;
}

export function createIdTokenVerifier(opts: OidcOptions): IdTokenVerifier {
  let keys = opts.keys;
  return {
    async verify(idToken, nonce) {
      keys ??= createRemoteJWKSet(await discoverJwksUri(opts.issuer, opts.allowLoopbackHttp), {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
      });
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(idToken, keys, {
          issuer: opts.issuer,
          audience: opts.clientId,
          algorithms: ALGORITHMS,
          maxTokenAge: MAX_ID_TOKEN_AGE_SECONDS,
          clockTolerance: 60,
          requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
        }));
      } catch {
        throw new ApiError('UNAUTHENTICATED', 'The sign-in could not be verified');
      }
      // Several audiences are allowed by the spec only with an authorized party equal to our client.
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== opts.clientId) {
        throw new ApiError('UNAUTHENTICATED', 'The sign-in could not be verified');
      }
      if (payload.nonce !== nonce) throw new ApiError('UNAUTHENTICATED', 'The sign-in could not be verified');
      const sub = payload.sub ?? '';
      if (sub.length === 0 || sub.length > 255) {
        throw new ApiError('UNAUTHENTICATED', 'The sign-in could not be verified');
      }
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
      const validEmail =
        email !== null && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
      // Milestone 12 review: without the provider's own auth_time the sign-in never counts as recent (a silent
      // single-sign-on token must not satisfy step-up checks or staff sign-in).
      const authTimeSeconds = typeof payload.auth_time === 'number' ? payload.auth_time : 0;
      return {
        issuer: opts.issuer,
        subject: sub,
        email: validEmail,
        emailVerified: validEmail !== null && payload.email_verified === true,
        displayName: displayName(payload, validEmail),
        authTime: new Date(authTimeSeconds * 1000),
        expiresAt: new Date(((payload.exp ?? 0) + 60) * 1000),
        amr: Array.isArray(payload.amr)
          ? payload.amr.filter((v): v is string => typeof v === 'string' && v.length <= 32).slice(0, 10)
          : [],
      };
    },
  };
}

/** A printable, bounded display name: provider name claims, else the e-mail's local part, else "User". */
function displayName(payload: JWTPayload, email: string | null): string {
  const raw = [payload.name, payload.preferred_username, email?.split('@')[0]].find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from a display name
  const clean = (raw ?? 'User').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim();
  return [...clean].slice(0, 120).join('') || 'User';
}

async function discoverJwksUri(issuer: string, allowLoopbackHttp: boolean): Promise<URL> {
  const allowed = (url: URL) =>
    url.protocol === 'https:' ||
    (allowLoopbackHttp &&
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  try {
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
    if (!res.ok || doc.issuer !== issuer || !doc.jwks_uri) throw new Error('bad discovery');
    const uri = new URL(doc.jwks_uri);
    if (!allowed(uri)) throw new Error('insecure jwks_uri');
    return uri;
  } catch {
    throw new ApiError('UNAVAILABLE', 'The identity provider is unavailable');
  }
}

export interface OidcEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
}

/** The provider's authorization and token endpoints (for the support console's own sign-in), same address rules. */
export async function discoverEndpoints(issuer: string, allowLoopbackHttp: boolean): Promise<OidcEndpoints> {
  const allowed = (url: URL) =>
    url.protocol === 'https:' ||
    (allowLoopbackHttp &&
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  try {
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    const doc = (await res.json()) as {
      issuer?: string;
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    if (!res.ok || doc.issuer !== issuer || !doc.authorization_endpoint || !doc.token_endpoint) {
      throw new Error('bad discovery');
    }
    const auth = new URL(doc.authorization_endpoint);
    const token = new URL(doc.token_endpoint);
    if (!allowed(auth) || !allowed(token)) throw new Error('insecure endpoints');
    return { authorization_endpoint: auth.toString(), token_endpoint: token.toString() };
  } catch {
    throw new ApiError('UNAVAILABLE', 'The identity provider is unavailable');
  }
}
