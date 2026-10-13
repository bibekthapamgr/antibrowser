# Security model (draft, milestones 01–04)

This document states what the product protects, what it does not, and the disclosures customers must see. Milestone 12 turns it into a reviewed threat model.

## What is protected
| Asset | Protection in place now | Planned |
|---|---|---|
| Tenant data in the API | Server-derived membership; non-members get 404; row-level security on every tenant table; response schemas strip unexpected fields; least-privilege DB roles | Pen test (12) |
| Profile directories | Named only by validated id; stored reference must equal the id; symlinks refused; containment re-checked; exclusive OS lock per profile held from launch until every browser process has exited; never copied while a browser uses them | Encrypted snapshots (07) |
| Manager UI → native code | 44 commands, each granted individually to the `main` window only; every command re-checks the calling window label; typed arguments with size limits rejected before work starts; browser executable and download folder never taken from UI strings; strict CSP (`script-src 'self'`, no remote origins); navigation outside the bundle blocked and new windows denied; prototypes frozen; no Tauri global | Signed installers (owner certificates, see os-setup.md), updater signatures (12) |
| External links and deep links | Only `https://github.com/…` help links open, and only in the system browser; deep links accepted only for the auth-callback shape bound to a one-time state | OIDC sign-in (06) |
| Local database | WAL + foreign keys; all pending migrations in one transaction; a copy is taken before upgrading; a failed upgrade keeps the previous database and shows recovery actions | Encrypted local secrets (07) |
| Browser runtime | Only the runtime in the Ed25519-signed manifest (owner key, verified against compiled-in public keys); download prefix compiled in; https only, size-capped; SHA-256 + size checked before extraction, mismatch → quarantine; extraction refuses absolute paths, `..`, escaping links, writes through links and zip bombs; executable and macOS code signature checked; free-space check; journal for interrupted installs. No executable path is accepted from the UI or settings in release builds | Over-the-air manifest updates and key revocation (12); redistributable runtime before customers (ADR-0010) |
| Secrets on the device | OS keychain only; if unavailable, secret persistence is disabled (no file fallback) | 06–07 |
| Crash data | Local only, opt-in flag off by default, home paths/user names/tokens scrubbed, at most 20 reports | Upload service (13) |
| Browser processes | Launched from a structured argument list with a minimal environment (no inherited tokens); start URLs only http(s) and after `--`; extra switches only from an allowlist used by tests (`--no-sandbox` and remote debugging are not in it); identified by pid + start time + executable; only a profile's own verified process tree is ever force-closed | Runtime update SLA (ADR-0001) |
| Profile library (04) | Every list/filter/sort is one parameterised query (no SQL from the UI; unknown filter fields refused); bulk selections are ids or a filter checked against the count the user saw; at most 10,000 per action; open/busy profiles cannot be trashed; permanent deletion only from the trash with `DELETE` + exact count, under the launch lock, with the profile claimed so no backup or recovery can start, after re-checking the supervisor, the process table and the profile's OS lock, and by moving the folder aside before removing it; an authorization hook on bulk edit, deletion, import and export | Role checks (06), leases (08), sync tombstones (07) |
| Import files (04) | Path chosen in the native dialog, the UI only holds an opaque token; 20 MB / 10,000 rows; schema version required; every row validated alone; preview bound to the file's SHA-256 and settings, a changed file refused; archives refused for traversal, drive letters, links, encryption, extra entries, size, expansion ratio and executable content; bundles claiming session data refused; formulas never evaluated; retries idempotent (`import_ref` unique) | Additional adapters only by ADR |
| Notes and exports (04) | Notes are plain text rendered as text; control and bidi-override characters removed; notes that look like passwords, keys, tokens or card numbers refused by the API, left out on import, withheld on export; exports hold an allowlist of configuration fields (no paths, ids, cookies), notes off by default, CSV formulas neutralised, written via temp file + rename | Export permission per role (06) |
| Local audit log | Launch/stop/crash/recover/backup/install events with machine codes only — never URLs, titles, cookies or passwords; bounded to 5,000 entries | Server audit (06) |
| Snapshots | Planned client-side encryption before upload (ADR-0003) | 07 |
| Logs | Authorization, cookie and idempotency headers redacted; errors carry codes, not stack traces or SQL | OpenTelemetry pipeline with redaction (13) |

## Required disclosures (must appear in docs and UI where relevant)
1. **Profiles in use are plaintext to Chromium on the device.** Anyone with access to the logged-in OS account while a profile is open can read its data; disk encryption is the customer's responsibility.
2. **Separate profiles separate stored website data** (cookies, local storage, IndexedDB, cache). They do **not** make profiles appear as different devices or networks, and they do not prevent websites from linking activity.
3. **Logins may not survive moving a profile to another device** (ADR-0002). Users may need to sign in again.
4. **Operator access to encrypted snapshots** is technically possible through key management and is restricted and audited (ADR-0003). No end-to-end or zero-knowledge claim.
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

## Milestone 04 boundary tests
- Storage (`crates/storage/src/tests_m04.rs`): folded-name uniqueness, filter validation, bulk across workspaces counts as not found, undo only where the version is unchanged, trash retention, `import_ref` uniqueness.
- Import engine (`crates/import/src/tests.rs`, `tests/examples.rs`): traversal (`../`, absolute, backslash, drive letter), symlink, encrypted and unexpected entries, decompression bomb by ratio and by size, executable magic and permission bits, session-data manifests, CSV formula round trip, Unicode, long notes, missing fields, wrong types.
- Commands (`apps/desktop/src-tauri/tests/ipc.rs`): a running profile refused for the trash and for deletion, deletion of a folder held by another process refused, preview bound to the file (`SOURCE_CHANGED`), retries without duplicates, 10,000-row cancel and resume, secret-looking notes refused and withheld on export, hidden characters stripped.
- Source hygiene: hidden bidirectional characters are never written literally in source; tests build them at run time.

## Known gaps after milestone 04
- Undo tokens live in memory and end with the app; permanent deletion cannot be undone (by design).
- The secret heuristic in notes can miss secrets or flag ordinary text; notes are documented as not encrypted.
- The authorization hook allows everything for the local owner until roles exist (06).

## Known gaps after milestone 03
- The runtime is Chrome for Testing, licensed for testing only: **not for customer distribution** (ADR-0010 gate).
- Linux (development only) closes browsers with SIGTERM, which may drop cookie writes from the last ~30 seconds.
- Extension data isolation follows from separate user-data folders but is exercised by tests only when extensions arrive (09).

## Known gaps after milestone 02
- Installers are **unsigned** until the organization's Apple Developer ID and Windows code-signing certificates are added as repository secrets.
- No auto-update channel yet (milestone 12); internal builds are installed manually and verified with `SHA256SUMS`.
- Build provenance attestation needs a GitHub plan that supports attestations for private repositories; `provenance.json` is produced regardless.

