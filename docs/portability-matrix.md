# Profile portability matrix (milestone 03, step 8)

Question: if a closed profile's folder is copied (caches and lock files excluded, exactly as a backup does) and
restored into a **new** profile folder, what still works? Decision for v1: [ADR-0002](adr/0002-profile-portability.md)
(same-device restore; on another device, site data restores where it can and **the user signs in again**).

Method: `portability_spike` in `apps/desktop/src-tauri/tests/browser.rs`. A profile "signs in" to a test page (a
real cookie, encrypted at rest by Chromium with the OS key store; plus localStorage and IndexedDB), closes cleanly,
is copied, and is restored into a new folder. Restores use the same origin (`http://127.0.0.1:47615`) because
browser storage is keyed by scheme, host **and port**. "Other machine" means a fresh CI runner.

## Results so far

| Source | Target | Machine | Runtime | Cookie (encrypted) | localStorage | IndexedDB | Evidence |
|---|---|---|---|---|---|---|---|
| macOS arm64 | macOS arm64 | same, new folder | CfT 155.0.8059.39 | kept | kept | kept | runtime pipeline run 38281685691 |
| Linux x64 | Linux x64 | same, new folder | CfT 155.0.8059.39 | kept | kept | kept | runtime pipeline runs 38274243731, 38281685691 |
| Linux x64 | Linux x64 | same, new folder | Chromium 141.0.7390.37 | kept | kept | kept | local sandbox, 2026-10-12 |
| Windows x64 | Windows x64 | same, new folder | CfT 155.0.8059.39 | pending | pending | pending | blocked: Windows fix awaiting CI |
| each OS | each OS | other machine (9 pairs) | CfT 155.0.8059.39 | pending | pending | pending | blocked: needs all three compatibility jobs green |

The cross-machine jobs run automatically once the compatibility set passes on all three platforms; the pipeline's
"portability matrix" job then prints the full table (`scripts/runtime/portability-report.mjs`), which replaces the
pending rows here.

## What to expect on other machines (to be confirmed by the pending rows)
| Pair | Cookies / sign-ins | Site data (localStorage, IndexedDB) | Why |
|---|---|---|---|
| Same device, new folder | Kept | Kept | Same OS user, same key store |
| Windows → other Windows | Expected lost | Expected kept | Cookie key protected with DPAPI for that Windows user and machine |
| macOS → other Mac | Expected lost | Expected kept | Cookie key stored in that Mac's login Keychain, not in the profile |
| Windows ↔ macOS | Expected lost | Expected kept | Different key stores and formats |
| Linux (development only) | Kept anywhere | Kept | The basic password store is not machine-bound, so Linux results are **not** representative |

## Supported in v1 (backup vs session transfer)
| Operation | v1 support |
|---|---|
| Local last-good copy and restore on the same device | **Supported** (milestone 03: automatic after a clean close, at most daily, and before engine upgrades; restore keeps the damaged data as evidence) |
| Restore on a different device | Site data best effort; **sign in to sites again**. The UI must say so (milestone 08 handoff) |
| Session transfer (staying signed in across devices) | **Not supported and not advertised.** Changing this needs a superseding ADR with passing rows for that exact OS pair and a security review of any key handling |
| Restore into an older browser major version | Refused (downgrade guard). Newer versions first take a copy made by the old version |
