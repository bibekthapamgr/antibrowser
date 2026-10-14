# Feature-retirement register (R1–R5)

Rule from the revised roadmap: **no table, column or API route is dropped in R1–R5.** "Retired" below means
*leaves the default customer path*; the data, routes and grants stay and are reachable by the paths listed.
Decisions: [ADR-0020](../adr/0020-unified-workspace-model-and-safe-migration.md).

| Feature | Status after R3 | Where it stays | Data / routes | Removal |
|---|---|---|---|---|
| Agency-first onboarding (create a local workspace, then an organization, then clients) | Retired from the default path | R2 onboarding creates the workspace; local workspaces still exist for local-only profiles | `workspaces` (SQLite), `POST /orgs` | none planned |
| Separate *Organization → Profiles* section | Replaced by the unified Profiles view when `ui.unified_profiles` is on | Rollback (`ui.unified_profiles = false`) shows the old screens | all profile routes | none |
| "Copy local workspace into an organization" dialog (`org_import`) | Retired from the default path; the migration tool and "Share with team" use the same route with `device_id` | still callable (`org_import` command, `POST …/local-import`) | unchanged | none |
| Client dashboards, tasks, bookmarks | Optional module (`modules.agency`), on for workspaces with client data | *Clients* module | `clients`, `client_tasks`, `client_bookmarks`, `client_grants` and routes | none |
| Per-client download folders | Part of the agency module | same | `downloads.per_client_folders` setting | none |
| Developer tools in the UI (tokens, jobs, computers, webhooks) | Optional module (`modules.automation`); the API itself is unchanged and always on | *Developer* module | automation tables/routes | none |
| Role names in the UI (`operator`, `viewer`, `billing`) | Presented as presets (Member; Viewer and Billing only under *Advanced*) | `ROLE_PRESETS` | `memberships.role` enum unchanged | none |
| Local *client* field on a profile (name used by dashboards) | Hidden when the agency module is off | field remains in SQLite and in import/export | `profiles.client_id` (SQLite) | none |
| Downloads/Health/Diagnostics as top-level navigation | Moved under Settings in R3 | Settings tabs | — | n/a |

Review this register at the end of each of R2–R5; a line may move to "scheduled for removal" only after R5 with its
own ADR, a deprecation notice in the API changelog and a data-export path.
