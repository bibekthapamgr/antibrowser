# R6 — Signed canary/stable evidence

The updater, signing and promotion machinery exist since milestone 12 (ADR-0019, [update runbook](../security/update-runbook.md)).
R6 adds the distribution gates in `.github/workflows/desktop-release.yml` and makes the remaining gates explicit.

## Gates
| Gate | State 2026-10-15 | Enforced by |
|---|---|---|
| Release public key in `release-keys.json` | **open** — empty; owner generates the key locally (never in chat) and adds the public half | release workflow (refuses every action), preflight `release_keys` |
| Protected signing environment, separate build/sign permissions | done in code (build jobs have no secrets; `release` environment holds the key) | workflow |
| Independent review, admin MFA, no self-approval (D1) | **open** — owner GitHub settings | [security closure](security-closure.md) |
| Production address compiled in (`PB_DEFAULT_SERVER`) | **open** until the domain exists | release workflow refuses stable without https |
| Windows Authenticode + Apple Developer ID notarization (`PB_OS_SIGNING`) | **open** — certificates not bought | release workflow refuses stable unless signed or `PB_UNSIGNED_PILOT` |
| Unsigned pilot exception (`PB_UNSIGNED_PILOT`) | owner decision | release title/notes "Unsigned pilot build"; never the signed public release |
| Runtime redistribution (ADR-0010) | **open** — Chrome for Testing is `customer_distribution: false` | release workflow refuses stable; preflight `runtime_eligibility` |
| Canary → stable promotes the exact files | done | `promote` copies the signed manifest entries; files are immutable |

## Procedure and record
1. Set the version, push, run `desktop release` → `release` → `canary`. Approve in the `release` environment (a second
   reviewer once D1 is resolved).
2. On a clean computer: install from the canary release, check the signature (Windows SmartScreen / macOS Gatekeeper
   once signed), update from the previous canary, try a tampered download (the app must refuse; covered by
   `crates/update` and `apps/desktop/src-tauri/tests/updates.rs` tests).
3. `promote` canary → stable. Compare SHA-256 of stable with canary (`SHA256SUMS`, provenance attestation).

| Date | Version | Channel | Run | SHA-256 match | OS signature | Tested on | By |
|---|---|---|---|---|---|---|---|
| _(first canary)_ | | canary | | | | | |
