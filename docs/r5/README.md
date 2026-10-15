# R5 — business-owner administration: access guide, walkthrough and evidence

Decision record: [ADR-0024](../adr/0024-business-owner-administration.md). Status: [milestone-r5-status.md](../milestone-r5-status.md).
Role matrix: [permission-matrix.md → Platform staff](../permission-matrix.md#platform-staff-r5-adr-0024).

## 1. Admin URL and access

| | |
|---|---|
| Console | `<server>/console/` (staging: `http://127.0.0.1:8080/console/` through the SSH tunnel; R6 gives it its own hostname) |
| Sign-in | your staff account at the identity provider: password **and** one-time code every time (no single sign-on) |
| Session | 30 minutes, no refresh; closing the tab ends it |
| Who | staff only (`platform_staff`); workspace owners are not staff |

**First platform owner (once, on the server)** — the person signs in to Project Browser or the portal once first, so
their account exists, then:

```
runuser -u pb -- bash -c "cd /home/pb/antibrowser/services/api && /opt/node/bin/node --env-file=/etc/project-browser/api.env scripts/staff.ts bootstrap-owner you@example.com"
```

It refuses when an active platform owner already exists. More staff, by an operator with server access:

```
… scripts/staff.ts add someone@example.com --roles business_admin          # or business_analyst, support, support_lead, billing_admin
… scripts/staff.ts list
… scripts/staff.ts remove someone@example.com                                # the last platform owner cannot be removed
```

The console's Staff screen (platform owners) lists staff and the role mapping; it does not change them.

## 2. What each role sees

| Screen | platform_owner | business_admin | business_analyst | support roles |
|---|---|---|---|---|
| Dashboard | yes | yes | yes | — |
| Customers (list, detail) | yes, with owner addresses | yes, with owner addresses | yes, addresses masked | — (exact search only) |
| Payment restriction | yes | yes | — | — |
| Security suspension (workspace or account) | yes | — | — | — |
| Case notes | read, write | read, write | read | read, write |
| Plans (drafts, publish) | yes | yes | read | — |
| Operations (retry e-mail, resync) | yes | yes | read | leads and billing admins |
| Release requests | yes | — | — | — |
| Staff | yes | — | — | — |
| Members and activity of a workspace | after approval by a support lead (milestone 11), or break-glass | same | — | same |

## 3. Owner walkthrough

1. **Sign in** at `/console/` with your password and one-time code. If the yellow banner says the session was opened
   without your code, sign out and in again.
2. **Dashboard** — active customers, paying, trials, past due/grace, restricted, canceled; recurring revenue per
   currency (each currency on its own line, never converted); cash collected and refunds in the last 30 days; open
   payment alerts; how fresh the numbers are and what they do not include.
3. **Customers** — type the start of a name, an `org_…` id, a `cus_…` id or an owner's e-mail; filter by state or plan;
   *Show more* for the next page. Open a customer for plan, price, usage, members by role, computers by platform,
   invoices, provider events, restrictions, notes and who looked.
4. **Restrict a workspace** (unpaid chargeback, abuse report) — choose *Payment restriction* (stops new and opened
   profiles, keeps data, export and billing) or, for security, *Security suspension* (stops all access, closes open
   profiles, revokes API tokens). Write the reason (kept internally, not e-mailed), optionally an end in days, and
   whether to e-mail the owners. *Lift…* with a reason undoes it.
5. **Change a plan or price** — *Plans → New version of …* opens a draft with the current values. Change limits,
   features or prices (amounts before tax; monthly, optionally yearly), *Save draft*, then *Publish…* and confirm.
   The payment provider creates new prices (they can never be changed afterwards); new purchases use the new version
   at once; existing customers keep what they bought. If the provider fails, nothing is published and the draft stays
   — publish again later. To stop selling a plan, publish a version with *Sell this plan* unchecked.
6. **Operations** — failed provider events, failed e-mail (*Retry* within 7 days), outbox, last profile backup,
   log-archiving status, when the worker last ran, the release channel. *Record request* asks the release pipeline to
   pause/resume downloads or publish a built version; nothing is changed from the console.
7. **Refunds and payment changes** stay in the payment provider's dashboard; the console shows their effect (refund
   totals, alerts). There is no "mark as paid": access follows what the provider confirms.

## 4. Metrics definitions

| Metric | Definition | Not included / caveats |
|---|---|---|
| Workspaces by state | customer workspaces (internal plan excluded) by billing state as last observed by the worker | ≤1 minute old |
| Active customers | trial + active + past due + grace | |
| Paying | provider subscription present and active | |
| MRR (per currency) | Σ list price × quantity ÷ months per billing period, active provider subscriptions | discounts, credits, one-time items; tax-inclusive prices include tax (counted and listed as a gap) |
| At risk | the same for past-due and grace subscriptions | not in MRR |
| Canceling | the part of MRR set to cancel at the period end | |
| Cash collected 30 d | Σ amount paid of paid invoices created in the last 30 days, per currency | |
| Refunds 30 d | Σ refunded amount of charges refunded in the last 30 days, per currency | |
| Freshness | oldest provider confirmation of a live subscription, last applied provider event, events waiting/failed | |

## 5. Completion checks → evidence

| Check | Evidence |
|---|---|
| Customer token / workspace owner cannot reach admin endpoints | `admin.test.ts` "customers, workspace owners and portal cookies never reach admin routes" |
| Support-only staff cannot enumerate all accounts | `admin.test.ts` "support-only staff cannot list all customers…"; database refusal test; console e2e "support-only staff do not see business screens" |
| Staff MFA | `admin.test.ts` (session without `otp` → `MFA_REQUIRED`); `deploy-scripts.yml` (real Keycloak: `amr` contains `otp`, `/admin/me` → `mfa: true`) |
| Last platform owner protected | `admin.test.ts` "the first platform owner is bootstrapped once; the last owner cannot be removed or demoted"; `deploy-scripts.yml` second bootstrap refused |
| Two simultaneous publish requests → one catalog version and price mapping | `admin.test.ts` "two simultaneous publish requests…" (2 provider price creations for 2 intervals, 1 plan row) |
| Failed publication never leaks to pricing | `admin.test.ts` "a failed publication publishes nothing…" (public `catalog_version` unchanged); console e2e |
| Existing subscribers retain old limits/price | `admin.test.ts` "a workspace that bought a version keeps its limits and price…" |
| Restriction/revoke across web/desktop/API | `admin.test.ts` restrictions (desktop session → `SUBSCRIPTION_RESTRICTED` / `WORKSPACE_SUSPENDED` / 401; leases revoked; tokens revoked; lift restores) |
| Metrics reconcile with controlled fixtures, currency separate | `admin.test.ts` "recurring revenue, cash and refunds reconcile…" (USD monthly + yearly, EUR every 3 months, refund) |
| Role matrix | [permission-matrix.md](../permission-matrix.md#platform-staff-r5-adr-0024); `admin.test.ts` mapping parity with the database |
| Dashboard and screens usable | `apps/web-admin/e2e/admin.e2e.test.ts` (flows, axe light/dark, 390 px and 1280 px, no sideways scroll); screenshots `docs/design/admin-*.png` |
