# Security findings register (milestone 12)

Every finding from the milestone 12 reviews, with severity, owner, status and how the fix is verified. The release
gate is: **no open critical or high finding**. Medium and low findings are either fixed or tracked here with an
owner and a deadline.

## How the review was done

- **When:** 14 October 2026, against commit `af5492c` (milestones 01–12 code).
- **Who:** three reviewers who had not seen the code being written, each limited to one area:
  - tenant authorization: API routes, tenancy, row-level security, the worker, migrations;
  - cryptography: sealed archives, the key hierarchy, tokens, webhooks, update signatures;
  - the desktop trust boundary: manager IPC, deep links, browser processes, archives, the updater.
- **Method:** read-only. Each reviewer confirmed its findings with a proof of concept or a test outside the
  repository.
- **Limits:** these were AI-assisted reviews run inside the project. They are **not** a third-party penetration
  test. A third-party assessment remains an owner action before the paid launch (milestone 14); see the end of this
  page.

**Owners.** Roles below follow the roadmap's team plan. Until those roles are staffed, every owner is the project
owner (security contact in [SECURITY.md](../../SECURITY.md)).

## Summary

| Severity | Found | Fixed | Accepted / tracked |
|---|---|---|---|
| Critical | 0 | — | — |
| High | 0 | — | — |
| Medium | 1 | partly (pipeline side) | 1 tracked (owner actions; due before paid launch) |
| Low | 12 | 10 | 2 tracked (T3, C-L4) |
| Informational | 4 | 1 | 3 documented |

## Findings

### Medium

| ID | Area | Finding | Owner | Status | Verification |
|---|---|---|---|---|---|
| D1 | Release | **A takeover of the repository's admin account can get any build signed.** The release key is a GitHub environment secret. With one maintainer, an admin can change the environment's reviewers and branch rules, or push a workflow change to `main` and approve the run, and so obtain a correctly signed installer that every manager offers as an update. | Repository owner + release engineering | **Tracked. Must be resolved before the paid launch (milestone 14).** Done in code: build jobs hold no secrets; publishing runs only in the protected `release` environment from `main`; every signature is verified against the compiled-in keys before upload; signed SBOM and provenance attestations; revocation and minimum-version controls exist for recovery. Owner actions (see [update runbook](update-runbook.md#protecting-the-signing-key)): add a second required reviewer and enable "prevent self-review"; turn off admin bypass on the environment and on `main`; require reviews for `.github/workflows/**`; turn on two-factor authentication with a hardware key for every admin. Preferred end state: offline or hardware-backed signing, with CI only building. | GitHub settings screenshot or export attached to the release checklist; a test run where a workflow change on a branch cannot reach the `release` environment. |

### Low

| ID | Area | Finding | Owner | Status | Verification |
|---|---|---|---|---|---|
| T1 | Support staff | **Break-glass was unscoped, and its holder could resolve its own alert.** One grant opened members and activity of *every* organization (and their emergency token revocation); a holder with `billing_admin` could clear the `break_glass_used` alert their own use raised. | Backend | **Fixed.** Grants name 1–10 organizations (`staff.ts break-glass … --org org_…`; `break_glass_grants.org_ids`, migration 0011). Every support route honours a grant only for those organizations. The grant's holder cannot resolve its alerts (`own_break_glass`); another billing admin must. | `services/api/test/support.test.ts` "only the server command grants it…": another organization stays closed, the holder's resolve is refused, a second admin's succeeds. Console e2e: the banner shows only on the named organization. |
| T2 | Automation | **Automation job detail and screenshots ignored grant capabilities.** An operator whose grant lacks `launch` (or their `automation:read` token) could read step outputs and download screenshots of logged-in pages. | Backend | **Fixed.** Job detail and screenshot download need the grant's `launch` capability on the profile, as creating the job does. | `services/api/test/automation.test.ts` "needs the launch capability…": a `backup_download`-only operator gets 403 (`capability: launch`). |
| T3 | Database | **Row-level security trusts the organization the API sets.** Policies compare `org_id` with `app.org_id`, which `resolveTenant` sets before checking membership. The database does not check membership a second time, so a future route that skipped `resolveTenant` would expose a tenant. All 127 organization routes call it today. | Backend | **Tracked (defence in depth).** Target: milestone 13. Add a definer helper `app.is_member(current_org(), current_user_id())` to the tenant policies, with a separate path for the worker and staff. Until then, `cross-tenant.test.ts` runs every organization route as a non-member. | `cross-tenant.test.ts` (all routes); new policy test when the follow-up lands. |
| T4 | Identity | **A "recent sign-in" could be met without a fresh login.** When the identity provider omits `auth_time`, the token's issue time was used, so a silent single-sign-on token counted as recent. | Backend | **Fixed.** Without `auth_time` the sign-in time is the epoch: step-up actions and staff sign-in then always require a fresh login. Keycloak sends `auth_time`. | `services/api/test/oidc.test.ts` "a token without auth_time never counts as a recent sign-in". |
| T5 | Backups | **Undelete could race the trash purge.** An undelete at the end of the trash period could bring a profile back after the purge had erased its snapshots. | Backend | **Fixed.** The purge locks the profile row and re-checks, through `app.profile_purge_due` (migration 0011), that the profile is still past its trash period. Undelete works only while the period lasts, measured when the row is re-checked (`clock_timestamp()`). Whichever action takes the row lock first wins, and the other refuses. | `services/api/test/sync.test.ts` trash test: undelete after the period → 404, then purge. |
| C-L1 | Release | **The release gate accepted legacy minisign signatures that the app refuses.** | Release engineering | **Fixed.** `scripts/release/minisign.mjs` accepts only prehashed (`ED`) signatures, matching the app. | `scripts/release/release.test.mjs`: a legacy signature from a trusted key is refused. |
| C-L2 / D3 | Updates | **A channel could be frozen for up to about 90 days, and switching channels dropped runtime revocations.** Whoever controls the release host (but not the key) could keep serving an older, still-valid manifest. The revoked-runtime list was replaced by the current channel's list. | Release engineering + desktop | **Fixed.** Manifests are valid for 30 days and the app refuses more than 45. The workflow re-signs weekly. Each channel's revocations are kept separately, the app enforces their union, and only a newer manifest of the same channel replaces that channel's list. | `crates/update` `revoked_runtimes_survive_channel_switches_and_older_manifests`; `release.test.mjs` validity limit (46 days refused); regenerated Tauri CLI fixtures. |
| C-L3 | Audit | **The audit hash chain's field encoding was ambiguous.** Fields are joined with U+001F, and `org_id` and `target` were unconstrained, so two different entries could hash identically. | Backend | **Fixed.** A CHECK constraint (`platform_audit_no_separator`, migration 0011) refuses U+001F in every text field. Details are jsonb, whose text form escapes control characters, so the joined text splits back into exactly one set of fields. | `services/api/test/security.test.ts` audit chain tests; constraint visible in the schema. |
| C-L4 | Desktop backups | **Local backups reuse one device key, and `backup.json` is unauthenticated.** Nonce collision is negligible (56-bit random prefix). Rewriting `backup.json` could force a plaintext restore or swap backup slots, but only for someone who can already write the live profiles. | Desktop | **Accepted for v1; tracked.** Target: milestone 13. Derive a per-backup key with HKDF(device key, profile, object id, slot) and refuse plaintext restores while a device key exists. | Will be covered by `crates/runtime` backup tests when it lands. |
| C-L5 / D2 | Updates (macOS) | **The macOS update extractor could write outside the app bundle through a chain of symbolic links.** The archive kept its file modes as they were. This needs a validly signed archive. | Desktop | **Fixed.** Link targets may not contain `..` or be absolute. No entry may be written through an existing link, and the entry itself may not already be one. Modes are masked to at most `0o755` (no setuid, setgid, sticky bit or group/other write). | `crates/update` `hostile_archives_are_refused` (three chain cases) and `extracted_modes_never_carry_setuid_or_group_write`. |

### Informational

| ID | Note | Status |
|---|---|---|
| I1 | Migration 0010 was changed in `56646f2` after it first shipped in `548f8c1`. A server that had already applied 0010 would refuse to migrate (checksum). No persistent environment applied it in between: the owner's server was not updated during that window, and CI always starts fresh. | Documented. Later changes go into new migrations (0011 holds all review fixes). If a server ever reports "Migration 0010_security_and_recovery.sql changed after being applied", stop and contact the security owner. Do not edit the checksum. |
| I2 | Snapshot data keys reach devices as base64 inside the TLS response (envelope encryption, not end-to-end; disclosed). A leaked access token or a TLS-terminating proxy log exposes that snapshot's key. | Documented ([customer limitations](limitations.md)). Design option for later: wrap the data key to a per-device public key (HPKE). |
| I3 | Windows installers are not Authenticode-signed and macOS builds are ad-hoc signed (owner decision). The first install therefore has no OS-level authenticity check, while updates are verified with the release key. | Documented in the [update runbook](update-runbook.md) and [customer limitations](limitations.md). The pipeline is ready for a certificate. |
| I4 | The update runbook and ADR-0019 were cited in code but missing. | Fixed: [ADR-0019](../adr/0019-production-security-updates-and-recovery.md), [update runbook](update-runbook.md). |

## Reviewed and found sound

Areas the reviewers checked and found sound. Detail is in the reviewers' notes; the main points are summarised
here.

- **Tenant entry:**
  - Every `/orgs/:orgId` route resolves membership on the server. Non-members get the same 404 as a missing
    organization.
  - Every other id is filtered by organization and limited by row-level security.
  - API tokens cannot exceed their creator's role or grants, and are refused on routes not marked for tokens.
- **Staff:**
  - Staff and organization tokens are separated by audience and type.
  - Access approvals need two people, enforced in code and by a database constraint.
  - Only the server command creates break-glass grants.
  - The platform audit is append-only and hash-chained, and the API role cannot write its head.
- **Cryptography:**
  - Sealed archives use the STREAM construction, with the header authenticated in every chunk.
  - Key wrapping uses AES-256-GCM with fresh IVs and unambiguous associated data.
  - Data keys are bound to organization, profile, snapshot and key version.
  - Tokens are pinned to ES256 with kid, issuer, audience and type checks.
  - Secrets are 256-bit, stored hashed and compared in constant time.
  - Webhook HMACs are compared in constant time.
- **Desktop:**
  - Every command is granted to the `main` window only and re-checks its caller.
  - The CSP is strict.
  - Deep links are accepted only for the auth-callback shape, with one-time state, PKCE, nonce and issuer checks.
  - Chromium switches come from an allow-list.
  - DevTools is reachable only over a private pipe.
  - Secrets stay in the OS keychain with no plaintext fallback.
- **Updater:**
  - The signature is checked before the manifest is parsed.
  - Manifests are bound to their channel file and artifacts to their version and file.
  - Replays and rollbacks are refused.
  - Each artifact is checked for size, SHA-256 and signature, and checked again just before installing.

## Before the paid launch (milestone 14)

1. Resolve D1 (owner actions above). Preferably move to offline or hardware-backed signing.
2. Commission a third-party penetration test of the API, the support console and the desktop boundary, and a
   cryptography review of the sealed-archive format and the key hierarchy. Record the findings here.
3. Close T3 and C-L4 or re-accept them with a dated decision.
