# Architecture decision records

Shared assumptions change only through an ADR (roadmap: "Record changes as architecture decisions rather than silently changing shared assumptions").

Status values: **Proposed** (needs the named owner's sign-off), **Accepted**, **Accepted (provisional)** (in force until the stated evidence arrives), **Superseded by NNNN**.

| ADR | Decision | Status | Owner to sign off |
|---|---|---|---|
| [0001](0001-runtime-distribution.md) | Browser runtime distribution and update SLA | Proposed (alpha part superseded by 0010) | Technical lead + browser/security owner |
| [0002](0002-profile-portability.md) | Profile portability: same-device backup + re-authentication for v1 | Accepted (provisional, 01 stop gate) | Technical lead |
| [0003](0003-encryption-trust-model.md) | Encryption trust model and key custody: service-managed envelope encryption, not end-to-end (refined in 0014) | Accepted (option A) | Technical lead + security |
| [0004](0004-identity-provider.md) | Identity: OIDC Authorization Code + PKCE, app-owned RBAC (vendor and redirect decided in 0013) | Accepted | Backend lead |
| [0005](0005-regions.md) | One primary region, multi-zone; region choice criteria | Proposed | Product owner + operations |
| [0006](0006-supported-operating-systems.md) | Windows 11 x64 and macOS Apple Silicon first | Accepted | Product owner |
| [0007](0007-toolchain-and-versions.md) | Pinned toolchain and package versions | Accepted | Technical lead |
| [0008](0008-foundation-contract-decisions.md) | Interpretations made while implementing the 01 contracts | Accepted | Technical lead |
| [0009](0009-desktop-shell-decisions.md) | Desktop shell: local workspaces, quit policy, deep links, keychain, installers | Accepted | Technical lead |
| [0010](0010-runtime-source-and-lifecycle.md) | Chrome for Testing for the internal alpha (customer gate), signed runtime manifest, lifecycle, graceful close, last-good copies | Accepted (alpha) | Technical lead + browser/security owner |
| [0011](0011-profile-library-and-configuration-import.md) | Profile library (clients, tags, templates, trash), safe deletion, selections/bulk/undo, configuration-only import and export | Accepted (alpha) | Technical lead |
| [0012](0012-proxy-gateway-and-privacy-controls.md) | Proxies through a per-profile loopback gateway, fail-closed by default, logins only in the keychain, user-started checks, no rotation; privacy and environment controls with per-OS support | Accepted (alpha) | Technical lead + browser/security owner |
| [0013](0013-identity-and-authorization.md) | OIDC (Keycloak reference) with PKCE in the system browser; device-bound API sessions with rotating refresh tokens; five roles + client/profile grants, deny by default; RLS + composite keys; invitations, ownership, audit, rate limits, local→organization import | Accepted (beta track) | Backend lead + security owner |
| [0014](0014-encrypted-snapshots-and-sync.md) | Encrypted snapshots: root → organization key version → per-snapshot data key; sealed format (zstd + AES-256-GCM STREAM, header as AAD); fenced upload, worker verification and compare-and-set commit; restore into a fresh folder with evidence kept; conflict choices; device-key local backups; retention, quota, trash, key rotation | Accepted (beta track) | Technical lead + security owner |
| [0015](0015-team-sessions-and-handoff.md) | Team sessions: one authoritative lease per profile with fencing tokens on the database clock; uncertain sessions instead of expiry takeovers; 15 s heartbeats / 60 s TTL; handoff only after the closing backup commits; forced takeover and revocation with new tokens; recovery copies never merged; grant capabilities (launch, edit, backup download) | Accepted (beta track) | Technical lead + backend lead |
| [0016](0016-agency-workspace-and-technical-health.md) | Agency workspace: client dashboards that never count hidden profiles; tasks and http(s)-only bookmarks as app records; extension inventory read from Chromium's own files and an organization policy (off / warn / enforce with `--disable-extensions`, never installing or bypassing checks; shared judgement vectors); health cards with check times and validity, no account claims; per-tree resources with the manager apart and a measured memory check; per-client download folders; a built-in profile picture per client; redacted, previewed, size-limited diagnostics; persistent notifications and bulk confirmations naming clients | Accepted (beta track) | Technical lead + UI lead |
| [0017](0017-developer-api-and-automation.md) | Developer API and automation: API tokens (hashed, scoped, never beyond the creator, restricted to clients/profiles, deny-by-default routes, rate limits); jobs as a state machine with typed steps run under the profile's session lease with fencing, one active job per profile, idempotent creation, safe-step resume and `outcome_unknown` reconciliation; outbound-polling computers; DevTools over a protected pipe with `--enable-automation`; an opt-in, capability-bound loopback broker for Playwright; signed, retried, deduplicable webhooks with SSRF checks and an egress firewall | Accepted (beta track) | Backend lead + desktop lead |
| [0018](0018-billing-plan-limits-and-support-access.md) | Billing with Stripe (Ten Tech Solutions LLC, USD): versioned plan catalog, entitlements decided by the database at request time (no cache grants), trial → active → past_due → grace → restricted → canceled with time-based transitions and bounded outage grace, no deletion by billing state; limits enforced by row-locking triggers; hosted checkout/portal opened by the shell; webhooks verified on the raw body, deduplicated, applied from fresh provider data; usage ledger; staff console with separate identities, two-person approved time-bound access and audited overrides | Accepted (beta track) | Backend lead + product owner |
| [0019](0019-production-security-updates-and-recovery.md) | Production security: signed update channels (dev/canary/stable) on GitHub Releases with sequence, 30-day validity, no rollback, pause/revoke/minimum and a server-side minimum version; release keys only in a protected environment, SBOM and provenance; before-upgrade copies and revocable runtimes; PITR and object copies to R2 with separate permissions, a restore drill and whole-server restore; hash-chained append-only platform audit; break-glass scoped to named organizations; recent sign-in for old-data actions; findings register and third-party test before paid launch | Accepted (paid-launch track) | Security owner + release engineering |
| [0020](0020-unified-workspace-model-and-safe-migration.md) | Unified workspace model (R1): the organization presented as a Workspace (label only, no renames); role presets Owner/Admin/Member over existing roles; folders that organize but never grant; agency features as an optional module; additive schema (onboarding, folders, feature settings, device identity map, migration runs); migration that keeps linked ids authoritative, adopts local-only profiles only with opt-in, quota, lock and clean shutdown, in resumable idempotent batches, uploads nothing without sync; capability negotiation and a per-workspace rollback flag | Accepted (revised-roadmap track) | Product owner + desktop lead + backend lead |
| [0021](0021-self-service-accounts-and-onboarding.md) | Self-service accounts (R2): registration, e-mail verification and password reset at the provider only with a mail server; staff console flow with a one-time code every time (S1 fixed); one server-side onboarding call (invitations first, one workspace and one trial per direct signup under concurrency, returning people selected, a choice once); trial clock per verified address; suspended workspaces and addresses closed; sealed e-mail tasks sent by the worker; customer portal as a backend-for-frontend cookie session (CSRF + Origin, deny-by-default routes, rotation); desktop Create account and Profiles after sign-in | Accepted (revised-roadmap track) | Backend lead + desktop lead + security owner |

## Template

```markdown
# NNNN — Title
Status: Proposed | Accepted | Superseded by NNNN. Date: YYYY-MM-DD. Owner: role.

## Context
## Decision
## Consequences
## Evidence / verification
## Revisit when
```
