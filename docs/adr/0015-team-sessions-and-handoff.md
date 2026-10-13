# 0015 — Team sessions, locking and handoff
Status: **Accepted (beta track)**. Date: 2026-10-13. Owner: technical lead + backend lead. Builds on ADR-0013
(roles, grants, tenant isolation) and ADR-0014 (fenced uploads, snapshots) for milestone 08.

## Context
Milestone 07 made organization profiles backed up and restorable, with fenced uploads (one winner per version) but no
control over who may *open* a shared profile: two people could work in copies of the same profile and only find out
at upload time. Milestone 08 requires one authorized writer per shared profile, an understandable handoff between
operators, and safe behaviour when connections drop, apps crash, access is removed or an administrator has to step in.
A takeover request must never secretly close someone else's work, and newer state must never be overwritten.

## Decision
### One authoritative lease per profile
`profile_leases` (one row per profile, PostgreSQL) is the only authority. Each acquisition gets a new lease id
(`lse_…`) and a new fencing token from `lease_fencing_seq` (monotonic, 64-bit, decimal string in JSON). A lease has a
**purpose** (`session`: the browser runs on that device; `upload`: a milestone 07 backup of a closed profile) and a
**state**: `active`, `released`, `taken_over`, `revoked`, `superseded`. Expiry is judged by the database clock only
(`expires_at = now() + ttl`); device clocks are never trusted.

| Situation | Rule |
|---|---|
| Live | `state = 'active' and expires_at > now()` |
| Uncertain | An **active session** lease whose expiry passed without a release. Its browser may still be open, so nobody else may open the profile. The holder confirms closure (a heartbeat revives the same lease and token; a release ends it), or an owner/admin forces a takeover. Never a second session on expiry alone |
| Upload lease expired | Simply free again (as in milestone 07) |
| Ended by someone else (takeover, revocation) | `released_at` set, **a new fencing token is allocated**, so everything the old holder still sends is refused (`FENCING_TOKEN_STALE` with how its lease ended) |
| Same device acquires again | Its own earlier lease becomes `superseded` (a crashed app reopening) |

`lease_history` keeps every acquisition (token, holder, device, how it ended) for recovery uploads and the audit.

### Protocol (handoff file steps 1–8)
1. **Acquire** (`POST /v1/orgs/{org}/profiles/{id}/leases`, Idempotency-Key, row lock on the profile): membership,
   role permission `profile.launch`, a grant with the `launch` capability for granted scopes, the plan entitlement
   (`team_sessions`, milestone 11 sets plans; a disabled entitlement refuses with `ENTITLEMENT_REQUIRED`), a supported
   runtime (the device's browser major must not be older than the newest backup's: `RUNTIME_TOO_OLD`), the device must
   be the caller's own active device. Answers the lease, the note left by the previous holder and the newest version.
   `LEASE_HELD` / `LEASE_UNCERTAIN` name the holder and device.
2. **Heartbeat** every 15 s, TTL 60 s (`SESSION_LEASE`), monotonic timers on the device. The heartbeat reports the
   browser's run state (`restoring`, `running`, `stopping`, `uploading`; changes are audited as `session.<state>`) and
   returns open access requests addressed to the holder.
3. **Restore before launch**: the desktop downloads the newest committed snapshot only after the lease is held,
   restores it into a fresh folder (milestone 07 switch) and launches. If this computer had unsynced changes and a
   newer version exists elsewhere, its copy is **kept aside** (evidence folder), never merged. A failed launch, or a
   browser that exits before it finished starting, releases the lease (outcome `failed`).
4. **Stop and hand off**: the browser closes; the exit must be clean (verified by the supervisor); the closing backup
   is sealed and uploaded **under the session's fencing token** (no separate upload lease), committed, and only then is
   the lease released with outcome `committed` and the handoff note. "Handoff ready" is shown only after the commit.
5. **Connection loss**: without a successful heartbeat for 40 s the desktop pauses edits and closes the browser
   gracefully (forced after 60 s), well before the lease could run out on the server. The closing backup continues
   when the connection is back (a heartbeat revives the lease if it expired meanwhile and nobody took it).
6. **No second session on expiry alone** (uncertain, above).
7. **Forced takeover** (`POST …/force-takeover`, owners and admins, `lease.force_release`, reason required,
   `confirm: true`): the token is incremented, actor and reason are audited, open requests are answered. The old
   device's heartbeat is fenced (`taken_over`); its app closes the browser, keeps its copy aside and uploads it as a
   **recovery copy** (`snapshot_manifests.status = 'recovery'`, never the head, restorable only as a separate profile by
   owners and admins, erased after the organization's trash period). Nothing is merged.
8. **Revocation** (grant removed or reduced, role change, membership removal, device signed out): the holder's
   leases end as `revoked` with a new token; API, lease and restore use stop at once (404/403); the app is told at its
   next heartbeat and closes the browser. Data already on that computer is **not erased** (kept aside there).

### Requests and notes
`handoff_requests`: one open request per requester and profile, addressed to the current holder, expiring after 4 h;
`declined`, `canceled`, `fulfilled` (release or takeover), `expired`. A request never closes anything by itself; the
holder chooses "Close and hand off" or "Not now". Handoff notes and request notes are plain text up to 500 characters;
notes that look like passwords, keys, tokens or card numbers are refused by the API (`NOTE_LOOKS_SECRET`) and by the
app before sending (shared `secretHint`).

### Fenced writes
Every write that changes a shared profile's runtime state presents the fencing token: snapshot init and commit (the
worker re-checks the token at verification), heartbeats, release. A stale token is refused with
`FENCING_TOKEN_STALE` and `safe_details.state` (how that lease ended), so a device stops instead of retrying. A
recovery upload presents the lost token and is accepted only as a recovery copy, only from the device that held it.
Profile metadata edits (name, notes, client) are organization-level and versioned (If-Match), not fenced; settings
that travel in backups are edited on the device inside the session and need the `edit` capability. Automation
(milestone 10) will present the session's token like any other fenced write.

### Permissions
Grant **capabilities** separate what an operator may do with the profiles a grant covers: `launch` (open, including
the session's closing backup), `edit` (configuration) and `backup_download` (restore). Viewers' grants carry none
(viewers cannot open a profile or download session data). Permanent deletion, export and sharing are never grantable:
they stay with owners and admins. Admins assign grants only within their organization (composite keys, RLS);
operators cannot grant themselves anything (`grants.manage` is owner/admin). Export and ownership changes need a
sign-in within 10 minutes (`REAUTHENTICATION_REQUIRED`). Changing a grant ends the sessions it no longer allows.

### Desktop
The shell holds the lease id and fencing token (SQLite `team_sessions`, never in the window, never logged); the window
sees phases: `opening`, `running`, `closing`, `handing_off`, `pending` (waiting for a decision: upload failed or
canceled, the browser did not close normally, conflict), `lost`, `taken_over`, `revoked`. Repeated clicks join one
operation. An app killed mid-open replays the open with its idempotency key at start-up and releases it. Offline,
shared profiles do not open (`SHARED_OFFLINE`); local profiles work as before.

## Consequences
- Opening a shared profile needs the server (by design). A team that works offline keeps local profiles.
- An unreachable holder blocks others until it comes back or an admin takes over; this trades availability for never
  overwriting work (a deliberate choice, explained in the app and the recovery playbook).
- A takeover cannot stop activity already happening on websites in the old browser; it only fences what reaches the
  organization. The dialog says so.
- Cross-device handoff carries website data but not sign-ins between computers (milestone 07 portability matrix); the
  app labels it.

## Evidence / verification
- API: `services/api/test/sessions.test.ts` (20 scenarios), `authorization.test.ts`, `cross-tenant.test.ts` (every new
  route), permission matrix.
- Engine: `crates/sync/src/tests.rs` (session mode, recovery mode, fenced and lost leases).
- Desktop: `apps/desktop/src-tauri/tests/team.rs` (7 scenarios: contention, repeated clicks, offline, packet loss,
  delayed heartbeat, app restart and crash, killed mid-open, stale upload, takeover, revocation, unsynced copy kept
  aside), `tests/sync.rs`.
- Real API, two devices: `crates/sync/tests/real_api.rs` `sessions_against_the_real_api` (CI "sync end to end").
- [Contention test report](../team/contention-test-report.md), [recovery playbook](../team/recovery-playbook.md).

## Revisit when
Remote browser hosting (session runs on our servers), concurrent read-only viewing, per-site handoff, or plan limits on
sessions (milestone 11) are introduced.
