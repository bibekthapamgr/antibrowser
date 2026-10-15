# R5 — status against the handoff file

Business-owner administration and catalog publishing (revised roadmap). API 0.17.0.
- **Decision:** [ADR-0024](adr/0024-business-owner-administration.md).
- **Deliverables:**
  - admin URL and access guide, owner walkthrough, metrics definitions: [r5/README.md](r5/README.md);
  - dashboard and screens: `apps/web-admin` (Dashboard, Customers, Plans, Operations, Staff), screenshots
    `docs/design/admin-*.png`;
  - catalog migration: `infra/db/migrations/0016_business_admin.sql` (database-published catalog, drafts,
    publications, immutable versions);
  - role matrix: [permission-matrix.md → Platform staff](permission-matrix.md#platform-staff-r5-adr-0024);
  - test evidence: [r5/README.md §5](r5/README.md#5-completion-checks--evidence).

**Outcome.** The owner runs routine customer work from `/console/`: sees customers, revenue and alerts, finds and
inspects a customer, restricts or suspends with a reason and lifts it, writes case notes, changes plans and prices by
publishing new versions, retries e-mail and records release requests — without shell or SQL. Support staff keep their
narrower tools and the two-person rules.

## Ordered implementation

| Step | Done |
|---|---|
| 1. New staff permissions enforced server-side on each endpoint; staff MFA | Business roles + versioned mapping (code and database); each `/v1/admin` route names its permission, checked in the API and again in the database; MFA from the `amr` claim (Keycloak staff flow sets `pwd`/`otp`), required on all admin routes and for business roles on support routes. |
| 2. Bounded aggregates, cursor-paginated customer list, minimal PII, audited browsing | Definer functions per reader; ≤100 per page; owner address only with the contact permission; every list and view audited; no sessions, credentials, cookies, screenshots or member names. |
| 3. Explicit metrics | MRR per currency (monthly-normalized list price × quantity), at risk, canceling; cash and refunds separate; freshness and gaps shown. |
| 4. Audited restrictions (reason, scope, expiry, notification); payment vs security; revoke/lease handling | `account_restrictions`; payment → `restricted`/`staff_restriction`; security → `WORKSPACE_SUSPENDED`, leases fenced, tokens revoked; account → disabled, sessions and tokens ended; notices without the internal reason; expiry undone by the worker; nothing deleted. |
| 5. Provider portal for refunds; no "mark paid"; entitlement exception with reason/expiry/audit | Refunds stay at the provider (shown as metrics and alerts); entitlement exceptions are the milestone 11 overrides (now also for business admins and owners). |
| 6. Drafts and immutable published versions; database is runtime authority | `plans` immutable by trigger; `plan_prices`, `catalog_state`; seeds only fill missing versions; pricing, checkout, portal, desktop plan list, onboarding and the worker read the database. |
| 7. Publishing workflow without a transaction across the provider call | Claim → provider (create/reuse, verify) → commit → cache dropped; failure leaves the draft unpublished and alerts. |
| 8. Subscribers keep version and price; new price for new purchases; never mutate a provider price | Tested end to end. |
| 9. E-mail status/retry, subscription resync, redacted case notes | Operations screen; failed e-mail kept sealed 7 days for retry; notes redacted before storage; resync on the customer page. |
| 10. Release metadata through the signed pipeline only | Release actions are recorded requests; the channel status comes from the verified manifest. |

## Completion checks
All passing — see [r5/README.md §5](r5/README.md#5-completion-checks--evidence).

## Verification
- API: 611 passed, 13 skipped (`admin.test.ts` 18 new; billing catalog test now proves the database refuses to change a
  stored version).
- Worker: 28 passed (failed e-mail kept for retry then erased; restriction notices).
- Console e2e: 22 passed (8 support + 14 business: flows, axe light/dark, phone width).
- Portal e2e: 25 passed. Website: unchanged.
- `deploy-scripts.yml`: real Keycloak sign-in with `amr` = pwd+otp, MFA session, owner bootstrap once, admin data.

## Deploying to the test server
In the consolidated list at the end of the roadmap: migration `0016`, `keycloak-setup.sh` again (amr settings and
`STAFF_MFA_AMR`), then `staff.ts bootstrap-owner <your e-mail>` once. Until the server is updated, the console keeps
working as in R4 for support roles.

## Not in R5 (by design)
Refunds or payment changes from the console (provider dashboard); staff management in the console (server command);
currency conversion in reports; account deletion processing beyond the pending count (policy decision for the owner).
Public hostnames and TLS: R6. Pilot: R7.
