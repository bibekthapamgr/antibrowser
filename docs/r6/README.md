# R6 — Public deployment, security and release readiness

Decision: [ADR-0025](../adr/0025-public-deployment-and-release-readiness.md). Status against the handoff file:
[milestone-r6-status.md](../milestone-r6-status.md).

## Deliverables
| Deliverable | Where |
|---|---|
| Domain/service map | [domain-service-map.md](domain-service-map.md) |
| Preflight (script + report format + expected results) | `scripts/deploy/preflight.sh`, `services/api/scripts/preflight.ts`; [preflight-report.md](preflight-report.md) |
| Restore evidence | `restore-drill.sh --workspace`; [restore-evidence.md](restore-evidence.md) |
| Signed canary/stable evidence | [release-evidence.md](release-evidence.md) |
| Security closure | [security-closure.md](security-closure.md) |
| Owner operational guide | [operations-guide.md](operations-guide.md) |
| Incidents, escalation, rollback, patch coverage | [incident-and-rollback.md](incident-and-rollback.md) |

## Acceptance tests
| Acceptance item | Automated evidence |
|---|---|
| New laptop signs up, logs in, downloads without a tunnel; production app needs no server address | CI `deploy-scripts.yml` → job "production server behind TLS (R6)": "A new laptop signs up, verifies, signs in and downloads (no tunnel)" (signup + e-mail verification + desktop sign-in over the public https names); `PB_DEFAULT_SERVER` compiled into release builds (required for stable); `apps/desktop/src-tauri/tests/account.rs` → `a_build_default_server_is_offered_once_and_create_account_opens_registration` |
| Real provider e-mail and webhook checks | preflight `email_delivery` (delivery recorded) and `webhook_signature` (verified event of the right mode) — pass only with the real providers on the server |
| Revoked staff access | `support.test.ts` → "removing staff with the server command ends their console sessions at once" |
| Revoked member access | `organizations.test.ts` → "a removed member, a removed grant or a lowered role loses access at the next request"; `sessions.test.ts` → "taking launch away, a role change and removal from the organization end sessions too"; `crates/sync` → `revoked_access_ends_the_upload_and_the_lease` |
| Expired cookie | `web.test.ts` → "an idle or expired portal cookie is refused, and use within the limits slides only the idle window (R6)" |
| Cross-origin request | `web.test.ts` → "changes need the CSRF token and the portal origin; reads do not"; `keycloak.test.ts` → console CORS for its origin only |
| Update tamper/replay | `crates/update` → `rejects_tampering_unknown_keys_and_bad_signatures`, `stale_and_replayed_manifests_are_refused`, `offers_only_newer_safe_versions_and_never_rolls_back`; `apps/desktop/src-tauri/tests/updates.rs` → `stale_replayed_forged_and_expired_key_manifests_are_refused`, `corrupt_and_wrongly_signed_updates_are_deleted_and_never_installed` |
| Lost network during sync | `crates/sync` → `network_lost_at_every_call_keeps_the_prior_snapshot_and_commits_once`, `a_download_cut_off_resumes_where_it_stopped`; `apps/desktop/src-tauri/tests/team.rs` → `a_lost_connection_closes_the_browser_before_the_lease_runs_out_and_the_handoff_resumes` |
| Failed backup | CI "A failed backup is reported (R6)" (R2 down → PostgreSQL records the failure → `pb-backup status` ALERT, exit 3 → recovery); `preflight.test.ts` → backups check |
| Password-only staff sign-in rejected | `admin.test.ts` → "refuses a password-only staff sign-in when STAFF_REQUIRE_MFA is on…" |
| Production fails closed | `env.test.ts` (same-server database naming, https addresses, MFA cannot be off); CI "Production configuration fails closed" |
| Only public surfaces public; safe readiness | CI "Only the public surfaces are public"; `security.test.ts` readiness; preflight `customer_admin_separation`, `private_ports`, `readiness` |
| Real restore meets RPO/RTO | CI restore drill (RPO < 900 s); staging rehearsal of record: [restore-evidence.md](restore-evidence.md) (owner run pending) |
| Runtime and signing gates for claimed distribution | release workflow gates; preflight `runtime_eligibility`, `release_keys`, `artifact_eligibility` |
| No live secret in repo or artifacts | gitleaks in CI; test keys built at run time; preflight report redaction (`preflight.test.ts`) and the CI secret scan of the report |
