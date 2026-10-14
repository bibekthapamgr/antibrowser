# R4 — status against the handoff file

Website, customer portal and checkout (revised roadmap). API 0.16.0.
- **Decision:** [ADR-0023](adr/0023-website-customer-portal-and-checkout.md).
- **Deliverables:**
  - staging website `apps/web-public` (served at `/`) and customer portal `apps/web-customer` (served at `/app/`);
  - catalog endpoint `GET /v1/public/plans`; download manifest integration `GET /v1/public/downloads`;
  - journey tests: [r4/README.md §3](r4/README.md#3-acceptance-journeys--tests);
  - page content: `apps/web-public/src/pages.mjs`, legal drafts in `apps/web-public/content/legal/`;
  - host layout, checkout sequence and the owner's content to-do: [r4/README.md](r4/README.md);
  - screenshots: `docs/design/site-*.png`, `docs/design/portal-*.png`.

**Outcome.** A visitor reads honest product pages, sees prices read from the payment provider (with currency, period
and tax), starts free without payment details, lands in a trial workspace in the portal and downloads the app when a
signed stable release exists. An owner pays through the provider's hosted checkout; the portal shows *Pending
verification* until the verified webhook activates the plan, and the desktop reads the same plan. Invited people join
without paying.

## Build in order

| Step | Done |
|---|---|
| 1. Home: real screenshots, concrete profile/team benefits, platforms, Start free / Sign in / Download | Yes. Two screenshots of the real app (sample data), six concrete features, a "What it does not do" section, supported systems. |
| 2. Pricing from the server catalog; monthly/yearly only if configured; currency, interval, tax; misconfigured plans hidden; no fingerprint / "never banned" claims | Yes. `GET /v1/public/plans`; the period switch appears only when a plan has both; unverifiable prices are not offered and never shown as $0. A build test rejects forbidden claims. |
| 3. Download: OS/arch, version/date, notes, verified links; never internal builds; "not yet available" if the gate fails | Yes. Verified with the app's release keys (signature, validity, pause, revocation). With no trusted key yet the page says "not yet available". |
| 4. Help/contact, security overview, status link, legal pages supplied/reviewed by the owner; no invented certifications | Help, contact form, security page; status link from `STATUS_URL`; privacy/terms/refund drafts with a visible Draft banner until the owner marks them reviewed. |
| 5. Portal overview: plan/trial end, usage, Download, Team, Billing, Account; owner sees billing controls | Yes; billing controls only with `billing.manage`, others see who manages billing. |
| 6. Reuse checkout/portal endpoints; price/plan/currency on the server | Yes; the request names a plan and period only. |
| 7. Checkout: validate → create/reuse idempotently → hosted checkout → Pending verification → webhook → Active → same entitlement | Yes (row lock + one active attempt per workspace + provider idempotency key). |
| 8. Plan intent through signup; resume canceled/failed checkouts; never two subscriptions | `?plan=` kept through signup and onboarding; open checkout reused; a different choice replaces it; subscribed workspaces go to the provider portal. |
| 9. Billing: invoices, payment methods, upgrade/downgrade/cancel via provider portal; no hand-calculated tax | Yes. |
| 10. Team reuses R3; Account: device revoke, password recovery, notification preferences, deletion request | Team = R3 invite wizard and access semantics; Account = computers (revoke), provider account page, optional e-mails, deletion request (recorded, withdrawable). |
| 11. Transactional notifications, deduplicated; marketing unsubscribe separate from essential mail | Welcome, verification, invitation, payment result, trial ending, contact copy; dedupe keys per period/trial; signed one-click unsubscribe for product news only. |

## Security
R2 cookie + CSRF + Origin; the portal cookie only on `web: true` routes, never on staff routes; site, portal and
console have separate CSPs with no inline code; public pages cacheable, account and billing answers `no-store`; the
contact form is validated, honeypotted and rate limited per sender and address; e-mail and support data are not
readable by the application role.

## Verification
- API: 593 passed, 13 skipped (`portal.test.ts` 11 new; stripe-mock request shapes include a product with monthly and
  yearly prices in one portal configuration).
- Worker: 27 passed.
- Portal e2e: 25 passed (journeys, axe light/dark at 375/1280 px, keyboard).
- Website: 8 build checks + 24 browser tests (pricing states, download gate, contact, 404, status link, axe, phone width).
- Desktop e2e: 204 passed.
- `deploy-scripts.yml`: the server script builds the site and portal; checks pages, CSP, caching, the catalog without
  prices, gated downloads and the portal.

## Owner content before customers
See [r4/README.md §4](r4/README.md#4-owner-to-do-before-customers-content-not-code): legal texts, prices (monthly and
optional yearly), `SUPPORT_EMAIL` and `STATUS_URL` in `site.env`, and a signed stable release (option B).

## Deploying to the test server
Nothing to run now: as agreed, every server update (migration `0015_customer_portal.sql`, the new `site.env`, the
site and portal builds) is applied together at the end of the revised roadmap with one consolidated list.

## Not in R4 (by design)
Business-owner administration (deletion request handling, refunds): R5. Public host names, TLS and separate origins:
R6. Pilot: R7.
