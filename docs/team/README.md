# Team access and handoff (milestone 08)

One person at a time works in a shared (organization) profile. Opening it takes the profile's session lease on the
organization server; closing it saves its backup and gives it to the next person, with a note.

| Document | What it covers |
|---|---|
| [ADR-0015](../adr/0015-team-sessions-and-handoff.md) | Decisions: one authoritative lease per profile, fencing tokens, uncertain sessions, heartbeats, handoff, takeover, revocation, grant capabilities |
| [contention-test-report.md](contention-test-report.md) | Exit-gate evidence: simultaneous opens, packet loss, app crash, delayed heartbeat, stale uploads, revoked access, forced takeover; measurements |
| [recovery-playbook.md](recovery-playbook.md) | What owners, admins and the server operator do when a session is stuck, a computer is lost, access must end or work must be rescued |
| [Permission matrix](../permission-matrix.md) | Roles, scopes and the capabilities a grant carries |
| [Portability matrix](../portability-matrix.md) | What a handoff to another computer keeps (website data) and loses (sign-ins) |

## Journeys and where they live
| Journey | Desktop | API |
|---|---|---|
| Open a shared profile | Profiles → Open (the profile list's "Shared" column shows the session here) | `POST /v1/orgs/{org}/profiles/{id}/leases`, then a restore plan when this computer's copy is older |
| See who has it | Profile → "Shared with your organization"; Organization → Profiles → "In use" | `GET …/profiles/{id}/leases/current`; `in_use` in profile lists |
| Ask for it | Profile → "Ask for it…", "Withdraw request" | `POST …/handoff-requests`, `POST …/handoff-requests/{hrq}/cancel` |
| Answer a request | The request appears in the profile panel and as a notice: "Close and hand off…" or "Not now" | Delivered with heartbeats; `POST …/handoff-requests/{hrq}/decline` |
| Close and hand off | Profile → "Close and hand off…" with a note (never a password) | Closing backup under the session token (`snapshots/init` … `commit`), then `POST …/leases/{lse}/release` with `outcome: committed` and the note |
| Keep the session alive | Automatic, every 15 s | `POST …/leases/{lse}/heartbeat` |
| A handoff waits | "Handing off", "Needs attention": Try again, Give the handoff up (keeps this copy) | — (local job store) |
| Take over (owners, admins) | Organization → Profiles or the profile panel → "Take over…" (reason, warning) | `POST …/profiles/{id}/force-takeover` |
| Rescue a lost session's work | Organization → Backups → Recovery copies → "Restore as a new profile" | `GET /v1/orgs/{org}/recovery-copies`, restore plan for that snapshot |
| Decide what operators may do | Organization → Access: Open, Change settings, Restore backups per grant | `PATCH /v1/orgs/{org}/grants/{grt}` |

The handoff file names the routes `/v1/profiles/{id}/leases`, `…/heartbeat`, `…/release`, `/handoff-requests`,
`/force-takeover`; they live under the organization like every milestone 06 route.

## Where the code is
| Part | Path |
|---|---|
| Schema (leases, history, requests, capabilities, recovery copies) | `infra/db/migrations/0005_team_sessions.sql` |
| API routes and shared rules | `services/api/src/routes/sessions.ts`, `services/api/src/sessions.ts`, `routes/grants.ts`, `routes/snapshots.ts` |
| Engine: session and recovery upload modes, REST client, fake server with the same rules | `crates/sync` |
| Desktop sessions (open, restore, launch, heartbeat, lost connection, handoff, takeover, revocation) | `apps/desktop/src-tauri/src/team.rs`, `crates/storage/src/team.rs` |
| Window | `apps/desktop/src/team.tsx`, `org.tsx` (in use, takeover, access), `backups.tsx` (recovery copies) |
| Allow-list of window requests | `crates/cloud/src/allow.rs` |

## Known limitations
1. **Opening a shared profile needs the organization server.** Offline, shared profiles do not open; local profiles do.
2. **An unreachable holder blocks others** until it reconnects or an admin takes over (never a second session on
   expiry alone).
3. **A takeover cannot stop activity already happening on websites** in the old browser; it only stops what reaches the
   organization. Their unsaved work is kept as a recovery copy, never merged.
4. **Removed access does not wipe the computer.** The data already there is kept aside; device management is the
   customer's responsibility.
5. **Sign-ins do not move between computers** (milestone 07): a handoff to another computer brings website data back,
   and the next person signs in to websites again.
6. **One session per profile**, no read-only viewing of an open profile.
7. **Plans** are not enforced yet: the `team_sessions` entitlement hook exists; milestone 11 sets it per plan.
8. **The team beta is limited to the validated OS combinations** (Windows x64, macOS arm64; Linux for development).
