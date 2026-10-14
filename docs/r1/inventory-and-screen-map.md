# R1 step 1 — inventory of the actual state and the screen map

Date: 2026-10-14, at commit `1c05cfc` (milestone 12 delivered). Decisions: [ADR-0020](../adr/0020-unified-workspace-model-and-safe-migration.md).
This is what exists, not what the roadmap wishes existed.

## 1. Inventory

### Desktop app (Tauri 2 + React 19), `apps/desktop`
| Area | Where | State |
|---|---|---|
| Main navigation | `src/App.tsx` `NAV` | Profiles, Proxies, Downloads and updates, Health, Account, Settings; plus an *Organization* view reached from Account / the workspace switcher |
| Local profiles | `src/profiles.tsx`, `src/library.tsx` | Local workspace list: search, sort, tags, templates, saved filters, trash, bulk actions, launch, import/export, per-profile drawer (`src/drawer.tsx`) |
| Organization screen | `src/org.tsx` sections | Profiles, Clients, Members, Invitations, Access, Backups, Extensions, Automation, Billing, Activity, Settings — each gated by a permission (`can(role, …)`) |
| Agency features | `src/clients.tsx` (dashboards, tasks, bookmarks), per-client download folders | Working; counted on the organization *Clients* section and the local *client* field |
| Team sessions | `src/team.tsx` | Handoff, takeover, requests, recovery copies (milestone 08) |
| Sync / backups | `src/backups.tsx`, backend `demo-sync.ts` | Auto backup per linked profile, restores, conflicts (milestone 07) |
| Automation | `src/automation.tsx` | Tokens, jobs, computers, webhooks, allowed sites (milestone 10) |
| Billing | `src/billing.tsx` | Plan, checkout/portal via the shell, invoices (milestone 11) |
| Updates | `src/updates.tsx` | Signed channels (milestone 12) |
| Settings | `src/screens.tsx` `SettingsScreen` | Local settings table (`SettingValue` keys) |
| Local DB | `crates/storage` SQLite, schema v11 after R1 | `workspaces`, `profiles`, `org_profile_links` (the device's identity map), `sync_*`, `settings`, `migration_runs` (new) |
| Cloud allow-list | `crates/cloud/src/allow.rs` | The window may only call listed routes; R1 added capabilities, onboarding, folders, feature-settings |

### API (Fastify 5), `services/api`
| Area | Routes | State |
|---|---|---|
| Identity | `/auth/*`, `/devices`, `/me/*` | OIDC + device sessions (ADR-0013); `/me/capabilities`, `/me/onboarding` new |
| Organizations | `/orgs`, `/orgs/{org}`, members, invitations, grants, audit | Five roles, client/profile grants, RLS |
| Profiles | `/orgs/{org}/profiles*`, `/local-import` | `local-import` now records the identity map when `device_id` is sent |
| Agency | `/orgs/{org}/clients*`, tasks, bookmarks | Unchanged; becomes the optional module in the UI (R3) |
| Snapshots / leases | `/orgs/{org}/profiles/{prf}/snapshots*`, sessions | Unchanged |
| Automation | `/orgs/{org}/api-tokens`, `/automation/*`, webhooks | Unchanged |
| Billing | `/orgs/{org}/billing/*`, Stripe webhooks | Unchanged; `billing/usage` is the migration's quota source |
| Support | `/support/*` | Unchanged |
| New in R1 | folders, profile folder, feature-settings, migration-runs | Additive (`docs/automation/api-changelog.md` 0.13.0) |

### Database (PostgreSQL), `infra/db/migrations`
0001–0011 unchanged. `0012_product_model.sql` adds `onboarding_state`, `folders`, `profile_folders`,
`feature_settings`, `profile_identity_map`, `migration_runs` — all with tenant RLS; no drop, no rename, no column
change. The migration runner (`services/api/scripts/migrate.ts`) sets `search_path = app, public` for every file.

### Contracts, `packages/contracts`
`resources.ts` (roles, permissions, resources), `ipc.ts` (desktop commands and events), `automation.ts`,
`billing.ts`; R1 adds `workspace.ts` (role presets, folders, feature settings, onboarding, capabilities, migration
runs) and two id prefixes (`fld`, `mgr`).

### Identity and billing
Keycloak realm and desktop client ids, Stripe product/price catalog: unchanged (no brand rename).

## 2. Screen map: as built → target (R3), with what R1 delivers

| Today (as built) | Target after R3 | R1 foundation |
|---|---|---|
| Local **Profiles** list + separate **Organization → Profiles** section | One **Profiles** view: local-only and workspace profiles together, keyed by `view_key`; folders in the sidebar; "Share with team" instead of "copy to organization" | `view_key`, `migration_plan`/`migration_run`, folders API, `ui.unified_profiles` flag |
| **Proxies** (local) | **Proxies** unchanged | — |
| **Downloads and updates**, **Health** | Folded into **Settings** (Downloads, Updates, Health, Diagnostics tabs) | — (R3 UI) |
| **Account** with create/join organization | **Team**: members, invitations, roles as presets (Owner/Admin/Member; Viewer and Billing under *Advanced*), access grants, activity | `ROLE_PRESETS`, `presetOfRole` |
| **Organization → Billing** | **Subscription** | — (label) |
| **Organization → Clients** (dashboards, tasks, bookmarks) | Optional **Clients** module, shown only when `modules.agency` is on | `feature_settings` |
| **Organization → Automation** | Optional **Developer** module, shown when `modules.automation` is on | `feature_settings` |
| **Organization → Backups / Extensions / Settings** | **Settings → Workspace** tabs | — (R3 UI) |
| Welcome: create a local workspace, then an organization | R2 onboarding: sign up → workspace created → first profile; "invited" path joins the inviter's workspace | `onboarding_state`, `GET /me/onboarding` |

The default navigation after R3 is therefore **Profiles / Proxies / Team / Subscription / Settings**, with
*Clients* and *Developer* appearing only as modules. Nothing on the right-hand column needs a route, table or column
that does not exist after R1.

## 3. What R1 explicitly does not do
- No screen changes shipped to customers (the demo backend and the IPC commands exist; the R3 view is not built).
- No rename of repository, issuer, app id, tables or contracts to a brand.
- No deletion or rewrite of any local or server record; no automatic upload.
