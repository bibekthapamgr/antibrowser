# Profile portability matrix (milestone 03, step 8)

Question: if a closed profile's folder is copied (caches and lock files excluded, exactly as a backup does) and
restored into a **new** profile folder, what still works? Decision for v1: [ADR-0002](adr/0002-profile-portability.md)
(same-device restore; on another device, site data restores where it can and **the user signs in again**).

Method: `portability_spike` in `apps/desktop/src-tauri/tests/browser.rs`. A profile "signs in" to a test page (a
real cookie, encrypted at rest by Chromium with the OS key store; plus localStorage and IndexedDB), closes cleanly,
is copied, and is restored into a new folder. Restores use the same origin (`http://127.0.0.1:47615`) because
browser storage is keyed by scheme, host **and port**. "Other machine" means a fresh CI runner.

## Results (Chrome for Testing 155.0.8059.39, runtime pipeline run [38315660017](https://github.com/bibekthapamgr/antibrowser/actions/runs/38315660017), 2026-10-12)

| Source | Target | Machine | Cookie (encrypted) | localStorage | IndexedDB |
|---|---|---|---|---|---|
| Windows x64 | Windows x64 | same, new folder | kept | kept | kept |
| Windows x64 | Windows x64 | other machine | **lost** | kept | kept |
| Windows x64 | macOS arm64 | other machine | **lost** | kept | kept |
| Windows x64 | Linux x64 | other machine | **lost** | kept | kept |
| macOS arm64 | macOS arm64 | same, new folder | kept | kept | kept |
| macOS arm64 | macOS arm64 | other machine | **lost** | kept | kept |
| macOS arm64 | Windows x64 | other machine | **lost** | kept | kept |
| macOS arm64 | Linux x64 | other machine | **lost** | kept | kept |
| Linux x64 | Linux x64 | same, new folder | kept | kept | kept |
| Linux x64 | Linux x64 | other machine | kept | kept | kept |
| Linux x64 | Windows x64 | other machine | **lost** | kept | kept |
| Linux x64 | macOS arm64 | other machine | **lost** | kept | kept |

Every restored profile opened. Also confirmed locally: Linux, Chromium 141.0.7390.37, same machine, everything kept.

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
| Local last-good copy and restore on the same device | **Supported** (milestone 03: automatic after a clean close, at most daily, and before engine upgrades; restore keeps the damaged data as evidence) |
| Restore on a different device | Site data best effort; **sign in to sites again**. The UI must say so (milestone 08 handoff) |
| Session transfer (staying signed in across devices) | **Not supported and not advertised.** Changing this needs a superseding ADR with passing rows for that exact OS pair and a security review of any key handling |
| Restore into an older browser major version | Refused (downgrade guard). Newer versions first take a copy made by the old version |
