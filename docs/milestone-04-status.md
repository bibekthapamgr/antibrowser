# Milestone 04 — status against the handoff file

Profile/client management and safe migration. Version 0.4.0. Decisions:
[ADR-0011](adr/0011-profile-library-and-configuration-import.md). Formats: [import/README.md](import/README.md).
Walkthrough: [usability/milestone-04-walkthrough.md](usability/milestone-04-walkthrough.md).

Scope reminder: import and export move **configuration** (names, clients, tags, notes, start pages, permission
defaults). They never move cookies, sign-ins or other browser data; there is no session migration (ADR-0002).

## Screens
| Required | Implemented |
|---|---|
| Virtualized table: name, client, tags, running state, last used, proxy label, sync placeholder | `apps/desktop/src/profiles.tsx`: windowed grid that loads only the 200-row pages on screen; columns ★, name, client badge, tags, status, last used, proxy (“—” until 05), sync (“Local” until 07). On narrow windows proxy/sync hide first, then tags/last used; all are always in the drawer |
| Search, filter, sort, saved filters | Search over name/client/tags (case- and accent-insensitive) or exact id; tag and status filters; six sorts (also by clicking column heads); **Save view…** stores folder + filters + sort, listed in the sidebar |
| Detail drawer, client folders, archive/trash, import preview | Drawer with client badge, favourite, client picker (or new client), tag editor, notes, lifecycle actions; sidebar folders (All, Favourites, Open now, No client, Archived, Trash, each client with counts, saved views); trash view with dates and Restore; import wizard with preview |
| Bulk actions show the selected count; cross-page selection is clear | Bulk bar: “N selected of M” or “All M matching profiles selected”, “Select all M matching”, action buttons carrying the count (“Archive 12”, “Move 12 to trash”, dialogs “Add a tag to 12 selected profiles”). An “all matching” selection is sent with the count the user saw and refused if it changed |

## Implementation order
| Step | Status |
|---|---|
| 1. Local CRUD, transactional writes, optimistic versions; names not unique, ids unique | Done. Every write is one transaction with `expected_version`; `VERSION_CONFLICT` otherwise. Same names allowed; clients/tags unique per workspace by folded name |
| 2. Clients, tags, notes, favourites; notes as sanitized text; no secrets in notes | Done. Notes rendered as text; control and bidi characters stripped; notes that look like passwords/keys/tokens/card numbers refused (`NOTES_LOOK_SECRET`) with a live warning in the drawer |
| 3. Templates: new profile has empty storage; cloning never clones sessions | Done. Templates hold start pages, permission defaults, tags. Create-from-template and Duplicate copy configuration only (tests check no browser data and no `last_started_at`) |
| 4. Bulk tag/move/archive in bounded batches with per-item results; running profiles can't be deleted | Done. Batches of 250; each profile changed/unchanged/failed with a reason; open or busy profiles refused for the trash and deletion; undo for 10 minutes |
| 5. Trash retention; permanent-deletion confirmation; no live process writes into a removed directory | Done. Retention 7/30/90 days (Settings), hourly purge; deletion needs `DELETE` + exact count, holds the launch lock, re-checks supervisor, process table and the profile's OS lock, renames the folder aside before removing it |
| 6. CSV/JSON import: size limit, schema version, preview, dry run, duplicate policy, escaped formula export, row errors | Done (`crates/import`, `transfer.rs`). 20 MB / 10,000 rows; schema v1; preview bound to SHA-256 + settings; skip/update/create duplicates; per-row field errors; formulas never evaluated and neutralised on export |
| 7. Adapters only for documented/user-supplied formats; configuration ≠ cookie migration; archive validation | Done. Own CSV/JSON/bundle only; bundles claiming session data refused; traversal, links, encryption, extra entries, size, ratio and executable checks |
| 8. Export with an authorization placeholder; secrets excluded by default | Done. `authz::authorize(ExportConfiguration, n)`; configuration allowlist; notes off by default and secret-looking notes always withheld |

## Data and commands
| Required | Implemented as |
|---|---|
| `clients_local`, `profile_tags`, `templates`, `import_jobs`, `trash_entries` | Schema v4 (`crates/storage/src/migrations.rs`), plus `tags` and `saved_filters`; v3 client/folder labels migrated |
| `profiles.query(cursor, filters)` | `query_profiles { filter, sort, cursor \| offset, limit }` → rows, total, next cursor (`CURSOR_STALE` if the filter changed) |
| `profiles.update(id, expected_version)` | `update_profile { profileId, expectedVersion, … }` |
| `profiles.bulk(action, ids)` | `bulk_profiles { action, selection }` + `undo_action`, `delete_profiles` |
| `imports.preview(file_ref)` / `imports.commit(preview_id)` | `choose_import_file` → `preview_import { fileRef, settings }` → `commit_import { previewId }`, `cancel_import`, `list_imports` |
| `exports.configuration(ids)` | `export_profiles { selection, format, includeNotes }` |
| Preview binds source digest and settings | SHA-256 + settings kept with the preview; commit re-reads and refuses a changed file (`SOURCE_CHANGED`) |

21 new commands (44 in total), each granted individually to the main window; contract in
`packages/contracts/src/ipc.ts`, regenerated `docs/ipc-schema.json`.

## UX
| Required | Implemented |
|---|---|
| Undo for reversible actions | Undo bar after every bulk or single-profile archive/trash/restore/move/tag/favourite action |
| Persistent import status | Progress in the sidebar on every screen; job history (with row errors) under Downloads and updates; interrupted imports marked at start-up |
| Table updates without reload | Profile events re-read the visible pages in place; a new filter keeps the old rows until its first page arrives |
| Specific errors | Every refusal has a code and a sentence (e.g. “This profile is open. Close it first.”); bulk failures list each profile and reason |
| Client label visible in details and launch confirmation | Badge under the name in the drawer; toasts “Opening Shop admin (Client North)…” |
| Basic creation needs only a name and optional client | New profile: name (required), client (optional, new names create the client), template (optional) |

## Verification
| Criterion | Evidence |
|---|---|
| 10k-row import with bounded memory and cancel | `ipc.rs` `ten_thousand_row_import_can_be_cancelled_and_resumed_without_duplicates`: 10,000 rows, cancel mid-way, continue, exactly 9,999 valid profiles. Measured 2026-10-13 (Linux sandbox): 0.7 s release / 2.2 s debug end to end, peak process memory 38 MB (rows are planned once and written in batches of 250; the file is never held twice) |
| Mixed-validity input reports each failed row; retry doesn't duplicate | `ipc.rs` `import_preview_binds_the_file_…`; `crates/import/tests/examples.rs` on [mixed-validity.csv](import/examples/mixed-validity.csv) |
| Duplicates, Unicode, long notes, missing fields, malicious archives, CSV formulas | `crates/import/src/tests.rs` (traversal incl. drive letters, links, bombs by ratio and size, executables, session manifests, formulas, Unicode, 2,000-character notes, missing columns/fields, wrong types), storage folded-name tests |
| Search p95 ≤ 200 ms at 10k | `crates/storage/tests/search_latency.rs` (runs on every CI build): release p50 25 ms, **p95 45 ms**; debug p95 ≈ 94 ms |
| UI flows | `apps/desktop/e2e/manager.e2e.test.ts`: keyboard selection + bulk + undo, select-all-matching at 10,000, folders and accent-insensitive search, trash and typed deletion, import preview/commit, 10,000-row cancel/continue, client in launch toast, secret notes; axe clean on 19 screens × light/dark |

## Deliverables
| Deliverable | Where |
|---|---|
| Manager UI | `apps/desktop/src/profiles.tsx`, `drawer.tsx`, `importer.tsx`, `library.tsx`; screenshots in `docs/design/` |
| Import schemas and example fixtures | [import/README.md](import/README.md), [profiles.v1.schema.json](import/profiles.v1.schema.json), [examples/](import/examples/) |
| Safe import engine | `crates/import` + `apps/desktop/src-tauri/src/transfer.rs` |
| Usability walkthrough | [usability/milestone-04-walkthrough.md](usability/milestone-04-walkthrough.md) |

## Test totals
Rust 139 (runtime 33, storage 22 + 1 latency gate, update 16 + 1 Windows-only, import 13, desktop 17 unit + 32 IPC
integration + 5 real-browser). TypeScript desktop unit/contract 25 (was 15), packages 18; API/worker suites unchanged
(they need PostgreSQL and run in CI). UI end-to-end 59 (was 39).

## Owner actions
1. Try it on your Mac: build as before (`scripts/dev/try-runtime.sh`), then create a few profiles with clients, tag
   two at once, import `docs/import/examples/profiles.csv`, and empty the trash.
2. The usability walkthrough is an internal review. Plan 3–5 short sessions with real agency users before the team
   beta (the task list is in the walkthrough).

## Handed to later milestones
- 05: fill the proxy column and the drawer's proxy line; proxy assignment as a bulk action.
- 06: replace `authz::authorize` with role checks (export and permanent deletion likely admin-only).
- 07: sync status column, tombstones for trash and permanent deletion, server-side import history.
- 08: undo and audit for shared workspaces; leases block bulk actions on profiles another person has open.
