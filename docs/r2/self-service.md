# R2 — self-service accounts: contracts, identity settings, e-mail, database

Decisions: [ADR-0021](../adr/0021-self-service-accounts-and-onboarding.md). API changes: [changelog 0.14.0](../automation/api-changelog.md).

## 1. Onboarding contract (`packages/contracts/src/onboarding.ts`)

`GET /v1/onboarding/status` → `OnboardingStatus`; `POST /v1/onboarding/complete` (body `OnboardingComplete`) →
`{ outcome, status }`. Both accept the desktop's bearer session and the portal's cookie session.

| Outcome | When | What the app shows |
|---|---|---|
| `existing` | the default workspace is still reachable | Profiles |
| `selected` | a returning person: their only owned workspace, else the one they were invited to | Profiles |
| `created` | a direct signup (or `create_own`): workspace + owner + trial, one transaction | Welcome → Profiles |
| `joined` | `invitation_token` accepted (or the same request retried) | "You joined …" → Profiles |
| `chosen` | `choose_org_id` among the person's non-suspended workspaces | Profiles |
| `choice_required` | several owned workspaces and no choice yet (asked once) | choose dialog |
| `invitations_pending` | invitations wait for this verified address | list + "Create my own workspace" |
| `terms_required` | a workspace would be created but the current terms are not accepted | terms dialog |

Errors: `EMAIL_NOT_VERIFIED`, `ACCOUNT_SUSPENDED`, `WORKSPACE_SUSPENDED`, `TERMS_REQUIRED` (stale version, with
`current_version`), `PLAN_NOT_AVAILABLE` (intent not offered), `INVITATION_*`, `PLAN_LIMIT_REACHED` (`limit: seats`),
`RATE_LIMITED` (20 per person / 60 per address per 10 minutes). Unknown body fields (`user_id`, `role`, `email`,
`org_id`, `price`…) are refused with `VALIDATION_FAILED`.

## 2. Portal session contract (backend-for-frontend, `services/api/src/routes/web.ts`)

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/web/config` | public | brand, terms version/URL, download URL, whether portal sign-in is configured |
| `GET /v1/web/auth/login?mode=signin\|signup&return_to=/app/…` | public, 30/10 min per address | starts PKCE (S256) + state + nonce at the provider; `signup` adds `prompt=create` |
| `GET /v1/web/auth/callback` | public | takes the pending sign-in once (10 min), exchanges the code server side, verifies the ID token, sets the cookie, redirects to `return_to` (only `/app/…`) or `/app/#/signin?failed=…` |
| `GET /v1/web/auth/session` | cookie | the user and the CSRF token for changes |
| `POST /v1/web/auth/logout` | cookie + CSRF | ends this browser's session |
| `POST /v1/web/auth/revoke-all` | cookie + CSRF | ends every portal and desktop session of the account |

Cookie: `pb_web` (`__Host-pb_web` on https), HttpOnly, SameSite=Lax, Path=/, `Max-Age` = absolute lifetime (12 h,
`WEB_SESSION_ABSOLUTE_SECONDS`), idle 30 min (`WEB_SESSION_IDLE_SECONDS`), Secure on https. Changes need
`x-csrf-token` **and** `Origin: <WEB_ORIGIN>` (and `Sec-Fetch-Site: same-origin` if the browser sends it). Routes
not marked for the portal answer `401 not_for_web` to a cookie. Configuration: `WEB_ORIGIN`, `OIDC_WEB_CLIENT_ID`,
`WEB_DIR` (the static page), `TERMS_VERSION`, `TERMS_URL`, `BRAND_NAME`, `WEB_DOWNLOAD_URL`.

## 3. Identity settings (`scripts/deploy/keycloak-setup.sh`, enforced on every run)

- Realm: `verifyEmail: true`; `registrationAllowed` and `resetPasswordAllowed` **only when `/etc/project-browser/smtp.env`
  describes a mail server**; e-mail as user name; e-mail theme `pb`; events kept 7 days (register, verify, send
  verification/reset and their errors, login errors, one-time-code setup). Other realm settings stay the owner's.
- Clients: `project-browser-desktop` (unchanged), `project-browser-console` (+ browser flow override
  `pb-staff-browser`), `project-browser-web` (public, PKCE S256, redirect `<WEB_ORIGIN>/v1/web/auth/callback`
  only, no CORS origins: the API exchanges the code).
- Staff flow `pb-staff-browser` (copied from Keycloak's browser flow once, its steps enforced each run): password
  form and one-time-code form REQUIRED, cookie / Kerberos / identity-provider redirect / "only if configured" /
  WebAuthn / recovery codes DISABLED.
- Files: `oidc.env` (+ `OIDC_WEB_CLIENT_ID`, `WEB_ORIGIN`, `WEB_DIR`), `email.env` (generated from `smtp.env`:
  `EMAIL_TASK_KEY`, `SMTP_URL`, `EMAIL_FROM`, `EMAIL_BRAND`, `BRAND_NAME`; root only; read by pb-api and pb-worker).
- `smtp.env` format (yours, root only):

  ```
  SMTP_HOST=smtp.example.com
  SMTP_PORT=587            # 465 with SMTP_SECURITY=ssl
  SMTP_SECURITY=starttls   # starttls | ssl | none (none only for a server on 127.0.0.1)
  SMTP_USER=you@example.com
  SMTP_PASSWORD=app-password-from-your-mail-provider
  SMTP_FROM=you@example.com          # an address your mail server allows you to send from
  SMTP_FROM_NAME=Project Browser
  ```
- `bash keycloak-setup.sh email-status`: mail server in use, Keycloak's recent e-mail events and the worker's e-mail
  results of the last 7 days — no addresses, no links.

## 4. E-mail templates

| E-mail | Sent by | Template |
|---|---|---|
| Confirm your e-mail address | Keycloak | `scripts/deploy/keycloak-theme/pb/email/messages/messages_en.properties` (`emailVerification*`) |
| Set a new password | Keycloak | same file (`passwordReset*`) |
| Invitation to a team (link `…/app/#/invite/<token>`) | worker | `services/worker/src/email-templates.ts` (`invitation`) |
| Welcome (workspace ready, download) | worker | `services/worker/src/email-templates.ts` (`welcome`) |

Worker e-mails have a text and an HTML part, escape every variable, keep names to one line (no header injection) and
set `Auto-Submitted: auto-generated`. Brand: `EMAIL_BRAND` (= `SMTP_FROM_NAME`).

## 5. Database (migration `0013_self_service_onboarding.sql`, additive)

| Object | Constraint / rule |
|---|---|
| `onboarding_state` | + `bootstrap_org_id` **unique** (one personal workspace per person), `plan_intent` (catalog id pattern), `choice_made_at`, `attempts`, `last_error`; states `new / invited / ready / choose`; the R1 check coupling state and default was dropped (it broke deleting a default workspace) |
| `user_consents` | append-only, own rows (RLS); terms are only ever `granted`; marketing separate |
| `trial_claims` | PK = SHA-256 of the verified address; unique per user; no grants — only `app.claim_trial`, `app.trial_available` |
| `organizations.suspended_at` | suspended workspaces cannot be joined (`app.accept_invitation`) or be a default |
| `web_sessions` | PK = digest of the cookie; own rows (RLS); `app.web_session_for_auth` checks session, user and both lifetimes |
| `web_auth_requests` | pending sign-ins, taken once, 10 minutes; return address `/…` only; definer functions only |
| `email_tasks` | `dedupe_key` unique; the API may insert, only the worker reads (like the outbox); payload sealed, erased when final |
| `app.accept_invitation` | + `workspace_suspended`, `seats_full` (members only); a retry by the acceptor learns the workspace |

## 6. Tests

| Required case | Test |
|---|---|
| direct signup → one workspace | `services/api/test/onboarding.test.ts` "asks for the terms, then creates one personal workspace…" |
| simultaneous bootstrap → one workspace / trial | "desktop and browser finishing at the same moment…" (5 parallel calls) |
| interrupted bootstrap → resumable | "a bootstrap interrupted half-way leaves nothing behind…" (failure injected after the workspace row) |
| invited user → assigned team only | "an invited teammate joins only the invited workspace…" |
| wrong e-mail cannot accept | "the wrong account cannot accept…" |
| exceeded seat cap fails cleanly | "a workspace whose seats are now full fails cleanly" |
| web and desktop share account | `services/api/test/web.test.ts` "web and desktop are the same account…" |
| customer cannot access staff routes | `onboarding.test.ts` "customers cannot reach staff routes…", `web.test.ts` "only routes meant for the portal…" |
| BFF: PKCE/state/nonce, cookie flags, CSRF + Origin, rotation, logout, revoke-all, no open redirect | `web.test.ts` |
| e-mail queue: sealed, sent, refused, retried, skipped, no double send | `services/worker/test/email.test.ts` |
| real provider end to end (register → verify by e-mail → portal → workspace; invite e-mailed → teammate joins; staff one-time code) | `.github/workflows/deploy-scripts.yml` "Self-service signup…" with `scripts/ci/signup-check.ts`, `smtp-sink.ts`, `totp.ts` |
| desktop: Create account, terms once, Profiles after sign-in | `apps/desktop/e2e/manager.e2e.test.ts` "R2: Create account…"; `src-tauri/tests/account.rs` (registration URL, default server) |
