# 0018 — Billing, plan limits and support access
Status: **Accepted (beta track)**. Date: 2026-10-14. Owner: backend lead + product owner (prices, limits and the
retention policy are the owner's to set). Builds on ADR-0013 (roles, tenant isolation), ADR-0014 (backup quota),
ADR-0015 (session leases) and ADR-0017 (automation limits) for milestone 11.

## Context
Organizations need subscriptions with predictable behaviour: what a plan allows, what happens when a payment fails or
a customer leaves, and how support can help without seeing what they should not. The hard parts are correctness under
the payment provider's real behaviour (duplicate, late and out-of-order webhooks; outages), limits that hold under
concurrent requests, never losing customer data over a billing state, and support access that is least-privilege,
time-bound, approved and visible to the customer.

Merchant decision (product owner, 2026-10-14): **Stripe**, merchant of record **Ten Tech Solutions LLC** (United
States), prices in **USD**. The merchant is responsible for sales tax/VAT registration and remittance; Stripe Tax can
calculate tax once the owner configures registrations (`BILLING_AUTOMATIC_TAX=true`). The application never computes
or stores a tax rate.

## Decision
### Plan catalog: versioned, in the repository, immutable per version
- `packages/contracts/src/billing.ts` (`PLAN_CATALOG`) defines each plan as `id@version` with four limits — active
  profiles, seats, cloud backup storage, automation concurrency (`null` = no limit) — and features (`team_sessions`,
  `automation`, `api_tokens`, `webhooks`). The migration script syncs it into `plans`; an existing `id@version` that
  differs from the file stops the migration (a change is a new version). Organizations keep the version they bought
  (grandfathering); new purchases use the newest purchasable version.
- Plans: `trial` (14 days, every new organization), `starter`, `team`, `agency` (purchasable), `beta` (organizations
  that existed before this milestone: the team beta keeps working) and `internal` (staff and fixtures). **The limit
  numbers are provisional placeholders**, to be set by the owner from the cost worksheet and pilot feedback; no price
  amount exists in the code. Prices live only in Stripe; `BILLING_STRIPE_PRICES` maps `plan@version` → Stripe price
  id per deployment. A plan without a configured price is not offered.

### Entitlements: the database decides, nothing caches a grant
- `subscriptions` (one row per organization, created with the organization) holds the plan, the stored state and the
  provider's references and dates. `app.billing_effective(org)` computes the **effective** state and limits at the
  moment of the request from that row, active `entitlement_overrides` and the clock: time-based transitions (trial
  end, grace end, unconfirmed renewal) need no job to take effect. There is no cache; anything added later may speed
  reads but may never grant access the database no longer grants.
- The billing state only ever **narrows** access already allowed by role and grants (ADR-0013); it never widens it.
  An unavailable payment provider changes nothing about permissions: requests never call Stripe to decide access.

### Lifecycle
```
trial ──(checkout paid)──▶ active ──(payment fails)──▶ past_due ──(provider gives up)──▶ grace ──(7 days)──▶ restricted
  │                          ▲  │                          │                                                ▲
  └──(14 days, no plan)──────┼──┼──────────────────────────┼────────────────────────────────────────────────┘
                             │  └──(cancel at period end)──┼──────────────────────────────────▶ canceled
                             └──────(payment succeeds)─────┘
```
- `trial`: full access within trial limits; at the end without a subscription → `restricted` (`trial_ended`).
- `active`: paid. If the period end passes by 72 h without the provider confirming a renewal (missed webhooks, an
  outage), the organization is treated as `grace` (`renewal_unconfirmed`) — never restricted at once; 10 days after
  the period end without confirmation → `restricted`. The reconciliation worker normally confirms long before.
- `past_due`: a payment failed and Stripe is retrying (its retry schedule is the merchant's Stripe setting): full
  access, an owner banner with the action required — for at most 30 days after the period end, then grace (7 days)
  and restricted, whatever the retry setting or an outage.
- `grace`: Stripe stopped retrying (`unpaid`, or canceled for non-payment): full access for 7 days, final warning.
- `restricted`: read, close, back up, export and billing only (below). Data is kept.
- `canceled`: the customer canceled and the paid period ended: same access as `restricted`. Data is kept.
- Mapping from Stripe: `trialing`→trial, `active`→active, `past_due`→past_due, `unpaid`→grace, `canceled` with
  `cancellation_details.reason = cancellation_requested`→canceled, other `canceled`→grace (then restricted),
  `paused`→restricted, `incomplete`/`incomplete_expired` ignored (an unfinished checkout changes nothing).
- **No deletion** happens because of a billing state. A retention schedule after cancellation is a policy the owner
  must decide and communicate (terms of service); until then data is kept until an owner deletes it. The billing
  screen says so.

### What `restricted` and `canceled` allow
Allowed: everything that reads; closing profiles and releasing sessions; uploading and committing backups (a closing
backup is never refused for billing reasons — the existing storage quota still applies, and a refused upload stays
pending on the computer); downloading backups and restoring them; configuration export; deleting profiles, clients,
tokens and webhooks; removing members and revoking invitations; billing. Refused with `SUBSCRIPTION_RESTRICTED` (403,
naming the state, the reason and what is allowed): creating profiles, clients, invitations, API tokens, webhook
endpoints and jobs; opening profiles (session leases); computers claiming jobs; importing; restoring from the trash;
joining through an invitation made before the restriction.
The list is `RESTRICTED_ACTIONS` in contracts and every gated route calls `requireBillingAllows(access, action)`;
a test walks the list.

### Limits hold under concurrency
- Active profiles: a trigger on `profiles` (insert, and undeleting from the trash) locks the organization's
  `subscriptions` row and counts; over the effective limit it raises `PLAN_LIMIT_REACHED` (409, `limit`, `used`,
  `allowed`, remediation). Every path (create, import, restore) is covered by the one trigger; concurrent creates
  serialize on the row lock, so they cannot overshoot.
- Seats: members plus pending invitations, by the same mechanism on `memberships` and `invitations` (an invitation
  reserves its seat; accepting it converts the reservation).
- Storage: `app.org_backup_quota` (ADR-0014) becomes the plan's storage (plus overrides), under the service
  operator's per-organization ceiling (1 TiB by default since the review below).
- Automation concurrency: a claim uses the smaller of the organization's running limit (ADR-0017) and the plan's.
  Jobs already running keep their capacity after a downgrade; new claims wait until the organization is under the new
  limit.
- **Downgrades never remove anything**: data over a lower limit stays usable (open, close, back up, export, delete);
  only new creation stops, with the reason and what to do (upgrade, or remove N).

### Stripe integration
- Hosted Checkout (subscription mode) and the hosted Customer Portal (plan changes, payment methods, cancellation,
  invoices). The application never sees card data; nothing card-like is logged or stored.
- A small REST client (`fetch`, form encoding, no SDK): `Stripe-Version: 2025-03-31.basil` pinned (subscription
  periods are read from the subscription item); `Idempotency-Key` on every create; 10 s timeouts. Upgrading the API
  version is a deliberate change verified by the mock and sandbox tests.
- One Stripe customer per organization (created by us with the organization id in metadata; stored, unique). The
  customer, not metadata from an event, maps events to organizations.
- Checkout: only owners (`billing.manage`), only plans with a configured price, refused while a subscription is live
  (`ALREADY_SUBSCRIBED`: use the portal). The success page is informational only — **a redirect is never proof of
  payment**; the state changes only from the provider's own data.
- The desktop shell creates checkout and portal sessions itself and opens them in the default browser only after
  checking the host (`checkout.stripe.com`, `billing.stripe.com`, invoice hosts); the manager window never receives a
  payment URL to open.

### Webhooks: verified on the raw body, deduplicated, applied from fresh provider data
- `POST /v1/webhooks/billing` (public, provider-authenticated): the `Stripe-Signature` header is verified against the
  exact raw body (HMAC-SHA256 with the endpoint secret, `t.` + body, hex, any `v1`, constant-time, 5-minute tolerance,
  several secrets during a rotation); `livemode` must match the key in use; at most 1 MiB. The event id is inserted
  into `billing_webhook_events` (primary key): a duplicate answers 200 and does nothing. The route stores only the
  event id, type, object id and creation time — no payload — and answers 200 at once.
- The worker processes events by **fetching the current object from Stripe** (subscription, checkout session,
  invoice) and applying that. Order of arrival therefore does not matter, and a replayed or late "paid" event cannot
  reactivate a newer canceled state (the fetch returns the canceled subscription). A subscription replaces the
  organization's current one only if it is the same subscription or a newer one (provider creation time); events for
  an older, ended subscription change nothing. If Stripe is unreachable the event is retried with backoff and the
  organization keeps its last validated state (plus the bounded renewal grace above).
- Refunds and disputes are recorded and raise a reconciliation alert for staff; they never delete profile records.

### Reconciliation worker
Processes pending events; resyncs every Stripe subscription at least daily, and hourly around period ends and in
`past_due`/`grace`; records state transitions (including time-based ones) in `subscription_history` and the
organization's audit log; raises deduplicated `billing_alerts` (webhook backlog, failed events, unknown customer or
price, duplicate live subscriptions, paid invoice but not active, disputes, refunds, missed webhooks found by resync);
rolls usage up. Invoices are mirrored from provider data (number, status, amounts, currency, hosted URLs) for the
owner's invoice list and receipts.

### Usage ledger
`usage_events(id, org_id, type, quantity, dedupe_key, occurred_at)` with a unique `(org_id, dedupe_key)`: committed
snapshots (`snapshot:<id>`), finished jobs (`job:<id>`), daily samples of storage, active profiles and seats
(`storage:<day>` …), daily API-token request counts (`api:<day>`). Writers insert with `on conflict do nothing`, so
reprocessing never double-counts. No usage is billed in v1 (flat plans); the ledger feeds the usage screen, the cost
worksheet and future metered units.

### Support: separate identities, least privilege, time-bound, approved, visible
- **Staff are not a tenant role.** `platform_staff` (roles `support`, `support_lead`, `billing_admin`) is managed
  only by a command run on the server (`staff.ts`), never through the API. Staff sign in to the internal console
  (`apps/web-admin`, served at `/console/`) with their own OIDC client; the API issues a **staff token** (30 minutes,
  no refresh, audience `pb-support`) that works only on `/v1/support/*`, while tenant tokens never work there.
- `support`: find an organization (by id, Stripe customer id or exact e-mail — audited) and see its overview: plan,
  state, dates, limits and usage numbers, invoices, billing events, alerts. No member e-mails, profile names, activity
  details or session data.
- Sensitive access (members and the organization's activity log) needs a request with a reason and a duration
  (≤ 4 h), **approved by a different `support_lead`**, and ends by itself. Grants, approvals and every view are
  written to the platform audit and to the **organization's own activity log**, so its owners see that support looked.
- Browser session data (cookies, site data, backups' contents) is not reachable through any support route at all.
- `billing_admin` alone may add entitlement overrides (scope, value, reason, expiry ≤ 90 days; revocable), resync a
  subscription and resolve alerts — the "separate authorization" for overrides. Overrides are audited both ways.

## Consequences
- The old `entitlements` table (milestone 01 placeholder) is replaced by plans and overrides; `requireEntitlement`
  now reads plan features.
- Every new organization starts a 14-day trial; organizations created before this milestone are on `beta` (no end)
  until the owner moves them. Fixture organizations are `internal`.
- The test server can run with Stripe in test mode once the owner adds a test key and prices (`stripe-setup.ts`); as
  it is reachable only through the SSH tunnel, the setup runs the Stripe CLI as a forwarder of test-mode events (no
  public webhook address). Without a key, billing routes answer `BILLING_UNAVAILABLE` and everything else works.
- The owner must decide prices, final limits, the retention policy and tax registrations before charging anyone.

## Evidence / verification
- API tests against an in-process fake Stripe (same endpoints, signatures and objects): successful and failed
  payments, duplicate and out-of-order webhooks, a replayed paid event after cancellation, upgrade, downgrade,
  cancellation, grace and trial expiry, provider outage, concurrent profile and seat creation, restricted
  organizations closing and exporting, no card data in logs, support access rules.
- The request shapes are validated against Stripe's OpenAPI with `stripe-mock` in CI; a sandbox test against Stripe
  test mode (test clocks) runs when the owner adds `STRIPE_TEST_SECRET_KEY` as a repository secret.
- [Billing docs](../billing/README.md): state diagram, catalog configuration, reconciliation, admin roles, cost
  worksheet.

## Independent review (2026-10-14)
A reviewer who had not seen the work checked the state logic against these rules. Fixed in migration
`0009_billing_review.sql` and `reconcile.ts`, each with a regression test (`billing.test.ts`, "review fixes"):
1. Accepting an invitation skipped the seat check (its seat was reserved), so an organization over its seats after a
   downgrade, or a restricted one, could still gain members. Joining now needs the organization within its seats and
   not restricted (`invitation.accept` is in `RESTRICTED_ACTIONS`).
2. `past_due` had no end. It is now bounded (30 days after the period end → grace → restricted).
3. Two fetches of one subscription (two workers, an event and a resync) could commit out of order. Each applied object
   records the database time its fetch started; an older fetch is ignored.
4. Of two subscriptions, the newer always won, so a customer still paying for an older one after a newer one ended was
   locked out. A live subscription now wins over an ended one (of two alike, the newer); checkout expires earlier open
   checkouts and refuses while Stripe has a live subscription.
5. One organization whose resync kept failing held the head of every resync batch. Failures back off (with a
   `resync_failed` alert after a lasting one); a staff resync request no longer clears `synced_at`.
6. The organization's milestone 07 cost limit (20 GiB by default) capped every plan's storage. It is now an operator
   ceiling of 1 TiB by default; the plan decides below it.
Checked and found sound: signature verification, event deduplication, profile-limit locking, seat lock ordering,
override expiry and `null` limits, support access rules, usage-ledger idempotency, row-level security on the new tables.

## Revisit when
Prices and final limits are set (new catalog versions); metered or remote-browser units are added; the retention
policy is decided; a second payment provider or merchant of record is needed; Stripe's API version is upgraded.
