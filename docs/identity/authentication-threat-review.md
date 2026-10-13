# Authentication and authorization threat review (milestone 06)

Scope: desktop sign-in, ID-token handling in the API, device-bound sessions, organization authorization, invitations,
audit and rate limits. Decisions: [ADR-0013](../adr/0013-identity-and-authorization.md). Each row names the threat,
the control, and the test that shows the control works. Residual risks are listed at the end; a full penetration test
is part of milestone 12.

## Desktop sign-in (Authorization Code + PKCE in the system browser)

| Threat | Control | Evidence |
|---|---|---|
| Password captured by our app | No embedded login view: the provider's page opens in the system browser; the manager never sees a password | Design; `begin_sign_in` opens the URL with the OS opener |
| Another app registers `projectbrowser://` and steals the code | PKCE S256: the verifier never leaves the manager's memory, so a stolen code cannot be exchanged; the provider enforces PKCE for the client | `pb-cloud` PKCE vector test; `keycloak.test.ts` (wrong verifier → `invalid_grant`, no PKCE → refused) |
| Login CSRF / injected callback | Fresh `state` per attempt, recorded as a one-time transaction (hashed) with a 10-minute expiry; the callback must match the pending attempt | `tests/account.rs` (unknown state not bound, replay refused, cancelled attempt refused) |
| Mix-up (response from another provider) | `iss` in the response (RFC 9207) must equal the configured issuer; discovery must name the same issuer | `refuses_replayed_mismatched_or_unknown_callbacks`, `oidc.test.ts` |
| Malicious deep links | Only `projectbrowser://auth/callback` with a strict parameter set and character rules; never logged, never opened as a URL or path | `deeplink.rs` unit tests (incl. Keycloak-shaped callbacks) |
| Redirect to an attacker's URL | The provider only redirects to the registered URI; the API publishes the redirect URI and the desktop refuses any other | `keycloak.test.ts` (unregistered redirect → 400, no redirect) |
| Downgrade to plain http | Provider endpoints and the API must be https; http only for loopback addresses (developer servers) | `http.rs` tests; `server_address_rules` |
| Bearer token sent to another origin through a redirect | The HTTP client never follows redirects | `pb-cloud` transport configuration |

## ID tokens in the API

| Threat | Control | Evidence |
|---|---|---|
| Forged or tampered token | Signature against the provider's JWKS from discovery (https); algorithms RS256/PS256/ES256/EdDSA only (no `none`, no HMAC) | `auth.test.ts` (foreign key, HS256), `oidc.test.ts` |
| Token for another application or provider | `aud` = desktop client id (several audiences only with `azp` = ours), `iss` = configured issuer | `auth.test.ts` |
| Old or replayed token | `exp`, `iat` ≤ 10 minutes old, `nonce` equal to the desktop's, and **one-time use** (digest stored until expiry) claimed in the transaction that uses it | `auth.test.ts` (replay refused and audited), `keycloak.test.ts` |
| Account takeover by e-mail | Users are matched by issuer + subject, never by e-mail; e-mail is only used for invitations and display | `auth.test.ts` (same e-mail, different subject → different user) |
| Disabled account keeps working | `disabled_at` blocks sign-in, refresh and every request | `auth.test.ts` |
| Unverified address used to gain access | Creating organizations and accepting invitations require `email_verified` from the provider | `organizations.test.ts`, `keycloak.test.ts` |

## Sessions

| Threat | Control | Evidence |
|---|---|---|
| Stolen access token | 10-minute ES256 JWT bound to session + device; every request checks the session, device and user in the database, so revocation applies at the next request | `auth.test.ts` (sign-out, device revocation) |
| Stolen refresh token | Stored only in the OS keychain (memory only when unavailable; never a file); rotated at every use; presenting the previous value revokes the session; idle 14 days, absolute 30 days | `tests/account.rs` (keychain/DB/WAL contents), `auth.test.ts` (reuse detection) |
| Concurrent refreshes end the session by mistake | The manager serializes refreshes | `account.rs` refresh lock |
| ID token used as an API token | API tokens must carry our session issuer, `typ: at+jwt`, ES256 and our key id | `auth.test.ts` |
| Signing key compromise | Key from the secret manager; rotation keeps old public keys valid for one access-token lifetime (`SESSION_PREVIOUS_PUBLIC_KEYS`); all sessions can be revoked in the database | Configuration (`packages/config`) |
| Development tokens in production | Refused outside `APP_ENV=dev|test` by `packages/config`; never count as a recent sign-in | `env.test.ts`, `authorization.test.ts` |
| Sensitive action from a stolen session | Ownership transfer needs a sign-in within 10 minutes (`REAUTHENTICATION_REQUIRED` → `prompt=login`) | `organizations.test.ts`, UI e2e |

## Authorization and tenancy

| Threat | Control | Evidence |
|---|---|---|
| Reading or changing another organization's data by id | Membership derived from the session; non-members and out-of-reach ids get the same 404 as nonexistent ids; RLS underneath; composite same-organization foreign keys | [tenant isolation report](tenant-isolation-report.md) |
| Leaking tenant context between pooled connections | `set_config(…, true)` inside each request's transaction; tested with a one-connection pool, including failed requests | `cross-tenant.test.ts` |
| Privilege escalation | Owner role only through the transfer endpoint; invitations cannot assign owner; admins cannot change or remove owners; last owner protected by a deferred trigger | `organizations.test.ts`, `database.test.ts` |
| Operators/viewers seeing everything | Grants (client or profile), deny by default; viewers cannot open, read snapshots or export | `authorization.test.ts` (role × operation matrix) |
| Removed access lingering | No authorization caching: membership, role and grants are read on every request | `organizations.test.ts` |
| Mass assignment / moving a profile between organizations | Request schemas reject unknown fields; `org_id` is not writable; RLS `WITH CHECK` refuses a change | `cross-tenant.test.ts`, `tenant-isolation.test.ts` |
| SQL injection | All values are parameters; scope predicates are fixed strings; search text is escaped for `LIKE` | Code review; tests with special characters |
| The manager window used to call arbitrary API endpoints | The shell only relays an allow-list of method + path shapes and query keys; sign-in, token, lease, snapshot and import calls are shell-only; the window never sees a token | `allow.rs` tests, `tests/account.rs` |

## Invitations

| Threat | Control | Evidence |
|---|---|---|
| Guessing a token | 256 random bits; previews and acceptance are rate-limited per user and per address | `organizations.test.ts` |
| Token leaked from logs or storage | Stored as SHA-256 only; URL paths with a token are masked before logging; never in audit details | `auth.test.ts` (log capture) |
| Forwarded or intercepted invitation | Bound to the invited verified e-mail; single use; expires (default 7 days, at most 30); can be withdrawn; re-inviting withdraws the earlier one | `organizations.test.ts` |
| Invitation spam | 100 per organization per day, 30 per inviter per hour | `organizations.test.ts` |

## Audit and logs

Audit entries record actor, action, target, outcome, request id and time; denials (`org.access`, `access.denied`) and
failed sign-ins are recorded even though the request failed. Never tokens, codes, passwords, e-mail bodies or browsing
history. The API role cannot update or delete entries (`database.test.ts`). Request logs mask authorization headers,
idempotency keys and invitation tokens in URLs (`auth.test.ts`).

## Residual risks and follow-ups

1. **A compromised device keeps what it already has.** Revoking it stops future refreshes and server operations, but
   cannot erase local data or secrets already copied from it (stated in the UI and the API description).
2. **The provider is the root of identity.** MFA, password policy, account recovery and e-mail verification are
   configured in Keycloak (see [keycloak-setup.md](keycloak-setup.md)); MFA for owners and admins is strongly
   recommended. A provider compromise allows sign-in as its users (but not into organizations they do not belong to).
3. **E-mail changes at the provider** change which invitations a person can accept; existing memberships are unaffected.
4. **A refresh answer lost in transit** (network failure after rotation) ends the session at the next refresh because
   the old token is then a reuse; the person signs in again. No local data is affected.
5. **Private-use scheme hijacking** remains possible on desktop OSes; PKCE makes an intercepted code useless.
6. **Clock skew** of up to 60 seconds is tolerated for ID tokens.
7. **Rate limits are per address and per account**; a distributed attack is handled at the edge (milestone 13).
8. Penetration test and independent review: milestone 12.
