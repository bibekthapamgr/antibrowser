# R3 — status against the handoff file

Unified desktop profiles and simple team sharing (revised roadmap). API 0.15.0.
- **Decisions:** [ADR-0022](adr/0022-unified-profiles-and-team-sharing.md) (supersedes ADR-0020's "folders never grant"
  with an explicit, previewed folder rule).
- **Deliverables:**
  - updated desktop build (`apps/desktop`: `workspace.tsx`, `team-access.tsx`, `App.tsx`; shell `src-tauri/src/unified.rs`);
  - migration evidence: [r3/migration-evidence.md](r3/migration-evidence.md);
  - screen map: [r3/screen-map.md](r3/screen-map.md);
  - role and grant tests: [r3/grant-tests.md](r3/grant-tests.md);
  - documentation: this file, the [permission matrix](permission-matrix.md), the
    [API changelog](automation/api-changelog.md) 0.15.0, OpenAPI and IPC schemas.

**Outcome.** The app opens on Profiles of the person's workspace. A profile is one row whether or not it is on this
computer; New profile asks only for a name (folder and proxy optional); opening uses the existing lease and restore path.
Team invites in one previewed step and grants exactly what was chosen; a Member opens and uses only.

## Build in order

| Step | Done |
|---|---|
| 1. Navigation Profiles, Proxies, Team, Subscription, Settings; profile count / plan usage; billing by role | Yes. "N profiles of M on your plan" on Profiles (M for roles that read billing); seats on Team; Subscription managed only with `billing.manage`, read with `billing.read`, others see who manages it. |
| 2. One active-workspace context; switching changes list and permissions; stale requests cancelled; no flash | One switcher (account workspaces + This computer). Content keyed by workspace; every load checks it is current; the previous workspace's data is dropped at the switch. e2e: a mutation observer sees no old row. |
| 3. Create Profile: name, optional folder and proxy; no client/org/grant/server setup | Yes (`POST …/profiles` with `folder_id`, then `workspace_profile_prepare` with the local proxy). |
| 4. Merged rows via the R1 mapping; seven statuses; never duplicate | `workspace_copies` (links + first downloads) → one row per workspace profile; Available / Downloading / Running / In use by teammate / Sync pending / Sign-in needed / Recovery needed. |
| 5. Start through lease/download/restore/start; Stop through clean close/snapshot/commit/release | `workspace_profile_open` → prepare → `launch_profile` → `launch_shared`; a download opens by itself when complete. Close = `stop_profile` (closing backup, then release). |
| 6. Team: members, pending invitations, permissions; invite wizard; Member = open/use only; granular grants stored | `TeamScreen`, `InviteWizard` (e-mail → preset → scope → server preview → send), `MemberAccessDialog`; presets map to role + grants; detailed per-grant view kept. |
| 7. Folder grants for future profiles only when explicit and previewed; move shows access impact; deny without grant management; one definition of effective access | `folder_id` / `all_profiles` grants with "also profiles added later"; otherwise ids now. `folder-impact` before a move; 403 without `grants.manage`; `grantCovers` used by API, leases, automation and tokens. |
| 8. Invited member opens the assigned team automatically; seats from the workspace plan | After joining, the joined workspace opens on its Profiles. Seats counted on the workspace (R2 seat check at acceptance). |
| 9. Diagnostics/updates/extensions/developer tools under Settings; backups in profile details + workspace backup settings; critical warnings always visible | Settings tabs; Workspace tab (Backups, Extension policy, Developer tools, Activity); Details opens the profile's own backups; reconnect/update/billing banners and notifications on every screen. |
| 10. Client/task module behind Agency tools; stale milestone copy and internal ids out of routine screens | *Agency tools* only where clients are used; role names Member / Billing manager; "Internal build" → "Version"; no ids on the new screens. |

## Local-only compatibility
Local-only profiles stay under **This computer**, labelled, never uploaded unless moved with *Move profiles into a
workspace…* (R1 plan → opt-in → quota → move, optional encrypted backup; re-running never duplicates). Existing data is
kept and not counted twice. Signed-out first run creates a local container silently; the account path is one button.
Browser execution is local in every case and the list says so. Local mode never opens a shared profile offline.

## Permissions and lifecycle
Revoking access or moving a profile out of someone's reach ends their session (lease revoked; their app closes the
profile and keeps the data aside — no remote erasure claimed). One writer at a time (ADR-0015 unchanged); portability
shown as *Sign-in needed*. Viewer and billing restrictions unchanged; the last owner cannot be removed; workspace owners
are not platform staff.

## Acceptance

| Criterion | Evidence |
|---|---|
| Fresh user reaches Create Profile without organization/client setup | e2e "a fresh user signs up and reaches Create Profile…" |
| Owner shares exactly 10 of 50; teammate sees/opens only 10 | API `team.test.ts` (end to end through invitation acceptance and leases); e2e wizard preview and the Member's view |
| Member has no billing-management/export authority by default | API "a Member can open and use by default…"; e2e Member view |
| Workspace switch does not leak rows/status | e2e "switching workspaces never shows the previous workspace's rows" |
| Linked profile appears once and opens prior session | e2e; Rust `sync.rs` `opening_a_workspace_profile_here_restores_it_once_and_then_opens_it` |
| Recoverable UI: network failure, lease collision, disk full, interrupted restore, pending sync | e2e (in use → Ask for it; offline → marked copy or Try again); statuses *Recovery needed* / *Sync pending*; earlier suites for disk warning, interrupted restore and pending handoff ([grant tests](r3/grant-tests.md)) |
| Mac Apple Silicon and Windows x64 | Same commands and lease path; CI full-OS run (`ci.yml` on macOS arm64 and Windows x64) |
| Keyboard/accessibility and small screens | axe (light/dark) at 900×600 with no horizontal scroll on eight R3 screens; dialogs trap focus and return it |

## Verification
- API: 582 passed, 13 skipped (`team.test.ts` 9 incl. folder create/filter; cross-tenant swap list extended).
- Worker: 25 passed.
- Rust: clippy clean; workspace tests green (new: `account.rs` empty linked copy, `sync.rs` open-restores-once,
  `allow.rs` R3 routes).
- Desktop e2e: 181 classic (rollback switch) + 7 R3 flows + 16 R3 accessibility checks.

## Deploying to the test server
Nothing to run now: as agreed, every server update (migration `0014_team_sharing.sql` included) is applied together at
the end of the revised roadmap with one consolidated list.

## Not in R3 (by design)
- Removing the earlier screens: after the parity period, in one change (ADR-0022 consequences).
- Website checkout and portal pages: R4. Business-owner admin: R5. Public hostnames and residual security items: R6.
