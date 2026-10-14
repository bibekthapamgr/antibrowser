# API changelog

The API is versioned in its path (`/v1`). Within `v1`, changes are additive: new routes, new optional request fields,
new response fields and new enum values (clients must ignore unknown fields and treat unknown enum values as
"other"). A breaking change needs a new path version and a deprecation period announced here first. The OpenAPI
document ([docs/openapi.json](../openapi.json)) is regenerated and checked in CI on every change.

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
