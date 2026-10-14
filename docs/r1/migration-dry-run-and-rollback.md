# R1 migration: dry-run tool, run, rollback and the report

Decisions: [ADR-0020](../adr/0020-unified-workspace-model-and-safe-migration.md). Code: `apps/desktop/src-tauri/src/migration.rs`
(desktop shell), `services/api/src/routes/import.ts` + `routes/workspace.ts` (server), `crates/storage/src/migration.rs`
(device record). Tests: `apps/desktop/src-tauri/tests/account.rs` (`migration_*`), `services/api/test/workspace.test.ts`,
`services/api/test/cross-tenant.test.ts`.

## The four commands (desktop IPC; also in the demo backend)
| Command | What it does | Changes |
|---|---|---|
| `migration_plan(workspaceId, orgId)` | **Dry run.** Lists every active local profile of the workspace with its state and `view_key`, the counts, the plan quota and the run record for this manifest. Asks the server (`local-import` with `dry_run: true` and `device_id`) which unlinked profiles it already mapped for this device. | Creates or returns the run record (`planned`); nothing else |
| `migration_run(workspaceId, orgId, adopt[], sync, batchSize?)` | Links what the server already mapped, adopts the chosen local-only profiles in batches with a checkpoint after each, verifies every selected profile has its link, marks the run `completed`. | `org_profile_links` on the device, `profiles` + `profile_identity_map` on the server; `auto_backup = sync` for adopted profiles |
| `migration_rollback(orgId)` | Sets `ui.unified_profiles = false` here and for the workspace; marks the latest run `rolled_back`. | Settings only; links and metadata stay |
| `migration_report(orgId)` | Latest run for the workspace on this device with the full `local id → workspace id` mapping. | none |

Entry states: `linked` (keeps its workspace id), `mapped_on_server` (restored without creating), `local_only`
(adoptable with opt-in), `blocked_running` (close it first), `blocked_unclean` (open and close it once).

## Checkpoints and crash behaviour
Checkpoint = `{step: "adopt", selection: sha256(sorted selected ids), batch_size, batches_done}`, written to the
device's `migration_runs` after every batch and mirrored to the server (best effort). Idempotency key per batch =
`sha256(manifest_digest \n selection \n batch)`. On retry with the same selection and batch size the run resumes after
`batches_done`; with a different selection it starts its batches again, and already-mapped profiles come back as
`existing`, so nothing is created twice either way. Tests inject a crash after batch 1, 2 and 3 of 3.

## Required fixtures and where each is covered
| Fixture | Covered by |
|---|---|
| local-only user (no links) | `migration_adopts_only_opted_in_profiles…` |
| linked profile (keeps its id) | `migration_plan_is_a_dry_run…` (`view_key` = cloud id, state `linked`) |
| one user in two tenants | `cross-tenant.test.ts`: folders, feature settings, identity map and migration runs of one tenant are 404 for the other; the device-scoped map cannot be read through the other tenant |
| client grants preserved | migration touches no grant table; `cross-tenant.test.ts` grants section unchanged (operator with a client grant sees exactly the same profiles before and after) |
| pending snapshot / active lease | untouched by R1 code paths (no snapshot or session route is called; test asserts no `snapshot`/`upload` request) |
| revoked membership | `migration_context` requires a signed-in session; a 401/403 from the server maps to `CLOUD_SIGNED_OUT` / `CLOUD_NOT_ALLOWED` and the run is recorded `failed` |
| over-quota | `migration_respects_the_workspace_quota…` (`PLAN_LIMIT_REACHED` → `MIGRATION_PLAN_LIMIT`, nothing created, run `failed` with the code) |
| missing keychain | sessions without a keychain live in memory (`without_a_keychain_the_session_lives_in_memory_only`); the migration uses the same `access_token` path |
| same name in two workspaces | identity is the id, never the name: `view_key` and the manifest carry ids only; `workspace.test.ts` folders use `name_key` uniqueness per org, profiles do not |
| crash at each checkpoint + retry | `migration_resumes_after_a_crash_at_every_checkpoint_without_duplicating` |
| no upload without opt-in | `migration_adopts_only_opted_in_profiles…` (no snapshot request; `auto_backup` false) |
| reinstall (device kept its id, lost its links) | `migration_respects_the_workspace_quota_and_a_reinstalled_device_restores_links` |

## Rollback report (what rollback does and does not do)
- Turns the R3 view off: local setting `ui.unified_profiles = false` and `PUT /orgs/{org}/feature-settings`
  `ui.unified_profiles = false`. The earlier screens are shown again on every device of the workspace once they sync
  the setting (R3 reads it at start-up).
- Keeps: `org_profile_links`, `profile_identity_map`, `migration_runs`, folders, feature settings, and every workspace
  profile created by adoption. Nothing is deleted, so a second migration after a rollback finds the same mapping.
- Does not: unlink profiles, delete cloud profiles, or change grants. Removing an adopted workspace profile is the
  ordinary profile delete (trash, retention, audit) by someone with `profile.delete`.
- Verified: `migration_adopts_only_opted_in_profiles…` asserts the feature-settings call, the local setting and that
  the two links survive.

## Exit criterion
"Migration twice gives identical counts/mappings and no broadened access": the second run of a completed manifest
returns the same run, counts and mappings (asserted); the cross-tenant suite passes with the new tables and routes,
and the permission matrix diff is two owner/admin permissions (`folders.manage`, `features.manage`).
