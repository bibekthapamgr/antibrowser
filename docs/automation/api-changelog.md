# API changelog

The API is versioned in its path (`/v1`). Within `v1`, changes are additive: new routes, new optional request fields,
new response fields and new enum values (clients must ignore unknown fields and treat unknown enum values as
"other"). A breaking change needs a new path version and a deprecation period announced here first. The OpenAPI
document ([docs/openapi.json](../openapi.json)) is regenerated and checked in CI on every change.

## 0.15.0 — 2026-10-15 (R3: unified profiles and simple team sharing)
Added (see ADR-0022; nothing removed or renamed)
- Grant scopes `folder_id` (a folder's profiles, including ones added later) and `all_profiles` (every profile of the
  workspace, including ones added later) on `Grant` and `POST /orgs/{org}/grants`; exactly one scope per grant.
- `POST /orgs/{org}/access/preview` (`members.manage`): what an access choice (`all` / `folder` / `profiles` / `client`,
  with `include_future` for all and folder) reaches now, by name, and what it allows — before anything is granted.
- `POST /orgs/{org}/invitations` accepts optional `access` (`{ scope, capabilities? }`, members and viewers only;
  viewers never get capabilities); it is applied in the same transaction that accepts the invitation.
- `PUT /orgs/{org}/members/{user}/access` (`grants.manage`): replaces an operator's or viewer's grants with one access
  choice and ends sessions they may no longer hold (event `grant.access_set`).
- `GET /orgs/{org}/profiles/{prf}/folder-impact?folder_id=fld_…|none`: who would gain or lose access by a move, and
  whether the caller may make it.
- `Profile.folder_id` in lists, single reads, create and update answers; `GET /orgs/{org}/profiles?folder_id=fld_…|none`;
  optional `folder_id` when creating a profile.

Changed (visible to clients)
- `PUT /orgs/{org}/profiles/{prf}/folder`: a move that changes who can reach the profile needs `grants.manage`
  (`403 FORBIDDEN`, `permission: grants.manage`) and ends the sessions of people who lose access.
- The feature setting `ui.unified_profiles` defaults to `true` (the R3 desktop view; `false` is the rollback).

## 0.14.0 — 2026-10-15 (R2: self-service accounts and automatic onboarding)
Added (see ADR-0021; nothing removed or renamed)
- `GET /onboarding/status`, `POST /onboarding/complete`: onboarding decided by the server (invitations first, one
  personal workspace with a trial per direct signup, returning people selected, a choice once among several owned
  workspaces). The body never names a user, role or e-mail; a plan is an intent (catalog id), never a price.
- Customer portal session (backend-for-frontend): `GET /web/config`, `GET /web/auth/login`, `GET /web/auth/callback`,
  `GET /web/auth/session`, `POST /web/auth/logout`, `POST /web/auth/revoke-all`. An HttpOnly cookie, CSRF token and
  Origin check on changes; only routes marked for the portal accept it (`/me`, `/me/workspaces`, `/me/capabilities`,
  `/me/onboarding`, `/onboarding/*`, `/invitations/{token}` and its accept, `GET /orgs/{org}`). Static page at `/app/`.
- `POST /orgs/{org}/invitations` answers `email_delivery: "queued" | "not_configured"` (the worker e-mails the link
  when the server has a mail server).
- Error codes `TERMS_REQUIRED`, `WORKSPACE_SUSPENDED`, `ACCOUNT_SUSPENDED`, `CSRF_FAILED`.

Changed (visible to clients)
- A further workspace of the same person or verified address (`POST /organizations` too) shares the earlier trial
  clock instead of starting a new trial.
- Accepting an invitation into a suspended workspace answers `WORKSPACE_SUSPENDED`; into a workspace whose seats are
  now full, `PLAN_LIMIT_REACHED` (`limit: seats`). Retrying an accepted invitation still answers `INVITATION_USED`.
- `GET /me/onboarding` may report the new state `choose`.

## 0.13.0 — 2026-10-14 (R1: product contracts and safe migration foundation)
Added (all additive; no route, table or column was removed or renamed — see ADR-0020)
- `GET /me/capabilities`: capability negotiation (`features`, `minimum_desktop_version`, `latest_desktop_version`).
  Accepts API tokens.
- `GET /me/onboarding`: the caller's onboarding state (`new` / `invited` / `ready`) and default workspace.
- Folders: `GET/POST /orgs/{org}/folders`, `PATCH /orgs/{org}/folders/{fld}`,
  `PUT /orgs/{org}/profiles/{prf}/folder`. Folders organize profiles and are never a grant scope; `GET …/folders`
  accepts API tokens with `profiles:read`.
- Per-workspace feature settings: `GET/PUT /orgs/{org}/feature-settings` (`ui.unified_profiles`, `modules.agency`,
  `modules.automation`; owner/admin). The desktop's rollback switch is `ui.unified_profiles = false`.
- Migration runs (desktop devices): `POST /orgs/{org}/migration-runs` (upsert per device and manifest digest;
  counts and checkpoint only, never names or secrets), `GET /orgs/{org}/migration-runs/{mgr}` (owner).
- `POST /orgs/{org}/local-import` takes an optional `device_id`; with it, the server records a profile identity map
  (`device_id` + local profile id → workspace profile id) and answers a profile already mapped for that device
  with `outcome: "existing"` and its existing `profile_id` instead of creating a second one.
- New id prefixes `fld_` (folder) and `mgr_` (migration run); new permissions `folders.manage`, `features.manage`
  (owner, admin).

## 0.12.0 — 2026-10-14 (milestone 12: production security, updates and recovery)
Added
- `GET /support/audit/export?after_seq=&limit=` (support leads): the hash-chained platform audit with the chain head;
  each later export continues from the last hash (`services/api/src/audit-chain.ts` recomputes it).
- `POST /support/orgs/{org}/emergency/revoke-api-tokens` (break-glass for that organization only, reason required).
- Request header `x-pb-client-version` (sent by the desktop app). With `MIN_DESKTOP_VERSION` set, desktop clients
  below it get `426 CLIENT_UPDATE_REQUIRED` (with `minimum_version`); scripts and the SDK are not affected.
- `break_glass_until` in the support organization overview; alert kind `break_glass_used`.

Changed (visible to clients)
- A recent sign-in (`REAUTHENTICATION_REQUIRED`, 403) is now needed for restore plans of anything other than the
  current version, recovery-copy restores and undelete. API and development tokens never qualify.
- Undelete works only during the trash period (404 afterwards).
- Automation job detail and screenshots need the grant's `launch` capability on the profile (403 otherwise), as
  creating the job does.
- `/v1/health` and `/v1/ready` return only their status. No documentation, debug or metrics routes are served.
- Resolving a `break_glass_used` alert is refused to the staff member who held that grant (`own_break_glass`).

## 0.11.0 — 2026-10-14 (milestone 11: billing, plan limits and administration)
Added
- **Billing** (interactive sign-in; `billing.read` / `billing.manage`): `GET /orgs/{org}/billing/subscription`,
  `…/billing/plans`, `…/billing/usage`, `…/billing/invoices`, `…/billing/invoices/{in}/links`;
  `POST /orgs/{org}/billing/checkout-session` and `…/billing/portal-session` (Stripe-hosted pages; owners only);
  `GET /billing/return` (informational page after checkout; never proof of payment).
- `GET /orgs/{org}` returns a `billing` summary (plan, state, reason, until) for every member.
- `POST /webhooks/billing`: Stripe events, authenticated by the `Stripe-Signature` header (not for clients).
- **Support console API** `/support/*` (staff tokens only; organization sessions and API tokens are refused there):
  sign-in (`/support/auth/config`, `/support/sessions`, `/support/sign-out`), organization search and overview,
  access requests and decisions, members and activity with approved access, overrides, resync, alerts, platform audit.
- New errors: `PLAN_LIMIT_REACHED` (409, with `limit`, `used`, `allowed`), `SUBSCRIPTION_RESTRICTED` (403, with the
  state and reason), `BILLING_UNAVAILABLE` (503, retryable), `ALREADY_SUBSCRIBED` (409), `PLAN_NOT_AVAILABLE` (422).
- Rate limits: billing webhooks 1,200/min per address, checkout/portal sessions 30 per 10 min per organization, staff
  sign-in 20 per 10 min per address.

Changed (additive for well-behaved clients, but visible)
- Creating profiles, clients, invitations, API tokens, webhook endpoints and jobs, opening profiles, claiming jobs,
  imports and restores from the trash can now be refused with `PLAN_LIMIT_REACHED` or `SUBSCRIPTION_RESTRICTED`.
  API-token callers should treat both as non-retryable and show the message.
- Job claims are limited by the plan's automation concurrency as well as the organization's running limit.

## 0.10.0 — 2026-10-14 (milestone 10: developer API and automation)
Added
- **API tokens** (`pbt_…`): `GET/POST /orgs/{org}/api-tokens`, `POST …/{tok}/rotate`, `DELETE …/{tok}`,
  `GET …/api-tokens/current`. Bearer authentication for 16 routes (deny by default); scopes `profiles:read`,
  `profiles:write`, `automation:read`, `automation:run`, `automation:debug`; client/profile restrictions; expiry,
  rotation with grace. New errors `TOKEN_SCOPE_MISSING`.
- **Automation**: `GET/PUT /orgs/{org}/automation/settings` (approved sites, running-job limit);
  `POST/GET /orgs/{org}/automation/jobs` (`Idempotency-Key` required for `POST`), `GET …/jobs/{job}`,
  `POST …/jobs/{job}/cancel`, `GET …/jobs/{job}/artifacts/{art}`; computers: `GET/POST /orgs/{org}/automation/agents`,
  `PATCH/DELETE …/agents/{agt}` and the desktop-only `…/poll`, `…/jobs/{job}/report`,
  `PUT …/jobs/{job}/steps/{seq}/artifact`. New errors `URL_NOT_APPROVED`, `QUEUE_FULL`, `JOB_FINISHED`,
  `JOB_CLAIM_STALE`, `AGENT_UNAVAILABLE`.
- **Webhooks**: `GET/POST /orgs/{org}/webhook-endpoints`, `GET/PATCH/DELETE …/{whk}`, `POST …/rotate-secret`,
  `POST …/test`, `GET …/deliveries`, `POST …/deliveries/{dlv}/redeliver`; Standard Webhooks signatures; events
  `automation.job.queued|started|succeeded|failed|canceled`, `webhook.test`. New error `WEBHOOK_DESTINATION_BLOCKED`.
- Permissions `automation.read|run|manage|debug|agent`, `tokens.create|manage`, `webhooks.manage`
  ([matrix](../permission-matrix.md)). Operators get `automation.read`, `automation.run`, `automation.agent`,
  `tokens.create`.
- Rate limits: per token 600/min, per organization (token requests) 3,000/min, job creation 1,000/h per organization,
  token creation 30/h per member, webhook tests 30 per 10 min per organization.
- `GET /orgs/{org}/profiles`, `…/profiles/{prf}`, `POST/PATCH/DELETE` profiles, clients reads and `GET /orgs/{org}`
  accept API tokens.

## Earlier (0.6.0–0.9.0)
Interactive routes for organizations, members, invitations, grants, profiles, clients and audit (0.6.0), encrypted
backups and restores (0.7.0), session leases, handoff requests and takeovers (0.8.0), client dashboards, tasks,
bookmarks and the extension policy (0.9.0). They require an interactive sign-in and were not part of the developer
API; see the milestone status documents.
