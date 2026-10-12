# Spike 01-5 — Launch IPC rejects invalid profile/path requests before any process starts

**Result: passed** on 2026-10-12 (`cargo test -p pb-desktop`). Code: `apps/desktop/src-tauri/src/ipc_spike.rs`.

## Method
The tests build the real Tauri application with Tauri's mock runtime: the generated context, the real capability file (`capabilities/default.json`) and ACL, and the real argument deserialization. Requests are sent through `get_ipc_response` exactly as the webview would send them. The process launcher is replaced with a counter.

## Results
| Request | Rejected where | Processes started | Directories created |
|---|---|---|---|
| 14 malformed `profileId` values: `../../../../etc/passwd`, absolute paths, `C:\Windows\System32`, UNC path, `prf_../..`, trailing slash, lowercase, `file://` URL, empty, number, null, object, array, missing | IPC argument deserialization (`ProfileId` type); the command body never runs | 0 | 0 |
| Well-formed id not present on this device | Command validation: `UNKNOWN_PROFILE` | 0 | 0 |
| Known profile with `file://`, `javascript:` or a `--switch` as start URL | Command validation: `BAD_START_URL` | 0 | 0 |
| Valid request that also sends `executable: "/bin/sh"` and `args` | Extra fields ignored; the trusted configured browser is launched | 1 (the trusted browser) | 1 |
| Second launch of a running profile | `ALREADY_RUNNING` | still 1 | — |
| Commands outside the capability (`plugin:shell|execute`, `plugin:fs|read_file`, `plugin:http|fetch`, unknown) | Tauri ACL | 0 | 0 |
| Labels like `../../escape` | Stored as display text; directory name is the generated id | 0 | 0 |

Errors returned to the UI are a stable code plus a fixed message, never a path, SQL or OS error text.

## Supporting unit tests
- `crates/runtime`: id grammar (including full-width characters, NUL, wrong prefix), symlinked profile directory refused, no directory created for a rejected launch, relative browser path refused.
