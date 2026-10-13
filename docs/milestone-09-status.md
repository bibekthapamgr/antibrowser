# Milestone 09 — status against the handoff file

Agency productivity and technical health. Version 0.9.0. Decisions:
[ADR-0016](adr/0016-agency-workspace-and-technical-health.md). Deliverables: agency workspace UI,
[extension policy docs](agency/extension-policy.md), [health definitions](agency/health.md),
[diagnostics redaction](agency/diagnostics.md) with tests. Overview: [agency/README.md](agency/README.md).

Outcome: clear client context (dashboards, tasks, shared start pages, downloads per client, the client visible in the
browser without relying on colour), useful diagnostics (health with check times, resources, a previewed and redacted
report) and safe extension management (inventory, organization policy, enforcement with the browser's own switch).

## Features
| Required | Implemented |
|---|---|
| Client workspace dashboard: profiles, assigned operators, recent app activity, tasks, bookmarks | Organization → Clients → Dashboard (`GET /v1/orgs/{org}/clients/{cli}/dashboard`): profiles the caller can see with who has them open, last opened in the app and backup state; people with grants (owners/admins); open tasks; bookmarks; recent app activity (owners/admins). Local clients: Profiles → client → Client overview |
| Profile/client name and colour in a supported browser surface | Profile name "<profile> · <client>" (profile menu), the client colour as the browser theme, and a built-in Chromium profile picture per client in the toolbar (`profile.avatar_index` 27–55, same on every computer) |
| Per-client downloads folders | A folder per client (native dialog) or "Give each client its own folder" (subfolder named after the client); a profile's own folder still wins |
| Search/command palette and keyboard shortcuts | Ctrl+K / ⌘K: screens, checks, organizations, profiles by name or client (open or show settings); Ctrl/⌘+1…6 screens; `?` shortcut list |
| Health cards: connectivity, browser updates, backup freshness, sync conflicts, disk space, active locks | Health: server connection, proxies, browser, backups, sync conflicts, disk space, open profiles and sessions, extensions, memory — each with status in words, check time, validity and a button ([definitions](agency/health.md)) |

## Ordered implementation
| Step | Implemented |
|---|---|
| 1. Dashboard from scoped metadata; no browser histories; "last activity" is app activity | Counts, items and activity computed over `profileVisible`; activity from `audit_events` targeting the client or its profiles; local overview from the local audit log; nothing reads history or page state |
| 2. App-owned tasks with owner, due date, profile links; completion implies nothing on a website | `client_tasks` (status, due date, optional profile and assignee, who ticked it off and when); scope-aware visibility; operators assign only themselves; secret-looking text refused; the UI says completion is an app record |
| 3. Shared bookmarks/start-page templates: http/https only, executable schemes rejected, labels sanitized | `client_bookmarks` with `bookmarkUrlProblem` (scheme, credentials, whitespace/control characters, length) in contracts, API, database `CHECK` and the form; labels cleaned of control and bidi characters; "Use these as start pages" sets a local profile's start URLs (passed after `--`) |
| 4. Extension inventory (source, version, permissions, install status) and organization allowlist; supported install paths, no bypass | Inventory read from Chromium's `Preferences`/`Secure Preferences` and manifests (component extensions left out; format checked on Chromium 141); `extension_policies` + organization mode; reports from each device (`PUT …/extension-report`, shell only); admin inventory (`GET …/extension-inventory`); nothing is installed, loaded or re-signed |
| 5. Staged, observable updates; block or warn on newly expanded sensitive permissions; per-profile extension data | Every scan records version changes and added sensitive permissions (audited, notified); judged at the next open: enforce opens with `--disable-extensions`, warn tells the person; local profiles review themselves; each profile has its own user-data directory |
| 6. Diagnostics page: actionable failures, last-checked times, retry; an old proxy check is not "connected" | Health cards with check times, validity and retry buttons; proxy checks older than 24 h and expired server checks show "Unknown" |
| 7. Safe diagnostic export: preview, redaction, size limit, retention; versions, operation ids, summarized errors | `preview_diagnostics` shows exactly the text to be saved; sections exclude personal data by construction, then every string is redacted; 1 MiB limit; previews live 10 min in memory and are saved once ([details](agency/diagnostics.md)) |
| 8. Resource panel per profile tree, manager separately; warn before launching too many from measured free memory | Health → Resources (processes and memory per tracked tree, the manager apart, other browsers never counted); `check_launch` asks only when free memory minus 1 GB is below the measured median × profiles to open |
| 9. Accessible notifications and reconnect UI; critical sync errors persist; no endless toasts | Repeated toasts are counted, not stacked; a notification centre keeps failed/conflicting backups, waiting or ended sessions, extensions turned off or asking for more access, long-open profiles and a full disk until resolved or dismissed; reconnect banner with one "Try again" |

## Records / API
| Required | Implemented ([OpenAPI](openapi.json)) |
|---|---|
| `client_tasks(id, org_id, client_id, profile_id?, assignee_id, title, status, due_at)` | Migration 0006: plus notes, created_by, completed_by/at, version; composite keys, RLS, assignee unassigned when they leave |
| `bookmarks(id, org_id, client_id, title, url)` | `client_bookmarks` plus position, version; at most 50 per client |
| `extension_policies(org_id, extension_id, source, approved_version_range, permissions)` | Plus name, decision (allowed/blocked); organization `extension_mode` and `extension_policy_version`; `extension_reports` per profile and device |
| `health_observations(profile_id, check_type, result, checked_at, expires_at)` | Desktop SQLite v9 (device-local): plus subject, code, detail; also `extension_inventory`, `extension_scans`, `extension_policy_cache`, `clients_local.download_dir` |
| `GET /v1/clients/{id}/dashboard`; CRUD `/v1/clients/{id}/tasks`; `GET /v1/orgs/{org}/extension-policy` | Under the organization like every route since 06: `GET /v1/orgs/{org}/clients/{cli}/dashboard`, `GET/POST …/tasks`, `PATCH/DELETE …/tasks/{tsk}`, `GET/POST …/bookmarks`, `PATCH/DELETE …/bookmarks/{bkm}`, `GET/PUT /v1/orgs/{org}/extension-policy`, `GET /v1/orgs/{org}/extension-inventory`, `PUT /v1/orgs/{org}/profiles/{prf}/extension-report` |
| Aggregates inherit permissions; hidden profile counts never leak | Tested: an operator with one granted profile sees `total: 1` and no names of the others; people and activity are `null` without `grants.manage` / `audit.read`; cross-tenant swaps answer like nonexistent ids on every new route |

## Error-prevention design
| Required | Implemented |
|---|---|
| Before a sensitive bulk action show client names, selected profiles and the operation | Trash, archive, move, proxy changes and permanent deletion first list each client with its profile count and names (`selection_summary`, also for "all matching"), open and shared profiles |
| Do not claim to intercept third-party buttons | Confirmations say "Only what this app controls changes. Nothing is done on websites, and actions inside open browser windows are not intercepted." |
| Downloads naming sanitizes labels, no path traversal; moving a client folder does not move in-progress downloads | `folder_name` replaces separators and reserved characters, trims dots and spaces, suffixes Windows device names, 64 characters; the folder must sit directly in the base; Chromium reads the folder at the next open, nothing is moved |
| Suspend/close inactive profiles only after warning and per explicit settings; never discard unsynced work | Never automatic: an optional reminder ("open for over N hours") with a "Close it" button the person chooses; the app cannot see unsaved page work |

## Acceptance
| Criterion | Evidence |
|---|---|
| The active client is identifiable without relying on colour | Profile menu name with the client, a per-client toolbar picture (desktop test checks `avatar_index` and the name; verified in Chromium 141 screenshots), client name with every profile in the manager |
| Health never shows account "ban risk" as a technical certainty | No such card or wording; desktop test asserts "ban", "suspend", "detect", "risk score" are absent; UI e2e repeats it |
| A forbidden extension is rejected | Desktop test: a blocked extension in enforce mode → the browser starts with `--disable-extensions`, `EXTENSIONS_DISABLED` notice, audit `extension disabled`; allowed again → normal start; warn mode → notice only |
| Diagnostics contain no fixture secrets | Desktop test with a proxy login, page address, e-mail address, token and server address (built at run time): none in the preview, which still has versions, operation ids and the error code; unit tests for each redaction rule |
| Resource counts exclude unrelated browsers | Desktop test: an unrelated Chrome with 6 GB is not counted; per-profile tree = main + renderer |
| Dashboard list remains responsive at 10,000 profiles | API test with 10,000 profiles, 10,000 past sessions and 30,000 audit events: owner median 118 ms (max 159 ms), operator median 23 ms ([measurements](agency/README.md#measurements)); the desktop list stays windowed at 10,000 rows (milestone 04 e2e) |
| Agency workspace UI, extension policy docs, health definitions, diagnostics redaction tests | Delivered (links above); UI e2e with axe in light and dark at 900×600 for 11 new screens |

Test counts: Rust 292 across the workspace (new: desktop agency 6, extension reader and shared policy vectors 3,
launch switches 1, storage 2, diagnostics redaction 4, client pictures 1, folder names and dates 2); API 367 locally (+ Keycloak
and real-S3 tests in CI; new: 13 agency scenarios including the 10,000-profile timing, 8 operations × 5 roles in the
role matrix, every new route in the cross-tenant swaps); contracts 14 (shared policy vectors); UI unit 30; UI end-to-end
157 (9 new flows plus 11 new screens in light and dark with axe); worker 7.

CI: see the end of this document.
