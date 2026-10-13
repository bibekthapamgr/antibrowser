/** API session keys: keys exported by WebCrypto (as the setup guide creates them), rotation and refusal. */
import { describe, expect, it } from 'vitest';
import { createSessionKeys } from '../src/session.ts';

async function exportedKey(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const { d: _d, key_ops: _ops, ...publicJwk } = jwk;
  return { privateJwk: JSON.stringify({ ...jwk, kid }), publicJwk: { ...publicJwk, kid } };
}

const claims = {
  userId: 'usr_01J9ZSEED0A100000000000000',
  deviceId: 'dev_01J9ZSEED0A1D1000000000000',
  sessionId: 'ses_01J9ZSEED0S100000000000000',
  authTime: new Date(Math.floor(Date.now() / 1000) * 1000),
};

describe('session keys', () => {
  it('accept a JWK exported by WebCrypto (with key_ops and ext) and round-trip a token', async () => {
    const { privateJwk } = await exportedKey('k1');
    expect(privateJwk).toContain('key_ops');
    const keys = await createSessionKeys({
      issuer: 'pb-api-prod',
      signingKeyJwk: privateJwk,
      previousPublicKeysJwk: null,
    });
    const token = await keys.sign(claims, 600);
    expect(await keys.verify(token)).toEqual(claims);
  });

  it('keep tokens signed with the previous key valid after a rotation, and refuse unknown keys', async () => {
    const old = await exportedKey('old');
    const next = await exportedKey('new');
    const before = await createSessionKeys({
      issuer: 'pb-api-prod',
      signingKeyJwk: old.privateJwk,
      previousPublicKeysJwk: null,
    });
    const token = await before.sign(claims, 600);
    const rotated = await createSessionKeys({
      issuer: 'pb-api-prod',
      signingKeyJwk: next.privateJwk,
      previousPublicKeysJwk: JSON.stringify([old.publicJwk]),
    });
    expect(await rotated.verify(token)).toEqual(claims);
    const later = await createSessionKeys({
      issuer: 'pb-api-prod',
      signingKeyJwk: next.privateJwk,
      previousPublicKeysJwk: null,
    });
    await expect(later.verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    // A token of another issuer is simply not ours.
    const other = await createSessionKeys({
      issuer: 'pb-api-staging',
      signingKeyJwk: next.privateJwk,
      previousPublicKeysJwk: null,
    });
    expect(await rotated.verify(await other.sign(claims, 600))).toBeNull();
  });

  it('refuse private keys among the previous public keys', async () => {
    const k = await exportedKey('k');
    await expect(
      createSessionKeys({
        issuer: 'x',
        signingKeyJwk: k.privateJwk,
        previousPublicKeysJwk: `[${k.privateJwk}]`,
      }),
    ).rejects.toThrow(/must not contain private keys/);
  });
});
