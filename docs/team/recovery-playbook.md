# Recovery playbook: shared sessions (milestone 08)

For owners and admins of an organization, and for whoever runs the organization server. Every situation below keeps
one rule: **nothing is overwritten and nothing is merged.** When in doubt, keep copies and compare.

Where to look:
- **Organization → Profiles**, "In use" column: who has each profile open, on which device, and whether that session
  ended without closing ("not closed properly").
- **Profile → Shared with your organization** (in the member's app): the session on that computer.
- **Organization → Activity**: opens, closes, requests, takeovers, removed access, recovery copies.
- **Organization → Backups → Recovery copies**: copies kept from computers that lost their session.

## 1. "Someone else has this profile open"
Normal. Ask for it ("Ask for it…" in the profile's panel); the holder sees the request and decides when to hand off.
Nothing closes by itself. If the holder is away for longer, see 3.

## 2. "Session not closed properly" (uncertain)
The holder's computer stopped answering (asleep, offline, app killed, crashed) without releasing the profile. Its
browser may still be open, so nobody else can open it.
1. Ask the holder to open the app on that computer. Their app reconnects, the session continues or hands off.
2. If that is not possible (laptop lost, person unavailable): an owner or admin uses **Take over…** (3).

## 3. Forced takeover (owners and admins)
Organization → Profiles → **Take over…**, or the same button in the profile's panel.
1. Write a reason (recorded in Activity, shown to the holder) and confirm that their unsaved changes are not merged.
2. Their session ends: their app closes the profile at its next heartbeat, keeps their copy aside on that computer and
   uploads it as a **recovery copy**. Anything they have not saved to the organization stays out of the shared profile.
3. The profile can be opened right away; it opens from the newest backup.
4. A takeover cannot stop activity already happening on websites in the old browser (for example a form being sent).
   If that matters, also contact the person or change the website account's password.

## 4. Rescuing work from a recovery copy
Organization → Backups → Recovery copies → **Restore as a new profile**. It becomes a separate local profile on your
computer ("… (recovery copy)"), not shared and not linked. Compare it with the shared profile and copy what is needed
by hand (for example finish the half-done task). Recovery copies are erased after the organization's trash period.

## 5. A handoff that does not finish
In the member's app the profile shows **Handing off** or **Needs attention**:
| Message | Meaning | What to do |
|---|---|---|
| Connection lost | The browser was closed before the lease could run out; the closing backup continues when the connection is back | Reconnect; it finishes by itself ("Try again now" to hurry it) |
| The closing backup did not finish / was canceled | Upload failed or the person canceled it | "Try again". The profile stays theirs meanwhile |
| The browser did not close normally | Crash: nothing was uploaded | "Open again" (the browser recovers its pages), then close and hand off |
| A newer version exists | Should not happen under a session; a sign of an earlier given-up handoff | "Give the handoff up", then resolve in Backups (keep mine / use newer / open as copy) |

**Give the handoff up** frees the profile without uploading: the organization keeps its newest backup, and this
computer keeps its copy with the changes (unsynced). If someone else then works and saves a newer version, the next time
this computer opens the profile its unsynced copy is kept aside first (never merged), so nothing is lost.

## 6. Access removed
Removing a grant, the `Open` capability, a membership, or signing out a device everywhere ends that person's sessions
immediately on the server. Their app closes the profile at its next heartbeat and keeps the data already on that
computer aside (it is not erased). If that data must not stay there, handle the device itself (OS account, disk
encryption, device management); the product does not remotely wipe computers.

## 7. A computer is lost or stolen
1. Account → Devices (theirs) or an admin removing the member: sign the device out. Its sessions end as revoked.
2. If a session was open, the profile shows as free after that; open it from the newest backup.
3. Website sign-ins of profiles that were on that computer: change the passwords of the website accounts concerned.

## 8. The organization server is down
Shared profiles do not open while the server cannot be reached (by design: there is no way to know nobody else has
them). Profiles already open keep running until their lease could run out: after 40 s without a heartbeat the app closes
them and keeps everything on the computer; the closing backup finishes when the server is back. Local (not shared)
profiles work as usual. Restore the server (milestone 07 runbook) and members reconnect by themselves.

## 9. Server operator checks
```sql
-- Sessions right now (uncertain = active and expired).
select profile_id, purpose, state, device_name, run_state, acquired_at, heartbeat_at, expires_at,
       expires_at <= now() as uncertain
  from app.profile_leases where state = 'active' order by acquired_at;
-- How a profile's sessions ended.
select fencing_token, holder_user_id, holder_device_id, acquired_at, ended_at, end_state, end_reason
  from app.lease_history where profile_id = '<prf_…>' order by acquired_at desc limit 20;
-- Recovery copies.
select id, profile_id, created_by, committed_at from app.snapshot_manifests where status = 'recovery';
```
Never edit `profile_leases` by hand; use the takeover in the app (it allocates a new fencing token and audits it).
Updating the server applies migration `0005_team_sessions.sql` (run `vps-setup.sh`; see [setup](../setup.md)).
