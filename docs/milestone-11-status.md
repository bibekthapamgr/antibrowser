# Milestone 11 — status against the handoff file

Billing, plan limits and administration. Version 0.11.0. Decisions:
[ADR-0018](adr/0018-billing-plan-limits-and-support-access.md). Deliverables: catalog configuration and the billing
state diagram, reconciliation worker and admin roles in [billing/README.md](billing/README.md); the
[cost worksheet](billing/cost-worksheet.md) ([CSV with formulas](billing/cost-worksheet.csv)); the owner's Billing screen
in the desktop app; the internal support console (`apps/web-admin`, served at `/console/`).

Outcome: subscriptions with predictable behaviour — the database decides what an organization may do at the moment
of each request, a payment problem narrows access step by step and never deletes anything, limits hold under
concurrent requests, and support can help without seeing what it should not.

Merchant (owner's decision): Stripe, **Ten Tech Solutions LLC** (Wyoming, US), USD.

## Product decisions
| Required | Implemented |
|---|---|
| Plans dimensioned by active profiles, seats, cloud storage, automation concurrency | `PLAN_CATALOG` (`plan@version`, immutable once released): those four limits plus four features; `trial`, `starter`, `team`, `agency` (sold), `beta` (organizations from before 11), `internal` (staff, fixtures) |
| Pricing needs unit economics and pilot feedback; no competitor claims | No price in the code: prices live only in Stripe (`BILLING_STRIPE_PRICES`); limits are marked provisional; the cost worksheet has no assumed prices or rates |
| Local CPU with the customer; storage, egress, support are provider costs; remote browsers priced separately later | The worksheet's cost lines; remote browsers listed as a separate future product |

## Build sequence
| Step | Implemented |
|---|---|
| 1. Versioned catalog and entitlement evaluator; the database owns entitlement; no cache grants after revocation | `plans` synced from the catalog by the migration script (a changed released version stops it); `app.billing_effective(org)` computes state, limits and features from the stored row, active overrides and the clock on every request; nothing caches a grant |
| 2. Supported payment provider after confirming merchant, eligibility, currencies, recurring; hosted checkout and portal; no card data | Stripe, confirmed by the owner (US LLC, USD, subscriptions); Checkout (subscription mode) and the Customer Portal; the desktop shell creates both sessions and opens only Stripe's hosted-page hosts in the default browser; card fields never reach the app (tested) |
| 3. Webhook signature on the exact raw body; dedupe by event id; out-of-order via provider state; redirect never proof | HMAC-SHA256 over `t.` + raw body, constant time, 5-minute tolerance, several secrets, `livemode` must match; event id primary key; the worker fetches the current object and applies it; the return page is informational only |
| 4. trial → active → past_due → grace → restricted → canceled; expiry and action shown; no deletion on transient failure | All six states with reasons and dates; time-based transitions take effect at request time; the desktop banner and Billing screen name the state, the date and what to do; no billing state deletes data |
| 5. Limits transactional; concurrent creates cannot exceed; reserve capacity for running jobs; reason and remediation | Row-locking triggers for profiles (create, import, restore) and seats (members + invitations); storage and automation limits combined with the earlier per-organization limits; running jobs keep their capacity; `PLAN_LIMIT_REACHED` names the limit, use, allowance and remedies |
| 6. Downgrades keep data; stop/export/cleanup allowed; no new excess; retention needs a communicated policy | Over-limit data stays usable; only new creation stops; `BILLING_RETENTION_DAYS` is the owner's policy (empty: kept until an owner deletes); nothing deletes automatically |
| 7. Usage ledger (storage, snapshots, API/jobs, future paid units); idempotent | `usage_events` unique per organization and `dedupe_key` (snapshots, jobs, daily samples), `api_usage_daily`; reprocessing never double-counts |
| 8. Owner billing UI and internal support console; least privilege, time-bound, audited, approved; no session data by default | Desktop: Organization → Billing (plans, limits with usage, invoices, portal) and a banner. Console: separate staff identities and tokens (30 min), roles `support` / `support_lead` / `billing_admin`, sensitive access approved by a different lead and time-bound, everything in the platform audit and the organization's own activity log; no route reaches session data |
| 9. Invoices/receipts and reconciliation alerts; no invented tax rates | Invoices mirrored from Stripe with hosted page and PDF opened by the shell; ten alert kinds (plus `resync_failed`) in the console; tax only through Stripe Tax when the owner enables it (`BILLING_AUTOMATIC_TAX`) |

## Data / API
| Required | Implemented ([OpenAPI](openapi.json), migrations `0008_billing.sql`, `0009_billing_review.sql`) |
|---|---|
| `plans(id, version, limits_json)` | Plus name, description, features, purchasable |
| `subscriptions(org_id, provider_ref, state, period_end)` | Plus plan, reason, customer and subscription ids, provider status and creation, trial end, cancel at period end, grace end, sync and fetch marks, observed state, history table |
| `entitlement_overrides(org_id, scope, reason, expires_at)` | Plus value, creator, revocation; scopes for each limit, each feature and unrestricted access |
| `usage_events(id, org_id, type, quantity, dedupe_key, created_at)` | Plus `occurred_at`; unique `(org_id, dedupe_key)` |
| `billing_webhook_events(provider_event_id, status, processed_at)` | Plus type, object, organization, attempts, error, next attempt; no payload stored |
| `POST /v1/billing/checkout-session`, `GET …/subscription`, `GET …/usage`, `POST …/portal-session` | Under the organization like every route since 06: `/v1/orgs/{org}/billing/…`, plus plans, invoices and invoice links |
| `POST /v1/webhooks/billing` (provider-authenticated) | As specified |
| Admin overrides need reason, expiry and separate authorization | `billing_admin` only (a staff role no API can grant), reason ≥ 20 characters, expiry ≤ 90 days, revocable, audited both ways |

## Failure handling
| Required | Implemented |
|---|---|
| Provider outage does not lock paid users out: last validated state plus bounded grace | Access never calls Stripe; `active` stays active until 72 h after the period end without a confirmed renewal, then grace, restricted 10 days after the period end; `past_due` likewise ends (30 days) |
| Unavailable billing never overrides tenant permissions | Billing only narrows role and grant permissions; without Stripe, billing routes answer `BILLING_UNAVAILABLE` and everything else works |
| A replayed paid event cannot reactivate a newer canceled state | The current object is fetched and applied; a fetch older than the last applied one is ignored; an ended subscription never replaces a live one |
| Refunds and reversals reconcile, never delete profiles | Alerts for refunds and disputes; nothing deleted |

## Acceptance
| Criterion | Evidence |
|---|---|
| Sandbox tests: successful/failed payment, duplicate/out-of-order webhook, upgrade, downgrade, cancellation, grace expiry, concurrent seat/profile creation | `services/api/test/billing.test.ts` against an in-process fake Stripe speaking Stripe's HTTP API (all listed scenarios, plus outage, replay after cancellation, trial expiry, bulk import over the limit, stale reads, double checkout, resync back-off); request shapes validated against Stripe's OpenAPI with stripe-mock in CI; `stripe-sandbox.test.ts` runs against Stripe test mode with a test clock when the owner adds `STRIPE_TEST_SECRET_KEY` |
| No card data in logs | Test scans the API's log lines and every request sent to Stripe |
| Restricted customers can close profiles and recover/export | Test: a restricted organization heartbeats and releases its open profile, uploads a closing backup, downloads, exports, deletes and manages billing, while every action in `RESTRICTED_ACTIONS` is refused |
| Deliver catalog configuration, state diagram, reconciliation worker, admin roles, cost worksheet | [billing/README.md](billing/README.md) (catalog, Mermaid state diagram, worker schedule and alerts, roles), `services/api/src/billing/reconcile.ts` run by the worker, [cost worksheet](billing/cost-worksheet.md) |

## Independent review
A reviewer that had not seen the work checked the state logic against the rules above and found six defects, all
fixed with regression tests ([ADR-0018, "Independent review"](adr/0018-billing-plan-limits-and-support-access.md)):
joining through an invitation skipped the seat and restriction checks; `past_due` had no end; two fetches could commit
out of order; a still-paid older subscription lost to a newer ended one; one failing resync could block the others;
and the milestone 07 per-organization quota (20 GiB) capped the Team and Agency storage.

## Tests
Rust 321 across the workspace (new: payment-page address checks 2, window allow-list 1); API 525 + 13 gated
(Keycloak, S3, Stripe sandbox; new: 33 billing including the review fixes, 10 support, 5 console page, 8 stripe-mock,
Keycloak console client); worker 18; contracts 24; config 10; SDK 8; desktop UI unit 30; desktop UI end-to-end 176
(Billing screen and banner, checkout and portal opened by the shell, two screens in light and dark with axe); support
console unit 7 (PKCE sign-in) and end-to-end 6 (search, overview, two-person access approval and expiry, overrides,
alerts, audit, role-dependent controls, light and dark with axe, CSP violations fail the run).

CI: full run green on Windows x64, macOS arm64 and Linux at `dc8d359`
([ci 38513237885](https://github.com/bibekthapamgr/antibrowser/actions/runs/38513237885)): fmt, clippy, Rust tests per OS,
TypeScript + PostgreSQL 18 including the billing suites, stripe-mock ("8 request-shape tests passed against Stripe's
OpenAPI"), the Keycloak suite with the console client ("6 of 6 sign-in checks"), sync end to end, UI e2e for the
manager and the console, license inventory, secret scan. The Stripe sandbox step reported "skipped: no
STRIPE_TEST_SECRET_KEY repository secret". Installers in
[desktop internal build 38513138274](https://github.com/bibekthapamgr/antibrowser/actions/runs/38513138274) at `d388c86`.
Test server setup and update path with the console client, staff sign-in and billing defaults in
[deploy scripts 38513146856](https://github.com/bibekthapamgr/antibrowser/actions/runs/38513146856) at `d388c86`.

## Test server
`vps-setup.sh` changed, so the update runs **twice**; then `keycloak-setup.sh` once (it adds the console's sign-in
client). The update applies migrations 0008 and 0009 (existing organizations move to the `beta` plan with no end;
fixtures to `internal`), builds the console, creates `/etc/project-browser/billing.env` (yours; never overwritten) and
says "billing not set up yet" until a Stripe test key is in it. Stripe test mode, the price setup and the console's
staff roles are step by step in [billing/README.md](billing/README.md#stripe-test-mode-on-the-test-server).

## Found and fixed during verification
- Stripe checkout session ids contain underscores (`cs_test_…`): the event envelope check and the database check were
  widened.
- A usage query used the reserved word `end` as an alias; the app role lacked read access to the daily API counts.
- The independent review's six findings (above).
- The CI check of the stripe-mock run read colored text; it now reads the JSON report.
- Two screen fixes: the trial notice said "Trial · Trial"; a plan-card button selector triggered a CSS specificity
  warning.

## Known limitations
- Prices, final limits, the retention policy, tax registrations and terms of service are the owner's decisions;
  nothing has been charged. The limits in the catalog are placeholders.
- Live mode is not set up: it needs a public HTTPS API address and webhook endpoint (milestones 12/14). The test
  server receives Stripe's test events through the Stripe CLI forwarder; its signing secret is read at each setup run.
- Backup downloads (egress) are not in the usage ledger yet; take them from the storage provider for the worksheet.
- The support console is reached through the SSH tunnel like the rest of the test server; staff sign-in has no
  second factor requirement yet (Keycloak can require one per account with `--otp`; enforcement for staff is a
  milestone 12 item).
- Sandbox tests against real Stripe run only once the owner adds the `STRIPE_TEST_SECRET_KEY` repository secret.

## Release
No release boundary at this milestone (team beta was reached at 08; paid launch after 14, which requires the live
setup, prices and policies above).
