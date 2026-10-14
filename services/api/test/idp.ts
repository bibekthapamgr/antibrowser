/**
 * An in-process identity provider for tests: an RSA key pair, ID tokens signed with it and the verifier the API uses,
 * bound to those keys. Real discovery over HTTP is covered in oidc.test.ts; Keycloak runs in CI (keycloak.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from 'jose';
import { createIdTokenVerifier, type IdTokenVerifier } from '../src/oidc.ts';

export const TEST_ISSUER = 'https://idp.example.test/realms/pb';
export const TEST_CLIENT_ID = 'pb-desktop-test';

export interface TestIdp {
  verifier: IdTokenVerifier;
  /** A verifier for another client of the same provider (milestone 11: the support console). */
  verifierFor(clientId: string): IdTokenVerifier;
  /** Signs an ID token; `overrides` replace standard claims (set a claim to undefined to omit it). */
  idToken(claims: { sub: string; nonce: string } & Partial<IdClaims>, opts?: SignOptions): Promise<string>;
}

interface IdClaims {
  email: string;
  email_verified: boolean;
  name: string;
  auth_time: number;
  iat: number;
  exp: number;
  aud: string | string[];
  azp: string;
  iss: string;
}

interface SignOptions {
  /** Sign with an unrelated key (signature must fail). */
  foreignKey?: boolean;
  alg?: 'RS256' | 'HS256';
}

export async function testIdp(): Promise<TestIdp> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const foreign = await generateKeyPair('RS256', { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const verifier = createIdTokenVerifier({
    issuer: TEST_ISSUER,
    clientId: TEST_CLIENT_ID,
    allowLoopbackHttp: false,
    keys: createLocalJWKSet({ keys: [publicJwk] }),
  });
  return {
    verifier,
    verifierFor(clientId) {
      return createIdTokenVerifier({
        issuer: TEST_ISSUER,
        clientId,
        allowLoopbackHttp: false,
        keys: createLocalJWKSet({ keys: [publicJwk] }),
      });
    },
    async idToken(claims, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload: JWTPayload = {
        iss: TEST_ISSUER,
        aud: TEST_CLIENT_ID,
        iat: now,
        exp: now + 300,
        auth_time: now,
        email_verified: true,
        // Unique per token, like a real provider's token identifier (tokens must not collide on one-time use).
        jti: randomBytes(8).toString('hex'),
        ...claims,
      };
      for (const [k, v] of Object.entries(payload)) if (v === undefined) delete payload[k];
      if (opts.alg === 'HS256') {
        return new SignJWT(payload)
          .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
          .sign(new TextEncoder().encode('x'.repeat(32)));
      }
      return new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
        .sign(opts.foreignKey ? foreign.privateKey : pair.privateKey);
    },
  };
}

/** A fresh nonce (the desktop generates one per sign-in). */
export const nonce = (): string => randomBytes(24).toString('base64url');
