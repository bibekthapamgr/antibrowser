# Contention test report (milestone 08)

Exit gate: *simulate simultaneous acquisition, packet loss, an app crash, a delayed heartbeat, stale uploads, revoked
membership and a forced takeover. Never overwrite newer state. Cross-device handoff follows the portability matrix.*

Every scenario runs at three levels: the API against PostgreSQL 18 (`services/api/test/sessions.test.ts`), the desktop
app (real IPC commands, SQLite, profile folders and a fake process table) against an in-memory server with the API's
rules on a controllable clock (`apps/desktop/src-tauri/tests/team.rs`), and the desktop's engine and HTTP client on two
"computers" against the real API, worker and S3 storage (`crates/sync/tests/real_api.rs`,
`sessions_against_the_real_api`, CI job "sync end to end"). Timings: heartbeat 15 s, lease 60 s past the last
heartbeat (database clock), browser closed after 40 s without a heartbeat, forced after 60 s.

Result: **no scenario overwrote newer state or merged copies.** Every refused write was refused by the server on its
fencing token, not by the client's good behaviour.

## 1. Simultaneous acquisition
| Level | What happens | Result |
|---|---|---|
| API | 12 concurrent upload-lease acquisitions (`leases.test.ts`, milestone 01) and 20 concurrent session opens from two people (`sessions.test.ts`) | Exactly one lease; the others `409 LEASE_HELD` naming the holder and device; tokens strictly increase |
| Real API, two computers | Both open the same profile at the same moment (two threads) | One session; the other `LEASE_HELD` "Owner laptop" |
| Desktop | A opens; B clicks Open | B's operation fails `PROFILE_IN_USE_ELSEWHERE`; B's window names A's device; the refused open took nothing (A's token unchanged) |
| Desktop | Two clicks while the server is slow | One operation id, one `open_session` call, one browser; a click on the open profile joins it |

## 2. Packet loss
| Level | What happens | Result |
|---|---|---|
| Desktop | Heartbeats fail for 15 s, 30 s, 45 s | At 45 s (≥ 40 s) the phase becomes `lost` and the browser is closed; the server still sees the lease (45 s < 60 s), so nobody else could open it meanwhile (B refused `PROFILE_IN_USE_ELSEWHERE`); once connected the closing backup commits under the same token and the lease is released |
| Desktop | The closing backup's parts fail to upload | The job waits (`STORAGE_OFFLINE`), the session stays `handing_off` and keeps the lease; it commits when storage is back |
| Desktop | Open request's answer lost after the server granted the lease | The open fails `SHARED_OFFLINE`; the next open from the same computer supersedes its own lease (new token) |
| Engine | Connection lost before/after each upload call (milestone 07 engine tests; a session's closing backup goes through the same steps with the session's token) | Resumes; commits once |

## 3. App crash
| Level | What happens | Result |
|---|---|---|
| Desktop | The app quits while the browser keeps running; restarted | The browser is re-attached, the session resumes under the same lease and token, heartbeats continue, the handoff commits |
| Desktop | The re-attached browser crashes (no clean exit record) | Phase `pending` (`PROFILE_CLOSED_UNCLEANLY`); nothing is uploaded; heartbeats keep the lease (5 periods checked); "Try again" is refused (`SESSION_NEEDS_REOPEN`); reopening runs under the same token; the normal close commits |
| Desktop | Killed while an open was on its way (lease granted, answer never stored) | At start-up the open is replayed with its idempotency key, the lease learned and released |
| Desktop | A browser that never finishes starting | The launch fails (`EXITED_EARLY`), the lease is released (outcome `failed`), nothing is uploaded |

## 4. Delayed heartbeat (uncertain session)
| Level | What happens | Result |
|---|---|---|
| API | The holder's lease expires without a release | `LEASE_UNCERTAIN` for everyone else (never a second session on expiry alone); the holder's heartbeat revives the same lease and token; its release after expiry is accepted (it confirms its browser closed) |
| Desktop | Heartbeats fail; the server's clock passes the 60 s lease | B refused `PROFILE_SESSION_UNCERTAIN`; A's closing backup does not commit on the expired lease (waits); A's next heartbeat revives the lease (same token); the backup commits; B then opens with A's version |

## 5. Stale uploads
| Level | What happens | Result |
|---|---|---|
| API | Init and commit with a token from an ended lease; a takeover between commit and verification | `409 FENCING_TOKEN_STALE` with `safe_details.state` (`taken_over`, `revoked`, `superseded`); the worker re-checks the token at verification, so the old upload fails and the new holder's version wins |
| Real API | After a forced takeover, the old holder uploads its closing backup | Refused `LEASE_TAKEN_OVER` (from `FENCING_TOKEN_STALE`); head unchanged (version 1) |
| Desktop | Taken over after the browser closed, before the closing backup committed | Upload fails `LEASE_TAKEN_OVER`, the session becomes `taken_over`, the copy is kept aside and uploaded as a recovery copy; head and committed versions unchanged |
| Desktop | A computer with unsynced changes opens after someone else committed | Its copy is kept aside (`unsynced-before-restore`), the newest version is put in place, its own closing backup builds on that version |
| Desktop | Handoff given up, then backed up later from a stale base | `VERSION_CONFLICT`; nothing overwritten; three choices (milestone 07) |

## 6. Revoked membership and access
| Level | What happens | Result |
|---|---|---|
| API | Grant removed, capability `launch` removed, role lowered, membership removed, device signed out everywhere | The holder's lease ends `revoked` with a new token; heartbeats and fenced writes refused; reopen `NOT_FOUND`/`FORBIDDEN`; audited with the admin who made the change |
| Real API | The owner removes the operator's grant during a session | Heartbeat refused, reopen refused, late upload refused, `leases/current` empty, head unchanged |
| Desktop | Access removed during a session | Phase `revoked` (`ACCESS_REMOVED`), the browser is closed, the data is kept aside on this computer (not erased, not uploaded); after dismissing, opening is refused `NO_ACCESS` |
| Desktop | An operator without `edit` | Settings that travel with backups are refused (`NO_EDIT_CAPABILITY`); favourite/notes still allowed |

## 7. Forced takeover
| Level | What happens | Result |
|---|---|---|
| API | An admin takes over an active and an uncertain session with a reason | New token; `lease.taken_over` audited with actor and reason; open requests answered; operators cannot (`403`) |
| Real API | The owner takes over the operator's session | Old heartbeat fenced `taken_over`; stale upload refused; recovery upload with the old token accepted as **1 recovery copy**, never the head |
| Desktop | Taken over while open | Phase `taken_over`, the browser closed, edits paused (`SESSION_PAUSED`), reopen refused until dismissed (`SESSION_ENDED`), copy kept aside and uploaded as a recovery copy (`RECOVERY_COPY_KEPT`); after dismissing, the profile opens from the newest backup |
| Window | The takeover dialog | Requires a reason and "I understand their unsaved changes are not merged"; says the other browser may still be open and that website activity there cannot be stopped |

## 8. Audit of the sequence
Real API: the profile's audit trail contains acquisition, the request, release, takeover and revocation (19 events in
the CI run [38411582584](https://github.com/bibekthapamgr/antibrowser/actions/runs/38411582584)), plus the run-state changes (`session.restoring`, `session.running`, `session.stopping`,
`session.uploading`), commits (`snapshot.committed`) and recovery copies (`snapshot.recovery_kept`).

## 9. Cross-device handoff
A handoff is a milestone 07 restore of the closing backup on the next computer. Same computer: website data and
sign-ins. Another computer: website data, sign-in required (cookies protected by Windows DPAPI or the macOS Keychain do
not move) — labelled per the [portability matrix](../portability-matrix.md), validated on Windows x64 and macOS arm64
(and Linux) in the runtime pipeline. The team beta is limited to those combinations.

## Measurements
Local development container (2 vCPU Xeon 2.1 GHz, PostgreSQL 16, API and client on the same machine, so no network
latency), 20 sessions with 10 heartbeats each:

| Request | Median | p95 |
|---|---|---|
| Open (acquire) | 13.8 ms | 168.1 ms (first requests warm the pool) |
| Heartbeat | 9.3 ms | 21.0 ms |
| Release | 9.2 ms | 26.6 ms |

Not a capacity claim (milestone 13 measures load). The time a handoff takes is dominated by the closing backup
(sealing and uploading, [milestone 07 report](../sync/backup-restore-report.md)) and, on the next computer, the restore.
