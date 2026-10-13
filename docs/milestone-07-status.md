# Milestone 07 — status against the handoff file

Encryption, backups and cloud synchronization. Version 0.7.0. Decisions:
[ADR-0014](adr/0014-encrypted-snapshots-and-sync.md) (accepts [ADR-0003](adr/0003-encryption-trust-model.md) option A).
Deliverables: [crypto design review](sync/crypto-design-review.md), [backup/restore report](sync/backup-restore-report.md),
retention jobs (worker), sync UI, [key recovery runbook](sync/key-recovery-runbook.md). Overview:
[sync/README.md](sync/README.md).

Outcome: recoverable encrypted snapshots of organization profiles with deterministic conflict handling — sealed on the
device, verified by the server before a compare-and-set commit, restored into a fresh folder with the previous data
kept, and labelled honestly about what survives on another computer.

## Security model decision
| Required | Implemented |
|---|---|
| Service-managed envelope encryption with KMS-controlled organization keys; not end-to-end | Root key (provider interface; v1 `local` = mode-600 file on the organization server) → organization key versions (wrapped by the root key) → a fresh data key per snapshot (wrapped by the organization key). The server can decrypt for authorized restores (audited). Stated in the app, the security model and the runbook |
| Local sealed backups with a device-protected key | The milestone 03 last-good copy is sealed with 32 random bytes in the OS keychain (`backup-key-v1`); a key fingerprint in the header; without a keychain it stays a plain copy (never a key in a file) |
| Active Chromium files may be plaintext; recommend disk encryption | Disclosure 1 in the security model; restored folders are plaintext like any open profile |

## Build sequence
| Step | Status |
|---|---|
| 1. Versioned manifest (snapshot_id, org_id, profile_id, parent_version, browser_version, platform, schema_version, object_digest, plaintext/ciphertext size, key_version, algorithm, created) | Done: `snapshot_manifests` (+ device, state, operation, parts, timestamps); the sealed header repeats the binding fields |
| 2. Only after a verified clean shutdown; app SQLite separately; include supported session data; exclude caches, crash dumps, downloads; explicit list | Done: sealing starts only for a `stopped` profile with no browser using the folder, holding busy + OS lock (opening cancels it). The app database is never copied; the profile's settings are exported to `meta/settings.json` (never proxies or their logins). Explicit exclusion list (caches, GPU/shader caches, crash dumps, metrics, model stores, Safe Browsing lists, singleton/lock files, links). Downloads live outside the profile folder, so they stay where the user saved them |
| 3. Compress, then audited AEAD; unique nonces; AAD binds org/profile/snapshot/schema | Done: zstd 3, then AES-256-GCM STREAM (RustCrypto `aes-gcm` 0.11.1 + `aead-stream` 0.6.0), 1 MiB chunks, 7-byte random prefix + counter + last flag; the whole header is the AAD |
| 4. Short-lived tenant-scoped upload; server checks size/digest/metadata before a transactional commit; uncommitted objects GC'd | Done: signed URLs for one 16 MiB part of one upload, 15 minutes; commit checks parts against storage; the worker checks size, sealed header and SHA-256 and commits in one transaction; uploads expire after 24 h, unreferenced objects erased after a 24 h grace period |
| 5. base_version + fencing token; 409; keep the local pending snapshot; no last-write-wins | Done: lease fencing token on init and commit; compare-and-set of the head; `409 VERSION_CONFLICT` keeps the head; the device keeps its data and offers three choices |
| 6. Restore into a fresh temporary directory; integrity, decrypt, archive safety, runtime compatibility; atomic switch; keep the previous directory | Done: resumable download, size + SHA-256 before decrypting, compatibility before downloading, unpack into `user-data.incoming`, switch with the previous data moved to evidence (kept), moved back on failure, finished at start-up after a crash; opening refused while restoring |
| 7. History, rollback-to-copy, retention, quotas, recoverable deletion (7 daily, 30-day trash) | Done: version history with restore or restore as copy; retention keeps the head, the last 24 h and the newest of each of 7 UTC days; quota 20 GiB and 4 GiB per snapshot (operator settings); trash 30 days with undelete; organization policy editable and audited |
| 8. Key rotation with versioned wrapping; audit recovery and KMS changes; key destruction and backup-expiry delay | Done: organization key rotation (owner, recent sign-in) and root key rotation (`root-key.sh`), re-wrapping in batches by the worker; a retired version is destroyed 30 days after it wraps nothing; every rotation, re-wrap, destruction and restore unwrap is audited |

## Data/API
| Required | Implemented |
|---|---|
| `snapshot_manifests`, `sync_operations`, `organization_key_versions` | Migration `0004_snapshots_keys_and_sync.sql`: the three tables plus organization backup policy columns (retention, trash, quota, size limit) and worker functions for verification, retention, trash purge, object erasure and key work; RLS and composite keys like milestone 06 |
| `POST /v1/profiles/{id}/snapshots/init`, `…/{snapshot}/commit`, `GET …/snapshots`, `POST …/restore-plans` | Under the organization like every 06 route: `/v1/orgs/{org}/profiles/{id}/snapshots/init`, `…/snapshots/{snapshot}/parts`, `…/commit`, `…/cancel`, `GET …/snapshots`, `POST …/restore-plans`, `GET /v1/orgs/{org}/sync-operations/{op}`; plus backup policy, trash, undelete, keys and key rotation ([OpenAPI](openapi.json)) |
| Authorization checks tenant, profile permission and current membership before object access | Tenant resolution, `snapshot.commit` / `snapshot.restore`, grants and the device session on every request; out-of-reach ids get the same 404 (all snapshot routes in `cross-tenant.test.ts`) |

## State and recovery
| Required | Implemented |
|---|---|
| `LOCAL_DIRTY → PREPARING → UPLOADING → VERIFYING → COMMITTED`; failed/canceled keep the last committed version | Device jobs persisted without secrets (`sync_jobs`, migration v7); `CONFLICT`, `FAILED`, `CANCELED` never move the head |
| Interrupted multipart transfer resumes or restarts safely; no duplicate commit | A resumed upload asks for the operation's state first; idempotency keys on lease and init; bounded restarts under a new snapshot id |
| Disk-full restore leaves the profile intact | Free space checked before downloading (size + plaintext + 512 MiB) |
| Wrong key/tamper fails closed; no plaintext secrets in error reports | Machine codes only (`SEAL_AUTHENTICATION_FAILED`, `SEAL_WRONG_BINDING`, `DIGEST_MISMATCH`, …); data keys and signed URLs never reach the window, logs, audit or events (tested) |
| "Restored; sign-in may be required" when cookies cannot move | Every restore is labelled `supported`, `sign_in_required` or refused as `unsupported`; the app says "Sign-in may be required on websites" for `sign_in_required` |

## Exit criteria
| Criterion | Evidence |
|---|---|
| Round trip of supported same-device data | Engine, desktop and real-API tests; real Chromium sealed round trip on all three OSes ([report §1](sync/backup-restore-report.md#1-same-device-round-trip)) |
| Cross-device matrix honestly labels supported / reauth-required / unsupported | [Portability matrix](portability-matrix.md): 12 OS pairs through sealed snapshots, 0 dishonest labels (runtime pipeline [38387874586](https://github.com/bibekthapamgr/antibrowser/actions/runs/38387874586)) |
| Kill network/app at each phase; prior snapshot remains restorable | 16 network-loss cases, 13 app-kill points, server-side abandon/cancel/failure, crash mid-switch, real API with a dropped part and a lost commit answer ([report §3](sync/backup-restore-report.md#3-interruptions-at-each-phase)) |
| Concurrent commits: one winner, one conflict | API, engine, desktop and real API ([report §4](sync/backup-restore-report.md#4-concurrent-commits)) |
| Wrong-org download, object substitution, manifest tampering fail | Cross-tenant sweep, real-S3 substitution, wrapped-key/manifest tampering, sealed binding ([report §5](sync/backup-restore-report.md#5-wrong-organization-substitution-tampering)) |

Test counts: Rust 258 across the workspace (new: seal 16, sync 12 + the real-API scenario, transfer 3, sealed local
backups 9, desktop sync 6, storage sync 2); API 264 (+ Keycloak and session-key tests in CI; new: 22 sync, 2 real-S3,
snapshot routes in the cross-tenant sweep); UI unit 30; UI end-to-end 111 (4 new backup flows plus the three new
screens in light and dark with axe at 900×600); worker 7; contracts and config 7 each.

CI: the three-OS run is recorded below once it completes.

## Test server
`vps-setup.sh` now installs SeaweedFS 4.48 (checksum-pinned) as `pb-storage` on `127.0.0.1:8333`, creates the backup
root key once (`/etc/project-browser/kms-root.json`, kept on re-runs) and finishes with a snapshot round trip through
the running services. The deploy-scripts workflow ([38389721802](https://github.com/bibekthapamgr/antibrowser/actions/runs/38389721802))
checks the round trip, that an update keeps the key and an earlier backup restorable, and a full root key rotation
(rotate → worker re-wrap → retire → the earlier backup still restores). The tunnel adds port 8333
([setup](setup.md#test-server-linux-vps)).

## Found and fixed during verification
- Windows refused to truncate the download file through an append-only handle, so every first restore download failed
  with `SYNC_IO_ERROR`; found by the 3-OS run, fixed in `a312b34`.
- On Windows a desktop test started an organization backup while the routine last-good copy of the same profile was
  still running; the app behaves as designed (the upload waits and is woken when the copy ends), and the test now
  starts after the copy, as a person would.
- The deploy-scripts rotation step ran the restore check while the API was still restarting; the smoke test now waits
  for `/health`.

## Known limitations
See [sync/README.md](sync/README.md#known-limitations). The most important: not end-to-end encrypted (root key file on
the organization server until a managed KMS exists), website sign-ins do not move between computers, and opening a
shared profile is not yet lease-controlled (milestone 08).

## Release
Still the local engineering alpha for profiles. Organization backups work against your own server for testing; the
team beta (sync with lease-controlled opening and handoff) follows milestone 08, on the OS combinations validated
here (Windows x64, macOS arm64).
