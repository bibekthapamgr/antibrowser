/**
 * Staff sign-in for the support console: OpenID Connect Authorization Code with PKCE (S256) in the browser, using the
 * console's own public client. The provider's ID token is exchanged once at POST /v1/support/sessions for a 30-minute
 * staff token; the provider's access and refresh tokens are dropped at once and never stored.
 *
 * Only the one-time sign-in values (state, nonce, PKCE verifier) are kept in sessionStorage, and only between the
 * redirect out and the redirect back; they are removed before the code is exchanged.
 */
import type { ConsoleConfig } from '@pb/contracts/billing';

export const PENDING_KEY = 'pb-console-sign-in';
/** The provider must have authenticated the person within this many seconds (the server allows 15 minutes). */
export const MAX_AUTH_AGE_SECONDS = 600;
const PENDING_MAX_MS = 10 * 60_000;

export interface PendingSignIn {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

export type SignInFailure =
  | 'not_started'
  | 'state_mismatch'
  | 'expired'
  | 'provider_error'
  | 'exchange_failed'
  | 'no_id_token'
  | 'bad_config';

export class SignInError extends Error {
  readonly reason: SignInFailure;
  constructor(reason: SignInFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** URL-safe random string from `bytes` random bytes (43 characters for 32 bytes). */
export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE S256 challenge of a verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** The provider's endpoints must be https, or http on a loopback address (development and the SSH tunnel). */
export function endpointOk(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function authorizeUrl(cfg: ConsoleConfig, p: PendingSignIn, challenge: string): string {
  const u = new URL(cfg.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.client_id,
    redirect_uri: p.redirectUri,
    scope: cfg.scopes.join(' '),
    state: p.state,
    nonce: p.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    max_age: String(MAX_AUTH_AGE_SECONDS),
  }).toString();
  return u.toString();
}

/** Starts sign-in: remembers the one-time values and returns the provider address to go to. */
export async function beginSignIn(
  cfg: ConsoleConfig,
  storage: Storage,
  redirectUri: string,
): Promise<string> {
  if (!endpointOk(cfg.authorization_endpoint) || !endpointOk(cfg.token_endpoint)) {
    throw new SignInError('bad_config', 'The identity provider’s address is not allowed');
  }
  const p: PendingSignIn = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(48),
    redirectUri,
    createdAt: Date.now(),
  };
  storage.setItem(PENDING_KEY, JSON.stringify(p));
  return authorizeUrl(cfg, p, await pkceChallenge(p.verifier));
}

/** Whether this page load is the provider sending the person back (a code or an error with a state). */
export function isCallback(search: string): boolean {
  const q = new URLSearchParams(search);
  return q.has('state') && (q.has('code') || q.has('error'));
}

/**
 * Finishes sign-in after the redirect back: checks the state against the one remembered (and forgets it, so a code
 * can be used once), exchanges the code with the PKCE verifier, and returns the ID token with its nonce.
 */
export async function completeSignIn(
  cfg: ConsoleConfig,
  storage: Storage,
  search: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ idToken: string; nonce: string }> {
  const q = new URLSearchParams(search);
  const raw = storage.getItem(PENDING_KEY);
  storage.removeItem(PENDING_KEY);
  if (!raw) throw new SignInError('not_started', 'Sign-in was not started from this page; start again');
  let p: PendingSignIn;
  try {
    p = JSON.parse(raw) as PendingSignIn;
  } catch {
    throw new SignInError('not_started', 'Sign-in was not started from this page; start again');
  }
  if (!p.state || q.get('state') !== p.state) {
    throw new SignInError(
      'state_mismatch',
      'The sign-in answer does not belong to this sign-in; start again',
    );
  }
  if (Date.now() - p.createdAt > PENDING_MAX_MS) {
    throw new SignInError('expired', 'Sign-in took too long; start again');
  }
  const error = q.get('error');
  if (error) {
    throw new SignInError(
      'provider_error',
      `The identity provider refused the sign-in (${error.slice(0, 64)})`,
    );
  }
  const code = q.get('code') ?? '';
  if (!endpointOk(cfg.token_endpoint)) {
    throw new SignInError('bad_config', 'The identity provider’s address is not allowed');
  }
  let res: Response;
  try {
    res = await fetchFn(cfg.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: p.redirectUri,
        client_id: cfg.client_id,
        code_verifier: p.verifier,
      }).toString(),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw new SignInError('exchange_failed', 'The identity provider could not be reached');
  }
  if (!res.ok) throw new SignInError('exchange_failed', 'The identity provider did not accept the sign-in');
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown };
  // Only the ID token is used; the provider's access and refresh tokens are not kept anywhere.
  if (typeof body.id_token !== 'string') throw new SignInError('no_id_token', 'No ID token was returned');
  return { idToken: body.id_token, nonce: p.nonce };
}
