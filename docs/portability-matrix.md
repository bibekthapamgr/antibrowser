# Profile portability matrix (milestone 03, step 8; sealed snapshots since milestone 07)

Question: if a closed profile's folder is copied (caches and lock files excluded, exactly as a backup does) and
restored into a **new** profile folder, what still works? Decision for v1: [ADR-0002](adr/0002-profile-portability.md)
(same-device restore; on another device, site data restores where it can and **the user signs in again**).

Method: `portability_spike` in `apps/desktop/src-tauri/tests/browser.rs`. A profile "signs in" to a test page (a
real cookie, encrypted at rest by Chromium with the OS key store; plus localStorage and IndexedDB), closes cleanly,
is copied, and is restored into a new folder. Restores use the same origin (`http://127.0.0.1:47615`) because
browser storage is keyed by scheme, host **and port**. "Other machine" means a fresh CI runner.

## Results through sealed snapshots (Chrome for Testing 155.0.8059.39, runtime pipeline run [38387874586](https://github.com/bibekthapamgr/antibrowser/actions/runs/38387874586), 2026-10-13)

"Label" is what the app shows after that restore (`pb_sync::portability`, ADR-0014); "Label honest" checks that a
label promising kept sign-ins (`supported`) was given only where the cookie really survived. The pipeline fails on any
dishonest row ("0 dishonest label(s)" in this run).

| Source | Target | Machine | Cookie (encrypted) | localStorage | IndexedDB | Label | Label honest |
|---|---|---|---|---|---|---|---|
| Windows x64 | Windows x64 | same, new folder | kept | kept | kept | supported | yes |
| Windows x64 | Windows x64 | other machine | **lost** | kept | kept | sign-in required | yes |
| Windows x64 | macOS arm64 | other machine | **lost** | kept | kept | sign-in required | yes |
| Windows x64 | Linux x64 | other machine | **lost** | kept | kept | sign-in required | yes |
| macOS arm64 | macOS arm64 | same, new folder | kept | kept | kept | supported | yes |
| macOS arm64 | macOS arm64 | other machine | **lost** | kept | kept | sign-in required | yes |
| macOS arm64 | Windows x64 | other machine | **lost** | kept | kept | sign-in required | yes |
| macOS arm64 | Linux x64 | other machine | **lost** | kept | kept | sign-in required | yes |
| Linux x64 | Linux x64 | same, new folder | kept | kept | kept | supported | yes |
| Linux x64 | Linux x64 | other machine | kept | kept | kept | sign-in required | yes |
| Linux x64 | Windows x64 | other machine | **lost** | kept | kept | sign-in required | yes |
| Linux x64 | macOS arm64 | other machine | **lost** | kept | kept | sign-in required | yes |

Every restored profile opened. The plain-copy results of milestone 03 (run
[38315660017](https://github.com/bibekthapamgr/antibrowser/actions/runs/38315660017), 2026-10-12) were identical
row for row: sealing changes nothing about what survives. Also confirmed locally: Linux, Chromium 141.0.7390.37, same
machine, everything kept and labelled `supported`; the simulated other machine labelled `sign_in_required`.

The third label, `unsupported`, is given before anything is downloaded: a snapshot from a newer browser major than
the one installed, no runtime installed, an unknown platform, or a newer snapshot format. Those restores are refused
and change nothing (tests in `crates/sync`).

## What this means
| Pair | Sign-ins (cookies) | Site data (localStorage, IndexedDB) | Why |
|---|---|---|---|
| Same device, new folder | **Kept** on all three OSes | Kept | Same OS user, same key store |
| Windows → another Windows PC | Lost | Kept | Cookie key protected with DPAPI for that Windows user and machine |
| Mac → another Mac | Lost | Kept | Cookie key stored in that Mac's login Keychain, not in the profile |
| Between different OSes | Lost | Kept | Different key stores and formats |
| Linux → Linux (development only) | Kept | Kept | The basic password store is not machine-bound, so Linux is **not** representative |

This confirms [ADR-0002](adr/0002-profile-portability.md) exactly: site data travels, sign-ins do not.

## Supported in v1 (backup vs session transfer)
| Operation | v1 support |
|---|---|
| Local last-good copy and restore on the same device | **Supported** (milestone 03: automatic after a clean close, at most daily, and before engine upgrades; restore keeps the damaged data as evidence; sealed with this device's keychain key since milestone 07) |
| Restore on a different device | Site data best effort; **sign in to sites again**. Organization backups (milestone 07) do this and the app says "Sign-in may be required on websites" after every such restore |
| Session transfer (staying signed in across devices) | **Not supported and not advertised.** Changing this needs a superseding ADR with passing rows for that exact OS pair and a security review of any key handling |
| Restore into an older browser major version | Refused (downgrade guard). Newer versions first take a copy made by the old version |
