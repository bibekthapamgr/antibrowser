# Tenant isolation test report (milestone 06)

All tests run against PostgreSQL with the real migrations and the least-privilege API role (`pb_app`, row-level
security, no `BYPASSRLS`), through the real HTTP stack (Fastify, schemas, error handler). Locally on PostgreSQL 16; in
CI on PostgreSQL 18 (`ci.yml`, job “lint, types, tests”), together with a real Keycloak for sign-in.

| Exit-gate requirement | Test | Result |
|---|---|---|
| Swap organization, client, profile ids across **all endpoints, including bulk, search and download** | `cross-tenant.test.ts` — every organization-scoped route (33 method+path pairs, checked against the generated OpenAPI so a new route without a swap test fails) is called with another tenant's organization, and then with another tenant's client, profile, member, invitation, grant and snapshot ids inside the caller's own organization. Every answer must equal the answer for a nonexistent id of that kind (status, code and message); lists, search (`q`, `client_id`), export and bulk return nothing of the other tenant; a fingerprint of all the other tenant's rows is unchanged afterwards | Pass |
| Pooled database connection reuse | `cross-tenant.test.ts` — one-connection pool, requests alternating between two tenants with failing (rolled-back) requests in between; after each, the connection has no tenant or user setting and sees no rows | Pass |
| Revoked membership loses access on the next authorization check | `organizations.test.ts` — removing a grant, lowering a role to billing, and removing the member each take effect on the very next request (404); the member's grants are deleted with the membership; the denied attempt is audited | Pass |
| Last-owner protection | `organizations.test.ts` — the last owner can neither leave nor be demoted (`LAST_OWNER`); the deferred trigger refuses the same through SQL; admins cannot change or remove an owner | Pass |
| Expired invitation | `organizations.test.ts` — expired (410 `INVITATION_EXPIRED`), withdrawn, used (410 `INVITATION_USED`), wrong account (403, audited), unverified e-mail (403) | Pass |

## Supporting tests

| Area | Tests |
|---|---|
| Role × operation matrix | `authorization.test.ts`: 5 roles × 22 operations (114 tests). Expected results are computed from the contract matrix (`ROLE_PERMISSIONS`, `ROLE_SCOPE`): out of reach → 404, no permission → 403 and an `access.denied` audit entry, allowed → the operation's own result (writes use stale versions so nothing changes) |
| Scope | Operators and viewers list only granted profiles and clients; a client grant covers profiles added later; workspace counts follow scope |
| Database guarantees | `database.test.ts`: upgrade of milestone 01 data, role attributes, RLS on every tenant table, definer functions callable only by the API role, append-only audit, no cross-organization membership insert, composite foreign keys (`cross-tenant.test.ts`) |
| Sessions | `auth.test.ts`: rotation and reuse detection, revoked device and signed-out session refused at the next request, disabled users, rate limits, no tokens in logs, audit or outbox |
| Real provider | `keycloak.test.ts` (CI): PKCE, state, `iss`, nonce, one-time ID tokens, unverified e-mail, `prompt=login` re-authentication |
| Desktop | `apps/desktop/src-tauri/tests/account.rs`: refresh token only in the keychain (never in the database or WAL), callbacks bound to one attempt, issuer mismatch refused, stale offline data, local data untouched when a session ends, local workspace copy with preview and idempotent commit |

## Counts at this milestone

API (TypeScript): 205 tests in 10 files (+6 Keycloak tests in CI). Worker: 7. Contracts: 7. Desktop Rust: account
9 (+ deep-link and storage unit tests). UI end-to-end: 101 (26 new for accounts and organizations, with axe in light
and dark mode at 900×600).
