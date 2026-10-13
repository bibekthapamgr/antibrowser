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
