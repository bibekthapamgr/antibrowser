# Milestone 03 — status against the handoff file

Browser runtime and profile isolation. Version 0.3.0. Decisions: [ADR-0010](adr/0010-runtime-source-and-lifecycle.md).
Evidence: [isolation-evidence.md](isolation-evidence.md), [portability-matrix.md](portability-matrix.md).
Guides: [runtime-pipeline.md](runtime-pipeline.md), [crash-recovery.md](crash-recovery.md).

Scope reminder: this is **storage isolation** between profiles (cookies, cache, localStorage, IndexedDB, service
workers, extension data each live in the profile's own Chromium folder). It is not OS-level isolation from hostile
code and does not make profiles look like different devices or networks.

## Implementation order
| Step | Status |
|---|---|
| 1. Approved, reproducible runtime pipeline; signed manifest, digest, architecture, version; no arbitrary executable | Done. Chrome for Testing stable (owner decision), pipeline on Windows/macOS/Linux runners, Ed25519-signed manifest with the owner's key, SHA-256 + size before extraction, safe extraction, executable check. Release builds can only run the runtime from the signed manifest. **Licensing:** CfT is not for end-user distribution, so the manifest says `customer_distribution: false` and the UI labels it as an internal testing build (ADR-0010 gate 2) |
| 2. States STOPPED/STARTING/RUNNING/STOPPING/CRASHED/RECOVERING; pid + start identity | Done (`crates/runtime/src/state.rs`, transition table; pid + OS start time + executable in `process_runs`) |
| 3. OS lock per profile; structured arguments; sandbox on | Done (`manager.lock` file lock + launch lock; argument list, never a shell; `--no-sandbox` and remote debugging refused) |
| 4. Directory only from validated ids; process tree; window open vs ready | Done (ids → `profiles/<id>/user-data`; tree from the process table; "ready" = helper processes started, "window open" = a page renderer exists) |
| 5. Graceful close with timeout, then explicit force close; wait for all writers before a copy | Done (Windows WM_CLOSE, macOS standard quit, Linux SIGTERM; force close offered after 10 s; copies only after the whole process tree exited; live databases never copied) |
| 6. Last known-good state; actionable status after an interrupted start; no reopen loops | Done (daily last-good copy after a clean close and before an engine upgrade; crash/interrupted/damaged statuses with suggested recovery; the manager never reopens by itself) |
| 7. Pinned manifests, compatibility test set, regular stable updates | Done (5 real-browser tests per platform gate the signing step; weekly run warns when behind upstream) |
| 8. Portability spike with real cookie encryption; backup vs session-transfer matrix | Same-machine rows done (macOS, Linux: everything kept); cross-machine rows run automatically after Windows passes. v1 support matrix written: [portability-matrix.md](portability-matrix.md) |

## Native API and metadata
| Required | Implemented as |
|---|---|
| `runtime.install(version)` | `install_runtime` (only the version in the signed manifest) |
| `profile.start(id)` | `launch_profile` (idempotent while starting/running) |
| `profile.stop(id, graceful)` | `stop_profile { force }` (graceful by default) |
| `profile.status(id)` | `get_profile_status` (state, runs, last-good copy, evidence count, suggested recovery) |
| `profile.recover(id)` | `recover_profile { action: reopen \| restore_backup \| start_fresh \| backup_now }` |
| `profiles_local` columns | `profiles` table, schema v3: `workspace_id` (client), `runtime_version`, `data_dir_ref`, `state`, `last_started_at`, `last_clean_shutdown_at`, `schema_version`, plus crash/backup fields |
| `process_runs` | `process_runs` (run id, profile, pid, start time + executable, exit code, outcome, start/end; one active run per profile enforced by a unique index) |
| Audit without URLs/cookies/passwords | `audit_log` with a fixed action list and short outcome codes; a test checks no URL is ever stored |

## Profile settings
Name, client label and colour, start pages (up to 10, http/https only), download folder (chosen in a native dialog),
camera/microphone/location defaults (ask/allow/block). Written into the profile's Chromium settings while it is
closed and locked. The client label is shown in the manager and in Chromium's profile name; the window title is not
customised (as the handoff file allows). No command-line editor.

## Failure cases
| Case | Behaviour | Test |
|---|---|---|
| Browser left running after a manager crash | Re-attached on restart only when the exact runtime executable owns that profile folder and the lock can be taken; another browser on the folder is refused, never killed | `ipc.rs` re-attach, `supervisor` unit tests |
| Damaged profile folder | Launch refused before Chromium sees it (Chromium would silently reset it); restore last-good copy into a new folder, damaged data kept as evidence, backup never written to | `ipc.rs`, `backup.rs` |
| Disk full | Launch refused below 1 GiB free, copies below 512 MiB headroom; running profiles warn below 256 MiB; an interrupted copy never replaces the previous one | `ipc.rs`, `backup.rs` |
| Browser newer than the profile's last version | Newer major: last-good copy by the old version first; older major (downgrade): refused | `ipc.rs` |
| Offline | Local profiles need no network; only runtime installation does | — |

## Exit criteria
| Criterion | Status |
|---|---|
| Controlled-origin tests prove no storage leakage between A and B | **Passed on macOS arm64 and Linux x64** with Chrome for Testing 155.0.8059.39. **Windows x64 pending** (fix for the Windows failures pushed, not yet run; see below) |
| Restart preserves A's state; a crash does not attach it to B | Same runs (incl. cookies after restart on macOS) |
| Repeated double-click creates one run | Same runs (5 concurrent requests → one operation, one browser) + `ipc.rs` |
| No debug endpoint exposed to the network | No remote-debugging switch can be passed; tests confirm no `DevToolsActivePort` and no such switch on the running browser |
| Ten launch/close cycles keep a clean state across supported OS builds | macOS arm64 and Linux x64 passed (CI runner OS images). **Windows pending; manual run on the owner's Windows 11 and macOS machines still to do** |

## Deliverables
| Deliverable | Where |
|---|---|
| Runtime adapter | `crates/runtime` (launch, preferences, process tree, lock, backups) + `crates/update` (manifest, download, install) |
| Process supervisor | `apps/desktop/src-tauri/src/supervisor.rs`, `lifecycle.rs` |
| Version manifest | Format, signing and verification done; **the signed `runtimes/manifest.json` + `.sig` for 155.0.8059.39 are not committed yet** because signing requires all three platforms to pass. Until then the manager shows "No approved browser in this build" (development builds can point at a local browser) |
| Isolation test evidence | [isolation-evidence.md](isolation-evidence.md) |
| Crash recovery guide | [crash-recovery.md](crash-recovery.md) |
| Portability matrix | [portability-matrix.md](portability-matrix.md) |

## Test totals
Rust 108 (runtime 32, storage 15, update 16, desktop 16 unit + 24 IPC integration + 5 real-browser); TypeScript 58
(incl. 15 desktop unit/contract); UI end-to-end 39.

## What is still open
| Item | Blocked on |
|---|---|
| Windows x64 real-browser run (fix for verbatim `\\?\` profile paths in commit 703ef1c) | GitHub Actions: "recent account payments have failed or your spending limit needs to be increased" (private repository; every workflow has been refused since 2026-10-12) |
| Cross-machine portability rows | The Windows run (the matrix starts only when all three platforms pass) |
| Signed runtime manifest for 155.0.8059.39 committed to `runtimes/` | The Windows run, then one pipeline run with `sign` ticked |

## Owner actions
0. **GitHub billing:** Settings → Billing and plans → fix the payment method or raise the Actions spending limit,
   then re-run *runtime pipeline* with `sign` ticked (or ask Claude to).
1. **Manual check on your own machines:** open two profiles on Windows 11 and on your Mac, sign in to a site in one,
   confirm the other is signed out, close and reopen.
2. **Before any customer or external user (team beta at 08 at the latest):** choose a redistributable, properly signed
   runtime (ADR-0010 gate 2).
3. Code-signing certificates from milestone 02 are still outstanding.
