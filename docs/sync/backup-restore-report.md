# Backup and restore report — milestone 07

What was built, how each exit criterion is demonstrated, and what is measured. Design:
[ADR-0014](../adr/0014-encrypted-snapshots-and-sync.md); cryptography: [crypto design review](crypto-design-review.md);
operations: [key recovery runbook](key-recovery-runbook.md). Date: 2026-10-13. Desktop 0.7.0.

## Summary
| Exit criterion | Result | Main evidence |
|---|---|---|
| Round trip of supported same-device data | **Met** | Engine, desktop and real-API tests; real Chromium sealed round trip on Windows, macOS and Linux (cookie, localStorage, IndexedDB kept) |
| Cross-device matrix honestly labels supported / sign-in required / unsupported | **Met** | Portability matrix through sealed snapshots with the label the app shows, checked per row ("0 dishonest labels"); `unsupported` cases refused before download |
| Kill network or app at each phase; the prior snapshot stays restorable | **Met** | 16 network-loss cases (8 calls × before/after) and 13 app-kill points in the engine; server-side abandoned/canceled/failed uploads; crash mid-switch on the desktop; real API with a dropped part and a lost commit answer |
| Concurrent commits: one winner, one conflict | **Met** | API (same base, overtaken base, lease taken over), engine, desktop and real-API tests |
| Wrong-organization download, object substitution, manifest tampering fail | **Met** | Cross-tenant route sweep, storage substitution against real S3, manifest/wrapped-key tampering, sealed header binding |
| Deliverables | Crypto design review, this report, retention jobs (worker), sync UI, key recovery runbook | Links above; UI below |

Not claimed: staying signed in to websites on another computer (ADR-0002), end-to-end encryption (ADR-0003), or any
capacity figure for the server (milestone 13).

## How the pieces were tested
| Layer | Where | Tests |
|---|---|---|
| Sealed format, archive safety | `crates/seal/src/tests.rs` | 16 (chunk boundaries, wrong key, every binding field, header edits, truncation/reordering/bit flips, splicing between files, traversal/links/device names/limits, cancel) |
| Transfer (signed part upload, resumable download) | `crates/cloud/src/transfer.rs` | 3 |
| Sync engine (state machine, resume, restore) against an in-memory server with fault injection | `crates/sync/src/tests.rs`, `portability.rs` | 11 + 1 |
| Engine against the **real API, PostgreSQL and S3 storage** (two computers, an operator, an outsider) | `crates/sync/tests/real_api.rs` (CI job *sync end to end*) | 1 scenario, 6 checks |
| Local sealed backups (device key) | `crates/runtime/src/backup.rs` | 9 |
| Desktop app (lifecycle, jobs on disk, switch, evidence, conflict choices, keychain) | `apps/desktop/src-tauri/tests/sync.rs`, `crates/storage/src/sync.rs` | 6 + 2 |
| API: upload, verification, versions, retention, trash, quota, keys, secrets | `services/api/test/sync.test.ts` | 22 |
| API against real S3 (multi-part signed upload, substitution in storage) | `services/api/test/sync-s3.test.ts` | 2 |
| Tenant isolation of every snapshot route | `services/api/test/cross-tenant.test.ts` | snapshot ids swapped across organizations on every route |
| Window (UI) | `apps/desktop/e2e/manager.e2e.test.ts` "encrypted backups (milestone 07)" | 4 (keyboard, axe) |
| Real Chromium through a sealed file, 3 OSes | `portability_spike` in `apps/desktop/src-tauri/tests/browser.rs` (runtime pipeline) | 12 rows |
| Deployed test server (API + worker + SeaweedFS + root key) | `services/api/scripts/snapshot-smoke.ts`, deploy-scripts workflow | round trip, update keeps backups restorable, root key rotation |

## 1. Same-device round trip
- **Engine** (`same_device_round_trip`): a profile folder with nested files and binary data is sealed, uploaded in
  parts, verified by the server, committed as version 1, then restored into a fresh folder; every file is identical,
  excluded files (caches, locks) are absent, settings come back from `meta/settings.json`.
- **Desktop** (`backups_after_a_clean_close_and_restore_with_evidence_kept`): a real clean exit of a profile starts
  the upload automatically (`auto_backup` on), the job reaches `committed`, the link records the version; a restore
  replaces the folder, keeps the previous data as evidence (`cloud-restore`), and the label is `supported`.
- **Real Chromium** (runtime pipeline, all three OSes): a profile signs in to a local test page, closes, is sealed
  exactly as an organization snapshot, opened into `user-data.incoming` of a new profile on the same machine and
  launched: cookie, localStorage and IndexedDB kept, label `supported` (see [portability matrix](../portability-matrix.md)).
- **Deployed server**: `snapshot-smoke.ts` backs up and restores through the running API, worker and SeaweedFS after
  every `vps-setup.sh` run (CI: deploy-scripts workflow).

## 2. Cross-device matrix and labels
The app labels every restore (`pb_sync::portability::classify`), and the matrix checks that the label tells the truth:

| Label | When | What the user sees |
|---|---|---|
| `supported` | Restored on the computer (enrolled device) that made the snapshot, same platform | "Restored version N." |
| `sign_in_required` | Any other computer or platform the runtime supports | "Restored version N. Sign-in may be required on websites: sign-ins only carry over on the computer that made the backup." |
| `unsupported` | Snapshot from a newer browser major than installed, no runtime, unknown platform, or a newer snapshot format | Refused before downloading, with the reason ("This backup was made with a newer browser. Update the browser on this computer first.", and similar for `NO_RUNTIME`, `UNKNOWN_PLATFORM`, `SNAPSHOT_FORMAT_TOO_NEW`); nothing changes |

Real Chromium results by OS pair (runtime pipeline [38387874586](https://github.com/bibekthapamgr/antibrowser/actions/runs/38387874586), 12 rows, "0 dishonest label(s)") are in the
[portability matrix](../portability-matrix.md): every same-machine row
keeps sign-ins and is labelled `supported`; every other-machine row is labelled `sign_in_required`, including Linux →
Linux where cookies happen to survive (the label never promises more than Windows and macOS deliver). The report
fails the pipeline on any row whose label promises kept sign-ins that were lost.

`unsupported` is tested in `portability.rs` and `restores_check_space_and_browser_version_before_downloading` (no
download starts, the profile is untouched). The real-API test restores on the operator's computer: identical files,
labelled `sign_in_required`.

## 3. Interruptions at each phase
| Phase | Interruption | Result | Test |
|---|---|---|---|
| Each call of an upload (lease, lease renewal, init, operation state, stored parts, part URLs, part upload, commit) | Connection lost **before** the request reaches the server, and **after** the server acted but before the answer arrived (16 cases) | The job waits and resumes; exactly one new version; the previous version restores byte for byte at every point | `network_lost_at_every_call_keeps_the_prior_snapshot_and_commits_once` |
| Every saved step of an upload (13 states/transitions written to the job store) | App killed right after the save; restarted from the saved job | Resumes from the saved step; asks the server for the operation state before uploading again; never two versions | `app_killed_at_every_step_resumes_without_losing_or_duplicating_a_version` |
| Sealing | Profile opened during sealing | Sealing is cancelled, the partial file removed; the job waits for the next clean close | desktop `an_open_profile_or_a_lost_connection_leaves_the_backup_waiting`, seal `cancelling_a_seal_removes_the_partial_file` |
| Upload expired, lease lost, verification failed | Server-side | Restarts under a new snapshot id (at most 3 times), then conflict or failure; head unchanged | `a_lease_lost_mid_upload_restarts…`, `a_failed_verification_restarts…`, API `abandoned, canceled, unverified and failed uploads never move the head` |
| Uncommitted objects | Upload abandoned | Erased after the grace period; known objects kept | API `orphaned objects (no manifest) are swept…` |
| Download | Connection cut mid-file | Resumes with `Range` from where it stopped; never unpacks a partial file | `a_download_cut_off_resumes_where_it_stopped` |
| Restore switch | App killed between moving the old folder away and moving the new one in | Finished at the next start (`tidy_restore`); evidence kept; opening refused (`PROFILE_RESTORING`) until done | desktop `a_restore_interrupted_mid_switch_is_finished_at_start_up` |
| Restore, low disk | Not enough free space | Refused before downloading; current profile intact | `restores_check_space_and_browser_version_before_downloading`, runtime `low_disk_keeps_the_previous_backup` |
| Real API | A dropped part upload and a lost commit answer | Committed once as version 1 after 4 attempts | `real_api.rs` (CI notice) |
| Cancel | User cancels an upload | Job `canceled`; last committed version unchanged | `canceling_an_upload_keeps_the_last_committed_version` |

## 4. Concurrent commits
- API: two uploads from the same base → exactly one becomes version n+1, the other `409 VERSION_CONFLICT`; a base
  overtaken before the request → 409 and the head kept; a lease taken over during verification →
  `FENCING_TOKEN_STALE`; a repeated commit returns the same operation (no second commit).
- Engine: `concurrent_devices_get_one_winner_and_one_conflict` — the loser's job ends in `conflict` with the head
  version; its local data and pending state stay.
- Desktop: `another_computer_restores_and_a_stale_computer_gets_a_conflict_not_an_overwrite` — the stale computer
  sees the conflict with the three choices ("Keep mine as the newest", "Replace mine with the newer one", "Open the
  newer one as a copy"); replacing keeps its data as evidence.
- Real API: the stale computer gets `VERSION_CONFLICT (head 2)` and the head is unchanged.

## 5. Wrong organization, substitution, tampering
| Attack | Result | Test |
|---|---|---|
| A member of another organization asks for a restore plan, the history or any snapshot route with real ids | `404 NOT_FOUND` (same as an unknown id); nothing downloaded | `cross-tenant.test.ts`, `real_api.rs` |
| Object replaced, modified, truncated or removed in storage after upload | Verification fails; nothing committed; object erased | API `object substitution, modification, truncation and removal fail closed`, `sync-s3.test.ts` (real S3) |
| Another snapshot's object served for a restore | `DIGEST_MISMATCH` before decrypting; with a forged manifest digest, `SEAL_WRONG_BINDING` | `restores_fail_closed_for_another_org_substitution_and_tampering` |
| Manifest moved to another profile, wrapped key modified, key destroyed | Restore plan refused or unwrap fails closed | API `a modified wrapped key, a manifest moved to another profile, or a destroyed key fail closed` |
| Header edited, chunks truncated/reordered/spliced | `SEAL_AUTHENTICATION_FAILED` / `SEAL_WRONG_BINDING`; destination removed, current profile untouched | `crates/seal` tests |
| Local backup opened with another device's key | "Key not available" (not "damaged"); nothing restored | runtime `a_sealed_backup_needs_this_devices_key…` |

## 6. Retention, history, trash and keys (worker jobs)
Covered by `sync.test.ts`: keep the head, the last 24 hours and the newest of each of the last 7 UTC days; erase
the rest after the grace period; organization policy (retention days, trash days) audited; quota and maximum
snapshot size enforced at init and at verification; deleted profiles restorable for 30 days, then purged with their
snapshots (tombstones kept); organization key rotation re-wraps data keys in batches and destroys the old version
30 days after it wraps nothing; root key rotation re-wraps organization keys and the old root key can be retired.
Rollback-to-copy: any version in the history can be restored as a new local copy without touching the current
profile (UI "Version history…" → "Restore as copy"); rolling the profile itself back is a restore of that version.

## 7. Sync UI
Profile drawer → **Backups**: status, progress, "Upload backup now", "Restore newest…", "Version history…",
"Back up automatically after it closes", conflict panel with three choices, failure and waiting reasons in plain
language. Organization → **Backups** (owners/admins): retention and trash, trash restore, storage used, organization
key versions and "Rotate key…" (after confirming the sign-in). Organization → Profiles: "Put on this computer".
Screens: `docs/design/profile-backups.png`, `profile-backup-conflict.png`, `organization-backups.png`.

## 8. Measurements
Sealing and opening, release build, `cargo run --release -p pb-seal --example measure -- <user-data> <work>` on a
2-vCPU Intel Xeon 2.1 GHz Linux cloud container with SSD (not the reference device; three runs). Synthetic profile:
4,097 files / 508 MiB on disk, of which 117 MiB are HTTP and GPU caches (excluded) and 391 MiB are kept: 200 MiB
incompressible blobs, 60 MiB LevelDB-like text, 80 MiB SQLite-like pages, 4,000 small scripts.

| Step | Result |
|---|---|
| Kept data → sealed file | 391.4 MiB → 251.5 MiB (64%) |
| Seal (pack + zstd 3 + AES-256-GCM + SHA-256) | 2.2–2.7 s (145–177 MiB/s) |
| SHA-256 check of the sealed file before opening | 0.26–0.27 s (~940 MiB/s) |
| Open (decrypt + decompress + archive checks + write 4,071 files) | 0.8–1.7 s (231–477 MiB/s) |

Upload and download times depend on the network and the storage server and are not claimed; the test server is a
1-vCPU VPS reached through an SSH tunnel. Parts are 16 MiB; each part URL is valid for 15 minutes.

## 9. Known gaps (carried forward)
- Shared profiles are fenced by the profile lease, but lease-controlled **opening** and handoff are milestone 08.
- The root key provider is a protected file (`local`); a managed KMS/HSM and an independent crypto review are paid
  launch gates (milestones 12/14).
- macOS Intel and Linux are not supported desktop targets (roadmap); Linux results are development evidence only.
- A per-file key for local backups (HKDF) is a schema 2 improvement (crypto review, residual risk 6).
