# API changelog

The API is versioned in its path (`/v1`). Within `v1`, changes are additive: new routes, new optional request fields,
new response fields and new enum values (clients must ignore unknown fields and treat unknown enum values as
"other"). A breaking change needs a new path version and a deprecation period announced here first. The OpenAPI
document ([docs/openapi.json](../openapi.json)) is regenerated and checked in CI on every change.

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
