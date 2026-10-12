# 0009 — Desktop shell decisions (milestone 02)
Status: **Accepted**. Date: 2026-10-12. Owner: technical lead.

## Context
Milestone 02 adds the desktop shell around the 01 runtime: local workspaces, quit behaviour, deep links, secret storage, crash recovery and installers. Several items in the handoff file allow more than one reading; this records the readings taken.

## Decision
1. **Local workspaces** use the opaque id grammar `wsp_` + 26 Crockford base32 characters (same rules as `prf_`, ADR-0008 item 8). A workspace is a local grouping only; there is no membership or sync until milestones 06–07. Profiles created before 02 are moved into a workspace called "My workspace" by migration v2.
2. **Manager data lives in the OS local app-data directory**: `%LOCALAPPDATA%\dev.projectbrowser.manager` on Windows (not Roaming: browser profiles are large and bound to the device) and `~/Library/Application Support/dev.projectbrowser.manager` on macOS. One manager process owns it at a time (single-instance plugin plus an exclusive `manager.lock`).
3. **Closing the manager does not have to close profiles.** The `manager.close_behavior` setting is `ask` (default), `keep_running` or `close_all`. With `ask`, the window shows how many profiles are open and offers *Cancel*, *Leave profiles open and quit* and *Close all profiles and quit*. The tray shows the running count. On the next start, still-running browsers are re-attached when (pid, process start time, executable name) all match; otherwise the record is cleared, so pid reuse never adopts an unrelated process.
4. **Deep links**: only `projectbrowser://auth/callback?state=…&(code|error)=…` is accepted. Tokens are 16–512 characters of `[A-Za-z0-9-._~]`, the whole URL at most 2 KiB. A callback is honoured only if `state` matches a one-time transaction the manager created (stored as a SHA-256 digest, consumed on first use, expiring). Everything else is dropped without reaching the UI. Sign-in itself arrives in milestone 06; 02 delivers the validated entry point.
5. **Secrets**: the OS keychain (macOS Keychain, Windows Credential Manager) is probed at start-up. When it is unavailable, secret persistence is disabled — nothing is written to disk as a fallback — and Settings says so.
6. **Settings are an allowlist** (`appearance.theme`, `manager.close_behavior`, `privacy.crash_reports`, `downloads.directory`, `workspace.active`) with typed validation and optimistic versions. `downloads.directory` can only be set through the native folder picker, never from a UI string.
7. **Crash reports** are written locally only, with home-directory paths, the OS user name and long opaque tokens scrubbed, at most 20 kept. `privacy.crash_reports` defaults to off; no sending service exists yet (milestone 13).
8. **Local profile listing** is bounded at 10,000 rows per call (the 10,000-profile search target) and rendered with a windowed list; cloud API pages keep their own smaller limit.
9. **Installers**: Windows NSIS (per-user, with Tauri's "delete application data" checkbox on uninstall) and MSI; macOS `.app` and DMG. Unsigned builds are allowed only as internal engineering builds and are labelled `internal-UNSIGNED` in every file name and in `provenance.json`.

## Consequences
- The manager can be quit without interrupting work in open profiles, at the cost of re-attach logic and a per-process identity check.
- A missing keychain degrades features instead of storing secrets insecurely.
- Removing the app does not silently remove profiles: the user chooses (NSIS checkbox, or *Settings → Remove all local data* on every OS).

## Evidence / verification
`apps/desktop/src-tauri/tests/ipc.rs` (IPC boundary, recovery, re-attach), `apps/desktop/e2e/` (keyboard, accessibility, resize, scale), `.github/workflows/desktop-internal-build.yml` (install/uninstall smoke test, checksums, provenance).

## Revisit when
Milestone 06 (real sign-in through the deep link), 07 (workspace sync), 12 (updater and signed channels).
