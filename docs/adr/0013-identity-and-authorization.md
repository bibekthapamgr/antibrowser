# 0013 — Identity, API sessions, organizations and authorization
Status: **Accepted** for the team beta track. Date: 2026-10-13. Owner: backend lead + security owner.
Builds on ADR-0004 (identity provider boundary), ADR-0008 (non-disclosing 404, If-Match/expected_version) and the
milestone 02 rules for deep links and the OS keychain. Amends ADR-0004 on the redirect type and closes its vendor
question.

## Context
Milestone 06: authenticated users operate only their authorized organizations and clients. Journeys: sign up/sign in,
verify account, create organization, switch workspace, invite member, accept invite, enroll device, sign out and revoke
device. Requirements include Authorization Code + PKCE in the system browser, no custom password cryptography,
organization scope enforced in the service layer **and** PostgreSQL row-level security, a five-role matrix combined
with client/profile grants (deny by default), single-use invitations bound to a verified identity, last-owner
protection, recent authentication for ownership transfer, device registration with refresh-token rotation and
revocation, an audit trail without secrets, rate limits, and a previewed local-workspace migration.

## Decisions

### 1. Identity provider: standard OIDC, Keycloak as the reference deployment
- The API and desktop speak **plain OpenID Connect** (discovery, JWKS, Authorization Code + PKCE S256, `nonce`,
  `email`, `email_verified`, `auth_time`). Nothing vendor-specific is coded in; the provider is configuration
  (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`).
- **Reference deployment: Keycloak** (Apache-2.0, self-hostable, MFA/WebAuthn, e-mail verification, identity
  brokering for business SSO/SAML later). CI runs a real Keycloak and performs the full PKCE sign-in against the API
  (`services/api/test/keycloak.test.ts`). A managed provider is acceptable if it supports: a public client with PKCE,
  a private-use-scheme redirect, `nonce`, `email_verified` and `auth_time`. Where Keycloak runs (owner's VPS or a
  managed Keycloak) is an operations choice, not a code change.
- The provider **authenticates people only**: it stores passwords/MFA. We never collect, hash or see a password.
  Organizations, roles, grants and devices live in our database.

### 2. Desktop sign-in
- System browser, Authorization Code + PKCE (S256), fresh `state` and `nonce` per attempt. Redirect URI
  `projectbrowser://auth/callback`, the private-use scheme the installer already registers (milestone 02), instead of
  the loopback redirect ADR-0004 proposed: it works the same on Windows, macOS and Linux and reuses the single-instance
  deep-link path. RFC 8252 accepts both; PKCE makes an intercepted code useless without the verifier, which never
  leaves the manager's memory.
- The callback must match the registered URI exactly, carry the `state` of a pending one-time transaction (SQLite
  `auth_transactions`, 10-minute expiry, consumed on first use) and, when the provider sends it, `iss` equal to the
  configured issuer (RFC 9207). Errors from the provider are shown, never retried automatically.
- The desktop exchanges the code at the token endpoint from discovery (https only), then sends the **ID token once**
  to the API. The provider's own access/refresh tokens are discarded (scopes `openid email profile`, no
  `offline_access`): our API session is the only session.

### 3. API verification of ID tokens
Signature against the discovered JWKS (https; plain http only for loopback in dev/test), `iss`, `aud` = desktop client
id (with several audiences, `azp` must be ours), `exp`, `iat` no older than 10 minutes, `nonce` equal to the one the
desktop sent, algorithms RS256/PS256/ES256/EdDSA only. Each token is **claimed once** (SHA-256 digest in
`used_id_tokens`); a replay fails and is audited. Users are matched by `(issuer, subject)`; e-mail and
`email_verified` are refreshed from every sign-in and only used for invitations and display.

### 4. API sessions (device-bound)
- Enrolling (`POST /v1/devices`) or signing in again on an enrolled device (`POST /v1/auth/token`, `grant_type=id_token`)
  creates a **device session**. Access token: ES256 JWT (`typ: at+jwt`, `sub`, `did`, `sid`, `auth_time`), 10 minutes.
  Refresh token: `ses_<id>.<256-bit secret>`, only its digest stored, **rotated on every use**; presenting the previous
  secret again revokes the session (reuse detection). Idle expiry 14 days, absolute 30 days.
- **Every request** checks that the session, its device and the user are still active, so sign-out, device revocation,
  account disablement and session revocation take effect at the next request, not at token expiry.
- Why our own tokens rather than the provider's: device binding, immediate revocation and reuse detection behave the
  same with any provider, and API authorization never depends on provider-specific claims.
- Signing key: P-256 private JWK from the secret manager (`SESSION_SIGNING_KEY`); `SESSION_PREVIOUS_PUBLIC_KEYS` keeps
  old public keys valid for one access-token lifetime during rotation. Dev/test without a key use a per-process key.
- The desktop keeps the refresh token **only in the OS keychain** (no file fallback) and the access token in memory.
  Refreshes are serialized. **Authentication expiry never deletes local data**: profiles, browser data and settings stay.

### 5. Roles, reach and grants (deny by default)
| Role | Permissions | Reaches |
|---|---|---|
| owner | everything incl. ownership transfer and billing | all clients and profiles |
| admin | members, invitations, clients, grants, profiles, audit; no billing/ownership | all |
| operator | read, open (lease) and snapshot granted profiles | granted only |
| viewer | read granted metadata; cannot open, read snapshots or export | granted only |
| billing | subscription data only (milestone 11) | none |

Grants name a whole client (all its profiles, including later ones) or one profile. The matrix lives in
`packages/contracts` and generates [permission-matrix.md](../permission-matrix.md). The milestone 01 draft role
`manager` is migrated to `admin`.

Decision order on every request: membership (else **404**, audited as `org.access`) → reach (else **404**, identical to
a nonexistent id, including in bulk/search/export) → permission (else **403**, audited as `access.denied`). Nothing is
cached between requests, so removed memberships, grants and role changes apply to the next request.

### 6. Tenant enforcement in two layers
- Service layer: `services/api/src/tenancy.ts` resolves the membership from the authenticated principal; an org id from
  the client is only a lookup key.
- Database: every tenant table has row-level security keyed on `app.org_id`/`app.user_id`, set with
  `set_config(..., true)` inside the request's transaction, so a pooled connection can never keep another request's
  tenant (tested with a one-connection pool). The API role `pb_app` is not the owner, not a superuser and has no
  `BYPASSRLS`. Work before a tenant or user is known (sign-in, refresh rotation, invitation lookup/acceptance, rate
  limits, ID-token claims) runs in owner-defined `SECURITY DEFINER` functions with fixed bodies and a pinned
  `search_path`, executable by `pb_app` only.
- References between tenant rows are **composite** `(org_id, id)` foreign keys (profile→client, grant→membership,
  grant→client, grant→profile), so a row can never point into another organization even through a bug.
- Every profile has exactly one owner organization. Moving between organizations is an export/import (or a future
  transfer workflow), never an `org_id` change: the API has no such field and RLS `WITH CHECK` refuses it.

### 7. Invitations
256-bit random token shown once (in a link), stored as SHA-256; default 7 days, at most 30; single use (row lock in
`app.accept_invitation`); **bound to the invited address**: accepting requires the signed-in user's e-mail, as verified
by the provider, to equal it. Re-inviting an address withdraws the previous open invitation. Invitations assign admin,
operator, viewer or billing — never owner. Tokens in URL paths are masked before any URL is logged.

### 8. Ownership
Ownership moves only through `POST /v1/orgs/{org}/ownership-transfer`: owner only, **sign-in within the last 10 minutes**
(`REAUTHENTICATION_REQUIRED` otherwise; the desktop then re-runs the sign-in with `prompt=login`), target membership
version required; the target becomes owner and the caller admin, audited. A deferred constraint trigger refuses any
commit that would leave an organization without an owner (`LAST_OWNER`); admins cannot change or remove owners.

### 9. Devices
Devices are enrolled at sign-in and listed per user. Revoking one ends its sessions immediately; its refresh token and
access tokens stop working at the next request. Revocation **cannot erase** data or secrets already copied from a
compromised device (documented in the threat review). Leases and snapshot commits from a signed-in device must name
that device.

### 10. Audit
`audit_events` is the security audit: actor user and device, action, target, outcome (`success`/`denied`/`failed`),
request id and time, small structured details. Never tokens, secrets, e-mail bodies or browsing history. Successful
changes are written in the same transaction as the change; denials and sign-in failures in their own transaction. The
API role may insert and read its tenant's entries, never update or delete. (The milestone 01 `audit_entries` table
remains the worker's index of domain events from the outbox.)

### 11. Rate limits
Fixed windows in PostgreSQL shared by all API instances, keyed by SHA-256 digests: sign-in 30/10 min per address,
refresh 120/10 min per address and 30/10 min per session, invitations 100/day per organization and 30/hour per
inviter, invitation preview/accept 10/10 min per user and 30/10 min per address, organization creation 10/day per user.
`TRUST_PROXY_HOPS` sets how many reverse proxies are trusted for the client address. The worker purges old counters.

### 12. Local workspace → organization
Explicit preview and mapping: the desktop sends `dry_run=true` and shows which clients are created, matched by folded
name or mapped to an existing client; the real run requires an `Idempotency-Key` and commits clients, profiles,
outbox events and one audit entry in one transaction. Organization profiles get **new** server ids. The desktop keeps
the local records untouched until that commit succeeds and only then records the local→organization mapping. Browser
data stays on the device (encrypted sync is milestone 07).

### 13. Offline and failure behaviour
Cached organization metadata is shown as **stale** and never authorizes a new shared-session launch: opening an
organization profile needs a successful online authorization (lease) first. Local-only profiles stay separate from
organization profiles and keep working offline and signed out. A later subscription failure (milestone 11) can never
grant access or change ownership.

## Consequences
- Operators need grants before they see anything; the admin UI must make granting obvious.
- The provider must be reachable for sign-in and re-authentication; an outage does not affect already signed-in
  devices until their refresh tokens expire, and never affects local profiles.
- Business SSO (SAML/OIDC federation) is added in the provider (Keycloak identity brokering) without API changes.
- Open for later milestones: MFA policy is configured in the provider (recommended: required for owners and admins);
  `lease.force_release` (08) and billing permissions (11) are reserved in the matrix.
