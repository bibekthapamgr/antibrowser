# Milestone 08 — status against the handoff file

Team access, locking and session handoff. Version 0.8.0. Decisions:
[ADR-0015](adr/0015-team-sessions-and-handoff.md). Deliverables: [contention test report](team/contention-test-report.md),
team UI, grant enforcement, [operational recovery playbook](team/recovery-playbook.md). Overview:
[team/README.md](team/README.md).

Outcome: one authorized writer per shared profile and a handoff people can follow — opening takes the profile's
session lease, closing saves its backup under that lease and only then gives it to the next person with a note;
requests never close anyone's work; a takeover is an admin action with a reason; a lost session's work is kept as a
recovery copy, never merged.

## UI flows
| Required | Implemented |
|---|---|
| Member permissions and assigned clients | Organization → Members (roles) and Access: per member, the clients and profiles shared with them and, for operators, what each grant allows (Open, Change settings, Restore backups); viewers see only |
| In-use badge | Profile list "Shared" column (Local / Shared / Open here / Handing off… / Needs attention / Taken over / Access removed); Organization → Profiles "In use" (who, which device, "not closed properly"); the profile panel |
| Request access, release profile, handoff notes | Profile → "Shared with your organization": Ask for it… / Withdraw request; requests appear to the holder with "Close and hand off…" and "Not now"; "Close and hand off…" with a note (refused when it looks like a password); the next person sees the note |
| Sync progress | "Handing off" while the closing backup uploads (Backups shows bytes and why it waits); "handoff ready" notice only after the commit |
| Revoked-access state | "Your access to this profile was removed…": closed, copy kept on this computer, Dismiss |
| Viewers cannot start a profile or download session data | Viewers' grants carry no capabilities; `profile.launch` and `snapshot.restore` are refused (`NO_ACCESS` in the app); "Put on this computer" is hidden |
| A takeover request must not secretly terminate another operator | A request only asks; a forced takeover is a separate owner/admin action with a reason and a warning dialog, audited; the holder's app says it was taken over and keeps their copy |

## Lease protocol
| Step | Implemented |
|---|---|
| 1. Acquire transactionally before a shared launch: membership, grant, entitlement, supported runtime; monotonic fencing token; expiry from DB time | `POST …/leases` under a row lock: role, scope, `launch` capability, `team_sessions` entitlement hook, browser major vs the newest backup, the caller's own device; token from `lease_fencing_seq`; `expires_at = now() + 60 s` |
| 2. Heartbeat 15 s, TTL 60 s, monotonic local timers | Desktop worker every 15 s with `Instant`-based timers (tests move the clock); server extends on the DB clock, records run state (audited on change) and returns open requests |
| 3. Download the last committed snapshot only after the lease; restore; launch; a failed launch releases | The desktop restores into a fresh folder after the lease when its copy is older (an unsynced copy is kept aside first), then launches; a failed launch or a browser that never starts releases (`failed`) |
| 4. On stop: close, verify exit, snapshot, upload, commit with the token, release; "handoff ready" after the commit | Clean exit verified by the supervisor; closing backup under the session token (no separate upload lease); release with `committed` and the note; the `handoff_ready` event follows the release |
| 5. On connectivity loss: pause mutations, controlled shutdown before expiry; server rejects stale-token writes | After 40 s without a heartbeat: phase `lost`, edits paused (`SESSION_PAUSED`), browser closed (forced at 60 s); stale tokens refused with `FENCING_TOKEN_STALE` and how the lease ended |
| 6. Never a second session on expiry alone; uncertain needs confirmed closure or an admin force takeover | An expired active session is *uncertain* (`LEASE_UNCERTAIN`); its holder revives (same token) or releases; others need a takeover |
| 7. Forced takeover increments the token, audits actor and reason; quarantine the old unsynced copy, never merge | `POST …/force-takeover` (owners/admins, reason, `confirm: true`): new token, `lease.taken_over` with reason, requests answered; the old device keeps its copy aside and uploads it as a recovery copy (never the head) |
| 8. Revocation stops API, lease and restore use and signals clients; does not erase downloaded data | Grant removal or change, role change, membership removal, device sign-out end the holder's leases (`revoked`, new token); 404/403 from then on; the app closes the profile at its next heartbeat and keeps the data aside |

## API
| Required | Implemented ([OpenAPI](openapi.json)) |
|---|---|
| `POST /v1/profiles/{id}/leases`, `/leases/{lease}/heartbeat`, `/leases/{lease}/release`, `/handoff-requests`, `/force-takeover` | Under the organization like every 06 route: `POST /v1/orgs/{org}/profiles/{id}/leases`, `…/leases/{lse}/heartbeat`, `…/leases/{lse}/release`, `GET …/leases/current`, `GET/POST …/handoff-requests`, `POST …/handoff-requests/{hrq}/decline\|cancel`, `GET /v1/orgs/{org}/handoff-requests`, `POST …/force-takeover`, `GET /v1/orgs/{org}/recovery-copies`, `PATCH /v1/orgs/{org}/grants/{grt}` |
| Handoff notes cannot include passwords | Plain text ≤ 500 characters, control characters removed, secret-looking notes refused (`NOTE_LOOKS_SECRET`) by the API and the app |
| Every upload commit, runtime metadata mutation and automation run validates the fencing token | Snapshot init and commit (re-checked by the worker at verification), heartbeats and releases; settings that travel in backups are edited inside the session; automation (milestone 10) presents the session token like any fenced write |
| Audit the acquisition/start/stop/commit/release sequence | `lease.acquired`, `session.restoring/running/stopping/uploading`, `snapshot.committed`, `lease.released` (with outcome), plus `lease.revived`, `lease.taken_over`, `lease.revoked`, `handoff.requested/answered`, `snapshot.recovery_kept`; shown in Organization → Activity |

## Permissions
| Required | Implemented |
|---|---|
| Admins assign operators only within their organization | Grants reference members, clients and profiles of the same organization (composite keys, RLS); cross-tenant sweep covers every new route |
| Operators cannot grant themselves export or share permissions | `grants.manage` is owner/admin only; capabilities are launch, edit and backup_download — export, sharing and permanent deletion are never grantable |
| Launch, config-edit, backup-download and permanent-delete are separate | Three grant capabilities checked per permission (`PERMISSION_CAPABILITY`); permanent delete stays with owners/admins ([permission matrix](permission-matrix.md)) |
| Recent authentication for sensitive export and ownership changes | Export and ownership transfer need a sign-in within 10 minutes (`REAUTHENTICATION_REQUIRED`) |

## Failure cases
| Required | Implemented |
|---|---|
| Upload fails after close: keep renewing the lease while retrying; pending handoff; abort keeps the local snapshot | The session keeps heartbeating while `handing_off`/`pending`; retries continue; "Needs attention" with Try again; "Give the handoff up" releases without uploading and keeps this computer's copy (unsynced, never overwritten later) |
| Lease lost: upload kept as an uncommitted recovery object, never overwrites canonical state | A recovery copy (`status = 'recovery'`), verified, never the head, restorable only as a separate profile by owners/admins, erased after the trash period |
| Multiple launch clicks share one operation ID | One operation per open (also while the server is slow); clicks on an open profile join it |
| Offline shared launch denied; local profiles usable | `SHARED_OFFLINE`; local profiles open as before |

## Exit gate
| Criterion | Evidence |
|---|---|
| Simulate simultaneous acquisition, packet loss, an app crash, a delayed heartbeat, stale uploads, revoked membership and a forced takeover | [Contention test report](team/contention-test-report.md) §1–7: API (20 session scenarios), desktop (7 scenarios against the in-memory server on a controllable clock), real API with two computers in CI |
| Never overwrite newer state | Every refused write is refused by the server on its token; head version unchanged in every stale-upload scenario; unsynced copies kept aside, never merged ([report](team/contention-test-report.md)) |
| Cross-device handoff follows the portability matrix | A handoff is a milestone 07 restore: website data on another computer, sign-in required ([portability matrix](portability-matrix.md), report §9) |
| Contention test report, team UI, grant enforcement, recovery playbook | Delivered (links above); UI e2e with axe in light and dark at 900×600 |

Test counts: Rust 273 across the workspace (new: desktop sessions 7, engine session modes 6, storage 1, real-API
sessions 1); API 311 (+ Keycloak and real-S3 tests in CI; new: 20 session scenarios, revocation and capability checks
in the authorization and cross-tenant suites); UI unit 30; UI end-to-end 126 (5 new team flows plus 5 new screens in
light and dark with axe); worker 7.

CI: full run green on Windows x64, macOS arm64 and Linux at `fcfcc2f`
([ci 38411582584](https://github.com/bibekthapamgr/antibrowser/actions/runs/38411582584): fmt, clippy, all Rust tests per
OS including the desktop session tests, TypeScript + PostgreSQL 18, **sync end to end with shared sessions** — run
notices "simultaneous opens from two computers: one session, the other LEASE_HELD naming the holder's device", "request
delivered by heartbeat; handoff committed version 1, then the note reached the next holder", "forced takeover: old
heartbeat fenced (taken_over), stale upload refused (head still 1), copy kept as 1 recovery copy", "access removed:
session ended (revoked), reopen and late upload refused, head still 1", "audit: 19 events for the profile" —, UI e2e
with axe, license inventory, secret scan). Installers in
[desktop internal build 38411598485](https://github.com/bibekthapamgr/antibrowser/actions/runs/38411598485); the test
server update path in [deploy scripts 38411586243](https://github.com/bibekthapamgr/antibrowser/actions/runs/38411586243).
The following commit only changes the takeover dialog's wording and documents.

## Test server
Updating with `vps-setup.sh` applies migration `0005_team_sessions.sql` and runs the session tests; nothing new to
install. Shared profiles need the SSH tunnel while open ([setup](setup.md#test-server-linux-vps)).

## Found and fixed during verification
- After a takeover, the old device's upload was refused as `LEASE_NOT_HELD` (the server looked only at the current
  lease), so the device would have waited instead of stopping; the real-API contention test found it. A stale token now
  gets `FENCING_TOKEN_STALE` with how its lease ended.
- Opening a linked profile used to leave an earlier queued backup waiting; the session's closing backup now replaces
  it, and "Upload backup now" during a session points to the handoff instead of taking a second lease.
- Two copies kept aside in the same second collided on the folder name; evidence folders now get distinct names.

## Known limitations
See [team/README.md](team/README.md#known-limitations): opening shared profiles needs the server; an unreachable holder
blocks others until an admin takes over; a takeover cannot stop website activity already happening in the old browser;
removed access does not wipe a computer; sign-ins do not move between computers; plans are not enforced yet.

## Release
Team beta boundary reached on the validated OS combinations (Windows x64, macOS arm64): cloud sync and handoff with
lease-controlled opening. Still internal builds without signing certificates (owner action, milestone 12 updater).
