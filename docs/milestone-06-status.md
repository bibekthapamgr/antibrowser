# Milestone 06 — status against the handoff file

Identity, organizations and authorization. Version 0.6.0. Decisions:
[ADR-0013](adr/0013-identity-and-authorization.md). Deliverables: [schema](identity/schema.md),
[permission matrix](permission-matrix.md), [OpenAPI](openapi.json),
[authentication threat review](identity/authentication-threat-review.md),
[tenant isolation test report](identity/tenant-isolation-report.md). Setup: [Keycloak](identity/keycloak-setup.md);
on the test server `scripts/deploy/keycloak-setup.sh` installs and connects a self-hosted Keycloak in one run.

Outcome: authenticated users operate only their authorized organizations and clients — enforced by the API on every
request and again by PostgreSQL row-level security, proven by id swaps on every endpoint.

## User journeys
| Journey | Implemented |
|---|---|
| Sign up / sign in | Account → “Sign in or create an account”: the provider's page in the system browser (Authorization Code + PKCE); registration is the provider's. No password ever reaches the app |
| Verify account | The provider verifies the e-mail; Account shows the state; creating organizations and accepting invitations require it (`EMAIL_NOT_VERIFIED`) |
| Create organization | Account → Create an organization (creator becomes owner) |
| Switch workspace | Sidebar switcher: “On this computer” (local workspaces) and “Organizations” |
| Invite member / accept invite | Organization → Invitations (code shown once); Account → Join an organization (preview, then accept) |
| Enroll device | Automatic at the first sign-in; later sign-ins start a new session on the enrolled device |
| Sign out and revoke device | Account → Sign out; Your devices → Sign out device (effective at the device's next request) |
| Identity provider | Generic OIDC; **Keycloak** is the reference deployment (self-hosted or managed), tested in CI. No custom password cryptography |

## Implementation
| Step | Status |
|---|---|
| 1. System-browser login, Authorization Code + PKCE, state and one-time callback validation; issuer/audience and redirect URI validated; refresh credentials in the keychain; no embedded credential collection | Done. Desktop: fresh state/nonce/verifier per attempt (memory only), state recorded once in the local store (10 min), callback must match the pending attempt and the provider's `iss` (RFC 9207); code exchanged at the discovered token endpoint (https; loopback http for development). API: ID token signature, `iss`, `aud`/`azp`, age, `nonce`, algorithm allow-list, one-time use. Refresh token only in the OS keychain (memory-only if none), access token in memory, the window never sees a token |
| 2. PostgreSQL migrations: users, organizations, memberships, clients, profiles, devices, invitations, permission_grants, audit_events | Done: migration 0003 (+ `device_sessions`, `rate_limit_counters`, `used_id_tokens`); upgrade of milestone 01 data tested ([schema](identity/schema.md)) |
| 3. Org scope in the service layer and RLS; `SET LOCAL` per transaction; pooled connections never keep a tenant; app role cannot bypass RLS | Done: `set_config(…, true)` inside every request transaction; tested with a one-connection pool incl. failed requests; `pb_app` is not owner, not superuser, no `BYPASSRLS` (tested) |
| 4. Role matrix | Done: owner (ownership, billing), admin (members, clients, grants, profiles, audit), operator (launch/snapshot granted profiles), viewer (granted metadata; no launch, snapshots or export), billing (billing data only) — generated [matrix](permission-matrix.md) |
| 5. Role combined with client/profile grants; deny by default; authorization on every read/write/download/launch/automation operation | Done: grants of a client (incl. later profiles) or a profile; out of reach → 404, no permission → 403 (audited); leases, snapshot commit/list/download, export, bulk and search all go through it; idempotent replays are re-authorized first |
| 6. Invitations expire, single use, bound to the verified identity; final owner protected; ownership transfer needs recent authentication and is audited | Done: 256-bit token stored as a digest, 7 days default (≤ 30), single use, bound to the verified e-mail; re-invite withdraws the earlier one; deferred `LAST_OWNER` trigger + API checks; transfer needs a sign-in within 10 minutes (`prompt=login` round trip in the desktop) |
| 7. Device registration, refresh-token rotation and revocation; authentication expiry never destroys local data | Done: device-bound sessions, rotation with reuse detection (session revoked), idle 14 d / absolute 30 d, device revocation and sign-out effective at the next request; an ended session shows the account as signed out and leaves every local profile and file untouched (desktop test) |
| 8. Local workspace → organization through explicit preview/mapping; originals preserved until the cloud commit succeeds | Done: dry run → plan (create / existing by folded name / mapped client) → commit with an idempotency key (retries replay) → local profiles linked to their copies; local records are never modified or removed |

## API
| Required | Implemented |
|---|---|
| `POST /v1/organizations`, `GET /v1/me/workspaces` | Yes (+ `GET/PATCH /v1/orgs/{org}`, `GET /v1/me`) |
| `GET|POST /v1/orgs/{org}/clients` and `/profiles` | Yes (+ client get/patch, profile get/delete, `profiles/bulk`, `profiles/export`, search `q`, `client_id`) |
| `PATCH /v1/orgs/{org}/profiles/{id}` with `expected_version` | Yes (`If-Match` or `expected_version`; 428 without, 409 when stale) |
| `POST /v1/orgs/{org}/invitations`, `POST /v1/invitations/{token}/accept` | Yes (+ list, revoke, preview) |
| `POST /v1/devices`, `POST /v1/devices/{id}/revoke` | Yes (+ `GET /v1/devices`, `POST /v1/auth/token`, `POST /v1/auth/sign-out`, `GET /v1/auth/config`) |
| Members, grants, audit, ownership | `GET/PATCH/DELETE /v1/orgs/{org}/members/{user}`, `POST …/ownership-transfer`, `GET/POST/DELETE …/grants`, `GET …/audit-events`, `POST …/local-import` |
| Cross-tenant ids → consistent non-disclosing denial | Same 404 body as for nonexistent ids, on all 33 organization routes (test enumerates the OpenAPI routes) |
| Rate limits; no tokens in logs | Sign-in, refresh, invitations, invitation preview/accept, organization creation; tokens absent from logs, audit and outbox (tested with captured logs) |

## Tenant migration rules, failure and offline
| Rule | Implemented |
|---|---|
| One owner organization per profile; moving is export/import, not an `org_id` change | `org_id` not writable (schema, RLS `WITH CHECK`); copies get new ids |
| Composite foreign keys validate same-organization relationships | profile→client, grant→membership/client/profile (tested at the database level) |
| Subscription failure cannot grant access or change ownership | No billing path touches authorization (billing is milestone 11; reserved permissions only) |
| Cached metadata marked stale; never authorizes a shared-session launch | Desktop serves cached reads only as `stale` with their time; changes are refused offline; nothing is opened from organization data in this milestone |
| Local-only profiles separate from organization profiles | Separate workspaces in the switcher; copies are new organization records linked from the local ones |
| Device revocation stops refresh and server operations; cannot erase copied secrets | Implemented and stated in the UI, API description and threat review |
| Audit: actor, action, target, outcome, request id, time; no secrets or browsing history | `audit_events`, append-only for the API role; denials and failed sign-ins included |

## Exit gate
| Criterion | Evidence |
|---|---|
| Integration tests swap org/client/profile ids across all endpoints incl. bulk/search/download | `cross-tenant.test.ts` ([report](identity/tenant-isolation-report.md)) |
| Pooled DB connection reuse | `cross-tenant.test.ts` (one-connection pool) |
| Revoked membership loses access on the next authorization check | `organizations.test.ts` (grant removal, role change, removal) |
| Last-owner protection and expired invitation tests pass | `organizations.test.ts`, `database.test.ts` |

Test counts: API 205 + 6 Keycloak (CI) + 3 session-key tests; worker 7; contracts 7; desktop Rust: account 9 new
(PKCE flow, keychain-only refresh token, callbacks, refresh/expiry, offline, sign-out, re-authentication, import),
deep-link and storage unit tests extended; UI end-to-end 101 (26 new: account and organization screens in light and
dark with axe at 900×600, sign-in, invitations, ownership transfer with re-authentication, grants and operator view,
offline, local copy).

CI: full run green on Windows x64, macOS arm64 and Linux at `e61d919`
([ci 38361642532](https://github.com/bibekthapamgr/antibrowser/actions/runs/38361642532): fmt, clippy, all Rust tests per
OS including the new desktop account tests, TypeScript + PostgreSQL 18 with a real **Keycloak 26.6.2** sign-in — run
annotation “5 of 5 sign-in checks passed” —, UI e2e with axe, license inventory, secret scan). Real-browser set passed
on all three OSes in [runtime pipeline 38360313482](https://github.com/bibekthapamgr/antibrowser/actions/runs/38360313482)
and installers built in [desktop internal build 38360311122](https://github.com/bibekthapamgr/antibrowser/actions/runs/38360311122)
(both at `ebb0a45`; the following commit changed only tests and CI). The first 3-OS run found one test that assumed a
Linux platform name; it was fixed before the green run.

## Known limitations
See [identity/README.md](identity/README.md#known-limitations). The most important: organization profiles cannot be
opened on a computer yet (metadata only; sync in 07, launch/handoff in 08), and invitation codes are sent by the
inviter.

## Release
Still the local engineering alpha for profiles. Organizations work for metadata and team administration against your
own server and identity provider; the team beta (sync and handoff) follows milestone 08.
