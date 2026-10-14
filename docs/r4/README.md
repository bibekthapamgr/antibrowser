# R4 — website, customer portal and checkout: reference

Decision record: [ADR-0023](../adr/0023-website-customer-portal-and-checkout.md). Status: [milestone-r4-status.md](../milestone-r4-status.md).

## 1. Surfaces and host layout (staging)

| Path | Served from | Who | Caching | CSP |
|---|---|---|---|---|
| `/`, `/pricing/`, `/download/`, `/help/`, `/contact/`, `/security/`, `/legal/*` | `apps/web-public/dist` (`PUBLIC_DIR`) | anyone | pages `public, max-age=300`; `/assets/*` immutable | self only; `connect-src 'self'` |
| `/app/` (hash routes `#/overview`, `#/billing`, `#/team`, `#/account`, `#/welcome`, `#/invite/…`) | `apps/web-customer/dist` (`WEB_DIR`) | signed-in customers (cookie) | page `no-store`; `/app/assets/*` immutable | self only |
| `/console/` | `apps/web-admin/dist` (`CONSOLE_DIR`) | staff only | `no-store` | self + identity provider |
| `/v1/public/*` | API | anyone | plans: `public, max-age=60` + ETag; downloads: `public, max-age=300`; contact: `no-store` | — |
| `/v1/*` (account, billing, team) | API | token or portal cookie on `web: true` routes | `no-store` | — |

One origin on staging (the API serves all four). Public host names, TLS and separate origins are R6.

Build: `pnpm --filter @pb/web-public build` and `pnpm --filter @pb/web-customer build` (the server script does both).

## 2. Catalog and checkout sequence

```
website /pricing/ ── GET /v1/public/plans ──► verified prices (provider, cached) ─► "Start free, then Team"
   │                                                                                 │
   └── /app/#/welcome?plan=team ── sign up / verify (provider) ── onboarding (trial workspace, plan intent kept)
                                                                                     │
portal Billing ── POST /orgs/{org}/billing/checkout {plan_id, interval, return_to: portal}
   server: owner? plan sellable at that interval? not subscribed?
           lock subscription row → open attempt same plan+interval → reuse URL
                                  → different choice → expire old session, mark replaced
                                  → none → insert `creating`, call provider (idempotency key pb-checkout-<attempt>)
   ◄── hosted checkout URL
provider checkout ── success ──► /app/#/billing/return?result=success  → "Pending verification" (polls)
                 └─ cancel  ──► /app/#/billing/return?result=canceled → "Nothing was charged" (resume any time)
provider webhook (verified signature, deduplicated) ── reconcile from fresh provider data ──► subscription active,
   attempt completed, payment e-mail queued once per period
desktop app & portal ── GET /orgs/{org}/billing/subscription ──► same plan and limits
```

## 3. Acceptance journeys → tests

| Journey | Where it is tested |
|---|---|
| Trial signup → workspace → download → desktop sign-in → launch | `deploy-scripts.yml` (real Keycloak: register, verify e-mail, onboarding, welcome mail); portal e2e "trial signup"; desktop e2e (sign-in, Create Profile, open); download gate in `portal.test.ts` |
| Paid: checkout → webhook → same plan in the desktop | `portal.test.ts` "pays through the portal return…"; `billing.test.ts` "a successful payment activates the plan; the redirect back alone changes nothing"; portal e2e "paying" |
| Invited member without checkout | portal e2e "an invited member joins without paying"; `deploy-scripts.yml` signup of an invited teammate |
| Canceled checkout | portal e2e "a canceled checkout charged nothing"; `portal.test.ts` reuse/replace |
| Declined card | `portal.test.ts` "…a declined card recovers"; `billing.test.ts` "a failed payment at checkout changes nothing" |
| Delayed or duplicate webhook | `billing.test.ts` "a duplicate event is recorded once and applied once", "an outage never locks a paid organization out…", "out-of-order and replayed events…"; portal e2e slow confirmation |
| Renewal failure | `billing.test.ts` "past_due keeps full access; exhausted retries give 7 days of grace…" (+ payment_failed e-mail in `portal.test.ts`) |
| Canceled subscription | `billing.test.ts` "cancellation at the period end keeps the plan until then…" |
| Downgrade below usage | `portal.test.ts` "a downgrade below current usage keeps everything and only stops new creation" |
| Concurrent checkout | `portal.test.ts` "concurrent clicks create one" |
| Unverifiable / disabled prices | `portal.test.ts` "a disabled or unreadable price is not offered…"; site and portal e2e "never shown as free" |
| Downloads never internal | `portal.test.ts` downloads; site e2e "not yet available"; `deploy-scripts.yml` |
| Contact form | `portal.test.ts` contact; site e2e contact |
| No SSH tunnel or manual setup for new users | the whole path runs in the browser and the app against the server's own origin; desktop builds take a default server (`PB_DEFAULT_SERVER`) |
| Phone width, keyboard, loading/error/empty states | site e2e and portal e2e: axe light/dark at 375 px and 1280 px, no sideways scroll, skip link; API down / no prices / no release states |

## 4. Owner to-do before customers (content, not code)

1. **Legal texts**: replace the drafts in `apps/web-public/content/legal/` (privacy, terms, refunds — the bracketed
   parts: company address, providers and locations, refund rules) and set `"reviewed": true, "updated": "YYYY-MM-DD"`
   in `meta.json`. Until then the pages show a Draft banner.
2. **Prices**: run `stripe-setup.ts` with your monthly amounts (and `--year-price plan=AMOUNT` for yearly).
3. **Support address**: `SUPPORT_EMAIL` (contact form recipient) in `/etc/project-browser/site.env` (created by the
   server script, yours to edit).
4. **Status page** (optional): `STATUS_URL` (https) in the same file — shown in the website footer and the portal.
5. **Signed release** (option B): add your release public key to `release-keys.json`; the download page then offers it.
