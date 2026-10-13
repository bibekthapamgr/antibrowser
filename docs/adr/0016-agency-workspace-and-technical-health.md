# 0016 — Agency workspace, extension policy and technical health
Status: **Accepted (beta track)**. Date: 2026-10-14. Owner: technical lead + UI lead. Builds on ADR-0013 (roles,
grants, tenant isolation), ADR-0014 (backups) and ADR-0015 (sessions) for milestone 09.

## Context
Agencies work client by client. Milestone 09 asks for a clear client context (dashboards, tasks, shared bookmarks,
per-client downloads, the client visible in the browser), safe extension management, useful diagnostics and health,
resource awareness, and notifications people can act on — without inventing website or account status, without
loading browser histories, and without bypassing the browser's own security.

## Decision
### Client dashboards inherit reach
`GET /v1/orgs/{org}/clients/{cli}/dashboard` answers from metadata only: profiles the caller can see (counts, who has
each open — session leases, last opened in the app — `lease_history`, backups), people with grants on the client (only
for `grants.manage`), open tasks, bookmarks and recent app activity (audit events targeting the client or its
profiles, only for `audit.read`). Every count is computed over `profileVisible`, so a hidden profile is never counted,
named or hinted at. The handoff file's `/v1/clients/{id}/…` routes live under the organization like every route since
06 (`/v1/orgs/{org}/clients/{cli}/…`). A local overview (`get_client_overview`) does the same for a client of a local
workspace from the local audit log.

"Last activity" is what the app did (opened, closed, backed up, changed). Nothing reads browser history, page titles or
website state.

### Tasks and bookmarks are app records
`client_tasks` (title, notes, status open/in_progress/done, due date, optional profile, optional assignee, who ticked
it off and when) and `client_bookmarks` (title, http(s) URL, position) belong to a client of the same organization
(composite keys, RLS). A task about a profile is visible with that profile; a task about the whole client to members
with a whole-client grant, its assignee and its creator. Operators (`tasks.write`, new) add tasks to what they reach,
assign only themselves, cannot take a task from someone else and delete only their own; owners and admins manage all.
Completing a task records an app event and implies nothing about a website. Notes and titles that look like secrets
are refused (`NOTE_LOOKS_SECRET`), as for profile notes.

Bookmarks are managed with `clients.manage`, at most 50 per client, `http://` or `https://` only — no user name or
password in the address, no whitespace or control characters (`bookmarkUrlProblem`, also a database `CHECK`). Labels
are cleaned of control and bidirectional-override characters. A bookmark becomes a start page only when someone sets
it on a profile on their computer; start URLs are still passed after `--` on the command line (milestone 03), so a
URL can never become a switch.

### Extension policy: judge what Chromium installed, never install or bypass
- **Inventory** is read passively from each profile's own `Default/Preferences` and `Default/Secure Preferences`
  (`extensions.settings`: location, path, creation flags, disable reasons, granted permissions) and each extension's
  `manifest.json` (name with `_locales`, version, permissions, host permissions, content-script matches). Component
  extensions (locations 5 and 10) are part of the browser and left out. Source: Chrome Web Store (internal location
  with the `FROM_WEBSTORE` flag or the Web Store update URL), policy (7, 9), another program (2, 3, 6), developer
  folder (4, 8). Format checked against a Chromium 141 profile.
- **Policy** (`extension_policies`, organization `extension_mode` and version): per extension `allowed` or `blocked`,
  source `web_store` or `any`, an approved version range (`1.2.3`, `1.2.*`, `>=1.2 <2`) and the sensitive permissions
  approved. Judgement (`judgeExtension` / `extensions::judge`): not listed, blocked, source not allowed, version not
  approved, permissions need review (a sensitive permission — every-site host patterns, cookies, webRequest,
  debugger, nativeMessaging, … — not in the approved list), or approved. TypeScript and Rust implement it identically
  and run the same vectors (`packages/contracts/fixtures/extension-policy-cases.json`).
- **Modes**: `off` (inventory only), `warn` (people are told after the profile opens), `enforce` (a profile with any
  installed extension that is not approved — enabled or not, since it could be turned on in the browser — opens with
  Chromium's own `--disable-extensions` for that session). Chromium enterprise policies were not used: they are
  machine-wide and need administrator rights. `--load-extension` and `--disable-extensions-except` (which load folders
  without Web Store signatures) are never accepted.
- **Staged, observable updates**: every scan records version changes and newly added sensitive permissions (audited
  `extension updated` / `permissions_added`, a notification on the desktop). Chromium updates Web Store extensions on
  its own while it runs; the change is judged at the next open, so an update outside the approved versions or asking
  for more access is held back (enforce) or reported (warn) until an admin approves it. On local profiles the person
  reviews the added access themselves.
- **Reports**: after an open and after a session ends, the desktop sends each organization profile's inventory with
  its own device id (`PUT …/profiles/{prf}/extension-report`, the shell only); admins see the aggregate
  (`GET …/extension-inventory`). The desktop caches each organization's policy (`GET …/extension-policy`, readable by
  every member) and refreshes it before opening an organization profile when older than 5 minutes.
- Extension data stays separate per profile: every profile has its own user-data directory.

### Health: results with times, never account claims
Health cards cover the server connection (a signed-in `GET /v1/me`, valid 15 minutes), proxies (the last user-started
check counts for 24 hours, older is "unknown"), the browser (installed and verified against the signed manifest),
organization backups, sync conflicts and handoffs waiting, disk space, open profiles and sessions held, extensions and
memory. Each says when it was checked and, where it applies, until when it counts; an expired result is "unknown",
never the last result. Device-local results that need time or the network are stored in `health_observations`
(SQLite, check type, subject, result, code, checked and expiry times). Health never states anything about website
accounts (no "ban risk"); a test asserts the words are absent.

### Resources and the memory check
Per profile: the process count and resident memory of the browser tree this app started or re-attached (main process
and descendants); the manager and its own helper processes are counted separately; other browsers are never counted.
Memory is RSS (working set on Windows), so shared pages count in each process — shown as an approximation. Before
opening, `check_launch` compares free memory with the median of this computer's own measurements (or 450 MB before
any) times the profiles to open, plus 1 GiB kept free; the app asks before opening only when that does not fit or when
extensions will be turned off. The estimate is about this computer, not a promise about a website.

### Downloads, client identity and reminders
- A client can have its own downloads folder (chosen in the native dialog, validated like other folders), and the
  setting `downloads.per_client_folders` puts profiles of a client into a subfolder named after it (characters folder
  names cannot have replaced, no leading/trailing dots or spaces, Windows device names suffixed, 64 characters; the
  folder is checked to sit directly inside the base). A profile's own folder still wins. Chromium reads the folder when
  the profile opens; changing it never moves files or in-progress downloads.
- The client is identifiable in the browser without relying on colour: the profile name `"<profile> · <client>"`
  (profile menu, milestone 04) and one of Chromium's built-in profile pictures chosen from the client id (indices
  27–55, the toolbar shows it), in addition to the client colour. `--window-name` was tested and does not change the
  window title in Chromium 141, so it is not used.
- Profiles are never suspended or closed automatically: the app cannot see unsaved work in a page. An optional
  reminder (`profiles.open_reminder_hours`) offers to close a profile open for long; closing is the person's choice.

### Diagnostics
The report is assembled from fixed sections (versions, store and runtime state, operations with their ids and error
codes, recent app activity, an error summary, health statuses, resource use by profile id, settings, extension ids and
versions) — never proxy addresses, logins, page addresses, notes, or profile and client names. Every string then goes
through a redactor (home folder → `~`, web and other addresses → `<address>`, e-mail and IP addresses, values after
secret-sounding words, long opaque tokens; the user name last), and keys that sound secret lose their value. The
report is limited to 1 MiB (the longest lists are halved until it fits). The person sees exactly the text that will be
saved (`preview_diagnostics`); saving (`export_diagnostics`) writes that preview once; previews live 10 minutes in
memory. Nothing is uploaded.

### Notifications and confirmations
Repeated toasts are merged (a counter instead of a stack); what needs the person — a failed or conflicting backup, a
lost, pending, taken-over or revoked session, extensions turned off, an extension asking for more access, a long-open
profile, a full disk — stays in a notification centre until resolved or dismissed. A banner explains when the
organization server cannot be reached or the session ended, with one "Try again" (no retry loop). Bulk actions that
change or remove profiles (trash, archive, move to another client, proxy changes, permanent deletion) first show the
clients, profile names and the operation (`selection_summary`, also for "all matching"). The app does not claim to
intercept buttons inside websites.

## Consequences
- Enforce mode cannot stop an extension from being installed during a session (there is no per-profile Chromium
  policy without machine-wide administration); it is found when the session ends and the next open runs with
  extensions off. Admins see it in the inventory.
- Turning extensions off is all or nothing for that session: Chromium has no supported per-extension switch that keeps
  Web Store signature checks.
- The memory estimate improves as this computer measures profiles; it never accounts for what a particular site will
  use.
- Tasks and bookmarks exist for organization clients; local workspaces have the overview, downloads and extensions.
- The profile picture overrides one chosen inside Chromium for profiles that have a client (like the name and colour).

## Evidence / verification
- API: `services/api/test/agency.test.ts` (dashboard visibility without hidden counts, task scope and assignment rules,
  completion audit, paging, secrets in notes, bookmark scheme and credential refusal, limit, policy versioning and
  validation, reports and inventory, a 10,000-profile dashboard timing), role matrix and cross-tenant swaps for every
  new route.
- Desktop: `apps/desktop/src-tauri/tests/agency.rs` (forbidden extension → `--disable-extensions`, warn mode,
  approval; update review on local profiles; download folders inside the base, client picture; selection summaries;
  resource counts excluding an unrelated browser; health times and wording; diagnostics with fixture secrets),
  `crates/runtime/src/extensions.rs` (shared vectors, Chromium-format profile), `crates/storage/src/agency.rs`,
  `apps/desktop/src-tauri/src/diagnostics.rs`, `crates/runtime/src/launch.rs`.
- UI end-to-end with axe for every new screen in light and dark mode.

## Revisit when
- Chromium offers per-profile extension policies without machine administration (then enforce could block installs).
- Milestone 10 automation needs task or bookmark APIs beyond the dashboard.
- Measured memory per profile shows the 450 MB default is far off on supported hardware.
