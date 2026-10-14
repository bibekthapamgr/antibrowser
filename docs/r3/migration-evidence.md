# R3 — migration evidence

What changed for existing data and how it is proven. Decisions: [ADR-0022](../adr/0022-unified-profiles-and-team-sharing.md).

## Database (`infra/db/migrations/0014_team_sharing.sql`)
| Change | Kind | Existing rows |
|---|---|---|
| `permission_grants.folder_id`, `permission_grants.all_profiles` (default false) | added columns | unchanged: every existing grant has exactly one of client/profile, so the new one-scope check holds |
| `permission_grants_check` → `permission_grants_one_scope` | check constraint replaced (same rule plus the two new scopes) | validated on all rows when added |
| unique indexes per (org, user, folder) and (org, user) for all-profiles | added | — |
| `invitation_grants` (RLS `tenant_isolation`) | added table | — |
| `app.accept_invitation` | function replaced; same outcomes as 0013, plus the invitation's access applied in the same transaction | open invitations without access behave as before |
Nothing is dropped or renamed. The API keeps every route and field; additions are listed in the
[API changelog](../automation/api-changelog.md) 0.15.0.

## Desktop
- SQLite schema unchanged (v12). The local setting `ui.unified_profiles` now defaults to on; an explicit value saved by
  the R1 migration or rollback is kept.
- Linked local profiles keep their ids and data; the unified list finds them through `org_profile_links`. Local-only
  profiles stay where they are (This computer) and are never counted or uploaded unless moved.
- New shell commands only (`workspace_copies`, `workspace_profile_prepare`, `workspace_profile_open`); opening still
  runs `launch_profile` → `launch_shared` (lease, newest backup, browser).

## Evidence
| Claim | Test |
|---|---|
| A linked profile appears once and opens its earlier session | desktop e2e "a linked profile appears once and opens its earlier session here"; Rust `sync.rs` `opening_a_workspace_profile_here_restores_it_once_and_then_opens_it` (one copy while downloading and after; cookies of the backup present; lease taken; team phase running) |
| No duplicate copy for one workspace profile | Rust `account.rs` `a_new_workspace_profile_gets_one_empty_linked_copy_here_and_unreachable_ones_are_refused`; `sync.rs` (second open during download → same local id) |
| A profile the person cannot reach creates nothing here | same `account.rs` test (`SYNC_FORBIDDEN`, local profile count unchanged) |
| Grants and invitations: only what was chosen; deleted profiles skipped; nothing across workspaces | API `team.test.ts` (9 tests), `cross-tenant.test.ts` (new routes in the swap list) |
| The migration's adoption and rollback still behave as in R1 | Rust `account.rs` migration tests (unchanged, green); desktop e2e classic suites (181) run with the rollback switch off |
| Existing grants keep working | the full API suite (582 passed) including milestone 06–11 grant, lease and token tests |

## Rollback
1. Settings → General → *use the earlier screens* (this device), or `migration_rollback` (device + workspace flag).
2. The database change needs no rollback for the earlier screens: they ignore folder and whole-workspace grants'
   extra columns, and the API still enforces them. Removing a folder/all grant is a `DELETE /orgs/{org}/grants/{id}`.
