# 0020 — Unified workspace model and safe migration (R1)
Status: **Accepted (revised-roadmap track)**. Date: 2026-10-14. Owner: product owner with the desktop lead and the
backend lead. Supersedes the agency-first onboarding of ADR-0016 and the separate local/organization presentation of
ADR-0013 and ADR-0014 **in the UI only**; every contract those ADRs introduced stays in force.

## Context
The product as built presents two worlds: a *local workspace* (profiles on this computer) and an *organization*
screen (cloud profiles, clients, members, backups, automation, billing). A person sets up an "agency" with clients
before they can share one profile with a colleague. The revised roadmap (`00-Revised-Roadmap-and-Feature-Decisions`,
14 October 2026) decides on a single, simpler model for customers:

- a **Workspace** (the team) with **Profiles**, **Proxies**, **Team**, **Subscription** and **Settings** as the
  default navigation;
- role presets *Owner / Admin / Member* on top of the existing roles, with *viewer* and *billing* as advanced presets;
- optional **folders** for organizing profiles;
- agency dashboards, client tasks and bookmarks as an **optional module**, off for new workspaces;
- existing customers, data and grants migrated **without losing any identity**, with a rollback.

R1 lays the foundation: contracts, additive schema, a migration tool that can run twice and a rollback switch. The
new screens themselves arrive in R3; this ADR sets the rules they are built on.

## Decision

### 1. "Workspace" is the organization, as a label
- The customer-facing *Workspace* is exactly one row of `organizations`. Nothing is renamed: not the table, not
  `org_id` in any contract, not the OIDC issuer, not the Tauri app id, not the repository. The brand remains undecided.
- The tenant boundary remains `org_id` (ADR-0013, row-level security). A profile is never moved between
  workspaces by changing its `org_id`; moving data between tenants is an export + import, not an update.
- The desktop's *local workspace* (`workspaces` in SQLite) stays as the container of local-only profiles. The unified
  Profiles view (R3) presents local-only and workspace profiles in **one list**, keyed by `view_key`: the workspace
  profile id when linked, `local:<local id>` otherwise. The list never shows the same profile twice because the key is
  the identity, not the name. Duplicates by name are resolved in the UI (rename, merge by choice), never by deleting.

### 2. Role presets map onto existing roles and never broaden them
| Preset | Role | Notes |
|---|---|---|
| Owner | `owner` | unchanged |
| Admin | `admin` | unchanged |
| Member | `operator` | profiles only through explicit client/profile grants (ADR-0013) |
| Viewer (advanced) | `viewer` | shown for existing members; not offered as a default |
| Billing only (advanced) | `billing` | same |

`ROLE_PRESETS` in `packages/contracts/src/workspace.ts` is the single source. No role is promoted, renamed or merged
in the database. The permission matrix gains only `folders.manage` and `features.manage` (owner, admin).

### 3. Folders organize; grants authorize
- `folders` / `profile_folders` are optional organization of profiles inside a workspace (one folder per profile,
  position, colour, archive). They are **not a grant scope**: moving a profile between folders changes nobody's
  access, and nothing is ever granted "to a folder". Access stays on roles, client grants and profile grants.
- Folders are **never auto-converted from clients**: a client is a business relationship with its own grants,
  dashboards and download folders. A workspace that wants folders creates them; a later helper may *offer* to create
  folders named after clients, with the grants left exactly as they were.

### 4. Agency features become a module, retired from the default path (not removed)
- `feature_settings` per workspace: `ui.unified_profiles` (R3 view; the migration's rollback switch), `modules.agency`
  (client dashboards, tasks, bookmarks), `modules.automation` (developer tools in the UI). Defaults are `false`.
- Existing workspaces with client data keep working: the module is switched on for them during R3 rollout based on
  the data they have (clients, tasks or bookmarks present); their API routes, tables and grants are untouched.
- The feature-retirement register (`docs/r1/feature-retirement.md`) lists what leaves the default path, what remains
  reachable and what is removed (nothing, in R1–R5).

### 5. Migration without losing identity
- The **linked profile's cloud id is authoritative**: a profile with an `org_profile_links` row (milestone 07) keeps
  that workspace id; the migration never creates a second cloud profile for it.
- The server keeps a **profile identity map** per device: `profile_identity_map (device_id, local_profile_id) →
  cloud_profile_id`, written by `POST /orgs/{org}/local-import` when the device sends `device_id`. A re-run, a
  retry after a crash and a reinstall that kept the device id all get `outcome: "existing"` with the same id, so
  adoption is idempotent at the server, not only by idempotency key.
- **Local-only profiles are adopted only with explicit opt-in** (the `adopt` list), after a quota check
  (`billing/usage`; the server refuses beyond the plan with `PLAN_LIMIT_REACHED`), with an OS-level lock (a running
  profile is `blocked_running`) and a clean shutdown (`last_started_at` set without `last_clean_shutdown_at` is
  `blocked_unclean`: open and close it first). Adoption creates **metadata only**; profile data is uploaded only
  when the person chooses sync (`auto_backup` is set to the chosen value, never left to a default).
- Grants are preserved because nothing about grants changes: the migration links identities, it does not touch
  `client_grants`, `profile_grants` or memberships. The cross-tenant suite proves no row became visible to another
  tenant or role through the new tables.

### 6. Compatibility and rollback
- All earlier API contracts remain; the new routes are additive (`docs/automation/api-changelog.md`, 0.13.0).
- **Capability negotiation:** `GET /me/capabilities` tells a desktop what the server offers (`folders`,
  `feature_settings`, `onboarding_state`, `profile_identity_map`, `migration_runs`) and the minimum desktop version;
  the desktop's cloud allow-list gained only these routes.
- **Per-workspace UI flag:** `ui.unified_profiles` on the server and the same key as a local setting on each device.
  Rollback = both set to `false`: the earlier screens come back, the identity map and additive metadata stay.
- **Backup and manifest:** every run is identified by the SHA-256 of its manifest `{schema, org_id, device_id,
  workspace_id, profiles: [local ids]}`; the device records the run in `migration_runs` (SQLite) and on the server
  (`POST /orgs/{org}/migration-runs`, upsert per device + digest), with counts and a checkpoint only. The local
  database is in WAL mode and the migration never deletes or rewrites a local record, so the "metadata backup" is the
  database itself plus the report's mapping; the report (`migration_report`) is the mapping manifest.
- **Bounded, resumable batches:** `migration_run` adopts in batches (1–500, default 50) with a checkpoint
  `{step, selection, batch_size, batches_done}` after each; a crash at any checkpoint resumes after it with the same
  idempotency key per batch (`sha256(digest \n selection \n batch)`), and the same manifest is the same run.
- **Re-run must not duplicate:** proven by `apps/desktop/src-tauri/tests/account.rs` (crash after batch 1, 2 and 3
  of 3, then retry: three cloud profiles, three distinct keys, identical mappings on a further run).

## Consequences
- R2 (self-service signup) can rely on `onboarding_state` and `GET /me/onboarding`; R3 builds the unified Profiles
  view on `view_key`, folders and the feature flag; R5 (admin) reads `migration_runs`.
- Two product vocabularies coexist in code for a while (organization in contracts, workspace in UI copy). That is
  deliberate: renaming identifiers is churn with no customer value and real migration risk.
- The identity map grows by one row per adopted profile per device; it is small and bounded by profile quota.
- Nothing in R1 changes what a signed-in person can see or do; the permission matrix diff is two owner/admin
  permissions. Security review: no new trust boundary; the new routes sit behind the same tenancy checks and RLS.

## Alternatives considered
- *Rename organizations to workspaces everywhere:* rejected (roadmap rule: label only).
- *Convert clients into folders automatically:* rejected; folders are not a grant scope and a silent conversion would
  either broaden access or surprise people who rely on client grants.
- *Delete duplicate profiles during migration:* rejected; duplicates are presented in the UI and resolved by choice.
- *Treat the device's link table as the only identity map:* rejected; a reinstall or a half-finished run would
  create a second cloud profile. The server-side map makes adoption idempotent by identity.
