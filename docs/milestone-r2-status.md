# R2 — status against the handoff file

Self-service accounts and automatic onboarding (revised roadmap). API 0.14.0.
- **Decisions:** [ADR-0021](adr/0021-self-service-accounts-and-onboarding.md).
- **Deliverables:**
  - auth/BFF contracts, identity settings, e-mail templates, database constraints and the test map:
    [r2/self-service.md](r2/self-service.md);
  - identity settings script: `scripts/deploy/keycloak-setup.sh` (registration, verification, reset, staff flow,
    portal client, mail server, `email-status`);
  - e-mail templates: Keycloak theme `scripts/deploy/keycloak-theme/pb`, worker `services/worker/src/email-templates.ts`;
  - database constraints: `infra/db/migrations/0013_self_service_onboarding.sql`;
  - automated integration tests (API, worker, desktop, and the real provider end to end in CI);
  - fresh-user demo without server commands: [r2/fresh-user-demo.md](r2/fresh-user-demo.md).

**Outcome.** A person who was never set up by the owner can create an account, verify it by e-mail and land in their
own workspace with a trial; an invited teammate lands in the inviting team only. Both from the website or the
desktop app, with no owner action beyond sending the invitation.

## Requirements

| Required | Implemented |
|---|---|
| Reuse Keycloak/OIDC, PKCE desktop login, e-mail verification, organizations/memberships, invitations, token rotation | All reused. New: the portal client and a staff flow in the same realm; onboarding routes on top of the existing organization, membership, invitation and billing tables. |
| Registration only in the customer flow; separate staff client with mandatory MFA; signup never creates staff | Registration on the realm's customer flow only when e-mail can be sent. Console client → flow `pb-staff-browser`: password + one-time code every time, no single sign-on. Staff roles only in `platform_staff` via `staff.ts`. Finding S1 fixed. |
| 1. Signup, verification-pending, resend, sign-in, forgot/reset, invite acceptance and onboarding-retry pages through IdP flows; e-mail with verified sender and delivery/error monitoring; never log tokens | Portal pages at `/app/` (create account, sign-in, verify, terms/workspace, invitations, choice, welcome, retry); the provider's own registration, verification (with resend), and reset pages. Sender and server from `smtp.env`; Keycloak events + worker results in `email-status` (no addresses). Codes, states, cookies and CSRF headers are redacted from logs; invitation links are sealed in the queue. |
| 2. `POST /v1/onboarding/complete`, `GET /v1/onboarding/status`; identity from verified issuer + subject | Added. The body cannot name a user, role, e-mail or org; e-mail verification comes from the provider's claims at the last sign-in. |
| 3. New direct signup: workspace + owner + trial in one transaction; lock and unique mapping; simultaneous web/desktop → one workspace and one trial | One transaction with the locked `onboarding_state` row; `bootstrap_org_id` unique. Five parallel calls → one `created`, four `existing`, one trial claim (test). |
| 4. Plan selection as a validated server-side intent, not a price | `plan_intent` = a purchasable catalog id (else `PLAN_NOT_AVAILABLE`); extra fields such as `price` are refused. Checkout continues in R4. |
| 5. Invitation priority: token, verified intended e-mail, expiry, seats; accept once; no forced personal workspace or payment; other memberships kept | Yes; plus suspended workspaces refused and seats re-checked against members at acceptance. |
| 6. Returning users: last authorized or deterministic fallback, no fresh trial; several owned → choice once, no merge/transfer | `existing` / `selected` / `choice_required` → `chosen`. |
| 7. Invited-only users: explicit "create my own workspace" with quota/trial rules; trial eligibility not reset by more workspaces | `create_own` (terms, rate limit); the trial clock is per verified address and per user (`trial_claims`), shared by every later workspace, also through `POST /organizations`. |
| 8. Partial failure → resumable status; DB transaction owns workspace+membership+trial; e-mail/external tasks through a queue | Failures roll back; `attempts`/`last_error` recorded separately; `email_tasks` with retries and backoff in the worker. |
| Web BFF: Code + PKCE + state; server-side credentials; short-lived opaque HttpOnly Secure SameSite cookie; CSRF + Origin; rotation; no tokens in localStorage; restrictive CSP; exact redirect allowlist; desktop keeps the keychain flow | Implemented in `routes/web.ts` and `routes/portal.ts` (see the table in [self-service.md](r2/self-service.md#2-portal-session-contract-backend-for-frontend-servicesapisrcrouteswebts)). Desktop flow unchanged. |
| Web and desktop are one user with separate session records; browser logout ends the web session; account-wide revoke explicit | Tested (`web.test.ts`). |
| UI: website Create account → Verify → Welcome (plan/start/download); desktop Sign in / Create account with the production endpoint preconfigured; after login Profiles; team switcher only with >1 workspace; configurable brand | Portal as listed; desktop buttons, `PB_DEFAULT_SERVER`, onboarding dialog only when a decision is needed, then Profiles; `BRAND_NAME`/`EMAIL_BRAND`. **Deferred to R3:** hiding the team switcher for a single workspace (it belongs to the unified Profiles view). |
| Abuse/errors: rate limits; generic recovery answers; safe resend for expired links; terms separate from marketing; suspended/deleted identities cannot start over; invitations never revive a suspended workspace; e-mail verified by trusted claims | Onboarding 20/person and 60/address per 10 min, portal sign-in 30/address; provider reset answers do not reveal accounts; expired links offer a new one; `user_consents`; `ACCOUNT_SUSPENDED`, `WORKSPACE_SUSPENDED`. Request limits in front of the provider's own pages come with the public reverse proxy (R6). |
| Tests: direct signup, simultaneous bootstrap, interrupted bootstrap, invited user, wrong e-mail, seat cap, web+desktop, staff routes | [Test map](r2/self-service.md#6-tests). |
| Exit: an unregistered user and an invited teammate both enter the correct workspace without owner intervention | CI (`deploy-scripts.yml`) against the real Keycloak: a new customer registers, verifies by e-mail, gets one workspace with a trial and the same workspace on the desktop; their invitation is e-mailed by the worker and a new teammate signs up through it into that team only. |

## Verification
- API: 572 passed, 13 skipped (`onboarding.test.ts` 18, `web.test.ts` 10, cross-tenant and database suites updated).
- Worker: 25 passed (`email.test.ts` 7).
- Rust: clippy clean; `cargo test --workspace` green (desktop account 14, SQLite schema v12).
- Desktop e2e 181 (new: Create account → terms → workspace → Profiles); console e2e 8.
- Deploy scripts (CI, real Keycloak + mail sink): self-service signup and invitation, staff one-time codes.

## Deploying to the test server
1. Optional but needed for self-registration: create `/etc/project-browser/smtp.env` (format in
   [self-service.md](r2/self-service.md#3-identity-settings-scriptsdeploykeycloak-setupsh-enforced-on-every-run)).
2. `\cp -f /home/pb/antibrowser/scripts/deploy/vps-setup.sh /root/ && bash /root/vps-setup.sh` — **twice** (the
   script changed; migration 0013 is additive).
3. `\cp -f /home/pb/antibrowser/scripts/deploy/keycloak-setup.sh /root/ && bash /root/keycloak-setup.sh`.
4. Staff: the next console sign-in asks every staff account to set up an authenticator app (one-time codes).
5. Portal: `http://127.0.0.1:8080/app/` through the tunnel.

## Not in R2 (by design)
- Public hostnames, TLS and a reverse proxy with request limits for the provider's pages: R6.
- Checkout from the chosen plan: R4. Unified Profiles view and single-workspace switcher: R3.
