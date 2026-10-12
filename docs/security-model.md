# Security model (draft, milestone 01)

This document states what the product protects, what it does not, and the disclosures customers must see. Milestone 12 turns it into a reviewed threat model.

## What is protected
| Asset | Protection in place now | Planned |
|---|---|---|
| Tenant data in the API | Server-derived membership; non-members get 404; row-level security on every tenant table; response schemas strip unexpected fields; least-privilege DB roles | Pen test (12) |
| Profile directories | Named only by validated id; symlinks refused; containment re-checked after creation | Exclusive OS lock per profile (03) |
| Manager UI → native code | 3 commands allowed by capability; typed arguments rejected before execution; browser executable never taken from the UI; strict CSP; no remote content | Code signing from 02, updater signatures (12) |
| Browser processes | Launched with a minimal environment (no inherited tokens); fixed argument list; Chromium sandbox left on | Runtime update SLA (ADR-0001) |
| Snapshots | Planned client-side encryption before upload (ADR-0003) | 07 |
| Logs | Authorization, cookie and idempotency headers redacted; errors carry codes, not stack traces or SQL | OpenTelemetry pipeline with redaction (13) |

## Required disclosures (must appear in docs and UI where relevant)
1. **Profiles in use are plaintext to Chromium on the device.** Anyone with access to the logged-in OS account while a profile is open can read its data; disk encryption is the customer's responsibility.
2. **Separate profiles separate stored website data** (cookies, local storage, IndexedDB, cache). They do **not** make profiles appear as different devices or networks, and they do not prevent websites from linking activity.
3. **Logins may not survive moving a profile to another device** (ADR-0002). Users may need to sign in again.
4. **Operator access to encrypted snapshots** is technically possible through key management and is restricted and audited (ADR-0003). No end-to-end or zero-knowledge claim.
5. The product is for **authorized business account work**. The acceptable-use policy forbids violating website terms, evading bans, or fraud; no feature is marketed as ban prevention or invisibility.

## Findings from milestone 01 spikes
- The tested Chromium build allowed a **second process to open a directory already in use**. The manager must hold an exclusive per-profile lock before launch (milestone 03) in addition to process tracking.
- **Cookies are not port-isolated** on the same host (web platform behaviour); localStorage and IndexedDB are. This does not affect isolation between profiles, but test origins must keep the same port across restarts.
- On Linux the spike browser used a non-machine-bound cookie key (`v10`, basic store). Windows (DPAPI + app-bound encryption) and macOS (Keychain) bind keys to the machine/user, so Linux results must not be generalized.
