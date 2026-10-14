/** ID-token verification against a provider discovered over HTTP (loopback, as a dev/test provider would be). */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdTokenVerifier } from '../src/oidc.ts';

let server: Server;
let issuer: string;
let privateKey: CryptoKey;
let discoveryIssuer: string | null = null;
let jwksUri: string | null = null;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  server = createServer((req, res) => {
    if (req.url === '/realm/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ issuer: discoveryIssuer ?? issuer, jwks_uri: jwksUri ?? `${issuer}/certs` }));
    } else if (req.url === '/realm/certs') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realm`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const sign = (claims: Record<string, unknown>) =>
  new SignJWT({ nonce: 'n'.repeat(20), email: 'a@b.test', email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(issuer)
    .setAudience('desktop')
    .setSubject('subject-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

describe('OIDC discovery and verification', () => {
  it('verifies a token using the discovered keys', async () => {
    const verifier = createIdTokenVerifier({ issuer, clientId: 'desktop', allowLoopbackHttp: true });
    const identity = await verifier.verify(await sign({ name: 'A‮B\u0007 Person' }), 'n'.repeat(20));
    expect(identity).toMatchObject({
      issuer,
      subject: 'subject-1',
      email: 'a@b.test',
      emailVerified: true,
      displayName: 'AB Person',
    });
  });

  it('refuses plain-http discovery unless explicitly allowed for loopback', async () => {
    const verifier = createIdTokenVerifier({ issuer, clientId: 'desktop', allowLoopbackHttp: false });
    await expect(verifier.verify(await sign({}), 'n'.repeat(20))).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('refuses a discovery document naming another issuer', async () => {
    discoveryIssuer = 'https://elsewhere.example.test';
    try {
      const verifier = createIdTokenVerifier({ issuer, clientId: 'desktop', allowLoopbackHttp: true });
      await expect(verifier.verify(await sign({}), 'n'.repeat(20))).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
    } finally {
      discoveryIssuer = null;
    }
  });

  it('refuses keys published at a non-loopback plain-http address', async () => {
    jwksUri = 'http://keys.example.test/certs';
    try {
      const verifier = createIdTokenVerifier({ issuer, clientId: 'desktop', allowLoopbackHttp: true });
      await expect(verifier.verify(await sign({}), 'n'.repeat(20))).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
    } finally {
      jwksUri = null;
    }
  });

  it('treats unverified or malformed e-mail as unverified', async () => {
    const verifier = createIdTokenVerifier({ issuer, clientId: 'desktop', allowLoopbackHttp: true });
    const unverified = await verifier.verify(await sign({ email_verified: false }), 'n'.repeat(20));
    expect(unverified.emailVerified).toBe(false);
    const stringly = await verifier.verify(await sign({ email_verified: 'true' }), 'n'.repeat(20));
    expect(stringly.emailVerified).toBe(false);
    const malformed = await verifier.verify(await sign({ email: 'not an address' }), 'n'.repeat(20));
    expect(malformed).toMatchObject({ email: null, emailVerified: false });
  });

  it('a token without auth_time never counts as a recent sign-in (milestone 12 review)', async () => {
    const verifier = createIdTokenVerifier({ issuer, clientId: 'desktop', allowLoopbackHttp: true });
    const now = Math.floor(Date.now() / 1000);
    const without = await verifier.verify(await sign({}), 'n'.repeat(20));
    expect(without.authTime.getTime()).toBe(0);
    const fresh = await verifier.verify(await sign({ auth_time: now }), 'n'.repeat(20));
    expect(fresh.authTime.getTime()).toBe(now * 1000);
  });

  it('requires the nonce claim', async () => {
    const verifier = createIdTokenVerifier({ issuer, clientId: 'desktop', allowLoopbackHttp: true });
    await expect(verifier.verify(await sign({ nonce: undefined }), 'n'.repeat(20))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});
