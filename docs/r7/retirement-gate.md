# R7 — Feature retirement gate

## Rules
- A screen or action is removed only when its replacement has parity and every supported route and link still lands
  somewhere sensible (deep links redirect, not 404).
- Dead UI code is removed only after a reference scan (imports, routes, tests) and the regression suites pass.
- Old customer records — clients, tasks, folders, API fields — are **never dropped because navigation changed**. They
  stay readable through the API and exports.
- Schema cleanup waits for a compatibility observation window: record actual usage first (how many workspaces still
  have the old records, which API fields are still called), decide in an ADR, then migrate.
- Optional agency/developer modules (clients dashboard, automation, API tokens) stay off the default onboarding path.

## Done in R7
| Check | Result |
|---|---|
| Demo/fixture code in production bundles | **Fixed.** The desktop bundle used to ship the in-memory demo backend (demo workspaces and the `__pbDemo` hook, unreachable inside the app but present). It now exists only in demo builds (`vite --mode demo`, `build:demo` → `dist-demo`); the UI tests use that build. |
| Artifact inspection | `scripts/ci/check-production-bundles.mjs` runs after every production build in CI and fails on demo names, test hooks, fixture ids or fixture secrets in the desktop, portal, console or website bundles. |
| Server fixtures | Development tokens and fixture tenants cannot be enabled in staging/prod (configuration refuses to start; preflight `dev_auth_disabled`). |
| Rust test features | `testing` features of the sync, network, devtools and update crates are dev-dependencies only; the `PB_DEV_BROWSER` override is debug-build only. |
| Docs describing compulsory organization/client setup | Scan of `docs/`, the website and the portal for "create an organization/client first": none left outside historical milestone records and ADRs (kept as history). |
| Agency/developer modules on onboarding | Onboarding creates one workspace with a trial; clients, automation and API tokens are reached from their own pages only. |

## Observation window (to do after launch)
After 60 days of production use, record: workspaces with clients or tasks, calls to legacy API fields (request logs by
route), local schema versions seen by the update server. Only then propose cleanup in a new ADR.
