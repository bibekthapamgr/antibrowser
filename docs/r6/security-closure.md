# R6 — Security closure

Status of the findings the original launch gate names, as of **2026-10-15**. Full register:
[docs/security/findings.md](../security/findings.md). Authorization and session-exposure vulnerabilities are never
waived for schedule; the two residuals below are defence-in-depth gaps with no known path, accepted with a date, an
owner and a re-decision point.

| ID | Finding | Decision | Owner | Evidence | Re-decide |
|---|---|---|---|---|---|
| S1 | Staff sign-in without a second factor | **Closed.** Keycloak staff flow (R2) + API reads `amr` (R5) + **every** staff sign-in refused without a second factor in staging/prod (R6, cannot be turned off there) | Backend | `admin.test.ts` "refuses a password-only staff sign-in…", preflight `staff_mfa`, CI prod job | — |
| D1 | Repository admin takeover could get a build signed | **Open — owner action required before the stable channel.** Second required reviewer + prevent self-review; no admin bypass on `release` and `main`; reviews for `.github/workflows/**`; hardware-key 2FA for admins | Repository owner | GitHub settings export attached to the release checklist | before the first stable release |
| T3 | RLS trusts the organization the API sets | **Residual accepted** (defence in depth; all 127 routes resolve membership first and are tested as a non-member; role reachable only from the API on loopback; preflight proves no-bypass and no rows without tenant) | Backend lead | `cross-tenant.test.ts`, `database.test.ts`, preflight `database_rls` | end of the R7 pilot, before paid launch |
| C-L4 | Desktop local backups reuse one device key; `backup.json` unauthenticated | **Residual accepted** (needs write access to the person's own profile folder; cloud snapshots unaffected) | Desktop lead | `crates/runtime` backup tests when the HKDF fix lands | end of the R7 pilot, before paid launch |

## External review
A third-party penetration test (API, portal, staff console, desktop boundary) and a cryptography review (sealed
archive format, key hierarchy, update signing) are **owner actions not yet commissioned**. Scope and the findings go
into the register; the paid launch waits for them.

## R6 changes with security effect
- Production fails closed (ADR-0025 §3); development tokens and fixtures do not exist on staging/prod.
- Only the four public names are reachable; staff surfaces, Keycloak administration, the master realm, other buckets,
  OpenAPI and metrics are 404 publicly; the database, storage and service ports listen on loopback only.
- One readiness endpoint with status words only.
- Telemetry and logs: the proxy keeps no access log; the API's structured logs are redacted (no tokens, cookies,
  credentials or page content, milestone 13); the preflight report redacts every configured secret.

## Incident contacts
See [incident-and-rollback.md](incident-and-rollback.md).
