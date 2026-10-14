# Threat model (milestone 12)

Reviewed 14 October 2026 for the paid-launch track. It covers what an attacker could want, who can reach which
boundary, how each boundary is defended, the test that proves it, and the risk that remains. Decisions are in
[ADR-0019](../adr/0019-production-security-updates-and-recovery.md). Findings and their status are in the
[findings register](findings.md). The earlier per-milestone notes stay in [security-model.md](../security-model.md).

## What attackers want

| Asset | Where it lives | Why it matters |
|---|---|---|
| Website sessions (cookies, local storage) | Profile folders on customers' computers; sealed snapshots on the server | Taking over customers' website accounts is the highest-value outcome |
| Tenant data (profiles, clients, members, activity) | PostgreSQL | One organization must never reach another's |
| Snapshot keys | Organization keys wrapped by the root key (server file, offline copy); data keys in memory during use | Whoever holds them can open sealed snapshots |
| Credentials | Refresh tokens, proxy logins and backup keys in the OS keychain; API tokens (hashes on the server) | Act as a user, a device or an integration |
| The update channel | GitHub Releases, the `release` environment's key | Code execution on every customer computer |
| Backups | R2 (encrypted DB backups and WAL, sealed objects) | A complete copy of the service |
| Staff powers | Support console, `staff.ts`, the platform audit | Least privilege, time limits and accountability |

## Who the attackers are

| Actor | Can | Cannot (assumed) |
|---|---|---|
| A website the customer visits | Run script in a profile's Chromium; try to reach the manager through links and deep links | Read other profiles' data on disk; call manager commands |
| Network attacker / hostile proxy | Observe and alter traffic outside TLS; serve old or altered files | Break TLS to the API or GitHub without a trusted CA |
| Another tenant (or a malicious member) | Call the API with valid credentials for their organization; guess ids | Hold credentials for the target organization |
| Thief of a token or device | Use a stolen access, refresh or API token until it is revoked or expires; read an unlocked logged-in OS account | Sign in again (password + provider MFA); meet "recent sign-in" checks |
| Compromised dependency or CI | Change what is built | Use the release key outside the protected `release` environment (see D1 for the admin-takeover gap) |
| Release-host controller (no key) | Delete, replace or withhold files on GitHub Releases | Produce signatures the app trusts |
| Malicious or careless staff | Use their console role; run `staff.ts` if they have server access | Change the platform audit or its head unnoticed (once exports are kept off the server); decrypt snapshots without the root key |
| Server compromise (root) | Everything on the server, including the root key file | Sign desktop releases; reach customer computers |

Out of scope:
- A compromised customer OS account. Profiles in use are plaintext to Chromium on that computer (disclosed).
- Making profiles look like different devices or networks to websites. This is not a security property of the product
  (disclosed).

## Boundaries, defences and evidence

### 1. Manager IPC (manager window → native shell)

| Threat | Defence | Evidence |
|---|---|---|
| Script injected into the manager window calls privileged commands | Each command is granted to the `main` window only (`build.rs`, `capabilities/default.json`) and every command re-checks the caller's label. The CSP is strict (`script-src 'self'`, `frame-src 'none'`). The Tauri global is off, prototypes are frozen, navigation outside the bundle and new windows are refused. The UI has no raw-HTML sinks. | `apps/desktop/src-tauri/tests/ipc.rs` (window allow-list per milestone); desktop review (findings: none) |
| Oversized or hostile arguments | Typed arguments with size limits, rejected before any work. Executable and folder paths never come from UI strings. | `tests/ipc.rs`, `docs/ipc-schema.json` |
| The window learns secrets | Tokens, proxy logins and keys never cross IPC. The window asks the shell for allow-listed API calls (`pb_cloud::allow`). | `tests/ipc.rs`, `crates/cloud` tests |

Residual: low. The window renders only bundled code.

### 2. Browser boundary (websites ↔ Chromium ↔ manager)

| Threat | Defence | Evidence |
|---|---|---|
| A deep link drives the manager | Only the auth-callback shape is accepted. It is bound to a one-time `state`, PKCE, nonce and issuer (RFC 9207). | `tests/ipc.rs`, `docs/identity/authentication-threat-review.md` |
| Chromium switches or environment abused | Structured argument list, switches from an allow-list (no `--no-sandbox`, no debugging port), a minimal environment, start URLs http(s) only and after `--`, `--disable-breakpad`. | `crates/runtime/src/launch.rs` tests, `tests/browser.rs` (real Chromium) |
| One profile reads another | Separate user-data folders named by validated id, symlinks refused, containment re-checked, an OS lock per profile. | `docs/isolation-evidence.md`, `tests/browser.rs` |
| A website reads proxy credentials or leaks the real IP | Loopback gateway adds credentials, fail-closed routing, WebRTC limited to the proxy. | Milestone 05 leak tests (`docs/network/`) |

Residual: Chromium vulnerabilities themselves. These are handled by runtime updates with revocation (section 7).

### 3. Local secrets

| Threat | Defence | Evidence |
|---|---|---|
| Secrets read from disk or logs | OS keychain only, with no plaintext fallback. The access token stays in memory. Diagnostics and crash reports are scrubbed. Notes that look like secrets are refused. | `apps/desktop/src-tauri/tests/account.rs` and `network.rs` (keychain only, no fallback), diagnostics tests (milestone 09) |
| Local backups read by another user | Sealed with the device key (AES-256-GCM STREAM). | `crates/runtime` backup tests |
| Local backup metadata tampered with | Accepted risk C-L4: needs write access to the profiles' own folder (same trust domain). | Tracked in findings |

### 4. Tenant access (API)

| Threat | Defence | Evidence |
|---|---|---|
| Cross-tenant reads and writes by id swapping | Membership resolved on the server for every `/orgs/:orgId` route (non-members get the same 404), every query filtered by organization, row-level security on every tenant table, composite same-organization foreign keys. | `cross-tenant.test.ts` (every route), `authorization.test.ts`, `docs/identity/tenant-isolation-report.md` |
| Privilege escalation in an organization | Five roles, grants with capabilities, admins cannot touch owners, tokens never exceed their creator's reach. | `authorization.test.ts`, `automation.test.ts` (T2 fix) |
| Session theft (stolen access or refresh token) | 10-minute access tokens checked against the database on every request, rotating refresh tokens with reuse detection (reuse ends the session), device revocation at the next request. Destructive or old-data actions need a **recent sign-in**, which development and API tokens never meet; a token without `auth_time` never counts (T4). | `auth.test.ts`, `oidc.test.ts`, `sync.test.ts` (recent sign-in), `crates/sync/tests/real_api.rs` |
| Undelete/purge race destroying data | Row lock and re-check on both sides (T5). | `sync.test.ts` |

Residual: T3. Row-level security does not re-check membership. Tracked for milestone 13.

### 5. Object downloads (snapshots)

| Threat | Defence | Evidence |
|---|---|---|
| Downloading another tenant's object | Object keys are never accepted from clients. Signed URLs are issued per part, per snapshot, for 15 minutes, after authorization. | `sync.test.ts`, `cross-tenant.test.ts` |
| Swapped or altered object | The sealed header (organization, profile, snapshot, key version) is authenticated in every chunk. Size and SHA-256 are checked before decrypting. | `crates/seal` tests, `restore-check.ts` (drill) |
| Key exposure in transit | TLS. Data keys are sent only to authorized devices for one snapshot (I2: not end-to-end; disclosed). | Crypto review |

### 6. Extensions (milestone 09)

| Threat | Defence | Evidence |
|---|---|---|
| A malicious extension loaded by the manager | `--load-extension` and `--disable-extensions-except` are never accepted. Enforce mode adds only `--disable-extensions`. Extension files are read, never written. | `tests/agency.rs`, `launch.rs` tests |
| An extension the customer installed in a profile | Out of our control inside Chromium. The organization policy can block all extensions from the next open. | Known gap: enforce mode cannot stop an install mid-session |

### 7. Updater (manager and browser runtime)

| Threat | Defence | Evidence |
|---|---|---|
| Malicious update from a hostile network or release host | Signed channel manifest and a per-artifact signature, keys compiled in with validity windows, https only, size then SHA-256 then signature, re-verified before install. | `crates/update` `manifest_signature_key_and_file_are_checked`, `corrupt_oversized_and_wrongly_signed_downloads_are_discarded`; `tests/updates.rs` `corrupt_and_wrongly_signed_updates_are_deleted_and_never_installed` |
| Rollback to a vulnerable version / replay / freeze | Sequence must not decrease, no older versions, manifests valid 30 days (max 45), weekly re-signing (C-L2). | `stale_and_replayed_manifests_are_refused`, `never_a_downgrade_and_channels_are_separate`, `stale_replayed_forged_and_expired_key_manifests_are_refused` |
| Expired or rotated key | Key validity windows. Expired keys are refused with `UPDATE_KEY_EXPIRED`. | `release_keys_must_match_their_id_and_have_a_window`, `tests/updates.rs` |
| Interrupted or corrupt download | A resumable `.part` file is verified as a whole. On mismatch it is deleted and the update is never installed. | `downloads_verify_and_resume_after_an_interruption`, `an_interrupted_download_resumes_where_it_stopped` |
| Archive escape on macOS | No `..` or absolute links, no writing through links, modes masked (C-L5). | `hostile_archives_are_refused`, `extracted_modes_never_carry_setuid_or_group_write` |
| A bad runtime breaks profiles | Before-upgrade copy, restore action, revocation, compatibility fixture. | `a_withdrawn_browser_upgrade_rolls_back_to_the_copy_made_before_it`, `a_revoked_runtime_is_neither_installed_nor_opened`, `runtime_upgrade_keeps_a_copy_the_old_browser_opens` |
| **Supply chain:** compromised dependency or CI step | Locked dependencies, `--ignore-scripts` in the job that holds the key, third-party actions pinned by commit, gitleaks, SBOM and provenance attestations, no self-hosted runners while the repository is public. | `desktop-release.yml`, `ci.yml` |
| **Supply chain:** admin account takeover reaches the key | **Open (D1, medium).** Owner actions are listed in the update runbook. | Findings register |

Residual: first installs carry no OS-level signature (unsigned Windows installer, ad-hoc macOS build). This is
disclosed, and every update is still signature-checked.

### 8. Automation (milestone 10)

| Threat | Defence | Evidence |
|---|---|---|
| A job acts outside approved sites | Approved origins are checked at creation, claim, and before and after each navigation. Only typed steps are allowed; page text never steers a job. | `automation.test.ts`, `tests/automation.rs` |
| A token or person sees session content without the right | Job detail and screenshots need the `launch` capability (T2). | `automation.test.ts` |
| The debugging broker is reached by a website | Opt-in per computer, loopback only, any `Origin` refused, `Host` checked, capability secret required. | `tests/automation.rs` |
| Webhook SSRF | Destination checks at configuration and at delivery, redirects not followed, host egress rules. | `services/worker/test/webhooks.test.ts` |

### 9. Billing (milestone 11)

| Threat | Defence | Evidence |
|---|---|---|
| Forged or replayed webhooks | HMAC over the raw body, 5-minute tolerance, deduplication by event id, state applied from fresh provider data. | `billing.test.ts`, billing review |
| Card data handled by the app | Hosted checkout and portal only. No card fields in any request. | `billing.test.ts` |
| A billing state destroys data | Billing narrows access only and never deletes. | `billing.test.ts` |

### 10. Support console and staff

| Threat | Defence | Evidence |
|---|---|---|
| Staff see more than needed | Members and activity need time-bound access approved by a different support lead (enforced in code and by a constraint). No route reaches browser session data. Staff cannot decrypt snapshots. | `support.test.ts` |
| Break-glass abuse | Granted on the server only, 5–60 minutes, a reason, 1–10 named organizations, every use audited in both logs and alerted. The holder cannot clear its own alerts (T1). | `support.test.ts` |
| Audit tampering | Append-only triggers, hash chain, head out of the application's reach, separator constraint (C-L3), exports that verify independently. | `security.test.ts` |
| Console token theft | 30-minute staff tokens, memory only, own OIDC client with PKCE, recent sign-in at sign-in, strict CSP, no framing. | `support.test.ts`, console e2e |

R2 (ADR-0021): S1 is fixed. The console client signs in through its own flow (`pb-staff-browser`): a password and a
one-time code every time, and no single sign-on from a customer's session. Customer self-registration cannot create
staff: staff roles exist only in the API's database. Residual (low): the API itself does not also check the
provider's `acr` claim for staff tokens.

R2 also adds the customer web portal: a backend-for-frontend cookie session (HttpOnly, SameSite=Lax, digest-only in
the database, CSRF token + exact Origin on every change, deny-by-default routes, new id at sign-in and after a
privilege change). Tests: `web.test.ts`. Self-service signup and onboarding: `onboarding.test.ts` (one workspace and
one trial under concurrency, invitations only for the verified invited address, no trial reset by new identities,
suspended accounts and workspaces stay closed).

### 11. Server and recovery

| Threat | Defence | Evidence |
|---|---|---|
| Loss or corruption of the server | PITR to R2 (RPO ≤ 15 min target), object copies with 30-day deleted-object retention, a restore drill into an isolated cluster. | `deploy-scripts.yml` (backup and drill assertions), `restore-drill.sh` reports |
| Backups used to change or read live data | Separate users and credentials, a read-only storage identity, an encrypted database backup, no root key in R2. | CI permission checks (`pb` and `pb-backup` cannot read each other's files) |
| Debug surface in production | No documentation, debug or metrics routes; status-only health; no `server` header. | `security.test.ts` |
| Key service outage | Only key-dependent operations fail, retryably. | `security.test.ts` |
| Failed migration | One transaction, checksums, previous state kept. | `security.test.ts`, `crates/storage` `failed_migration_keeps_the_previous_database_and_can_recover` |

Residual: whoever holds the R2 token (root on the server) can delete the off-site backups. R2 bucket locks cannot
be used, because pgBackRest rewrites its index files in place. The token is limited to one bucket, and it is the
first thing replaced after a server compromise. Later option: a second, write-once copy made with credentials that
never reach the server.

## Cross-cutting scenarios

### Session theft
A thief with a stolen refresh token gets at most one rotation. Reuse ends the session at the next refresh. A stolen
access token lasts at most 10 minutes. Neither can:
- restore older versions or recovery copies;
- undelete;
- rotate keys or export.

Those actions need a fresh sign-in with the provider. Revoking the device ends both at the next request. A stolen
**API token** is limited to its scopes and restrictions. In an emergency, staff can revoke all of an organization's
tokens through break-glass.

### Cross-tenant
Every organization route resolves membership, every query is scoped, and row-level security backs this up. The
restore drill proves that a restored database keeps both properties for two tenants. Gap T3 (row-level security
trusts the API's organization context) is the remaining defence-in-depth item.

### Supply chain
Dependencies are locked, actions pinned, build jobs hold no secrets, signatures are verified against what the app
trusts, and SBOM and provenance attestations are published for each release. The open item is custody of the
signing key against an admin-account takeover (D1).

## Review cadence
Update this model:
- when a new boundary is added (a new route family, IPC surface, external integration or release path);
- after every security incident;
- before the paid launch, together with the third-party test results.
