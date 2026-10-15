# 0010 — Browser runtime source and lifecycle (milestone 03)
Status: **Accepted** for the internal alpha. Date: 2026-10-12. Owner: technical lead + browser/security owner.
Partly supersedes ADR-0001 (its "engineering alpha" proposal).

## Context
Milestone 03 requires "supported Chromium binaries via an approved reproducible distribution pipeline; verify
licensing, signed manifest, digest, architecture and version before use", regular stable updates, and no arbitrary
executable path. On 2026-10-12 the candidates were checked:

| Source | Windows x64 | macOS arm64 | Redistribution | Notes |
|---|---|---|---|---|
| Chrome for Testing (CfT) | 155.0.8059.39 (current stable) | 155.0.8059.39 | Not for end-user distribution; "for testing" info bar | Official Google builds, every stable release, JSON index with URLs |
| ungoogled-chromium | 153.0.8010.52 (20 Sep) | **150.0.7871.46 (6 Jul)** | BSD-style, redistributable | macOS builds three months behind on security fixes |
| User's installed Chrome | vendor-updated | vendor-updated | n/a | Not pinned; skips the verified pipeline the milestone requires |

The product owner chose Chrome for Testing for the internal alpha (2026-10-12).

## Decision
1. **Source:** Chrome for Testing stable, downloaded by the manager directly from
   `https://storage.googleapis.com/chrome-for-testing-public/` (no re-hosting). The prefix is compiled into the manager;
   a signed manifest cannot widen it.
2. **Release gate:** the manifest records `customer_distribution: false`. Before any customer, pilot or paid build
   (milestone 14, and before team beta at 08 if external users are involved) the runtime must move to a source whose
   licence allows redistribution and whose security cadence meets ADR-0001's SLA. The UI labels the runtime
   "Internal testing build: not for customers".
3. **Pipeline:** `.github/workflows/runtime-pipeline.yml` resolves the current stable, installs it on Windows, macOS and
   Linux runners with the manager's own installer, runs the real-browser compatibility set, runs the portability
   matrix, and only then builds `runtimes/manifest.json` and signs it (Ed25519, owner-generated key in the
   `RUNTIME_MANIFEST_SIGNING_KEY` secret; public key in `runtimes/trusted-keys.json`). The signer refuses a secret that
   does not match the trusted public key. The manifest and signature are committed and embedded at build time
   ("pinned per release"). A weekly scheduled run warns when the pinned version is behind upstream stable.
4. **Verification in the manager:** signature against compiled-in keys → structural checks → https download capped at
   the pinned size → SHA-256 + size before extraction (mismatch → quarantine) → safe extraction (bundle-internal
   relative links only, never writing through a link) → executable present → macOS `codesign --verify --deep
   --strict` when the manifest says `required`. Release builds have no other way to choose an executable.
5. **Versions:** each profile records the runtime that last ran it; Chromium's `Last Version` file is checked before
   launch. A profile last opened by a newer major version is refused (downgrade not presumed safe). Opening with a
   newer major version first takes a last-good copy made by the old version.
6. **Lifecycle (state machine):** STOPPED → STARTING → RUNNING → STOPPING → STOPPED, with explicit CRASHED and
   RECOVERING; every other transition is rejected. Launches are serialized by an OS file lock per profile plus an
   in-process launch lock; a repeated launch returns the existing operation. Processes are identified by pid + OS
   start time + executable. A run ends only when the main process and its helper processes have exited.
7. **Graceful close per OS:** Windows `taskkill /PID …` without `/F` or `/T`, sent to the browser main process only
   (WM_CLOSE → normal shutdown; its helper processes have no windows and are ended by the browser itself); macOS the
   standard quit Apple event to that exact process (`NSRunningApplication.terminate` via `osascript -l JavaScript`),
   falling back to SIGTERM; Linux (development only) SIGTERM, which Chromium treats as "session ending" and which can
   drop cookie writes from the last ~30 s. After 10 s without exit the UI offers an explicit force close; nothing is
   force-killed silently.
8. **Crash classification:** for processes the manager started, only exit status 0 is an orderly exit; for re-attached
   processes Chromium's own `exit_type` decides. The manager never reopens a crashed profile by itself.
9. **Last-good copies:** after a clean close (at most daily, or when the engine major version changes) the manager
   copies the stopped, quiesced profile to `backups/<id>/last-good` (caches and lock files excluded), replacing the
   previous copy only after the new one is complete. Restore moves the current data to `evidence/<id>/…` first (three
   kept) and never writes into the backup. Copies are refused below 512 MiB headroom; launches below 1 GiB free.
   Opening a profile cancels a routine copy in progress (the previous copy stays); a launch never waits behind it.
10. **Profile settings** go into Chromium's `Default/Preferences` while the profile is stopped and locked: profile
    name (shown in Chromium's profile menu), client colour (`browser.theme.user_color`, best effort), download folder,
    camera/microphone/location defaults. Start URLs are passed after `--` on the command line, because Chromium
    MAC-protects its startup-page preferences. There is no command-line editor; extra switches exist only for the
    manager's own test configuration and are allow-listed (`--no-sandbox` and remote debugging are not allowed).

## Pipeline findings (2026-10-12, Chrome for Testing 155.0.8059.39)
- **macOS:** the upstream `Google Chrome for Testing.app` is ad-hoc signed and fails `codesign --verify --deep --strict`
  ("code has no resources but signature indicates they must be present") both when extracted by Apple's `ditto` and
  by the manager's installer, so the extraction is faithful and the upstream bundle is the cause. The pipeline
  therefore records `macos_codesign: none`; integrity rests on the pinned SHA-256 and size of the archive. A
  customer-grade runtime must be properly signed (gate 2 above).
- **Windows (1):** Chromium runs its network service in an app-container sandbox that must be able to read the
  browser executable. In a folder created by the manager (under the user's app data) it could not ("Sandbox cannot
  access executable"), the network service restarted in a loop and no page loaded. Chrome's own installer grants
  ALL APPLICATION PACKAGES and ALL RESTRICTED APPLICATION PACKAGES read/execute on its folder; the manager's
  installer now does the same (`icacls`, before the runtime is published). The sandbox stays on.
- **Windows (2):** `taskkill /T` (whole tree) without `/F` did not close Chromium within 10 s on the CI runner;
  asking only the main process closes it cleanly. All five compatibility tests then passed (run 38315660017).
- **Linux:** SIGTERM takes Chromium's "session ending" path; storage written in the last seconds can be lost. Linux is
  a development platform only.

## Consequences
- Every manager release carries one pinned runtime; updating it is: run the pipeline (sign=true) → commit the two
  files → release the manager. Milestone 12 adds over-the-air manifest updates.
- The CfT info bar appears in every profile window during the alpha.
- macOS sends one Apple event per close; if macOS asks the user to allow "Project Browser" to control the browser and
  the user declines, closing falls back to SIGTERM (data from the last seconds may be lost). Recorded in os-setup.md.

## Evidence / verification
`crates/update/src/tests.rs`, `crates/update/src/install/tests.rs`, `crates/runtime/src/*` tests,
`apps/desktop/src-tauri/tests/{ipc,browser}.rs`, runtime pipeline runs (docs/runtime-pipeline.md,
docs/isolation-evidence.md, docs/portability-matrix.md).

## Update — automatic install and update (2026-10-16)
The manager no longer asks the person to start the runtime download by hand. The verification, pinned size, signed
manifest, revocation and downgrade rules above are all kept unchanged; only *when* the verified install runs changed:
- **Install on first use.** A background runtime worker (`AppState::start_runtime_worker`, started from the shell
  setup) ensures the pinned runtime is installed shortly after start. Opening a profile while it is still missing no
  longer errors `RUNTIME_NOT_INSTALLED`: the launch operation downloads and installs the pinned runtime (or waits for
  an install already in progress) and then opens, with progress shown on that operation
  (`launch_when_runtime_ready` → `ensure_runtime_installed`). A single in-flight install is enforced by the existing
  `installing` guard; a stalled download surfaces as a failed launch rather than a silent hang.
- **Update on next safe moment.** When a manager release pins a newer engine, the worker installs it automatically —
  but only while no profile is open, so no profile's engine is swapped underneath it; it retries on its interval once
  profiles are closed. The one-way engine upgrade still takes a last-good copy at launch (point 9) and still refuses to
  open a profile with an older engine than last wrote it (point 5).
- **Gate unchanged.** `customer_distribution` stays the owner-side release gate (point 2 / the `runtime_eligibility`
  preflight); automatic install is only the download/install flow becoming hands-free for builds where it is allowed,
  and the "Internal testing build: not for customers" label is unchanged. The manual install control remains as an
  optional "Install now"/"Update now" affordance on the Downloads and updates screen.

## Revisit when
Before team beta/paid launch (gate 2), when CfT terms change, or if the pipeline shows the pinned runtime more than one
stable release behind for more than 7 days.
