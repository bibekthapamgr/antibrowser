# Security model (draft, milestones 01–08)

This document states what the product protects, what it does not, and the disclosures customers must see. Milestone 12 turns it into a reviewed threat model.

## What is protected
| Asset | Protection in place now | Planned |
|---|---|---|
| Tenant data in the API | Server-derived membership; non-members and out-of-reach ids get the same 404 as nonexistent ids (also in bulk, search and export); five roles with client/profile grants, deny by default (06, [permission matrix](permission-matrix.md)); row-level security on every tenant table with transaction-local context; composite same-organization foreign keys; response schemas strip unexpected fields; least-privilege DB roles; [tenant isolation report](identity/tenant-isolation-report.md) | Pen test (12) |
| Identity and sessions (06) | OIDC Authorization Code + PKCE in the system browser (Keycloak reference); ID tokens verified (signature, issuer, audience, age, nonce) and used once; users matched by issuer + subject; device-bound API sessions: 10-minute access tokens checked against the database on every request, rotating refresh tokens with reuse detection, kept only in the OS keychain; device revocation and sign-out effective at the next request; recent sign-in for ownership transfer; rate limits on sign-in, refresh and invitations; security audit of changes and denials ([threat review](identity/authentication-threat-review.md)) | MFA policy at the provider; pen test (12) |
| Profile directories | Named only by validated id; stored reference must equal the id; symlinks refused; containment re-checked; exclusive OS lock per profile held from launch until every browser process has exited; never copied while a browser uses them; backups and snapshots only after a verified clean shutdown, with the profile held (busy + OS lock) while it is read, and opening it cancels that step. Shared profiles open only with the organization's session lease (08) | — |
| Manager UI → native code | 74 commands, each granted individually to the `main` window only; every command re-checks the calling window label; typed arguments with size limits rejected before work starts; browser executable and download folder never taken from UI strings; strict CSP (`script-src 'self'`, no remote origins); navigation outside the bundle blocked and new windows denied; prototypes frozen; no Tauri global | Signed installers (owner certificates, see os-setup.md), updater signatures (12) |
| External links and deep links | Only `https://github.com/…` help links open, and only in the system browser; deep links accepted only for the auth-callback shape bound to a one-time state; the provider's `iss` must match (RFC 9207) before a code is exchanged with the in-memory PKCE verifier | — |
| Local database | WAL + foreign keys; all pending migrations in one transaction; a copy is taken before upgrading; a failed upgrade keeps the previous database and shows recovery actions | Encrypted local secrets (07) |
| Browser runtime | Only the runtime in the Ed25519-signed manifest (owner key, verified against compiled-in public keys); download prefix compiled in; https only, size-capped; SHA-256 + size checked before extraction, mismatch → quarantine; extraction refuses absolute paths, `..`, escaping links, writes through links and zip bombs; executable and macOS code signature checked; free-space check; journal for interrupted installs. No executable path is accepted from the UI or settings in release builds | Over-the-air manifest updates and key revocation (12); redistributable runtime before customers (ADR-0010) |
| Secrets on the device | OS keychain only; if unavailable, secret persistence is disabled (no file fallback). Proxy logins (05): written once to the keychain, never returned over IPC, never in SQLite, exports, diagnostics, logs, Preferences or command lines; a changed login replaces the keychain entry only after the database accepted the change. Account session (06): only the refresh token, only in the keychain (memory-only when no keychain works); access tokens in memory; the manager window never receives a token and can only ask the shell for allow-listed API requests. Backup keys (07): this device's local-backup key (32 random bytes, `backup-key-v1`) only in the keychain, never in a file; snapshot data keys only in memory (zeroized, redacted `Debug`), never sent to the window, dropped once the file is sealed or opened | Hardware-backed keys where the OS offers them (12) |
| Proxy routing (05) | Per-profile loopback gateway (127.0.0.1 only, loopback peers only, proxy requests only); the login is added by the gateway and sent only to that proxy; a `407` never reaches the browser; fail-closed by default (no direct route; WebRTC restricted to the proxy; QUIC off; prefetch off); fail-open only by explicit choice, only for an unreachable proxy, counted and shown; proxy addresses checked on every connection (private only with the local setting, link-local/metadata never); HTTPS proxy certificates verified; no change of route during a session | Gateway fuzzing and pen test (12); our own check endpoint (06/13) |
| Crash data | Local only, opt-in flag off by default, home paths/user names/tokens scrubbed, at most 20 reports | Upload service (13) |
| Browser processes | Launched from a structured argument list with a minimal environment (no inherited tokens); start URLs only http(s) and after `--`; extra switches only from an allowlist used by tests (`--no-sandbox` and remote debugging are not in it); identified by pid + start time + executable; only a profile's own verified process tree is ever force-closed | Runtime update SLA (ADR-0001) |
| Profile library (04) | Every list/filter/sort is one parameterised query (no SQL from the UI; unknown filter fields refused); bulk selections are ids or a filter checked against the count the user saw; at most 10,000 per action; open/busy profiles cannot be trashed; permanent deletion only from the trash with `DELETE` + exact count, under the launch lock, with the profile claimed so no backup or recovery can start, after re-checking the supervisor, the process table and the profile's OS lock, and by moving the folder aside before removing it; an authorization hook on bulk edit, deletion, import and export (local profiles belong to the device owner; organization profiles are authorized by the server, 06) | Leases (08), sync tombstones (07) |
| Import files (04) | Path chosen in the native dialog, the UI only holds an opaque token; 20 MB / 10,000 rows; schema version required; every row validated alone; preview bound to the file's SHA-256 and settings, a changed file refused; archives refused for traversal, drive letters, links, encryption, extra entries, size, expansion ratio and executable content; bundles claiming session data refused; formulas never evaluated; retries idempotent (`import_ref` unique) | Additional adapters only by ADR |
| Notes and exports (04) | Notes are plain text rendered as text; control and bidi-override characters removed; notes that look like passwords, keys, tokens or card numbers refused by the API, left out on import, withheld on export; exports hold an allowlist of configuration fields (no paths, ids, cookies), notes off by default, CSV formulas neutralised, written via temp file + rename | Export permission per role (06) |
| Local audit log | Launch/stop/crash/recover/backup/install events with machine codes only — never URLs, titles, cookies or passwords; bounded to 5,000 entries | — |
| Server audit (06) | Actor, action, target, outcome, request id and time for changes, denials and failed sign-ins; append-only for the API role; no tokens, secrets or browsing history | Export and retention policy (11/13) |
| Organization backups (07) | Sealed on the device before upload: zstd, then AES-256-GCM in the STREAM construction (RustCrypto), 1 MiB chunks; the header (organization, profile, snapshot, key version, nonce prefix) is the associated data of every chunk; a fresh data key per snapshot, wrapped by the organization key version, wrapped by the root key ([ADR-0014](adr/0014-encrypted-snapshots-and-sync.md)). Uploads need the profile lease (fencing token), `snapshot.commit` and the current head version; signed URLs for one part of one upload, 15 minutes; the worker checks size, sealed header and SHA-256 before a compare-and-set commit (one winner, never last-write-wins). Restores need `snapshot.restore` (audited, rate limited); size and SHA-256 checked before decrypting; archive safety checks; unpacked into a fresh folder and switched with the previous data kept as evidence. Retention, quota, 30-day trash, key rotation and destruction ([crypto review](sync/crypto-design-review.md)) | Managed KMS/HSM provider and independent crypto review (12/14) |
| Backup root key (07) | `local` provider: a file owned by the API user, mode 600, checked at start-up; repository fixture keys refused outside dev/test; rotation re-wraps organization keys and the old key can be retired only when it wraps nothing (`scripts/deploy/root-key.sh`); offline copy mandatory ([runbook](sync/key-recovery-runbook.md)) | Managed KMS/HSM (12/14) |
| Local last-good copies (03, 07) | Sealed with the device key (`kind local-backup`, key fingerprint in the header); a reset keychain is reported as "key not available", never as damage; without a usable keychain they stay plain copies as in 03 | — |
| Shared sessions (08) | One authoritative lease per profile in PostgreSQL with a monotonic fencing token and expiry on the database clock ([ADR-0015](adr/0015-team-sessions-and-handoff.md)); an expired session is *uncertain* and blocks others until its device confirms or an admin takes over (never a second writer on expiry alone); takeovers and revocations allocate a new token, so every later write from the old device is refused (`FENCING_TOKEN_STALE` with how it ended), including commits already being verified; recovery copies are kept separately, never the head, restorable only as a separate profile by owners and admins; grants carry launch/edit/backup-download capabilities, viewers none, export and sharing never grantable; the lease id and token live in the shell (SQLite, never in the window or logs); handoff and request notes refused when they look like secrets | Remote wipe is out of scope (device management) |
| Logs | Authorization, cookie and idempotency headers redacted; invitation tokens masked in logged URLs; errors carry codes, not stack traces or SQL | OpenTelemetry pipeline with redaction (13) |

## Required disclosures (must appear in docs and UI where relevant)
1. **Profiles in use are plaintext to Chromium on the device.** Anyone with access to the logged-in OS account while a profile is open can read its data; disk encryption is the customer's responsibility.
2. **Separate profiles separate stored website data** (cookies, local storage, IndexedDB, cache). They do **not** make profiles appear as different devices or networks, and they do not prevent websites from linking activity.
3. **Logins may not survive moving a profile to another device** (ADR-0002). Users may need to sign in again; after a restore on another computer the app says "Sign-in may be required on websites".
4. **Operator access to organization backups**: whoever holds the server's root key file (the operator of the organization server) can decrypt them; every restore is recorded in Activity (ADR-0003, ADR-0014). No end-to-end or zero-knowledge claim. The app says so under Backups.
5. The product is for **authorized business account work**. The acceptable-use policy forbids violating website terms, evading bans, or fraud; no feature is marketed as ban prevention or invisibility.

## Findings from milestone 01 spikes
- The tested Chromium build allowed a **second process to open a directory already in use**. The manager must hold an exclusive per-profile lock before launch (milestone 03) in addition to process tracking.
- **Cookies are not port-isolated** on the same host (web platform behaviour); localStorage and IndexedDB are. This does not affect isolation between profiles, but test origins must keep the same port across restarts.
- On Linux the spike browser used a non-machine-bound cookie key (`v10`, basic store). Windows (DPAPI + app-bound encryption) and macOS (Keychain) bind keys to the machine/user, so Linux results must not be generalized.

## Milestone 02 boundary tests
- Rust: `apps/desktop/src-tauri/tests/ipc.rs` — wrong window, path traversal and malformed ids, 5 MB request, disallowed URLs, settings allowlist, download-folder validation, capability boundary for remote origins, manager kill during migration and during a runtime install.
- UI: `apps/desktop/e2e/` runs the production bundle under the same CSP as the shell and fails on any CSP violation.
- Contract: `apps/desktop/tests/contract.test.ts` fails if the TypeScript contract, generated permissions, capability file and Rust handler list disagree.

## Milestone 03 boundary tests
- Real Chromium (`apps/desktop/src-tauri/tests/browser.rs`, run per OS by the runtime pipeline): no storage leakage between profiles (cookies, localStorage, IndexedDB, Cache Storage, service workers), no `DevToolsActivePort` and no debug/sandbox switches, crash never attached to another profile, one browser per profile under concurrent launches.
- Manifest: tampered bytes, unknown key, wrong key, URLs outside the compiled prefix and malformed fields are refused (`crates/update/src/tests.rs`); tampered downloads are quarantined (`tests/ipc.rs`).
- Process safety: an unrelated process that reuses a pid is never adopted or signalled; a foreign executable using a profile folder is refused, not killed.

## Milestone 05 boundary tests
- Routing adapter (`crates/netproxy/tests/routing.rs`): wrong/missing/unsupported logins, outage and recovery,
  fail-open limited to unreachable proxies, SOCKS5 remote DNS, HTTPS proxy certificate verification, IPv6, address
  policy (loopback refused without the setting, link-local always), malformed and non-proxy requests answered 400.
- Commands (`apps/desktop/src-tauri/tests/network.rs`): the username and password are searched for in the database
  file and its WAL, every IPC answer, diagnostics and all three export formats; validation of hosts (schemes, logins
  in hosts, paths), ports, logins, dates and secret-looking notes; unknown fields refused; launch refused before
  anything starts when the login is missing or the address is no longer allowed.
- Real Chromium (`apps/desktop/src-tauri/tests/browser_network.rs`, per OS in the runtime pipeline): no DNS query for
  the site, no UDP datagram, every TCP connection to the gateway, zero STUN packets from a fail-closed profile, outage blocks
  instead of going direct, fail-open visible; evidence in [network/leak-test-evidence.md](network/leak-test-evidence.md).

## Known gaps after milestone 05
- Proxied profiles have no connection while the manager is closed; other programs of the same OS user could use an
  open profile's gateway port (see [network/README.md](network/README.md) for all limitations).
- The connectivity check uses an interim third-party service until our own endpoint exists (ADR-0012).
- Linux keeps proxy logins only until logout (kernel keyring).

## Milestone 07 boundary tests
- Sealed format (`crates/seal/src/tests.rs`): wrong key, every binding field, edited header, truncation, reordering,
  bit flips, chunks spliced between files, traversal/links/special files/Windows device names/limits in the archive;
  a failed open leaves nothing usable.
- Engine against a fault-injecting server (`crates/sync/src/tests.rs`): connection lost before and after each of 8
  calls, the app killed after each of 13 saved steps, concurrent devices, lost lease, failed verification, cancel, cut
  download, another organization's snapshot, substituted object, forged manifest, low disk, newer browser.
- API (`services/api/test/sync.test.ts`, `sync-s3.test.ts` with real S3, `cross-tenant.test.ts`): stale base and
  fencing tokens, object substitution/truncation/removal in storage, headers naming another kind or key version,
  modified wrapped keys, manifests moved to another profile, destroyed keys, snapshot ids swapped across
  organizations on every route, data keys and download URLs searched for in request logs, audit details and outbox
  events.
- End to end (`crates/sync/tests/real_api.rs`, CI): the desktop engine against the real API, PostgreSQL and S3 with
  dropped requests, two computers, an operator and a member of another organization.
- Desktop (`apps/desktop/src-tauri/tests/sync.rs`): restore switch interrupted and finished at start-up, opening
  refused while restoring, keychain-sealed local backups. Window: the allow-list (`crates/cloud`) refuses init,
  restore plans and operation routes to the window; they exist only in the shell.

## Known gaps after milestone 07
- Not end-to-end encrypted; the root key is a file on the organization server until a managed KMS/HSM provider exists.
- Restored profile folders are plaintext on disk like any open profile (disclosure 1).
- Storage sees object sizes and timing; compression makes the size follow the profile's content coarsely.
- Strings derived from keys in Node.js (base64 in JSON) are not zeroized; the desktop drops its JSON copy right after
  parsing.
- (Closed in milestone 08: opening a shared profile is lease-controlled.)

## Milestone 08 boundary tests
- API (`services/api/test/sessions.test.ts`, 20 scenarios; `authorization.test.ts`; `cross-tenant.test.ts` for every
  new route): simultaneous acquisition, capabilities and viewers, entitlement and runtime refusals, database-clock
  expiry and uncertain sessions, revival, same-device replacement, notes that look like secrets, requests that never
  end a session, takeover by admins only (and of uncertain sessions), stale tokens on init, commit and verification,
  recovery copies (never the head, admins only), revocation by grant, capability, role, membership and device.
- Desktop (`apps/desktop/src-tauri/tests/team.rs`, `tests/sync.rs`): contention, repeated clicks, offline opens,
  packet loss, delayed heartbeats, app restart and crash, killed mid-open, stale upload after takeover, revocation,
  unsynced copy kept aside, `edit` guard. Window allow-list: opening, heartbeat and release are refused to the window.
- Real API with two computers (`crates/sync/tests/real_api.rs`, CI): simultaneous opens, request, handoff note,
  takeover with a stale upload kept as a recovery copy, removed access, the audit trail.

## Known gaps after milestone 08
- A takeover cannot stop website activity already happening in the old browser; removed access does not wipe data on
  that computer (kept aside there).
- Opening shared profiles needs the server; an unreachable holder blocks others until an admin takes over.
- Fencing tokens and lease ids are not secrets on their own (they need the holder's session), but they are kept out of
  the window and logs anyway.

## Milestone 09 boundary tests
- API (`services/api/test/agency.test.ts`; role matrix and cross-tenant swaps for every new route): dashboard counts
  and names never include profiles outside the caller's reach; people and activity only for `grants.manage` /
  `audit.read`; task visibility follows profile and client reach; operators assign only themselves and cannot take
  others' tasks; secret-looking task titles and notes are refused; bookmarks refuse `javascript:`, `data:`, `file:`,
  `chrome:`, scheme-relative addresses, user names and passwords in the address, whitespace and control characters
  (also a database `CHECK`); extension policy edits need `extensions.manage` and the current version; reports only
  from the caller's own active device for a profile they can see.
- Desktop (`apps/desktop/src-tauri/tests/agency.rs`, `crates/runtime/src/launch.rs`): enforce mode adds only
  `--disable-extensions`; `--load-extension` and `--disable-extensions-except` are never accepted; extension files are
  read, never written; relative extension paths cannot leave the profile's `Extensions` folder; per-client download
  folders cannot leave the base folder (`..`, separators, device names); the diagnostics preview contains none of the
  fixture secrets (proxy login, page address, e-mail address, token, server address); resource counts exclude other
  browsers. Window allow-list: dashboards, tasks, bookmarks and the policy are reachable; extension reports are sent
  by the shell only.
- Health never states anything about website accounts (tested for the words).

## Known gaps after milestone 09
- Enforce mode cannot block an install during a session; it takes effect at the next open (all extensions off).
- The memory estimate is this computer's median, not a prediction for a given website; RSS overcounts shared pages.
- Diagnostics redaction is pattern-based on top of sections that exclude personal data by construction; a four-part
  version number can be shown as `<ip>` (errs on the side of removal).

## Milestone 04 boundary tests
- Storage (`crates/storage/src/tests_m04.rs`): folded-name uniqueness, filter validation, bulk across workspaces counts as not found, undo only where the version is unchanged, trash retention, `import_ref` uniqueness.
- Import engine (`crates/import/src/tests.rs`, `tests/examples.rs`): traversal (`../`, absolute, backslash, drive letter), symlink, encrypted and unexpected entries, decompression bomb by ratio and by size, executable magic and permission bits, session-data manifests, CSV formula round trip, Unicode, long notes, missing fields, wrong types.
- Commands (`apps/desktop/src-tauri/tests/ipc.rs`): a running profile refused for the trash and for deletion, deletion of a folder held by another process refused, preview bound to the file (`SOURCE_CHANGED`), retries without duplicates, 10,000-row cancel and resume, secret-looking notes refused and withheld on export, hidden characters stripped.
- Source hygiene: hidden bidirectional characters are never written literally in source; tests build them at run time.

## Known gaps after milestone 04
- Undo tokens live in memory and end with the app; permanent deletion cannot be undone (by design).
- The secret heuristic in notes can miss secrets or flag ordinary text; notes are documented as not encrypted.
- The local authorization hook allows everything for the device owner: local profiles have no roles. Organization data is authorized only by the server (06); cached organization data shown offline never authorizes an action.

## Known gaps after milestone 03
- The runtime is Chrome for Testing, licensed for testing only: **not for customer distribution** (ADR-0010 gate).
- Linux (development only) closes browsers with SIGTERM, which may drop cookie writes from the last ~30 seconds.
- Extension data isolation follows from separate user-data folders but is exercised by tests only when extensions arrive (09).

## Known gaps after milestone 02
- Installers are **unsigned** until the organization's Apple Developer ID and Windows code-signing certificates are added as repository secrets.
- No auto-update channel yet (milestone 12); internal builds are installed manually and verified with `SHA256SUMS`.
- Build provenance attestation needs a GitHub plan that supports attestations for private repositories; `provenance.json` is produced regardless.

