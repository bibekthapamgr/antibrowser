# R1 — status against the handoff file

Product contracts and safe migration foundation (revised roadmap, 14 October 2026). API 0.13.0.
- **Decisions:** [ADR-0020](adr/0020-unified-workspace-model-and-safe-migration.md) (supersedes agency-first onboarding
  and the separate local/organization presentation, in the UI only).
- **Deliverables:**
  - [inventory and screen map](r1/inventory-and-screen-map.md);
  - schema diff: [`infra/db/migrations/0012_product_model.sql`](../infra/db/migrations/0012_product_model.sql) (additive);
    API diff: [api-changelog 0.13.0](automation/api-changelog.md) and [openapi.json](openapi.json);
  - [permission matrix](permission-matrix.md) (regenerated: `folders.manage`, `features.manage` for owner/admin);
  - [feature-retirement register](r1/feature-retirement.md);
  - [dry-run tool, rollback report and fixture coverage](r1/migration-dry-run-and-rollback.md).

**Outcome.** Everything the R2–R5 screens need exists as contracts, routes and tables without one drop or rename; a
device can plan, run, resume and roll back its migration into the unified model, and running it twice gives the same
counts and mapping.

## Requirements

| Required | Implemented |
|---|---|
| Step 1: inventory of the actual state; screen map as built → target; ADR superseding agency-first onboarding and separate local/org presentation | [inventory-and-screen-map.md](r1/inventory-and-screen-map.md); [ADR-0020](adr/0020-unified-workspace-model-and-safe-migration.md) |
| Step 2: Workspace = `organizations` row (label only); role presets Owner/Admin/Member, viewer/billing advanced; folders optional, not a grant scope, never auto-converted from clients | `packages/contracts/src/workspace.ts` (`ROLE_PRESETS`, `presetOfRole`, folders, feature settings, onboarding, capabilities, migration runs); no rename of repository, issuer, app id, tables or contracts |
| Step 3: additive schema `onboarding_state`, `migration_runs`, `profile_identity_map`, `folders`/`profile_folders`, `feature_settings`; new numbered migration only | `0012_product_model.sql`: six tables, tenant RLS, grants to `pb_app`; the runner sets `search_path` per file; device schema v11 adds `migration_runs` (SQLite) |
| Step 4: linked profile's cloud id authoritative; dedupe in the UI, not by deleting; local-only adopted only with opt-in, quota check, OS lock, clean shutdown, idempotent metadata creation, no upload unless sync chosen; no tenant transfer by changing `org_id`; grants preserved | `apps/desktop/src-tauri/src/migration.rs` (`migration_plan` / `migration_run` / `migration_rollback` / `migration_report`), `services/api/src/routes/import.ts` (`device_id` → `profile_identity_map`, `outcome: existing`); nothing writes `org_id` or any grant table |
| Step 5: old API contracts kept; capability negotiation; per-workspace UI flag; metadata backup + mapping manifest; bounded resumable batches; re-run never duplicates; rollback disables the new UI and keeps metadata | `GET /me/capabilities`; `feature_settings.ui.unified_profiles` + local setting; manifest digest + `migration_runs` on both sides; batches 1–500 with checkpoints and per-batch idempotency keys; [rollback report](r1/migration-dry-run-and-rollback.md#rollback-report-what-rollback-does-and-does-not-do) |
| Tests: fixtures (local-only, linked, one user/two tenants, client grants, pending snapshot, active lease, revoked membership, over-quota, missing keychain, same name in two workspaces); crash at each checkpoint and retry; no upload without opt-in | `apps/desktop/src-tauri/tests/account.rs` (4 migration tests incl. crash after batch 1/2/3 of 3), `services/api/test/workspace.test.ts` (7), `cross-tenant.test.ts` extended with folders, feature settings, identity map, migration runs; mapping in [migration-dry-run-and-rollback.md](r1/migration-dry-run-and-rollback.md#required-fixtures-and-where-each-is-covered) |
| Outputs: ADR, screen map, schema/API diff, permission matrix, feature-retirement register, dry-run tool, rollback report | all linked above |
| Exit: migration twice gives identical counts/mappings and no broadened access | asserted in `migration_adopts_only_opted_in_profiles_without_uploading_and_runs_twice_identically`; cross-tenant suite green; permission diff is two owner/admin permissions |

## Verification
- Rust: `cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo test --workspace` green (desktop
  `account` 13 incl. the 4 migration tests).
- API: 544 passed, 13 skipped (`workspace.test.ts`, `cross-tenant.test.ts`, token-route list now 18).
- Desktop e2e: 180 passed (demo backend carries the same four commands via `demo-migration.ts`).
- `pnpm typecheck`, Biome, `pnpm openapi`, `pnpm docs:permissions`, `pnpm docs:ipc` regenerated.

## Deploying the server part
`\cp -f /home/pb/antibrowser/scripts/deploy/vps-setup.sh /root/ && bash /root/vps-setup.sh` applies migration 0012
(additive; safe to run on the existing database). No key, bucket or Keycloak change.

## Not in R1 (by design)
- No customer-visible screen change; the unified Profiles view, Team, Subscription and the modules are R3/R5.
- No onboarding flow (R2) — only its state record and route.
- No removal of any feature, route, table or column (see the retirement register).
