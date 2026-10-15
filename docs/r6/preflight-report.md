# R6 — Preflight report

`bash scripts/deploy/preflight.sh` (root, staging/production server). Code: `scripts/deploy/preflight.sh` (machine
facts as root) and `services/api/scripts/preflight.ts` with the checks in `services/api/src/preflight.ts` (unit tests:
`services/api/test/preflight.test.ts`). Report: `/var/lib/pb-preflight/<time>.json` and `latest.json`. Exit code 0
only without FAIL. No secret value is printed or saved (details carry names, hosts, counts and file names; every
configured secret is also redacted from the report before it is written).

## Checks

| id | Passes when | Typical fix |
|---|---|---|
| `configuration` | (only reported on failure) the API configuration loads | the listed problems |
| `https_issuer` | `OIDC_ISSUER` is https on `ID_HOST`, discovery names exactly it; all four names answer over verified TLS with HSTS, and http redirects to https | DNS, `public-setup.sh`, `keycloak-setup.sh` |
| `tls_mode` | certificates come from a public authority (`TLS_MODE=public`) | remove `TLS_MODE=internal` (tests only) |
| `dev_auth_disabled` | `APP_ENV` is staging/prod, development sign-in off, and a made-up development token gets 401 from the public API | — (fails closed at start) |
| `public_registration` | "Create account" on the portal leads to the provider's registration form | set up `smtp.env` (registration opens only with e-mail) |
| `email_delivery` | a mail server is configured **and** the worker delivered e-mail in the last 30 days (WARN: failures in the last day) | send a message through the website contact form |
| `customer_admin_separation` | staff paths, Keycloak administration, the master realm, other buckets, OpenAPI and metrics answer 404 on the public names; the console is served on `ADMIN_HOST`; three separate sign-in clients | re-run `public-setup.sh` |
| `readiness` | `/v1/ready` answers 200 with only status words (WARN: worker stale) | `systemctl status pb-worker` |
| `webhook_signature` | billing configured (live key in prod) and a signature-verified event of the right mode arrived in 30 days (WARN: recent signature failures) | step 4 of the [operations guide](operations-guide.md) |
| `database_rls` | the app role is not superuser/BYPASSRLS, sees no rows without a tenant, every non-platform table has RLS | migrations / database roles |
| `staff_mfa` | `STAFF_REQUIRE_MFA` on and a platform owner exists | `staff.ts bootstrap-owner` |
| `private_ports` | PostgreSQL, API, Keycloak and storage ports listen on 127.0.0.1 only, the proxy runs (WARN: other programs' public ports) | stop or rebind the program |
| `env_files` | the secret files have their expected mode and owner | `chmod`/`chown` as listed |
| `backup_recency` | off-site backups configured, newest database backup < 8 days (WARN > 26 h), log archiving not failing now, objects copied < 15 min ago | `backup.env`, `pb-backup status` |
| `release_keys` | `release-keys.json` holds at least one key | owner generates the release key |
| `runtime_eligibility` | the runtime manifest is approved for customer distribution | ADR-0010 runtime decision |
| `artifact_eligibility` | the download page offers a verified stable release | release to stable |

## Expected state today (2026-10-15)
Code-side checks pass on a correctly set-up server. These stay FAIL until owner actions outside the code are done:
`tls_mode`/`https_issuer` (real domain and DNS), `email_delivery` and `public_registration` (verified mail provider),
`webhook_signature` (Stripe live), `backup_recency` (R2 for the environment), `release_keys` (release key),
`runtime_eligibility` (runtime licensing), `artifact_eligibility` (a signed stable release).

CI evidence (every change): the `production server behind TLS (R6)` job of `deploy-scripts.yml` sets up a prod server
with private certificates and asserts PASS for `https_issuer`, `dev_auth_disabled`, `public_registration`,
`email_delivery`, `customer_admin_separation`, `database_rls`, `env_files`, `staff_mfa`, PASS/WARN for `readiness` and
`private_ports`, and the honest FAIL of `tls_mode`, `release_keys`, `runtime_eligibility`, `artifact_eligibility`,
`webhook_signature`, `backup_recency`; and that no secret value appears in the output or the report.

## Report of record
Attach the `latest.json` of the production server to the launch checklist:

| Date | Environment | Result | FAIL ids | Signed off by |
|---|---|---|---|---|
| _(first production run)_ | prod | | | |
