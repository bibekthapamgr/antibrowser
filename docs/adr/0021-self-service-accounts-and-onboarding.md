# 0021 — Self-service accounts and automatic onboarding (R2)
Status: **Accepted (revised-roadmap track)**. Date: 2026-10-15. Owner: backend lead with the desktop lead and the
security owner. Builds on ADR-0013 (identity and authorization), ADR-0018 (billing and staff) and ADR-0020 (unified
workspace model).

## Context
Until R2 every account was made by the owner on the server (`keycloak-setup.sh add-user`) and every organization by
hand. The revised roadmap requires that a customer can sign up, verify their address and land in a working
workspace, and that an invited teammate lands in the inviting team, **without owner intervention**. Constraints:
reuse the stack (Keycloak/OIDC, PKCE desktop sign-in, organizations, invitations, token rotation); identity comes
from verified claims, never from the browser; staff stay separate with a second factor; one workspace and one trial
per direct signup even when desktop and browser finish at the same moment.

## Decision

### 1. Accounts at the identity provider, only where e-mail works
- The customer realm allows self-registration, requires e-mail verification and offers password reset **only when a
  mail server is configured** (`/etc/project-browser/smtp.env`, the owner's file). Without one, registration stays
  off: an address that cannot be verified could never create a workspace anyway.
- Security e-mails (verification, password reset) are sent by Keycloak with the product's wording (theme `pb`).
  Product e-mails (invitation links, welcome) are sent by our worker (§5). Keycloak events record e-mail sends and
  errors for 7 days; `keycloak-setup.sh email-status` shows both senders' results **without addresses**.
- Generic recovery answers come from Keycloak (it does not reveal whether an address exists). Brute-force
  protection and the password policy stay. Rate limits for registration and reset requests at the provider belong to
  the public reverse proxy (R6); the API limits its own steps (§3).

### 2. Staff stay separate, with a second factor every time
- The support console client signs in through its own flow `pb-staff-browser`: password **and** one-time code on
  every sign-in, an authenticator app configured at the first one, cookie single sign-on and identity-provider
  redirects disabled (a customer session in the same browser never opens the console). This resolves finding S1.
- Public signup never creates staff: staff roles exist only in the API's `platform_staff` table, granted by the
  server command `staff.ts`. Customer tokens are refused on `/v1/support/*` (staff tokens are a different kind).

### 3. One onboarding call, decided by the server
`POST /v1/onboarding/complete` (idempotent) and `GET /v1/onboarding/status`. The body may carry only: terms version
to accept, marketing consent, a workspace name, a plan **intent** (catalog id, never a price), an invitation token,
a chosen workspace, or `create_own`. It never names a user, role or e-mail. Order of decisions:

1. **Invitation first**: validated token, the caller's *verified* address equals the invited one, not expired or
   withdrawn, the workspace not suspended, a free seat now (members only). Accepted once; the invited workspace
   becomes the default. No personal workspace, no payment. Existing memberships stay.
2. **Explicit choice** among the caller's non-suspended workspaces.
3. **Existing default** still reachable: nothing changes.
4. **Returning person**: their only owned workspace, else (several owned) a choice asked **once** (`choose`), else
   the workspace they were invited to. Never a new workspace, never a fresh trial, nothing merged or moved.
5. **Direct signup**: only with a verified address, no suspended account for that address, no waiting invitations
   (unless `create_own`), and the current terms accepted. Then, in **one transaction** with the onboarding record:
   the organization, the owner membership and the trial.

Concurrency: the person's `onboarding_state` row is inserted if missing and locked `for update` for the whole
decision; `bootstrap_org_id` is unique. A desktop and a browser finishing together produce one workspace and one
trial (tested with five parallel calls). A failure rolls everything back; `attempts` and `last_error` are recorded
in their own transaction so the status page can offer "try again".

### 4. Trial eligibility is per verified address
`trial_claims` keeps one trial clock per verified address (SHA-256 of it) and per user. Any later workspace of the
same person or address — through onboarding, `create_own` or the older `POST /organizations` — **shares** that clock
instead of starting a new 14 days; a new identity for an address whose trial ended starts restricted until it
subscribes. Existing owners' earliest trial workspace was back-filled as their claim. A disabled account's address
cannot create a fresh owner workspace through a new identity (`ACCOUNT_SUSPENDED`). Workspaces gain `suspended_at`:
a suspended workspace cannot be joined (an invitation never revives it) and is never anyone's default.

### 5. E-mail tasks through the database, sealed links
`email_tasks` is written in the transaction that causes the e-mail (invitation created, workspace created) and sent
by the worker with retries and backoff (SKIP LOCKED: two workers never send one twice; at least once on a crash).
Template variables, including invitation links, are sealed with AES-256-GCM under `EMAIL_TASK_KEY` (never in the
database; the task id is the additional data) and erased once sent or given up. Like the outbox, the API may insert
but never read the queue. Without a key (no mail server) nothing is queued and the inviter sees the link, as before.

### 5a. Terms and marketing consent are separate records
`user_consents` is append-only: terms acceptance per version (never a "no") and marketing consent (given or
withdrawn). Creating a workspace needs the current `TERMS_VERSION`; marketing is optional.

### 6. Web portal: backend-for-frontend, no token in the browser
- The API runs Authorization Code + PKCE with state and nonce for the portal's own public client
  (`project-browser-web`, redirect `<WEB_ORIGIN>/v1/web/auth/callback` only), exchanges the code server side and
  verifies the ID token exactly like a desktop sign-in (one-time use, issuer, audience, nonce, age).
- The browser gets one opaque cookie (`pb_web`, `__Host-pb_web` on https): HttpOnly, SameSite=Lax, Path=/, Secure on
  https; the database keeps only its SHA-256 (`web_sessions`), with a 30-minute idle and 12-hour absolute lifetime.
- Changes need `x-csrf-token` (derived from the cookie secret, never stored) **and** `Origin` equal to `WEB_ORIGIN`
  (and `Sec-Fetch-Site: same-origin` when sent). Only routes marked `web: true` accept the cookie (deny by default):
  `/me`, `/me/workspaces`, `/me/capabilities`, `/me/onboarding`, `/onboarding/*`, `/invitations/{token}` (+accept),
  `GET /orgs/{org}`, `/web/auth/*`. Staff routes never.
- A new session id at sign-in and after a privilege change (onboarding created or joined a workspace, an invitation
  accepted). Sign-out ends this browser's session; "sign out everywhere" (`/web/auth/revoke-all`) ends every portal
  **and** desktop session of the account. Return addresses are limited to `/app/…`.
- The portal page (`/app/`, `apps/web-portal`) is static, served by the API with `default-src 'none'`, scripts and
  styles from itself only, no framing; it never renders data as HTML.

### 7. Desktop
Sign in / Create account (OIDC `prompt=create`) in the system browser, as before (keychain, no session secret in
deep links). A build may carry its production server (`PB_DEFAULT_SERVER`, applied once; clearing it is respected).
After sign-in the app completes onboarding by itself and opens **Profiles**; a dialog appears only for a decision
(terms for a new workspace, a waiting invitation, which owned workspace first, verify your address).

## Consequences
- Additive schema (migration 0013); one R1 check constraint was replaced (it made deleting a default workspace fail).
  Earlier routes are unchanged except: `POST /orgs` shares the trial clock; invitation creation also queues an e-mail
  (`email_delivery` in the answer); accepting into a suspended or full workspace is refused.
- The test server's Keycloak and links use `http://127.0.0.1:…` through the SSH tunnel; public hostnames, TLS and a
  reverse proxy with request limits are R6.
- Deferred: the team switcher showing only when more than one workspace exists, and the unified Profiles view, ship
  with R3 (ADR-0020's `ui.unified_profiles`); checkout from the plan intent is R4.

## Alternatives considered
- *Create the workspace in a provider event listener (Keycloak SPI):* rejected; a second system writing tenants, no
  transaction with our trial and memberships, Java code to maintain.
- *Tokens in browser storage for the portal:* rejected (XSS turns into account takeover); the BFF cookie is the
  roadmap's requirement.
- *Trial per user id only:* rejected; deleting and re-creating the account at the provider would reset it.
- *Send invitation e-mails from the API request:* rejected; a slow or failing mail server would fail the request and
  there would be no retry.
