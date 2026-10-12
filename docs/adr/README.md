# Architecture decision records

Shared assumptions change only through an ADR (roadmap: "Record changes as architecture decisions rather than silently changing shared assumptions").

Status values: **Proposed** (needs the named owner's sign-off), **Accepted**, **Accepted (provisional)** (in force until the stated evidence arrives), **Superseded by NNNN**.

| ADR | Decision | Status | Owner to sign off |
|---|---|---|---|
| [0001](0001-runtime-distribution.md) | Browser runtime distribution and update SLA | Proposed | Technical lead + browser/security owner |
| [0002](0002-profile-portability.md) | Profile portability: same-device backup + re-authentication for v1 | Accepted (provisional, 01 stop gate) | Technical lead |
| [0003](0003-encryption-trust-model.md) | Encryption trust model and key custody | Proposed | Technical lead + security |
| [0004](0004-identity-provider.md) | Identity: OIDC Authorization Code + PKCE, app-owned RBAC; vendor TBD | Accepted (protocol) / Proposed (vendor) | Backend lead |
| [0005](0005-regions.md) | One primary region, multi-zone; region choice criteria | Proposed | Product owner + operations |
| [0006](0006-supported-operating-systems.md) | Windows 11 x64 and macOS Apple Silicon first | Accepted | Product owner |
| [0007](0007-toolchain-and-versions.md) | Pinned toolchain and package versions | Accepted | Technical lead |
| [0008](0008-foundation-contract-decisions.md) | Interpretations made while implementing the 01 contracts | Accepted | Technical lead |
| [0009](0009-desktop-shell-decisions.md) | Desktop shell: local workspaces, quit policy, deep links, keychain, installers | Accepted | Technical lead |

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
