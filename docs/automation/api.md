# Developer API reference (v1)

The full schema is [docs/openapi.json](../openapi.json) (generated from the server's route schemas; every route that
accepts API tokens says "API tokens: yes (scopes apply)"). This page explains the parts the schema cannot.
Changes: [api-changelog.md](api-changelog.md). TypeScript: [@pb/sdk](../../packages/sdk/README.md).

## Authentication
`Authorization: Bearer pbt_tok_<26>_<43>` — an API token made in the app (Organization → Automation → API tokens). A
token acts as the member who made it, never with more: a request is allowed only if that member's **current** role and
grants allow it **and** one of the token's scopes includes it. Optional client/profile restrictions narrow it further.
Anything out of reach answers `404 NOT_FOUND`, exactly like an id that does not exist.

| Scope | Allows | Roles that can hand it out |
|---|---|---|
| `profiles:read` | Read the organization, its clients and profiles (`org.read`, `clients.read`, `profile.read`) | owner, admin, operator, viewer |
| `profiles:write` | Create, edit and trash profiles | owner, admin |
| `automation:read` | See jobs and their screenshots, settings, computers | owner, admin, operator |
| `automation:run` | Create and cancel jobs (includes opening a profile: `profile.launch`) | owner, admin, operator |
| `automation:debug` | Debugging sessions (Playwright) | owner, admin |

The generated [permission matrix](../permission-matrix.md) lists every permission per role and per scope.

Tokens expire after 1–365 days, are revoked at once, and can be rotated (the previous secret keeps working for 0–24 h,
default 1 h). At most 25 active tokens per member and organization; 30 created per member per hour. Tokens are managed
only with an interactive sign-in (a token cannot create, rotate or revoke tokens, or manage webhooks or computers).

### Routes that accept tokens (16)
| Method | Path (under `/v1`) | Scope |
|---|---|---|
| GET | `/orgs/{org}` | any scope but `automation:debug` alone |
| GET | `/orgs/{org}/api-tokens/current` | any (the calling token itself) |
| GET | `/orgs/{org}/profiles`, `/orgs/{org}/profiles/{prf}` | `profiles:read` |
| POST, PATCH, DELETE | `/orgs/{org}/profiles`, `/orgs/{org}/profiles/{prf}` | `profiles:write` |
| GET | `/orgs/{org}/clients`, `/orgs/{org}/clients/{cli}` | `profiles:read` |
| GET | `/orgs/{org}/automation/settings`, `/orgs/{org}/automation/agents` | `automation:read` |
| GET | `/orgs/{org}/automation/jobs`, `/orgs/{org}/automation/jobs/{job}` | `automation:read` |
| GET | `/orgs/{org}/automation/jobs/{job}/artifacts/{art}` | `automation:read` |
| POST | `/orgs/{org}/automation/jobs` | `automation:run` (+ `automation:debug` for `debug`) |
| POST | `/orgs/{org}/automation/jobs/{job}/cancel` | `automation:run` (own jobs; `automation.manage` for others') |

Every other route refuses tokens (deny by default; the list is pinned by a test).

## Conventions
- **Errors**: `{ "code", "message", "request_id", "retryable", "safe_details" }`. M10 codes:
  `TOKEN_SCOPE_MISSING` (403), `URL_NOT_APPROVED` (422), `QUEUE_FULL` (429, retry later), `JOB_FINISHED` (409),
  `AGENT_UNAVAILABLE` (409, a chosen computer cannot run the job: `safe_details.reason`),
  `WEBHOOK_DESTINATION_BLOCKED` (422, `safe_details.reason`), `RATE_LIMITED` (429 with `Retry-After`).
- **Idempotency**: `POST /automation/jobs` requires `Idempotency-Key` (8–128 of `[A-Za-z0-9_-]`, kept 24 h). The same
  key with the same body answers the same job (also while the first request is still running); the same key with a
  different body is `IDEMPOTENCY_KEY_REUSED`. Store the key with your own record before sending, and retry with it.
- **Versions**: `PATCH`/`PUT` take `If-Match: "<version>"` (or `expected_version`); a stale version is
  `VERSION_CONFLICT` with `current_version`.
- **Paging**: `limit` (1–100) and `cursor` (`next_cursor` from the previous page).
- **Rate limits** for tokens: 600 requests/min per token and 3,000/min per organization, plus per-route limits (job
  creation 1,000/h per organization).

## Jobs
`POST /v1/orgs/{org}/automation/jobs`
```json
{
  "profile_id": "prf_…",
  "label": "Morning login check",
  "steps": [
    { "action": "open_url", "url": "https://portal.example.com/login", "timeout_ms": 30000 },
    { "action": "wait_for", "condition": { "type": "text", "text": "Welcome" }, "timeout_ms": 15000 },
    { "action": "screenshot", "label": "login" }
  ],
  "keep_open_minutes": 30,
  "agent_id": "agt_…",
  "queue_timeout_seconds": 3600
}
```
- Steps: at most 20; the first must be `open_url`; at most 5 screenshots. Conditions: `selector` (CSS), `text`,
  `title_contains`, `url_prefix` (an approved address). Control characters are refused.
- Every `open_url` address and `url_prefix` must match the organization's approved sites (also checked again when a
  computer takes the job, and by the computer before navigating).
- `keep_open_minutes` (1–480) keeps the profile open after the steps until canceled or the time is up.
- `debug: { "capability_sha256": "<64 hex>" }` (needs `keep_open_minutes` and `automation:debug`): see
  [Playwright](playwright.md).
- `agent_id`: a specific enrolled computer (it must be on, accept the requester's jobs, and allow debugging for a
  debugging job); otherwise any computer that may run it.
- The requester must be able to open the profile (`profile.launch`: owners, admins, operators with the `launch`
  capability). At most 500 queued jobs per organization and 100 per requester.

Answer `201 { "job": Job, "steps": JobStep[], "artifacts": [] }` (a replay answers the same body with `200`).

### States
```
QUEUED ──claim──► CLAIMED ──started (session lease)──► RUNNING ──► SUCCEEDED | FAILED | CANCELED
   │                 │  └─ given back before anything ran ─► QUEUED (at most 5 claims)
   └─ cancel, queue timeout ─► CANCELED / FAILED (QUEUE_EXPIRED)
```
`GET …/jobs?state=QUEUED|CLAIMED|RUNNING|SUCCEEDED|FAILED|CANCELED|active|finished&profile_id=&agent_id=&mine=true`
lists jobs on profiles you can see; `GET …/jobs/{job}` adds steps and screenshots. Steps carry `state`
(`pending`, `running`, `succeeded`, `failed`, `skipped`, `canceled`, `outcome_unknown`), `attempt` (how many times it
started; more than 1 only for steps that are safe to repeat), `error_code` and a typed `output` (`final_origin`,
`http_status`, `elapsed_ms`, `artifact_id`, `width`, `height`, `backup`, `endpoint`, `restored`, `browser_version`) —
never page content.

`reconciliation_required: true` means a step's outcome could not be known (a lost connection after a step with an
external effect started). Such a step is never repeated automatically. v1 has no such step; the flag exists for when one
is added.

### Error codes of a job
`TIMEOUT`, `NAVIGATION_FAILED`, `PAGE_LEFT_APPROVED_SITES`, `CONDITION_NOT_MET`, `BROWSER_CLOSED`, `LEASE_LOST`,
`PROFILE_IN_USE`, `PROFILE_NOT_AVAILABLE`, `RESTORE_FAILED`, `LAUNCH_FAILED`, `BACKUP_PENDING` (closed, but the closing
backup waits on the computer for its person), `AGENT_LOST` (the computer did not come back within 10 minutes),
`CANCELED`, `OUTCOME_UNKNOWN`, `QUEUE_EXPIRED`, `UNSUPPORTED_BROWSER`, `DEBUG_NOT_ALLOWED`, `ARTIFACT_TOO_LARGE`,
`ACCESS_REMOVED` (the requester or token lost access before a computer took the job), `URL_NOT_APPROVED`,
`TOO_MANY_ATTEMPTS`, `INTERNAL`.

### Cancel
`POST …/jobs/{job}/cancel` (`{ "reason": "…" }`, optional): `QUEUED`/`CLAIMED` → `CANCELED` at once; `RUNNING` →
`cancel_requested_at` is set and the computer stops before the next step, closes the profile (closing backup) and
reports `CANCELED`. Stopping a profile held open (`hold_open`) ends the job as `SUCCEEDED`. A finished job answers
`JOB_FINISHED`.

### Screenshots
`GET …/jobs/{job}/artifacts/{art}` returns the image (`image/jpeg`, or `image/png`), at most 1.5 MiB, for 7 days.

## Settings and computers
- `GET/PUT /v1/orgs/{org}/automation/settings`: `allowed_origins` (at most 50; `https://app.example.com`,
  `https://*.example.com` — any subdomain, not the name itself —, `http://localhost:3000`; lowercase ASCII,
  punycode for international names) and `max_running_jobs` (1–50, all computers together). Owners and admins.
- `GET /v1/orgs/{org}/automation/agents`: enrolled computers (person, platform, browser version, on/off, whose jobs it
  takes, capacity, whether it allows debugging, online, running jobs). `PATCH`/`DELETE …/agents/{agt}`: its person, or
  owners and admins. Enrolling and polling are done by the desktop app itself.

## Tokens (interactive only)
`GET /v1/orgs/{org}/api-tokens[?all=true&state=all]`, `POST /v1/orgs/{org}/api-tokens`
(`{ name, scopes, client_ids?, profile_ids?, expires_in_days }` → `{ token, secret }`, the only time the secret is
returned), `POST …/api-tokens/{tok}/rotate` (`{ grace_minutes? }` → `{ token, secret }`), `DELETE …/api-tokens/{tok}`.

## Webhook endpoints (owners and admins, interactive only)
`GET/POST /v1/orgs/{org}/webhook-endpoints`, `GET/PATCH/DELETE …/{whk}`, `POST …/{whk}/rotate-secret`,
`POST …/{whk}/test`, `GET …/{whk}/deliveries?state=pending|delivered|dead`,
`POST …/{whk}/deliveries/{dlv}/redeliver`. See [webhooks.md](webhooks.md).

## Endpoints used only by the desktop app
`POST …/automation/agents` (enroll this device), `POST …/agents/{agt}/poll`, `POST …/jobs/{job}/report`
(`started`, `step_started`, `step_finished`, `released`, `finished`) and `PUT …/jobs/{job}/steps/{seq}/artifact`
need an interactive session of the computer's own person and device; reports from another computer or an older claim
answer `JOB_CLAIM_STALE`. They are documented in the OpenAPI file for completeness.
