# Security report — milestone 12 (production security, updates and recovery)

Date: 14 October 2026. Version: 0.12.0. Prepared for the owner and future auditors. This report summarises what
was reviewed, what was tested, what was found and fixed, and what remains before the paid launch. The details live
in the linked documents; this page is the entry point.

| Document | What it holds |
|---|---|
| [Threat model](threat-model.md) | Assets, attackers, every boundary with its defence, evidence and residual risk |
| [Findings register](findings.md) | Each review finding with severity, owner, status and verification |
| [Update runbook](update-runbook.md) | Release keys, releasing, emergency actions, verification, key rotation |
| [DR runbook](dr-runbook.md) | Backups, offline kit, restore drill, whole-server restore, scenarios, retention |
| [Incident response](incident-response.md) | Contacts, severity, procedure, playbooks |
| [Customer-facing limitations](limitations.md) | What the product does not protect against; data retention after deletion |
| [ADR-0019](../adr/0019-production-security-updates-and-recovery.md) | The decisions |
| [SECURITY.md](../../SECURITY.md) | How to report a vulnerability |

## Result
**Gate met for this milestone: no open critical or high finding.**
- 1 medium finding (D1, custody of the signing key against a GitHub admin-account takeover) is tracked. It must be
  resolved before the paid launch; the owner actions are listed.
- 10 of 12 low findings are fixed and verified by tests; 2 are tracked with owners (T3, C-L4).
- A third-party penetration test is still required before the paid launch. The reviews here were independent of the
  code's authors but AI-assisted ([findings](findings.md#how-the-review-was-done)).

## What was required and the evidence

| Required | Evidence |
|---|---|
| Threat model: manager IPC, browser boundary, local secrets, tenant access, object downloads, extensions, updater, automation, billing, support console; session theft, cross-tenant, supply chain | [threat-model.md](threat-model.md), with a test or document named for each defence |
| Independent review of tenant authorization, cryptography and the desktop boundary, tracked by severity, owner and remediation | Three separate reviews; [findings.md](findings.md) |
| Signed desktop and runtime manifests, OS signing, checksums, SBOM, provenance; signing keys in restricted infrastructure | **Manager:** signed channel manifests and per-artifact signatures (ADR-0019 §1). **Runtime:** Ed25519-signed manifest since milestone 03. Checksums: `SHA256SUMS` per release. **SBOM:** CycloneDX in every release, attested, plus one per commit in CI (`ci.yml`, artifact `sbom`). **Provenance:** GitHub build-provenance attestations (release and internal builds). **Keys:** only in the protected `release` environment; build jobs hold no secrets. **OS signing:** not yet (owner decision); the pipeline is ready. |
| dev / canary / stable channels; interrupted updates, wrong signatures and stale-manifest replay tested; anti-rollback | `crates/update` (35 tests) and `apps/desktop/src-tauri/tests/updates.rs` (9), named below |
| Runtime upgrades staged against compatibility fixtures, a pre-migration snapshot, recovery to a compatible snapshot | `runtime-pipeline.yml` (an old-runtime profile opened by the new runtime); before-upgrade copy and restore (`a_withdrawn_browser_upgrade_rolls_back_to_the_copy_made_before_it`, `runtime_upgrade_keeps_a_copy_the_old_browser_opens`) |
| Pause and revoke releases without wiping customer data | `pause`, `resume`, `revoke` (every channel) and `minimum` in `desktop-release.yml`; server `MIN_DESKTOP_VERSION`. Tests: `paused_and_revoked_releases_are_withdrawn_and_vulnerable_versions_flagged`, `a_revoked_runtime_is_neither_installed_nor_opened`, `security.test.ts` (minimum version) |
| Database PITR, object versioning and retention, separate backup permissions | pgBackRest to R2 (log at least every 60 s); object copies with `objects-deleted/` kept 30 days; root-only credentials, a `pb-backup` user, and a read-only storage identity. CI checks each of these (`deploy-scripts.yml`). |
| Incident procedures, retention and deletion testing, residual retention statements | [incident-response.md](incident-response.md); trash, purge and retention tests (`sync.test.ts`); deleted-object retention checked off-site in CI; [limitations → data retention](limitations.md#data-retention) |
| RPO ≤ 15 min, RTO ≤ 4 h | Measured by the restore drill and the whole-server restore in CI (below). The owner repeats both on the server after setup. |
| Break-glass: short expiry, reason, immutable audit export | `staff.ts break-glass`: 5–60 min, a reason, named organizations, alerts reviewed by another admin. Hash-chained append-only platform audit with a verifiable export. `support.test.ts`, `security.test.ts` |
| No "view every user's cookies" dashboard | No route or screen exposes browser session data; staff cannot decrypt snapshots (threat model §10) |
| Restores need recent authentication and the correct tenant scope | `requireRecentAuth` for non-head and recovery restores, undelete, key rotation and export; tokens without `auth_time` never qualify; tenant checks on every route. `sync.test.ts`, `oidc.test.ts`, `cross-tenant.test.ts`, `crates/sync/tests/real_api.rs` |
| Health shows status only; no debug endpoints; limited crash dumps | `security.test.ts` (no documentation, debug or metrics routes; status-only health; no `server` header); `--disable-breakpad` for Chromium; manager crash reports local, opt-in and scrubbed |

### Failure exercises required by the test gate

| Exercise | Test |
|---|---|
| Restore staging into an isolated environment; prove linkage for two tenants | `restore-drill.sh` in `deploy-scripts.yml`: R2 stand-in → isolated cluster → row ↔ object ↔ key for two tenants plus five isolation checks (`services/api/src/backup/restore-check.ts`). The same checks run in-process in `security.test.ts`. |
| Expired signing certificate (release key) | `release_keys_must_match_their_id_and_have_a_window`; `stale_replayed_forged_and_expired_key_manifests_are_refused` (`UPDATE_KEY_EXPIRED`); `release.test.mjs` (expired key refused by the release gate) |
| Signature mismatch | `manifest_signature_key_and_file_are_checked`; `corrupt_and_wrongly_signed_updates_are_deleted_and_never_installed`; legacy signatures refused (`release.test.mjs`) |
| Corrupt update | `corrupt_oversized_and_wrongly_signed_downloads_are_discarded`; `hostile_archives_are_refused` |
| Interrupted download | `downloads_verify_and_resume_after_an_interruption`; `a_server_that_ignores_the_range_restarts_the_file`; `an_interrupted_download_resumes_where_it_stopped` |
| Unavailable KMS | `security.test.ts` "an unavailable key service stops only what needs snapshot keys": `503 UNAVAILABLE`, retryable, everything else works |
| Failed migration | `security.test.ts` "a failing migration changes nothing…"; `crates/storage` `failed_migration_keeps_the_previous_database_and_can_recover` |

## Restore evidence
From CI ([deploy scripts run 38540671668](https://github.com/bibekthapamgr/antibrowser/actions/runs/38540671668) at
commit `22d095f`: a fresh Ubuntu 24.04 VM with the server scripts, a TLS R2 stand-in and two fixture tenants):

| Exercise | Result |
|---|---|
| Restore drill into an isolated cluster | **Passed.** Two tenants linked (row ↔ object ↔ key) with no cross-access; marker found. Recovery point **1 s** (target ≤ 15 min), recovery time **11 s** (target ≤ 4 h). |
| Whole-server restore over the live server (`restore-server`), setup re-run | **Passed in 80 s**, including `vps-setup.sh` and `keycloak-setup.sh`. The last change before the restore was kept, an API session from before still worked, earlier snapshots restored and backups resumed. The later CI steps (sign-ins, user management, root-key rotation with re-wrapping) then ran against the restored server. |
| Deleted snapshot object kept off-site | Gone from the live off-site copy, kept under `objects-deleted/<date>/` |

The CI times are for a small database. On the owner's server, run the drill after setting up R2 (DR runbook) and
keep the report from `/var/lib/pb-backup/drills/`.

## Supply chain

| Measure | Where |
|---|---|
| Locked dependencies (`Cargo.lock`, `pnpm-lock.yaml`, `--frozen-lockfile`, `--locked`) | All CI jobs |
| Third-party actions pinned by commit in release and attestation steps; actionlint in CI | `desktop-release.yml`, `desktop-internal-build.yml`, `ci.yml` |
| Secret scanning (gitleaks with project rules, including Tauri signing keys) | `ci.yml`, `.gitleaks.toml` |
| SBOM: CycloneDX per commit (CI artifact, 90 days; at `22d095f`, 614 Rust crates and 255 npm packages) and per release (published and attested) | `ci.yml` job `licenses`; `desktop-release.yml` |
| Build provenance attestations | `desktop-release.yml`, `desktop-internal-build.yml` |
| No secrets in build jobs; the key job installs with `--ignore-scripts` | `desktop-release.yml` |
| License inventory | `docs/licenses/` |

## Residual risks and owner actions before the paid launch
1. **D1:** protect the signing key. Second reviewer with "prevent self-review", no admin bypass, reviews for
   workflow changes, hardware-key 2FA. Preferably offline or hardware signing.
2. **Third-party penetration test** and cryptography review. Record the results in the findings register.
3. **OS code signing** (Windows certificate, Apple Developer ID) when affordable. Until then it is disclosed in the
   limitations.
4. **T3** (membership re-check in row-level security) and **C-L4** (per-backup local keys), planned for
   milestone 13.
5. Name a **second person** for incidents, with access to the offline kit.
6. Rehearse a single-organization restore (DR runbook, scenario 3) and a SEV-1 tabletop.
