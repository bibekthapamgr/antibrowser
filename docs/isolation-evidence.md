# Profile isolation — test evidence (milestone 03)

What this proves: **separate profiles keep separate browser storage**, a profile's own storage survives restarts and
crashes, and the manager never mixes up two profiles' processes. What it does **not** prove: OS-level isolation from
hostile code, or that two profiles look like different devices or networks to a website (separate browser data is
not a separate identity; see the roadmap's release boundaries).

## How it is tested
`apps/desktop/src-tauri/tests/browser.rs` drives the manager's real start/stop/supervisor code (`AppState`, the real
process launcher and process inspector) against a real Chromium. A local HTTP server on `127.0.0.1` serves one page
(the controlled origin) that writes or reads:

| Storage | How the page uses it |
|---|---|
| Cookie | `document.cookie = pb_iso=<tag>` (1-day expiry; stored in Chromium's encrypted cookie database) |
| localStorage | `localStorage.pb_iso` |
| IndexedDB | database `pb`, store `kv`, key `pb_iso` |
| Cache Storage | cache `pb`, entry `/pb-cached` |
| Service worker | `/sw.js` registered and active |

The page POSTs what it saw back to the test server, so the assertions use what the website itself can observe.

| Test | Steps | Pass condition |
|---|---|---|
| `storage_is_isolated_between_profiles_and_survives_restart` | A writes all five; A closes; B opens the same origin; B closes; A reopens | B sees **none** of A's data; A sees all of it after the restart; no `DevToolsActivePort` file and no `--remote-debugging*` / `--no-sandbox` switch on the browser; close recorded as clean |
| `a_crash_is_reported_and_never_attached_to_another_profile` | A writes; A reopens and its browser is hard-killed; B starts | A is `CRASHED`; B gets a new process and none of A's data; A stays `CRASHED` (not attached to B's run); reopening A keeps its data |
| `repeated_launch_requests_start_one_browser` | Five concurrent launch requests for A | One operation id for all five, exactly one browser main process |
| `ten_launch_close_cycles_stay_clean` | Ten open → count → graceful close cycles | Every run `clean`, Chromium's own exit record says orderly shutdown, no browser left after each close, the counter reaches 10 (data kept) |
| `portability_spike` | See [portability-matrix.md](portability-matrix.md) | Same machine, new folder: localStorage + IndexedDB kept (asserted) |

The "no debug endpoint" check is also enforced before launch: `crates/runtime/src/launch.rs` refuses any
`remote-debugging` switch and only five allow-listed extra switches exist (unit tests in the same file).

## Results
Chrome for Testing **155.0.8059.39** (stable on 2026-10-12), installed by the manager's own installer (digest, safe
extraction, executable check), on GitHub-hosted runners.

| Platform | Runner | Result | Run |
|---|---|---|---|
| Windows x64 | `windows-latest` | 5/5 passed (incl. cookie persistence after restart) | [38315660017](https://github.com/bibekthapamgr/antibrowser/actions/runs/38315660017) |
| macOS arm64 | `macos-14` (Apple Silicon) | 5/5 passed (incl. cookie persistence after restart) | [38315660017](https://github.com/bibekthapamgr/antibrowser/actions/runs/38315660017), 38281685691 |
| Linux x64 (development only) | `ubuntu-24.04`, `--ozone-platform=headless` | 5/5 passed | [38315660017](https://github.com/bibekthapamgr/antibrowser/actions/runs/38315660017), 38281685691 |
| Linux x64, local sandbox | Chromium 141.0.7390.37, non-root user | 5/5 passed after the backup-cancel fix (103 s) | — |

The Linux graceful close is `SIGTERM`, which Chromium treats as a session end and may drop cookie writes from the
last ~30 seconds; the Linux tests wait before closing and do not assert cookie persistence. Windows (`WM_CLOSE`) and
macOS (`NSRunningApplication.terminate`) use the browser's normal quit, and cookie persistence is asserted there.

## Bugs these tests found (fixed)
| Found | Problem | Fix |
|---|---|---|
| Local Linux | The process list included threads, so one browser looked like 27 | Threads filtered out of process snapshots |
| Local Linux | A quick kill left a stale "clean" exit record | The process exit status decides; the record is only used when no status exists |
| Local Linux | A stop-requested exit was labelled "early exit" | Early-exit rule applies only when no stop was requested |
| Windows CI | The browser environment allow-list was case-sensitive (`SystemRoot`, `Path`), so Chromium started without them | Case-insensitive allow-list |
| Windows CI | The browser inherited the test step's output pipe, so the step never finished | Output goes to a file; the test harness force-closes leftover browsers |
| Local Linux + Windows CI | Re-opening right after a close failed with "profile busy" while the automatic backup ran | Opening a profile cancels a routine backup (previous copy kept); `backup_now` joins a running backup |
| Windows CI | Chromium's sandboxed network service could not read the browser folder ("Sandbox cannot access executable") and restarted in a loop, so no page loaded (found with Chromium's own log) | The installer grants Windows app sandboxes read access to the runtime folder, as Chrome's installer does; sandbox stays on |
| Windows CI | Closing the whole process tree (`taskkill /T`) did not close Chromium within 10 s | The close request goes to the browser main process only |
| Windows CI | Profile folders were passed to Chromium as Windows "verbatim" paths (`\\?\C:\...`, what `canonicalize` returns) | Paths converted to the ordinary form when it names the same file (`simplify_path`) |
