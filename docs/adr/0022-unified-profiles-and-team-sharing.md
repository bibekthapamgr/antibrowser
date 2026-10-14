# 0022 — Unified desktop profiles and simple team sharing (R3)
Status: **Accepted (revised-roadmap track)**. Date: 2026-10-15. Owner: desktop lead with the backend lead and the
product owner. Builds on ADR-0015 (team sessions), ADR-0020 (unified workspace model) and ADR-0021 (self-service
onboarding). **Supersedes one rule of ADR-0020:** "a folder organizes but never grants" becomes "a folder grants only
through an explicit, previewed folder grant".

## Context
After R1 and R2 a person can sign up and land in a workspace, but the desktop still showed the milestone screens:
local workspaces on *Profiles*, an *Organization* screen with eleven sections, and *Downloads*, *Health* and *Account*
as top-level screens. A workspace profile and its copy on this computer were two rows on two screens. Sharing meant
picking grants one by one (a client or a profile) in *Access*. R3 requires one place to manage profiles, a short
sharing flow that grants exactly what was chosen, and the same effective access everywhere — without a second browser
launch path and without dropping tables, columns or routes.

## Decision

### 1. One navigation and one active workspace
- Default navigation: **Profiles, Proxies, Team, Subscription, Settings**; *Agency tools* appears only for a workspace
  that uses clients (the `modules.agency` feature or existing client records) and for roles that read clients.
- Diagnostics, health, extensions, updates and the account move under **Settings** (tabs *General, Account, Updates and
  downloads, Health and diagnostics, Workspace*). Workspace backups, extension policy, developer tools (automation, only
  with `modules.automation`), activity and workspace settings are the *Workspace* tab. Backups of one profile stay in
  its details. Reconnect, update and billing banners stay above every screen.
- One active-workspace context in the sidebar: the person's account workspaces, and **This computer** (local-only
  profiles). Signed in, the default is the workspace the server keeps as their default (R2), else the first; after
  joining or creating a workspace, that workspace opens at once (an invited Member sees what was shared).
- Switching drops everything loaded for the previous workspace before the new answers arrive (the content is keyed by
  the workspace; every load checks it is still current), so rows or statuses of another workspace never flash.
- Old destinations (Organization, Account, Health, Downloads) redirect: notices and commands that pointed there open the
  matching Settings tab or Profiles.
- **Rollback:** the R1 switch `ui.unified_profiles` (device setting and workspace feature) now defaults to **on**.
  Turning it off (Settings → General, or the R1 migration rollback) shows the earlier screens, which stay in the code
  until the parity period ends; the end-to-end suites of milestones 02–12 run on them (`?demo=classic`).

### 2. One row per profile, one launch path
- A row is a workspace profile (API). This computer's copy of it is found through the R1 identity mapping
  (`org_profile_links`, plus first downloads still in progress) by the new shell command `workspace_copies`. A linked
  local profile is therefore never a second row.
- Status, in order: *Recovery needed* (taken over, access removed, waiting handoff, lost connection, backup conflict,
  failed download) → *Downloading* → *Running* (opening/closing) → *In use by teammate* → *Sync pending* (closing backup
  running, waiting for the connection or retried) → *Sign-in needed* (restored from another computer) → *Available*.
- **Open** goes through the existing path only: `workspace_profile_open` makes sure a copy exists
  (`workspace_profile_prepare`: the existing copy; else the newest backup restored into one new local profile; else,
  for a never-backed-up profile, one empty local profile linked at once after the server confirms the person can reach
  it), then calls `launch_profile`, which takes the session lease first (`launch_shared`). A copy still downloading
  opens by itself when the download completes; nothing skips the lease to feel faster. **Close** is the usual clean
  close, whose closing backup commits before the lease is released.
- Browser execution stays local; the list says so. Revoking access blocks new opens, downloads and API calls; open
  sessions end as in ADR-0015. No remote erasure of copies is claimed.

### 3. Create Profile
Name; optional folder; optional proxy on this computer. No client, workspace, grant or server setup. The workspace
profile is created with its folder in one request (`POST /orgs/{org}/profiles` gains optional `folder_id`), then this
computer's empty linked copy is prepared with the proxy. Defaults are the browser's supported configuration, never a
"fingerprint identity". A plan's profile limit shows *Plan limit reached…* and leads to Subscription.

### 4. Sharing: one step, previewed, stored as granular grants
- **Scopes:** all profiles, a folder, selected profiles (and a client in the Agency module). `permission_grants` gains
  `folder_id` and `all_profiles`; exactly one scope per grant (check constraint). A folder or whole-workspace grant
  follows profiles added later and is created only when the person chose "also profiles added later"; otherwise the
  profiles there now are granted one by one (at most 2,000; more needs the rule). What the preview showed is what is
  granted.
- **One definition of effective access:** `grantCovers` (`services/api/src/tenancy.ts`) — profile, client, folder
  membership, or all profiles — used by listing, single reads, capability checks, lease acquisition (`sessions.ts`),
  automation and tokens. The desktop never decides access; its demo backend mirrors the rule for UI tests.
- **Presets are labels:** *Member* = role operator with `launch` only (open and use; no edit, backup download, delete,
  export, sharing or billing); *Member who can edit* adds `edit`; *Viewer* = role viewer with no capabilities; *Admin*
  and *Billing manager* reach profiles (or not) by role. "Also restore and download backups" adds `backup_download`.
- **Invite:** e-mail → role preset → scope → preview (`POST /orgs/{org}/access/preview`) → send. The chosen access is
  stored with the invitation (`invitation_grants`) and applied in the same transaction that accepts it
  (`app.accept_invitation`); profiles deleted meanwhile are skipped. Seats come from the workspace plan; no personal
  plan is needed to use shared profiles.
- **Change a member's access:** `PUT /orgs/{org}/members/{user}/access` replaces their grants (operators and viewers;
  `grants.manage`) and ends sessions they may no longer hold. Detailed per-grant editing stays under *Team → detailed
  access*.

### 5. Folders and moves
Moving a profile to another folder first shows who gains or loses access
(`GET /orgs/{org}/profiles/{prf}/folder-impact`). A move that changes access needs `grants.manage` (403 otherwise),
and ends the leases of people who lose access. Creating folders needs `folders.manage`.

### 6. Local-only profiles
Unlinked local profiles stay on the device under **This computer**, labelled as local-only and never uploaded unless
the person moves them. The R1 adoption (`migration_plan` / `migration_run`) is offered there as *Move profiles into a
workspace…*: a plan first (nothing changes), opt-in per profile, the workspace quota checked, and optional encrypted
backup; running it again never duplicates. Existing data is preserved and not counted twice; new local profiles keep
the local rules. Local mode never opens a shared profile offline (ADR-0015 unchanged).

## Consequences
- Additive only: migration `0014_team_sharing.sql` (two grant columns, a replaced check constraint, `invitation_grants`,
  `accept_invitation`), three API routes, two optional fields (`ProfileCreate.folder_id`, `Profile.folder_id`) and a
  list filter (`?folder_id=fld_…|none`); three shell commands; four allow-listed window routes. API 0.15.0.
- Grants made one by one through `POST /orgs/{org}/grants` keep their earlier default capabilities; the R3 flows default
  to `launch`.
- The earlier screens remain reachable through the rollback switch until parity is signed off; then *Organization*,
  top-level *Health*/*Downloads*/*Account* and the classic suites can be removed in one change.
- Cross-OS: the same commands and lease path on Windows x64 and macOS Apple Silicon (CI full-OS run); session
  portability rules are unchanged (*Sign-in needed* when a backup came from another computer).
