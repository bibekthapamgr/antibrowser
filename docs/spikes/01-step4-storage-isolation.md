# Spike 01-4 — Storage isolation between profile directories

**Requirement (milestone 01, step 4):** launch two sandboxed Chromium instances with distinct directories; set a test cookie/localStorage/IndexedDB value in A and prove B cannot read it on a controlled origin.

**Result: passed** on 2026-10-12, Linux harness (headless Chromium 153.0.8010.0, sandbox on, non-root user). Script: `spikes/src/isolation.ts`. Raw output: [results/isolation-report.json](results/isolation-report.json).

## Method
- A local HTTP server on `127.0.0.1` is the controlled origin. Its page writes a value to a persistent **HttpOnly cookie** (set by the server, invisible to script), **localStorage**, and **IndexedDB**, and reads them back (the cookie via a server echo of the `Cookie` header).
- Browsers A and B run **at the same time** with separate `--user-data-dir` directories; values are random per run.

## Checks
| Check | Result |
|---|---|
| Two concurrent browser processes with different PIDs | Pass |
| A reads back its own cookie, localStorage and IndexedDB | Pass |
| B, on the same origin at the same time, reads null for all three | Pass |
| B never sends A's cookie in any request header | Pass |
| After B writes its own values, A still sees only A's values | Pass |
| After restarting both, each directory still holds its own values | Pass |

## Observation that changes the plan
| Observation | Result | Consequence |
|---|---|---|
| A second browser process started on A's directory while A was running | **The browser allowed it** | Two writers on one profile can corrupt it. The manager must take an exclusive per-profile OS lock before launch and keep it for the process lifetime (**milestone 03 requirement**). Process tracking alone is not enough. |

## What this does not show
- It shows separation of **stored data** only. It says nothing about device or network signals, and the product must not claim otherwise.
- It has not yet run on Windows 11 or macOS with the chosen runtime (ADR-0001). Re-run there before 03 is delivered.
