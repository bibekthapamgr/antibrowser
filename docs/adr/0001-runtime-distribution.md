# 0001 — Browser runtime distribution
Status: **Proposed**. Date: 2026-10-12. Owner: technical lead + browser/security owner. Blocks: milestone 03.

## Context
The roadmap requires a "maintained Chromium stable distribution, pinned per release", separate processes and directories, and dedicated browser-security maintenance capacity. Chromium ships security fixes frequently; a pinned build that is not updated quickly becomes the product's largest security liability. Building Chromium from source needs very large CI machines and a dedicated owner; the suggested team has one Rust/browser engineer.

## Options
| Option | Pros | Cons |
|---|---|---|
| A. Build Chromium from source in our CI | Full control; can add enterprise policies and branding | Very high build cost and maintenance; security patch latency depends on our pipeline; too much for v1 team size |
| B. Bundle a pinned build from an established, maintained third-party Chromium distribution | Low build cost; predictable cadence | Depends on that project's cadence, license and binary provenance; codec/DRM gaps |
| C. Use Google's "Chrome for Testing" binaries | Official upstream builds | Intended for automated testing, not end-user distribution; unsuitable as a product runtime |
| D. Use the customer's installed Chrome/Edge (`--user-data-dir` per profile) | No distribution or patching burden; vendor auto-updates | No version pin; behaviour varies by vendor/version; cross-version profile reuse can corrupt data (Chromium policy docs warn profiles are not backward compatible) |

## Proposed decision
- **Engineering alpha (after 05):** option D behind a capability check, with the exact browser version recorded per profile and refusal to open a profile last written by a newer major version. This gets the local alpha moving without a distribution pipeline.
- **Team beta and paid launch:** option B, selected by the browser/security owner against these criteria: published security-release cadence, license compatible with redistribution, reproducible or verifiable provenance, Windows x64 + macOS arm64 builds, and our ability to verify hashes (crates/update).
- **Security SLA (to be ratified):** ship upstream Chromium security fixes rated High/Critical within 7 days of upstream stable release; others with the next scheduled release. Track exposure as a release metric.
- **Never** load untrusted web content in the Tauri manager webview (roadmap boundary). Unchanged by this ADR.

## Consequences
- Codecs (H.264/AAC) and Widevine DRM may be unavailable in third-party builds; document affected sites rather than promising parity with Google Chrome.
- The manager must enforce one process per profile: the step-4 spike showed the harness build does not stop a second process from opening a directory already in use (docs/spikes/01-step4-storage-isolation.md).
- Snapshot manifests record `browser_revision`; restores across major versions require a compatibility rule (milestone 07).

## Evidence / verification
- Step-4/6 spikes ran against headless Chromium 153.0.8010.0 (Linux harness only; see docs/spikes/README.md). Windows/macOS runs with the chosen distribution are an exit item before 03.
- Chromium user-data-directory policy reference: https://www.chromium.org/administrators/policy-list-3/user-data-directory-variables/

## Revisit when
The candidate distribution is chosen, or if security-patch latency exceeds the SLA twice in a quarter.
