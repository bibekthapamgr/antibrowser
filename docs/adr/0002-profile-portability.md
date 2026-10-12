# 0002 — Profile portability
Status: **Accepted**; confirmed by the milestone 03 portability matrix (originally provisional under the milestone 01 stop gate). Date: 2026-10-12. Owner: technical lead.

## Context
Milestone 01 stop gate: "if portable authenticated sessions cannot be safely supported, choose same-device backup plus reauthentication on new devices for v1. Do not advertise portable login continuity."

Chromium protects cookies and saved credentials at rest with OS-bound keys:
- **Windows:** DPAPI, plus app-bound encryption (Chrome 127+, July 2024) that ties the cookie key to the browser's app identity and machine. Google states profiles that roam between machines will not work correctly with it enabled.
- **macOS:** a key stored in the user's Keychain ("<browser> Safe Storage"), not inside the profile directory.
- **Linux (spike harness):** a basic password store whose key is not machine-bound (`v10` prefix observed), so copies decrypt anywhere. This makes Linux results look better than Windows/macOS will be.

## Decision
1. **v1 default:** encrypted snapshots restore on the **same device** (same OS user and browser identity). On a different device, the profile's stored site data restores where it can, and **the user re-authenticates** to sites. UI and marketing must not promise login continuity across devices.
2. Snapshots are taken **only of closed profiles** (process exited, lease held) and exclude caches, lock and singleton files (list in `spikes/src/snapshot.ts`).
3. Profile directories are named only by the opaque profile id; labels never become paths. Local-only alpha profiles generate ids with the same grammar on the device (ADR-0008).
4. Cross-device continuity may be enabled per OS pair **only after** the spike passes on that exact pair with the chosen runtime, and after security review of any key-export mechanism. It must never rely on extracting OS-protected keys outside supported APIs.

## Evidence (2026-10-12)
| Scenario | Result |
|---|---|
| Same device, restore to a new path (Linux harness, Chromium 153) | Cookie, localStorage and IndexedDB restored |
| Second OS user, same Linux machine | Restored (basic key store; NOT representative) |
| Same machine, new folder: Windows x64, macOS arm64, Linux x64 (Chrome for Testing 155.0.8059.39, milestone 03 pipeline) | Everything kept |
| Other machine, all 9 OS pairs (same runs) | localStorage and IndexedDB kept everywhere; cookies **lost** everywhere except Linux → Linux |

Full table: [docs/portability-matrix.md](../portability-matrix.md). The decision above is confirmed.

## Consequences
- Milestone 07 sync scope is "encrypted backup and same-device restore, plus best-effort site data on new devices".
- Milestone 08 handoff UX must ask the receiving user to sign in to sites where cookies did not survive, and say so plainly.
- Changing this decision requires a superseding ADR with spike evidence for each OS pair.
