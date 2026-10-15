# 0024 — Business-owner administration and catalog publishing (R5)
Status: **Accepted (revised-roadmap track)**. Date: 2026-10-15. Owner: backend lead with the frontend lead, the
security owner and the product owner. Builds on ADR-0018 (billing, staff console), ADR-0019 (break-glass, audit chain),
ADR-0021 (staff sign-in flow with a one-time code) and ADR-0023 (catalog and checkout).

## Context
After R4 the owner can sell plans, but running the business still needs the server shell or SQL: seeing how many
customers pay, finding a customer without an exact e-mail, restricting a workspace, changing a price or plan limits
(a code change plus an environment variable), retrying an e-mail, checking the worker. R5 moves routine business work
into the existing staff console without weakening the milestone 11 support controls (exact search, two-person
time-bound access, audit, break-glass).

## Decision

### 1. Business roles and permissions, separate from support and from workspace owners
- Three staff roles: `platform_owner`, `business_admin`, `business_analyst`, next to `support`, `support_lead`,
  `billing_admin`. A versioned mapping (`STAFF_ROLE_PERMISSIONS`, version 1; the same rows in `staff_role_permissions`,
  kept identical by a test) names what each may do — `admin.metrics.read`, `admin.customers.read`,
  `admin.customers.contact`, `admin.restrictions.payment|security`, `admin.catalog.read|edit|publish`,
  `admin.operations.read|act`, `admin.notes.read|write`, `admin.staff.read`, `admin.releases.request`,
  `admin.entitlements.exception`. Matrix: [permission-matrix.md](../permission-matrix.md#platform-staff-r5-adr-0024).
- No migration grants a business role. The first platform owner is bootstrapped once on the server
  (`staff.ts bootstrap-owner`, refused when an owner exists); further staff are added with `staff.ts add`. A database
  trigger refuses to remove, disable or demote the last active platform owner.
- Support-only roles cannot list all customers or see metrics. Business roles may use the support tools as well
  (search, overview, access requests, overrides), always with a second factor.

### 2. Every admin route: explicit permission, MFA, audit — checked twice
- `/v1/admin/*` routes accept staff console tokens only (customer sessions, API tokens and portal cookies never), check
  the route's permission in the API, and need a console session whose sign-in carried a second factor: the staff flow
  sets `amr` (`pwd`, `otp`) on its steps and the console client puts it in the ID token; `STAFF_MFA_AMR` lists the
  values that count. Business roles on the milestone 11 support routes need it too.
- Every cross-workspace reader is a `security definer` function that calls `app.staff_require(permission)` itself, so
  a mistake in a route cannot open it to customers.
- Lists, views, restrictions, notes, publications, retries and release requests are written to the platform audit;
  viewing a customer is also written to that workspace's own activity log.

### 3. Customers and metrics
- Customer list: cursor pages (newest first, ≤100), search by organization id, provider customer id, an owner's
  exact address or the start of a name; filters by state and plan; owner address masked without
  `admin.customers.contact`. State as last observed by the worker (≤1 minute old); the detail shows the live state.
  No member names, profile data, sessions, credentials, cookies or screenshots — members by role and computers by
  platform only; names still need the milestone 11 approval.
- Metrics, defined explicitly: **MRR** = active provider subscriptions × list price × quantity, normalized to a month
  (yearly ÷ 12, every N months ÷ N), per currency, never converted; tax excluded only where the price excludes it,
  discounts and one-time items not applied (listed as gaps). Past-due and grace amounts are "at risk", canceling
  amounts shown separately. **Cash collected** (paid invoices) and **refunds** (from the provider's charge) are separate,
  last 30 days. Freshness (oldest provider confirmation, last applied event, waiting/failed events) and known gaps are
  shown with the numbers. The worker stores each subscription's price facts and refund amounts for this.

### 4. Restrictions
- `account_restrictions`: kind `payment` or `security`, scope `workspace` or `account` (security only), reason
  (20-500), optional expiry (≤ 366 days), who, when, lifted by whom and why, whether the owners were e-mailed.
- **Payment** restriction: `app.billing_effective` returns `restricted` / `staff_restriction` (over the subscription and
  any entitlement exception) — creating and opening stop; reading, closing, backups, export, deleting and billing keep
  working, as for non-payment (ADR-0018).
- **Security** suspension of a workspace: every member route answers `WORKSPACE_SUSPENDED`, open profiles' leases are
  revoked with a new fencing token (the app closes them), API tokens are revoked, invitations cannot be accepted. Of an
  account: the account is disabled, its desktop and portal sessions and API tokens end, its leases are fenced.
- Lifting (with a reason) undoes the effects; an expired security suspension is undone by the worker. Nothing is
  ever deleted; profile directories on computers are never touched. The owners get a notice without the internal
  reason.

### 5. The database is the catalog's runtime authority
- `plans` rows are immutable (a trigger refuses updates and deletes) and record their source (`seed` or `admin`);
  `plan_prices` maps each version and interval to an immutable provider price; `catalog_state` holds a generation and
  the provider portal configuration that offers the current prices. `PLAN_CATALOG` in the contracts only seeds versions
  a database does not have (a differing seed is reported and ignored); `BILLING_STRIPE_PRICES` remains a bootstrap
  fallback for versions without a published price.
- Pricing, checkout, the portal, the desktop's plan list, onboarding plan intent and the worker's price → plan mapping
  read the database (cached briefly; a publication drops this server's caches; other instances within 15 s).
- Publishing (`plan_drafts`, `catalog_publications`): claim in a short transaction (expected revision, one running
  publication per plan by a unique index, the same revision returns the same publication) → create or reuse the
  provider product and prices (lookup keys contain version and amount; idempotency keys contain the publication) and
  verify them → store version, prices, generation and portal configuration in a short transaction. No transaction is
  held across a provider call. A failure marks the publication failed, returns the draft to editing, raises a
  `publish_failed` alert and publishes nothing; a running publication left by a crash is taken over after 10 minutes.
- Subscribers keep the version and provider price they bought (their subscription points at the old price); new
  purchases use the newest version. A provider price amount is never changed. Old API clients see the same fields.

### 6. Operations
- Provider events waiting/failed, the e-mail queue (no addresses or contents) with retry of failed e-mail (sealed
  contents are kept 7 days for that, then erased), outbox, newest profile backup, log archiving status
  (`pg_stat_archiver`), the worker's heartbeat, API version and environment, the release channel status, support-case
  notes (redacted: card numbers, passwords after keywords, keys and tokens become `[redacted]`).
- Release actions are **requests** recorded for the signed release pipeline; nothing in the console uploads, signs or
  changes a release.

## Consequences
- Migration `0016_business_admin.sql`; API 0.17.0 (additive). Staff sign-in must carry `amr`: `keycloak-setup.sh` sets
  the references on the staff flow, adds the claim to the console client and writes `STAFF_MFA_AMR=otp`.
- The console has Dashboard, Customers, Plans, Operations and Staff next to the support screens.
- Production use of the console still needs R6 (public hostname, TLS, live provider keys reviewed).

## Evidence / verification
`services/api/test/admin.test.ts` (customer token / owner / cookie refused, support-only refused, MFA required,
database-level refusal, mapping parity, owner bootstrap and last-owner protection, customer pages and masking, note
redaction, concurrent publish → one version and one price per interval, failed publication invisible to pricing and
retried with the same prices, subscribers keep version and price, payment/security/account restrictions and lifting,
metrics against provider fixtures per currency, e-mail retry, release requests), `apps/web-admin/e2e/admin.e2e.test.ts`,
`deploy-scripts.yml` (real Keycloak: amr in the ID token, MFA session, owner bootstrap once, admin data answers).

## Revisit when
Several API instances serve the console (shared cache invalidation), a second payment provider or currency
conversion for reporting is wanted, refunds are to be issued from the console (needs its own audited design), or
staff management moves into the console (needs two-person approval).
