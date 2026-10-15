# 0025 — Public deployment, security and release readiness (R6)
Status: **Accepted (revised-roadmap track)**. Date: 2026-10-15. Owner: backend lead with the security owner, release
engineering and the product owner. Builds on ADR-0019 (backups, updates, recovery), ADR-0021 (accounts and staff
sign-in), ADR-0023 (website, portal, downloads) and ADR-0024 (business administration).

## Context
Until R5 the only server was a test server reached through an SSH tunnel: `APP_ENV=dev`, development tokens, fixture
tenants, Keycloak and the API on `127.0.0.1`. R6 must let a new laptop sign up, sign in and download without a tunnel,
on publicly trusted HTTPS, while the database, the storage, Keycloak's administration and service ports stay private,
and the release, runtime and signing gates are honest about what is and is not done.

## Decision

### 1. One environment per server, chosen once; the existing systemd setup is kept
- `vps-setup.sh` takes `PB_ENV=dev|staging|prod` and records it in `/etc/project-browser/environment`. The supported OS
  set and the hardened systemd units stay as they are; nothing is reimaged.
- Each environment has its own database (`pb_staging`, `pb_prod`), storage bucket (`pb-snapshots-<env>`), Keycloak
  realm (`project-browser-<env>`), secrets, Stripe keys (test for staging, live only for prod) and public names. A
  test server may become staging or prod; staging/prod are never turned back into dev.
- A single VPS is acceptable for a small staged launch. It is **not** high availability: a server outage is downtime;
  recovery is the off-site restore (RPO 15 min / RTO 4 h targets, ADR-0019). About 4 GB of memory is needed with
  Keycloak, PostgreSQL and the storage on one machine.

### 2. A TLS reverse proxy with four public names; everything else on loopback
- `public-setup.sh` installs Caddy (version and SHA-256 pinned) as `pb-proxy` (own user, only `CAP_NET_BIND_SERVICE`,
  no admin API, no access log). It obtains and renews publicly trusted certificates (ACME), redirects http to https and
  sends HSTS. Owner input: `/etc/project-browser/public.env` (`SITE_HOST`, `ADMIN_HOST`, `ID_HOST`, `FILES_HOST`,
  `ACME_EMAIL`), each name's DNS checked to point at the server.
- Routing is an allowlist: `SITE_HOST` serves the website, `/app/` and `/v1/` but never the staff console or staff API;
  `ADMIN_HOST` serves only `/console/`, `/v1/support/*` and `/v1/admin/*`; `ID_HOST` serves the realm but refuses
  `/admin` and the master realm; `FILES_HOST` serves only this environment's bucket (presigned links). The firewall
  opens 80 and 443 only (firewalld/ufw when active). The proxy overwrites `X-Forwarded-For`; the API trusts exactly one
  hop (`TRUST_PROXY_HOPS=1`).
- `TLS_MODE=internal` (Caddy's private authority) exists for automated tests only; the preflight fails it in prod.
- Map: [docs/r6/domain-service-map.md](../r6/domain-service-map.md).

### 3. Production configuration fails closed
- Outside dev/test the API refuses to start with development sign-in, a repository fixture secret, a non-https issuer,
  a loopback database not named for the environment, a shared bucket, an http portal origin, an http public storage
  endpoint or an http billing return address, a test Stripe key in prod or a live key elsewhere, or with
  `STAFF_REQUIRE_MFA=false`. The only loopback database allowed is `*_<env>` (single-server deployments).
- Development tokens do not exist on staging/prod; fixture tenants are not seeded; the test suite does not run there.

### 4. Sign-in: one realm per environment, separate audiences, staff MFA checked by the server
- Keycloak runs behind the proxy (`hostname=https://ID_HOST`, `proxy-headers=xforwarded`, http on 127.0.0.1 only).
  The desktop (`projectbrowser://auth/callback`), the portal BFF (`https://SITE_HOST/v1/web/auth/callback`) and the
  staff console (`https://ADMIN_HOST/console/`, CORS for that origin only) are three separate public clients with
  PKCE S256 and exact redirects. Logout stays as before (portal session revocation; no front-channel logout).
- Every staff sign-in in staging/prod must carry a second factor in the provider's signed `amr` claim; a password-only
  staff sign-in is refused (`MFA_REQUIRED`) and audited — enforced by the API, not the UI.

### 5. Billing, e-mail
- Staging/prod receive Stripe events at `https://SITE_HOST/v1/webhooks/billing` (an endpoint the owner adds in the
  Dashboard; its `whsec_` secret in `billing.env`); no CLI forwarder. The verified webhook remains the entitlement
  authority; the reconciliation job runs as before. The test-mode workflow is exercised on staging first.
- Live mail delivery is proven by evidence, not configuration: the preflight passes only after the worker delivered
  e-mail through the configured provider (the website contact form is the owner's test).

### 6. Readiness and the preflight
- `GET /v1/ready` is the only public status endpoint and says only `ready|not_ready` with `database`, `schema`
  (`current` when the database has at least the migration this build needs, `REQUIRED_SCHEMA`) and `worker` words;
  503 when not ready. No versions, hosts or errors. Migrations stay backward compatible and run before new code;
  rollback of code is allowed only within that compatibility range, keeping data and outbox events.
- `preflight.sh` (root facts) + `services/api/scripts/preflight.ts` (as the app user, with the API's own settings) report
  named PASS/FAIL/WARN checks — https/issuer, certificates, dev-auth off, public registration, e-mail delivery,
  customer/admin separation, readiness, webhook signature, database/RLS, staff MFA, private ports, secret file
  permissions, backup recency, release keys, runtime eligibility, artifact eligibility — and keep a JSON report. Every
  configured secret value is redacted from the report as a second safeguard. vps-setup runs it at the end of every
  staging/prod run.

### 7. Backups and restore rehearsal
- Off-site backups are unchanged (pgBackRest + rclone to R2; no bucket lock that would block pgBackRest's index
  rewrites; offline recovery kit). New: the bucket follows the environment; `pb-backup status` exits 3 with an ALERT line
  while log archiving fails; the preflight fails a failing or stale backup.
- `restore-drill.sh --workspace org_…` rehearses getting one workspace back from the real off-site path into an
  isolated cluster: every profile's newest snapshot (row ↔ object ↔ key), member count and the workspace's snapshot lag
  are recorded next to RPO/RTO. Production is never overwritten by a drill.

### 8. Release, signing and runtime gates are explicit
- The desktop release workflow refuses the stable channel unless the production address is compiled in
  (`PB_DEFAULT_SERVER`, so customers type no server address), the runtime manifest is approved for customer
  distribution (ADR-0010; updater tests do not settle licensing), and OS signing is set up (`PB_OS_SIGNING`) — or the
  owner explicitly chose an unsigned pilot (`PB_UNSIGNED_PILOT`), which labels the release "Unsigned pilot build" and
  never counts as the signed public release. Canary → stable promotes the exact signed files.
- An empty `release-keys.json` is never a trusted production set: the release workflow and the preflight both fail it.

### 9. Security findings
- S1 is closed (server-side MFA). T3 and C-L4 are accepted residuals dated 2026-10-15 with owners and a re-decision at
  the end of the R7 pilot. D1 remains open until the owner's GitHub protections are in place. External security and
  cryptography review is an owner action before paid launch. Details: [docs/r6/security-closure.md](../r6/security-closure.md).

## Consequences
- The owner runs one command per server (`vps-setup.sh`), fills four files (`public.env`, `smtp.env`, `billing.env`,
  `backup.env`) and reads one report. Several gates stay FAIL until owner actions outside the code are done (domain,
  certificates' DNS, real e-mail, Stripe live, release key, OS signing, runtime licensing, external review). That is
  intended: the preflight is the honest list.
- A CI job proves the production path on every change: prod setup behind TLS, fail-closed configuration, public
  surface, signup/verification/sign-in over https, staff with a one-time code, the expected preflight results.

## Alternatives considered
- nginx + certbot: two moving parts and renewal timers; Caddy's built-in ACME with a pinned binary is simpler to
  operate for one person. Exposing Keycloak and the API directly with their own TLS: more certificates and ports.
- Kubernetes or managed load balancers: out of scope for a single-server staged launch (ADR-0001 delivery plan).
- A database-side membership check for T3 now: per-row cost on scans and new worker/staff paths; scheduled instead.
