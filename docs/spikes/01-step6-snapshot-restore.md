# Spike 01-6 — Closed-profile snapshot and restore

**Requirement:** snapshot/restore a closed profile on the same OS/device and across a second device; record browser encryption/platform constraints; do not assume copying a directory preserves usable logins.

**Result:** same-device restore **passed**. Cross-device on Windows/macOS **not yet run**. Decision for v1 recorded in [ADR-0002](../adr/0002-profile-portability.md) (stop gate applied). Script: `spikes/src/snapshot.ts`.

## Method
1. Create a profile, write cookie + localStorage + IndexedDB on a controlled origin, then **close the browser gracefully** (flushes cookie DB and LevelDB). Snapshots are never taken of a running profile.
2. Archive the user-data directory minus caches, lock/singleton files, crash dumps and metrics; hash the content.
3. Restore into a **different absolute path**, refusing archive entries that are absolute, contain `..` or are links.
4. Launch the restored copy and read the values on the **same origin** (scheme, host and port).

## Results (Linux harness, headless Chromium 153.0.8010.0)
| Scenario | Cookie | localStorage | IndexedDB | Report |
|---|---|---|---|---|
| Same device, new path | restored | restored | restored | [results/snapshot-local-report.json](results/snapshot-local-report.json) |
| Exported by one OS user, imported by another on the same machine | restored | restored | restored | [export](results/snapshot-export-report.json), [import](results/snapshot-import-report.json) |

Size for a near-empty profile: 33 files, ~176 KB before compression, ~7 KB archived; snapshot ~30 ms, restore ~15 ms. Real profiles will be far larger; measure in 13.

## Constraints recorded
| Platform | How cookies are protected at rest | Expected cross-device behaviour |
|---|---|---|
| Linux harness | `v10` prefix, basic password store, key not bound to machine | Copies decrypt anywhere; **not representative** |
| Windows | DPAPI + app-bound encryption since Chrome 127 (key bound to app identity and machine); key material referenced from `Local State` | Cookies from another machine are expected **not** to decrypt |
| macOS | Key in the user's Keychain ("Safe Storage"), outside the profile | Cookies expected **not** to decrypt on another Mac without that Keychain item |

Other constraints:
- **Origin includes the port.** An early run "lost" localStorage and IndexedDB because the verification server used a new random port; cookies survived because cookies ignore ports. Restores must be verified on identical origins.
- **Version compatibility.** Chromium profiles are not backward compatible; opening a profile written by a newer version can corrupt it. Snapshot manifests carry `browser_revision`, and restore must refuse older runtimes (07).
- **Process exclusivity.** See the step-4 finding: the manager must lock the directory before launching or snapshotting.

## Outstanding runs (needed before the team beta, not before 02)
On two real machines per pair, with the runtime chosen in ADR-0001:

```bash
# device 1
pnpm spike:snapshot -- export --file profile.tgz --browser "<chromium path>" --headless new --port 47311
# copy profile.tgz to device 2, then
pnpm spike:snapshot -- import --file profile.tgz --browser "<chromium path>" --headless new
```
Pairs: Windows→Windows, macOS→macOS, Windows→macOS, macOS→Windows. Record each report in `results/` and update ADR-0002.
