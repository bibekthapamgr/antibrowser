import type { ConsoleConfig } from '@pb/contracts/billing';
import { describe, expect, it } from 'vitest';
import {
  beginSignIn,
  completeSignIn,
  endpointOk,
  isCallback,
  MAX_AUTH_AGE_SECONDS,
  PENDING_KEY,
  pkceChallenge,
  SignInError,
} from '../src/oidc.ts';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const cfg: ConsoleConfig = {
  issuer: 'http://127.0.0.1:8081/realms/pb',
  client_id: 'pb-console',
  authorization_endpoint: 'http://127.0.0.1:8081/realms/pb/protocol/openid-connect/auth',
  token_endpoint: 'http://127.0.0.1:8081/realms/pb/protocol/openid-connect/token',
  scopes: ['openid', 'email', 'profile'],
};
const REDIRECT = 'http://127.0.0.1:8080/console/';

async function started() {
  const storage = new MemoryStorage();
  const url = new URL(await beginSignIn(cfg, storage, REDIRECT));
  return { storage, url, state: url.searchParams.get('state') ?? '' };
}

function tokenEndpoint(answer: unknown, status = 200) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) });
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe('support console sign-in (PKCE)', () => {
  it('computes the RFC 7636 S256 challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('asks the provider for a code with S256, a nonce, a state and a recent sign-in', async () => {
    const { storage, url } = await started();
    const q = url.searchParams;
    expect(url.origin + url.pathname).toBe(cfg.authorization_endpoint);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('pb-console');
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('max_age')).toBe(String(MAX_AUTH_AGE_SECONDS));
    expect(q.get('scope')).toBe('openid email profile');
    const pending = JSON.parse(storage.getItem(PENDING_KEY) ?? '{}');
    expect(q.get('state')).toBe(pending.state);
    expect(q.get('nonce')).toBe(pending.nonce);
    expect(q.get('code_challenge')).toBe(await pkceChallenge(pending.verifier));
    expect(pending.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('exchanges the code once with the verifier and keeps only the ID token', async () => {
    const { storage, state } = await started();
    const pending = JSON.parse(storage.getItem(PENDING_KEY) ?? '{}');
    const { calls, fetchFn } = tokenEndpoint({
      id_token: 'a.b.c',
      access_token: 'provider-access',
      refresh_token: 'provider-refresh',
    });
    const out = await completeSignIn(cfg, storage, `?code=xyz&state=${state}`, fetchFn);
    expect(out).toEqual({ idToken: 'a.b.c', nonce: pending.nonce });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(cfg.token_endpoint);
    expect(Object.fromEntries(calls[0]?.body ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'xyz',
      redirect_uri: REDIRECT,
      client_id: 'pb-console',
      code_verifier: pending.verifier,
    });
    expect(storage.length).toBe(0);
    // The same answer cannot be used twice.
    await expect(completeSignIn(cfg, storage, `?code=xyz&state=${state}`, fetchFn)).rejects.toMatchObject({
      reason: 'not_started',
    });
  });

  it('refuses an answer for another sign-in and forgets the started one', async () => {
    const { storage } = await started();
    const { calls, fetchFn } = tokenEndpoint({ id_token: 'a.b.c' });
    const err = await completeSignIn(cfg, storage, '?code=xyz&state=forged', fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(SignInError);
    expect(err.reason).toBe('state_mismatch');
    expect(calls).toHaveLength(0);
    expect(storage.getItem(PENDING_KEY)).toBeNull();
  });

  it('reports a provider refusal and a failed exchange', async () => {
    let s = await started();
    await expect(
      completeSignIn(cfg, s.storage, `?error=access_denied&state=${s.state}`, tokenEndpoint({}).fetchFn),
    ).rejects.toMatchObject({ reason: 'provider_error' });
    s = await started();
    await expect(
      completeSignIn(
        cfg,
        s.storage,
        `?code=x&state=${s.state}`,
        tokenEndpoint({ error: 'invalid_grant' }, 400).fetchFn,
      ),
    ).rejects.toMatchObject({ reason: 'exchange_failed' });
    s = await started();
    await expect(
      completeSignIn(
        cfg,
        s.storage,
        `?code=x&state=${s.state}`,
        tokenEndpoint({ access_token: 'x' }).fetchFn,
      ),
    ).rejects.toMatchObject({ reason: 'no_id_token' });
  });

  it('allows the provider only over https or on a loopback address', async () => {
    expect(endpointOk('https://id.example.com/auth')).toBe(true);
    expect(endpointOk('http://127.0.0.1:8081/auth')).toBe(true);
    expect(endpointOk('http://localhost:8081/auth')).toBe(true);
    expect(endpointOk('http://id.example.com/auth')).toBe(false);
    expect(endpointOk('https://user:pw@id.example.com/auth')).toBe(false);
    expect(endpointOk('javascript:alert(1)')).toBe(false);
    await expect(
      beginSignIn({ ...cfg, token_endpoint: 'http://id.example.com/token' }, new MemoryStorage(), REDIRECT),
    ).rejects.toMatchObject({ reason: 'bad_config' });
  });

  it('recognises the redirect back only with a state', () => {
    expect(isCallback('?code=x&state=y')).toBe(true);
    expect(isCallback('?error=access_denied&state=y')).toBe(true);
    expect(isCallback('?code=x')).toBe(false);
    expect(isCallback('')).toBe(false);
  });
});
