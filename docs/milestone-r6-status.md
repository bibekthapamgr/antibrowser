# R6 — status against the handoff file

Public deployment, security and release readiness (revised roadmap). API 0.18.0.
- **Decision:** [ADR-0025](adr/0025-public-deployment-and-release-readiness.md).
- **Deliverables:** [r6/README.md](r6/README.md) — domain/service map, preflight report, restore evidence, signed
  canary/stable evidence, security closure, owner operational guide, incidents and rollback.

**Outcome.** The code and scripts can run a staging or production server on the current VPS behind publicly trusted
HTTPS with four public names, everything else private, production configuration that fails closed, server-enforced
staff MFA, a safe readiness endpoint, a named preflight report, a one-workspace restore rehearsal and explicit release,
signing and runtime gates. CI proves the production path end to end with private certificates. **Not done yet (owner
actions outside the code):** domain/DNS, mail provider, Stripe live, R2 for the environment, the release key, D1
GitHub protections, OS signing (or the labelled pilot exception), the runtime licensing decision, external security
review, the staging restore rehearsal of record. The preflight shows each of them as FAIL until done.

## Deployment order

| Step | Done |
|---|---|
| 1. Final domains, pricing, legal contact; URLs in build/deploy configuration | Names in `public.env` (owner); API/portal/storage/billing addresses derived from it by the scripts; desktop address compiled in via `PB_DEFAULT_SERVER`. Prices: database catalog (R5). Domains, final prices and legal contact: **owner**. |
| 2. Reverse proxy and valid TLS; private services private | `public-setup.sh`: pinned Caddy, ACME, HSTS, http→https, allowlist routing per name, firewall 80/443 only; database/Keycloak/storage/API on 127.0.0.1; preflight `private_ports`. |
| 3. Production configuration fails closed | `env.ts` rules (dev auth, fixtures, https issuer, environment-named database, https portal/storage/billing addresses, MFA); no dev tokens/fixtures/tests on staging/prod. |
| 4. Production Keycloak; separate audiences; staff MFA server-side; negative test | Realm per environment behind the proxy; three clients with exact public redirects/origins; `STAFF_REQUIRE_MFA` enforced at `/v1/support/sessions`; negative test in `admin.test.ts`. |
| 5. Sender domain and mail; Stripe live, webhook, return host; test mode first; webhook is authority; reconciliation | Public webhook endpoint (no forwarder), live/test key per environment, `BILLING_RETURN_URL=https://SITE_HOST/…`, reconciliation unchanged; preflight `email_delivery`, `webhook_signature`. Provider accounts: **owner**. |
| 6. Off-site R2 backups, kit, no blocking bucket lock, alerting | Unchanged design; bucket per environment; `pb-backup status` ALERT/exit 3; preflight `backup_recency`; CI failed-backup test. R2 for production: **owner**. |
| 7. Restore drill on a realistic staging copy; one-workspace restore; linkage and lag | `restore-drill.sh --workspace`, `checkWorkspace` (row ↔ object ↔ key per profile, members, lag); [restore-evidence.md](r6/restore-evidence.md). Rehearsal of record: **owner run pending**. |
| 8. Release key; protected signing; review and MFA; canary then promote | Machinery from milestone 12; release workflow + preflight fail an empty key set. Key and D1 settings: **owner**. |
| 9. Windows signing and Apple notarization, or a labelled unsigned pilot | Release workflow gate `PB_OS_SIGNING` / `PB_UNSIGNED_PILOT` with an "Unsigned pilot build" label. Certificates: **owner**. |
| 10. Runtime distribution gate (ADR-0010) | Stable refused while `customer_distribution` is false; preflight `runtime_eligibility`. Decision: **owner**. |
| 11. External review; D1/S1/T3/C-L4 | S1 closed; T3, C-L4 residuals dated with owners; D1 open (owner); review not commissioned (owner). [security-closure.md](r6/security-closure.md). |
| 12. Incident contacts, status page, patching, escalation, rollback; telemetry without credentials/content | [incident-and-rollback.md](r6/incident-and-rollback.md); `STATUS_URL`; no proxy access log; redacted logs and report. |

## Mandatory preflight
Named PASS/FAIL/WARN for every item the handoff lists, no secret values: [preflight-report.md](r6/preflight-report.md).
Backward-compatible migrations before new clients; `/v1/ready` reports `schema: behind` and 503 if code is newer than
the database; only the readiness endpoint is public.

## Tests added or changed
- `packages/config/src/env.test.ts`: same-server database naming; https addresses in prod; staff MFA cannot be off.
- `services/api/test/admin.test.ts`: password-only staff sign-in refused and audited; with a code accepted.
- `services/api/test/web.test.ts`: idle and absolute portal cookie expiry.
- `services/api/test/security.test.ts`: readiness words and `REQUIRED_SCHEMA` = newest migration; one-workspace check.
- `services/api/test/preflight.test.ts`: every check's pass/fail rules, database checks, report redaction.
- `services/api/test/database.test.ts`: RLS-exempt list shared with the preflight.
- CI `deploy-scripts.yml`: "A failed backup is reported (R6)"; new job "production server behind TLS (R6)".

## Server steps for the owner (in the consolidated list after R7)
R5: migration 0016, `keycloak-setup.sh` again, `staff.ts bootstrap-owner`. R6: migration 0017 (runs with
`vps-setup.sh`), then — when the domain is ready — `PB_ENV=staging` on a staging server first, then `PB_ENV=prod`,
following [operations-guide.md](r6/operations-guide.md).
