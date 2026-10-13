# 0011 — Profile library, safe deletion and configuration import (milestone 04)
Status: **Accepted** for the local engineering alpha. Date: 2026-10-13. Owner: technical lead.
Builds on ADR-0002 (portability: sessions do not travel between devices) and ADR-0009 (local workspaces).

## Context
Milestone 04 asks for a manager that stays fast at 10,000 profiles per workspace, with clients, tags, notes,
favourites, templates, bulk actions with per-item results, a trash with confirmed permanent deletion, and CSV/JSON
import with preview, dry run, duplicate policy, row-specific errors and safe archives — while distinguishing
configuration import from cookie migration and keeping secrets out of notes. Teams and roles arrive in 06/08, so the
choices must not need to be undone then.

## Decision
1. **Library entities.** Clients (`cli_`), tags (`tag_`), templates (`tpl_`), import jobs (`imp_`) and saved views
   (`flt_`) are per-workspace records with opaque ids (schema v4). Client and tag names are unique per workspace by a
   folded key (trim → NFKD → strip combining marks → lowercase), so "Client Ä", "client a" and "CLIENT A" are one
   client. Profile names are not unique; ids are. The v3 free-text client label and folder label migrate into
   clients and tags.
2. **Lifecycle.** Active → Archived (reversible, hidden from the main list) → Trash (retention 7, 30 or 90 days,
   default 30) → permanent deletion. Open or busy profiles cannot be moved to the trash, launched from it, or edited
   while in it. Permanent deletion is only from the trash and needs `confirm = "DELETE"` plus the exact count the user
   saw. Per profile it holds the launch lock, re-checks the supervisor, the OS process table and the profile's OS
   lock, cancels a running backup, **renames the folder to `.deleting-<id>`** (atomic, so no browser can reopen it
   under the profile's path), deletes the metadata, removes backups and crash evidence, then deletes the moved
   folder. Leftover `.deleting-*` folders are purged at start-up and hourly, together with expired trash.
3. **Querying.** One parameterised SQL query serves filter (view, client(s), tags, run states, favourites, template,
   text over folded name/client/tags or exact id), sort (name, client, last used, created, state) and paging.
   `cursor` continues a page and is refused if the filter or sort changed (`CURSOR_STALE`); `offset` jumps, which the
   virtualized table uses to load only the pages on screen. Counts for the sidebar come from one aggregate query.
4. **Selections and bulk actions.** A selection is explicit ids or "all matching this filter" with the
   `expected_total` the user saw; a different count is refused (`SELECTION_CHANGED`). At most 10,000. Changes run in
   transactions of 250 and report each profile as changed, unchanged or failed with a reason. Undo is an in-memory
   token (10 minutes, last 20 actions) that restores only profiles whose version is still the one the action wrote.
5. **Templates and copies.** A template holds configuration only (start pages, permission defaults, tags); never
   notes, storage or sign-ins. A profile from a template, and a duplicated profile, start with empty browser storage.
6. **Import pipeline.** Native dialog → opaque file reference → preview (dry run) that plans every row and binds the
   file's SHA-256 and settings → commit re-reads the file and refuses a changed one → background batches of 250 with
   progress and cancel → job record with row errors. Each created profile stores `import_ref = digest:row` under a
   unique index, so retries never duplicate. One import at a time; jobs left running are marked interrupted at
   start-up.
7. **Formats and adapters.** Only this product's CSV, JSON and bundle formats (schema version 1, documented in
   `docs/import/`). New adapters only for documented or user-supplied formats, each with its own ADR. Configuration
   import is not session migration: no adapter reads cookie or session stores, and a bundle claiming session data is
   refused. Archive checks: traversal, links, encryption, entry list, size, ratio, executable content.
8. **Notes.** Plain text, rendered as text; control and bidirectional-override characters are removed. Notes that
   look like a password, key, token or card number are refused by the API (`NOTES_LOOK_SECRET`), left out on import
   with a warning, and withheld on export. The heuristic is shared by Rust (`pb_import::notes`) and the UI (live
   warning).
9. **Export and authorization.** Export is an allowlist of configuration fields, notes off by default, CSV formulas
   neutralised, written through the native save dialog. Bulk edit, permanent deletion, import and export pass through
   `authz::authorize(action, count)`, today a size check for the local owner; 06 (roles) and 08 (team access) replace
   its body without changing call sites.

## Consequences
- The UI never sees file paths, SQL or folder names; every command validates again in Rust.
- Undo does not survive a restart (tokens are in memory) and cannot undo a permanent deletion — the typed
  confirmation is the safeguard there.
- A continued import skips update rows only within the same preview session; after a restart a new preview treats
  them as ordinary duplicates.
- The secret heuristic can have false positives ("2FA: phone app"); the message tells the user why and how to
  rephrase. False negatives are possible; notes are documented as not encrypted.
- If deleting the metadata fails after the folder was moved aside, the profile stays in the trash without data and
  the next deletion attempt finishes it.

## Evidence / verification
- Storage: `crates/storage/src/tests_m04.rs` (upgrade from v3, folded uniqueness, query, bulk/undo, trash, import
  refs, templates/filters/jobs); `crates/storage/tests/search_latency.rs` (10,000-profile search p95 gate).
- Import engine: `crates/import/src/tests.rs` (CSV/JSON validation, formulas, malicious archives) and
  `crates/import/tests/examples.rs` (documented examples).
- Commands: `apps/desktop/src-tauri/tests/ipc.rs` (paging/cursor/offset, bulk with a running profile and undo,
  deletion safety, templates/duplicates without storage, preview binding and retry without duplicates, 10,000-row
  cancel and resume, unsafe files, export).
- UI: `apps/desktop/e2e/manager.e2e.test.ts` (keyboard selection, bulk + undo, all-matching count, trash and typed
  delete, import preview/commit/cancel/continue, client in launch confirmation, secret notes, axe on every screen).

## Revisit when
Workspaces become shared (06/08: real authorization, server-side undo/audit), cloud sync arrives (07: tombstones for
trash and deletion), or a customer supplies another tool's documented export format (new adapter ADR).
