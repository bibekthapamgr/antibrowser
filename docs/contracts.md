# Shared contracts (apply to milestones 02–14)

Source of truth: `packages/contracts` (TypeScript + JSON Schema), mirrored in Rust where the desktop needs it (`crates/runtime/src/id.rs`). Changing anything here needs an ADR. Interpretations already made: [ADR-0008](adr/0008-foundation-contract-decisions.md).

## Identifiers
Opaque, server-generated: `<prefix>_<26 Crockford base32>`; prefixes `org usr dev prf snp evt req aud`. Clients treat them as opaque strings. A profile id is the only input used to build a profile's directory name.

## Time and versions
UTC RFC 3339 timestamps produced by the database. Mutable resources carry an integer `version`, exposed as an `ETag` (`"3"`).

## HTTP API
- Prefix `/v1`. JSON request/response bodies validated by JSON Schema; unknown fields are rejected. OpenAPI 3.1 is generated from the route schemas: [openapi.json](openapi.json).
- Cursor pagination: `?limit=1..100` (default 50) and opaque `?cursor=`; responses `{ items, next_cursor }`.
- Optimistic concurrency: `If-Match: "<version>"` or `expected_version` in the body. Missing → `428`; stale → `409 VERSION_CONFLICT`.
- Idempotency: `Idempotency-Key` header (8–128 of `[A-Za-z0-9_-]`) is **required** for lease acquisition, snapshot commit, billing jobs and imports. Replays return the stored response with `idempotent-replayed: true`.
- Errors, always exactly these fields:

```json
{ "code": "VERSION_CONFLICT", "message": "Profile was changed by someone else; reload and retry",
  "request_id": "req_…", "retryable": false, "safe_details": { "current_version": 2 } }
```

| code | HTTP | retryable |
|---|---|---|
| VALIDATION_FAILED | 400 | no |
| UNAUTHENTICATED | 401 | no |
| FORBIDDEN | 403 | no |
| NOT_FOUND | 404 | no |
| VERSION_CONFLICT | 409 | no |
| LEASE_HELD | 409 | yes |
| LEASE_NOT_HELD | 409 | no |
| FENCING_TOKEN_STALE | 409 | no |
| IDEMPOTENCY_IN_PROGRESS | 409 | yes |
| IDEMPOTENCY_KEY_REUSED | 422 | no |
| PRECONDITION_REQUIRED | 428 | no |
| RATE_LIMITED | 429 | yes |
| INTERNAL | 500 | yes |
| UNAVAILABLE | 503 | yes |

No stack traces, SQL, secrets, file paths or other tenants' identifiers ever appear in responses. Every response carries `x-request-id`.

## Tenancy
Every organization-scoped row has `org_id`. Membership and role are derived on the server from the authenticated user; the `orgId` in a URL is only a lookup key. Row-level security enforces the same rule in PostgreSQL.

## Events (transactional outbox)
Envelope: `event_id, org_id, actor_id, aggregate_id, aggregate_version, event_type, created_at, redacted_payload`. Written in the same transaction as the state change. Payload keys such as `password`, `secret`, `token`, `cookie`, `authorization`, `private_key` are dropped at any depth. Consumers deduplicate on `(consumer, event_id)`.

Emitted now: `profile.created`, `profile.updated`, `profile.deleted`, `lease.acquired`, `lease.renewed`, `lease.released`, `snapshot.committed`, and since 06 `organization.created`, `organization.updated`, `client.created`, `client.updated`, `membership.created`, `membership.updated`, `membership.removed`, `grant.created`, `grant.removed`. Reserved: `device.registered` (devices are account-level, not organization events). The security audit (who did what, including refused attempts) is a separate table, `audit_events` (ADR-0013).

## Leases
`profile_leases(profile_id unique, holder_device_id, holder_user_id, fencing_token, expires_at, …)`. Expiry uses the database clock only. Each acquisition takes the next value of a monotonically increasing sequence. TTL 30–600 s (default 120). Writes that depend on the lease present the token and are refused if a newer lease exists.

## Desktop IPC
Commands: `list_profiles(query?, limit?)`, `create_local_profile(name, clientLabel?)`, `launch_profile(profileId, startUrl?)`. Errors: `{ code, message }` with codes `UNKNOWN_PROFILE`, `ALREADY_RUNNING`, `BROWSER_NOT_CONFIGURED`, `BAD_START_URL`, `PROFILE_DIRECTORY_REJECTED`, `SPAWN_FAILED`, `INVALID_LABEL`, `LOCAL_STORE_ERROR`.
