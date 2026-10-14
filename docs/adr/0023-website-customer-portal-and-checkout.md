# 0023 — Public website, customer portal and checkout (R4)
Status: **Accepted (revised-roadmap track)**. Date: 2026-10-15. Owner: frontend lead with the backend lead and the
product owner. Builds on ADR-0018 (billing with Stripe), ADR-0021 (self-service accounts and the portal session) and
ADR-0022 (team sharing).

## Context
After R3 a person can sign up in the R2 portal page and use the desktop app, but there is no public website, no
price list, no download page, and paying means opening the desktop app. R4 requires a website and a customer portal
that take a visitor from "Start free" to a launched profile, and a paying customer from a plan to the same entitlement
the desktop reads — without fabricated prices, without offering internal builds, and without a second subscription.

## Decision

### 1. Two surfaces, one origin, served by the API
- `apps/web-public`: prerendered static pages (home, pricing, download, help, contact, security, privacy, terms,
  refunds, 404) built by `node build.mjs` into `dist/`, served at `/` from `PUBLIC_DIR`. No inline script or style;
  the site CSP allows only its own files. Pages are public and cacheable for five minutes; hashed assets for a year.
  Prices, downloads and the status link are read from the API at view time — never written into the pages.
- `apps/web-customer`: the authenticated React portal at `/app/` (replaces the R2 static page `apps/web-portal`), using
  the R2 backend-for-frontend cookie session (HttpOnly cookie, CSRF token, Origin check). Overview, Billing, Team,
  Account; onboarding and invitations as in R2. The page is `no-store`; hashed assets immutable.
- `apps/web-admin` stays staff-only at `/console/`. Distinct cookies: the portal's `pb_web` (path `/`, HttpOnly,
  SameSite=Lax) is accepted only by routes marked `web: true`; the console uses its own bearer session; the website
  reads no cookie.
- Host names are placeholders: staging serves site, portal and API from one origin; R6 decides public hostnames.

### 2. Catalog from the server
- `GET /v1/public/plans`: purchasable plans with limits, features and **verified** prices per interval (read from the
  provider, cached), currency, tax display (`inclusive`, `exclusive`, `automatic`, `unspecified`), trial days, and a
  `catalog_version` (ETag). Monthly and yearly appear only when a price is configured for that interval
  (`plan@version/year` in `BILLING_STRIPE_PRICES`; `stripe-setup.ts --year-price`).
- A price that is not configured, unreadable, inactive or at another interval is not offered: the plan shows
  `available: false` with no prices. A plan is never shown at $0 and such a price cannot start checkout.

### 3. Checkout: one per workspace, resumable, never two subscriptions
- `POST /orgs/{org}/billing/checkout` (owner/billing manager) validates the plan and interval on the server, then in one
  transaction locks the subscription row and the workspace's `checkout_attempts`: an open session for the same plan and
  interval (valid ≥10 minutes) is **reused**; a different choice **replaces** it (the old session is expired at the
  provider); concurrent clicks see the `creating` row and wait. A unique partial index allows one active attempt per
  workspace. The provider call uses the idempotency key `pb-checkout-<attempt id>`.
- Subscribed workspaces are refused (`ALREADY_SUBSCRIBED`) and sent to the provider's portal for changes.
- Return page `/app/#/billing/return?result=success|canceled` shows **Pending verification** and polls; only the
  verified webhook (`checkout.session.completed`, subscription events) makes the plan active. The desktop reads the
  same entitlement (`GET /orgs/{org}/billing/subscription`). A canceled checkout charges nothing and can be resumed.
- The plan chosen on the website (`/app/#/welcome?plan=team`) is kept through signup and verification as an intent
  (never a price) and highlighted in Billing.
- Invoices, payment methods, upgrade/downgrade and cancellation stay in the provider's portal; we never calculate tax.

### 4. Downloads only through the release gate
`GET /v1/public/downloads` reads the stable channel manifest and verifies it with the app's trusted release keys
(`release-keys.json`, the same rules as `scripts/release/verify.mjs`), its validity window, pause and revocation; it
offers the Windows installer and the Mac disk image with SHA-256. Anything else — no trusted key yet, a bad signature,
an expired or paused manifest, internal builds — answers `not_available` ("not yet available"), never a link.

### 5. Account, contact and notifications
- Account page: computers signed in (revoke), password and sign-in methods at the identity provider's account page,
  optional e-mails (`/me/notifications`), and a **deletion request** (`/me/deletion-request`): recorded once, names
  workspaces where the person is the only owner, withdrawable; nothing is deleted automatically (policy owned by the
  product owner, R5 handles requests).
- Contact form `POST /v1/public/contact`: validated, honeypot, limited per address and per sender, queued as an e-mail
  to `SUPPORT_EMAIL` with reply-to; stored in a platform table the application role can only insert into.
- Transactional e-mail (worker): welcome, verification (provider), invitation, payment succeeded/failed, trial ending,
  contact copy. Deduplicated by key (per subscription period / per trial). Marketing needs consent and has a signed
  one-click unsubscribe (`/v1/public/unsubscribe`); essential mail cannot be turned off; trial/billing reminders can.

### 6. Copy rules
The website describes what the product does today. No "undetectable", invisibility, "never banned", fingerprint or
ban-prevention claims; a "What it does not do" section on the home page; no invented customers, counts, testimonials or
certifications. A build test fails on such phrases. Legal pages are owner-supplied; until `content/legal/meta.json`
says `reviewed: true` they carry a visible **Draft** banner.

## Consequences
- The R2 static portal page is removed; `keycloak-setup.sh` points `WEB_DIR` at `apps/web-customer/dist`.
- New tables: `checkout_attempts`, `contact_requests`, `notification_settings`, `account_deletion_requests`;
  definer functions `app.billing_contacts`, `app.trials_ending` for the worker (migration `0015_customer_portal.sql`).
- API 0.16.0, additive only.
- The download page says "not yet available" until a signed stable release exists (option B, before customers).

## Evidence / verification
`services/api/test/portal.test.ts` (catalog, checkout reuse/concurrency/replace, return and decline, trial reminders,
downgrade, downloads gate, contact, account), `billing.test.ts` (webhooks: duplicate, out of order, delayed, renewal
failure, cancellation), `web.test.ts` (cookie scope, CSRF), `apps/web-customer/e2e`, `apps/web-public/tests` and
`apps/web-public/e2e`, `deploy-scripts.yml` (served site, catalog without prices, gated downloads, portal). Journey map:
[docs/r4/README.md](../r4/README.md).

## Revisit when
Public hostnames are chosen (R6: separate site/portal/API origins change cookie and CSP settings); a second payment
provider or tax engine is added; legal text is reviewed; a signed stable release exists.
