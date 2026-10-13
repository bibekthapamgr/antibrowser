# Agency workspace and technical health (milestone 09)

Work client by client: a dashboard per client, tasks and shared start pages for the team, downloads kept apart,
browser extensions under the organization's control, and a health page that says what works right now — each result
with the time it was checked.

| Document | What it covers |
|---|---|
| [ADR-0016](../adr/0016-agency-workspace-and-technical-health.md) | Decisions: dashboards that inherit reach, tasks and bookmarks as app records, extension inventory and policy, health with check times, resources, downloads, client identity, diagnostics, notifications |
| [extension-policy.md](extension-policy.md) | For owners and admins: modes, rules, version ranges, sensitive permissions, what members see, limits |
| [health.md](health.md) | Definitions of every health card: what is checked, how long a result counts, what each status means |
| [diagnostics.md](diagnostics.md) | What the diagnostics report contains, what is removed and how, size and retention, redaction tests |
| [Permission matrix](../permission-matrix.md) | `tasks.write`, `extensions.manage` and who sees dashboard people and activity |

## Journeys and where they live
| Journey | Desktop | API / shell command |
|---|---|---|
| See a client at a glance (organization) | Organization → Clients → Dashboard: profiles you can see, who has them open, backups, people (owners/admins), tasks, bookmarks, recent app activity (owners/admins) | `GET /v1/orgs/{org}/clients/{cli}/dashboard` |
| See a client at a glance (this computer) | Profiles → choose the client → Client overview: counts, last opened, last safety copy, recent app activity, downloads | `get_client_overview` |
| Tasks and checklists | Dashboard → Tasks: add (profile, assignee, due date), tick off, reopen, take, delete | `GET/POST /v1/orgs/{org}/clients/{cli}/tasks`, `PATCH/DELETE …/tasks/{tsk}` (If-Match) |
| Shared bookmarks / start pages | Dashboard → Shared bookmarks: add (http/https only), reorder, remove, copy; "Use these as start pages" for the client's profiles on this computer | `GET/POST /v1/orgs/{org}/clients/{cli}/bookmarks`, `PATCH/DELETE …/bookmarks/{bkm}` |
| Decide which extensions may be used | Organization → Extensions: mode, reported extensions (Allow, Block, Approve its access), rules, Save | `GET/PUT /v1/orgs/{org}/extension-policy` (If-Match), `GET /v1/orgs/{org}/extension-inventory` |
| See extensions in profiles | Health → Extensions: per profile, version (and previous), source, access, the organization's verdict; "Mark as reviewed" for local profiles | `get_extensions`, `rescan_extensions`, `review_extension`; the shell reports with `PUT /v1/orgs/{org}/profiles/{prf}/extension-report` |
| Is everything working? | Health: nine cards with status in words, check time, validity and a button (Check again, Check all proxies, …) | `get_health`, `run_health_check` |
| What do open profiles use? | Health → Resources: processes and memory per profile, the manager apart, free memory, the estimate | `get_resources` |
| Opening many profiles | A question only when memory looks short or extensions will be turned off | `check_launch` |
| Downloads per client | Settings → Downloads → "Give each client its own folder"; Client overview → "Choose a folder for this client…" | `select_client_download_directory`, setting `downloads.per_client_folders` |
| Bulk changes | Trash, archive, move, proxy changes and permanent deletion first list the clients and profiles | `selection_summary` |
| Find anything | Ctrl+K / ⌘K: screens, checks, profiles by name or client; `?` lists shortcuts | — |
| What needs me | Notifications (sidebar): failed or conflicting backups, sessions waiting or ended, extensions turned off or asking for more access, long-open profiles, a full disk; reconnect banner | events `sync`, `team`, `warning` |
| Help from support | Health → Diagnostics → Preview and save report… | `preview_diagnostics`, `export_diagnostics` |

The handoff file names `GET /v1/clients/{id}/dashboard` and `CRUD /v1/clients/{id}/tasks`; like every route since
milestone 06 they live under the organization (`/v1/orgs/{org}/clients/{cli}/…`).

## Identifying the active client
Without relying on colour: the browser's profile menu shows "<profile> · <client>", and every profile of a client
shows the same built-in Chromium profile picture in the toolbar (chosen from the client, so it is the same on every
computer). The client colour is applied as the browser theme too. In the manager, the client name is shown with every
profile (list, confirmations, notices, the palette, resource use).

## Measurements
Dashboard at 10,000 profiles in one client (API test with 10,000 profiles, a past session each and 30,000 audit events,
local PostgreSQL 16, in-process requests, 15 requests each): owner median 118 ms (max 159 ms); operator with 5
granted profiles median 23 ms (max 34 ms). The test fails above a 500 ms median; the roadmap target for metadata reads
is p95 ≤ 250 ms in the primary region. The desktop profile list itself was already windowed for 10,000 rows
(milestone 04).
