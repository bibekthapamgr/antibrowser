# Milestone 04 — usability walkthrough

Date: 2026-10-13. Build: manager 0.4.0, production bundle in demo mode (the same React code as the app, with the
in-memory backend that mirrors the Rust rules). Screens: 1180×760 for screenshots, 900×600 (minimum window) and 2×
scale for layout checks, light and dark. Screenshots: [docs/design](../design/).

**Method and limits.** A task-based expert walkthrough by the engineering team, checked against the usual
heuristics (visibility of status, error prevention, recovery, recognition over recall, consistency) and scripted
end to end in `apps/desktop/e2e/manager.e2e.test.ts`, so every step below is re-run on each CI build. It is **not**
a study with real users. Before the team beta (after milestone 08), run 3–5 moderated sessions with agency staff who
manage many client accounts; the tasks below are the script.

## Tasks

| # | Task (what the user wants) | Path | Result |
|---|---|---|---|
| 1 | Create a profile for a client | **New profile** → name → client (suggested from existing clients; a new name creates one) → optional template → Create | Works with a name only. The toast names the client: “Profile “Shop admin (Client North)” created.” |
| 2 | See one client's profiles | Sidebar › Clients › *Client North* | Folder list shows counts; the heading shows “Client North · 1 profile”. Clients without a colour get the same automatic colour as their badge |
| 3 | Find a profile without knowing the exact spelling | Search “ÃDS” | Finds “Ads QA”: case and accents are ignored; client and tag names are searched too |
| 4 | Tag several profiles at once, then change one's mind | Space on two rows (or click the boxes) → **Add tag…** → type → Add to 2 → **Undo** | Bulk bar always says “2 selected of 3”; result line “Tagged 2 profiles”; Undo puts back only profiles nobody changed since |
| 5 | Act on everything that matches, across pages | Header checkbox (selects the 200 loaded) → **Select all 10,000 matching** → **Add tag…** | Bar: “All 10,000 matching profiles selected”; dialog title “Add a tag to 10,000 selected profiles”. If the matching set changes before confirming, the action is refused with an explanation instead of touching a different set |
| 6 | Clean up an old profile | Drawer › **Move to trash** (only when closed) → Sidebar › Trash → **Restore** or **Empty trash…** → type DELETE | Open profiles can't be trashed (the button explains why). The trash says when profiles are deleted for good; deletion needs DELETE and states the count and what is lost |
| 7 | Bring in profiles from a spreadsheet | **Import…** → Choose file → preview → choose duplicate handling → **Import 5 profiles** → summary | Preview shows new/updates/duplicates/already imported/errors/warnings before anything is written; each bad row lists line, field and problem; the table updates by itself afterwards |
| 8 | Stop a long import and resume later | **Cancel import** → **Continue import** | Cancelling keeps imported rows; continuing finishes without duplicates; progress stays in the sidebar if the dialog is hidden; history is in Downloads and updates |
| 9 | Share configuration with a colleague | Select → **Export…** → format → (notes off by default) | Says plainly what is and isn't exported; secret-looking notes are withheld even when notes are included |
| 10 | Keep a password “handy” in notes | Type “Password: …” in Notes | Live warning under the field; Save explains why it is refused and where secrets belong |
| 11 | Open the right account | Drawer › **Open profile** | Toast: “Opening Shop admin (Client North)…”; the client badge sits under the profile name in the drawer |
| 12 | Reopen a saved set of filters | **Save view…** → name → sidebar › Saved views | The view restores folder, search, tag/status filters and sort; × deletes it |

## Issues found during the walkthrough

| Finding | Severity | Status |
|---|---|---|
| Duplicate-handling radios rendered above their labels in the import dialog | Medium (hard to scan) | Fixed (label layout) |
| Client dots in the sidebar were grey unless a colour was set, unlike the badges | Low | Fixed (same automatic colour) |
| Proxy and sync columns disappeared below ~1,300 px window width | Low (placeholders) | Fixed: shown from ~1,150 px; below that they hide first, then tags and last used (below ~1,030 px); all are always in the drawer |
| The scrollable content area could not be reached by keyboard on short screens (axe: scrollable region) | Serious (a11y) | Fixed (focusable main region with visible focus) |
| “All 1 matching profile selected” | Low | Fixed (“The 1 matching profile is selected”) |
| An unsafe file showed a disabled “Nothing to import” button next to the error | Low | Fixed (button hidden; the error says nothing was imported) |
| Hidden bidirectional characters ended up literally in source after formatting | Engineering | Fixed (built at run time; noted in the security model) |

## Open questions for user sessions

- Is **Remove tag…** discoverable enough from the bulk bar, or should tag chips in the table be removable directly?
- Does the drawer need tabs (Overview / Settings / Recovery) once proxies (05) are added? It is already long.
- Do agencies want **column choice** (e.g. hide tags, show created date)?
- Is “Archive” understood as different from “Trash”? Both are reversible; only the trash expires.
- Should undo survive an app restart? (Today it lasts 10 minutes in the running app; see ADR-0011.)

## Accessibility checks (automated on every build)

axe-core (WCAG 2.1 A/AA + best practice) reports no serious or critical issues on: profiles, empty profiles, selection
with bulk bar, trash, profile drawer, delete confirmation, import preview, unsafe import file, export dialog,
settings (with clients/tags/templates), downloads (with import history), diagnostics and the recovery screens, in
light and dark. Keyboard: the table is one tab stop (arrows, PageUp/PageDown, Home/End, Space to select, Enter for
the drawer); dialogs trap focus and return it; Escape closes dialogs and the drawer.
