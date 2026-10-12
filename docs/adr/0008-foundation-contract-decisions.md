# 0008 — Interpretations made while implementing the 01 contracts
Status: **Accepted**. Date: 2026-10-12. Owner: technical lead.

Each item interprets wording in milestone 01 where more than one reading was possible.

1. **Idempotency key uniqueness.** "Key uniqueness includes tenant, operation and request digest" is implemented as: primary key `(org_id, operation, key)`; the stored request digest must match on replay, otherwise `422 IDEMPOTENCY_KEY_REUSED`. (Making the digest part of the key would let one key silently run two different requests.) Keys expire after 24 hours; failures are never cached because the key row commits in the same transaction as the work.
2. **Non-member organizations return 404**, identical to nonexistent ones, so tenants cannot be enumerated. A member lacking a permission gets `403 FORBIDDEN`.
3. **Mutations require a version.** `PATCH` without `If-Match` or `expected_version` returns `428 PRECONDITION_REQUIRED`; a stale version returns `409 VERSION_CONFLICT` with `safe_details.current_version`.
4. **Unknown request fields are rejected** (`400`), not silently stripped, so a client sending `org_id` in a body learns it is ignored.
5. **Lease rows are kept, not deleted.** A lease is held iff `released_at is null and expires_at > now()`. The per-profile lease version and global fencing sequence keep increasing. Lease events use the profile id as `aggregate_id` and the lease row version as `aggregate_version`.
6. **Fencing scope.** Renew, release and snapshot commit require the caller's current token. A stale token returns `409 FENCING_TOKEN_STALE` when a newer lease exists, otherwise `409 LEASE_NOT_HELD`.
7. **Defence in depth for tenancy.** Besides application checks, PostgreSQL row-level security keyed by transaction-local `app.org_id` filters every tenant table; with no context set, queries return nothing. The API role can insert into the outbox but cannot read it; the worker purges expired keys only through an owner-defined function.
8. **Local-only profile ids** (engineering alpha) are generated on the device with the same grammar as server ids (`prf_` + 26 Crockford base32 characters). On first sync (milestone 07) the server accepts the id if unused in any tenant, otherwise it assigns a new id and the device renames the directory while the profile is closed.
9. **Repository layout.** Rust crates live in `crates/` (runtime, storage, update) plus `apps/desktop/src-tauri`, all in one Cargo workspace; this is an addition to the 01 directory list, not a change.
10. **Timestamps** are produced by PostgreSQL in UTC with microsecond precision and RFC 3339 `Z` suffix, so cursor values round-trip exactly.
