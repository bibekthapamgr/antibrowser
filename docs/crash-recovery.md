# Crash recovery guide (milestone 03)

For support staff and users. Technical background: [ADR-0010](adr/0010-runtime-source-and-lifecycle.md).

## What the manager does by itself
- **Never reopens a crashed profile automatically.** A crash is shown as *Closed unexpectedly*; reopening is always
  your choice, so a broken profile cannot crash in a loop.
- **Keeps runs separate.** A crash in one profile never changes another profile's state; its process tree is
  identified by process id *and* start time, so an unrelated program that reuses the id is never touched.
- **Re-attaches after a manager crash.** Profiles that kept running while the manager was closed or crashed appear as
  *Open · kept open while the manager was closed*. Browsers started just before a manager crash are found by their
  profile folder and re-attached only if they are the manager's own browser.
- **Explains interrupted work.** *The last start was interrupted* (manager closed while a profile was opening) and
  *A recovery was interrupted* appear on the profile after a restart.
- **Waits for every browser process** to exit before marking a profile closed or copying it.

## Profile states
| Shown as | Meaning | What you can do |
|---|---|---|
| Opening… | Browser starting | Wait |
| Open / Running (no window) | Browser ready; "no window" means no page is open | Close |
| Closing… | Asked to close | Wait (up to 10 s) |
| Not responding | Did not close in time | **Force close** (pages may lose unsaved work) |
| Closed unexpectedly | Crash or hard kill | Open again, or Recover |
| Recovering… | Restore or fresh start in progress | Wait |

## Recover (Profile settings → Recover, profile must be closed)
| Action | When | What happens |
|---|---|---|
| **Open again** | First crash | Starts normally. Chromium may offer to restore the previous pages. |
| **Restore last good copy** | Repeated crashes (suggested after 3), or *browser data looks damaged* | Current data is moved to `evidence/` (never deleted), the last good copy is copied into a fresh folder. Changes since that copy are lost; sign-ins made since may need repeating. |
| **Start with empty data…** | No backup exists and the profile cannot open | Current data moved to `evidence/`; the profile opens like new (settings, name and client stay). |
| **Back up now** | Before risky work | Copies the closed profile now (otherwise automatic after a clean close, at most daily, and before a browser engine upgrade). Opening the profile while a routine backup runs cancels that backup; the previous copy stays in place. |

*This profile's browser data looks damaged* means Chromium's settings files cannot be read. The manager refuses to
open it (Chromium would silently reset it) so the evidence is preserved; use **Restore last good copy**.

*This profile was last opened by a newer browser version* means the profile came from a newer browser. Opening it with
an older one could corrupt it, so it is refused; install the newer runtime.

## Disk space
- Opening a profile is refused below **1 GiB** free; backups need the profile size plus 512 MiB.
- While profiles are open, the manager warns below **256 MiB** free: close profiles so Chromium can save safely.
- A backup that runs out of space is abandoned; the previous backup stays intact.

## Where things are
`<app data>/profiles/<id>/user-data` (browser data), `backups/<id>/last-good`, `evidence/<id>/<time>-<reason>`
(newest three kept), `crash-reports/` (manager crashes, scrubbed). App data: see [os-setup.md](os-setup.md).

## For engineers
- Diagnostics → *Save report* includes the last 20 lifecycle events (`start`, `stop`, `force_stop`, `exit`, `crash`,
  `adopt`, `interrupted`, `recover`, `backup`, `runtime_install`) with machine codes only — never URLs, page titles,
  cookies or passwords.
- `process_runs` in `local.db` keeps pid, start identity, runtime version, exit code and outcome
  (`clean`, `crashed`, `early_exit`, `forced`, `interrupted`, `lost`) per run.
