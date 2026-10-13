# Identity and tenancy schema (milestone 06)

Migration: [`infra/db/migrations/0003_identity_and_authorization.sql`](../../infra/db/migrations/0003_identity_and_authorization.sql)
(on top of 0001/0002). Decisions: [ADR-0013](../adr/0013-identity-and-authorization.md).

## Tables

| Table | Key | Purpose | Tenant column | Same-organization references |
|---|---|---|---|---|
| `users` | `id usr_…`; unique `(oidc_issuer, oidc_subject)` | A person as authenticated by the identity provider. `email`, `email_verified` refreshed at every sign-in; `disabled_at` blocks sign-in and every request | — | — |
| `organizations` | `id org_…` | Tenant | itself | — |
| `memberships` | `(org_id, user_id)` | Role: `owner`, `admin`, `operator`, `viewer`, `billing`; `version` for optimistic concurrency | `org_id` | — |
| `clients` | `id cli_…`; unique `(org_id, id)`, `(org_id, name_key)` | An organization's customer; `name_key` is the folded name | `org_id` | — |
| `profiles` | `id prf_…`; unique `(org_id, id)` | Organization profile metadata; `client_id` optional | `org_id` | `(org_id, client_id) → clients(org_id, id)` |
| `devices` | `id dev_…`; unique `(user_id, id)` | A user's enrolled device; `revoked_at`, `revoked_reason`, `last_seen_at` | (user) | — |
| `device_sessions` | `id ses_…` | One signed-in session of a device: refresh digest, previous digest (reuse detection), generation, `auth_time`, idle and absolute expiry, revocation | (user) | `(user_id, device_id) → devices(user_id, id)` |
| `invitations` | `id inv_…`; unique `token_hash`; one open per `(org_id, email)` | Invitation bound to an e-mail address, role ≠ owner, expiry ≤ 30 days, single use | `org_id` | — |
| `permission_grants` | `id grt_…`; unique per member+client and member+profile | A client (with all its profiles) or one profile granted to a member | `org_id` | `(org_id, user_id) → memberships`, `(org_id, client_id) → clients`, `(org_id, profile_id) → profiles` (all cascade) |
| `audit_events` | `id aud_…` | Security audit: actor user/device, action, target, outcome, request id, small details, time | `org_id` (nullable for account-level events) | — |
| `rate_limit_counters` | `(bucket, key_hash)` | Fixed-window counters (SHA-256 keys, no raw addresses) | — | — |
| `used_id_tokens` | `token_hash` | ID tokens already used (one-time use), kept until the token expires | — | — |

Existing tables from milestone 01 keep their role: `profile_leases`, `snapshot_manifests`, `idempotency_keys`,
`outbox_events`, `processed_events`, `audit_entries` (the worker's index of domain events), `entitlements`.

Data migration in 0003: the draft role `manager` becomes `admin`; each distinct free-text `client_label` becomes a
client (labels differing only in case, spacing or accents become one), profiles point to it, and `client_label` /
`folder_label` are dropped. Verified by `services/api/test/database.test.ts` against data loaded in the 0002 shape.

## Row-level security

The API connects as `pb_app` (not the owner, no `BYPASSRLS`). Each request runs in one transaction that first sets
`app.org_id` and `app.user_id` with `set_config(…, true)` (transaction-local, so a pooled connection never keeps them).

| Table | Policy |
|---|---|
| `organizations` | read: the organization in context or one the user belongs to; insert/update: only the organization in context |
| `memberships` | read: rows of the organization in context, or the user's own rows (to list workspaces); insert/update/delete: only in the organization in context |
| `profiles`, `clients`, `invitations`, `permission_grants`, `profile_leases`, `snapshot_manifests`, `idempotency_keys`, `entitlements`, `audit_entries` | `org_id = app.current_org()` for read and write |
| `users` | read: oneself, or members of the organization in context |
| `devices`, `device_sessions` | the user's own rows only |
| `audit_events` | read: the organization in context, or one's own account-level events; insert: the same; **no update or delete grant** |
| `rate_limit_counters`, `used_id_tokens` | RLS on, no policy: only definer functions touch them |
| `outbox_events`, `processed_events` | no RLS; the API may only insert into the outbox, the worker reads it |

## Functions (fixed bodies, `search_path` pinned, executable by `pb_app` only unless noted)

| Function | Used for |
|---|---|
| `app.upsert_oidc_user(id, issuer, subject, email, verified, name)` | Sign-in: find or create the user by issuer + subject |
| `app.claim_id_token(hash, expires_at)` | One-time use of an ID token (inside the request's transaction) |
| `app.rotate_refresh_token(session, presented_hash, new_hash, idle_seconds)` | Refresh rotation with reuse detection (row lock) |
| `app.invitation_by_token(hash)` | Invitation preview for the token holder |
| `app.accept_invitation(hash, user)` | Atomic, single-use acceptance bound to the verified e-mail |
| `app.rate_limit_hit(bucket, key_hash, window)` | Rate limits |
| `app.purge_rate_limits(seconds)` | Worker maintenance (`pb_worker` only) |
| `app.assert_org_has_owner()` | Deferred constraint trigger on `memberships`: refuses a commit that leaves an organization without an owner (`LAST_OWNER`) |

Evidence that these hold: [tenant isolation test report](tenant-isolation-report.md).
