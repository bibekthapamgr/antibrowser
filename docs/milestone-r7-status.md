# R7 — status against the handoff file

Full journey verification, performance and launch (revised roadmap; replaces the remaining execution of original
milestones 13/14). API 0.19.0, schema `0018_operations_watch.sql`.
- **Decision:** [ADR-0026](adr/0026-journey-verification-performance-and-launch.md).
- **Deliverables:** [r7/README.md](r7/README.md).

**Outcome.** Everything the code can prove is proven and repeatable: the eight journeys have named automated evidence
(with three new chained tests), performance is measured and labelled with its machine (API workload and 15-minute
soak, 10,000-row search, real-browser 1/5/10 profiles, Lighthouse), the owner sees health figures and alerts that
raise and clear themselves, and production bundles are proven free of demo code. **Launch is not complete:** the
launch checklist lists what only the owner, real Windows/macOS computers and the pilot can provide (signed build and
runtime licensing, reference-device numbers, a real new user's journey, the pilot report, the staging restore of
record, external review, rollback rehearsal, the release tag).

## Integration matrix
| Journey | State |
|---|---|
| 1. New user website → app → profile | Automated (CI production job over https, onboarding/web/portal tests, real-browser tests). Real-device install: pilot. |
| 2. Paid checkout, delayed webhook, limits everywhere | Automated (billing, portal, admin, Stripe sandbox). |
| 3. 10 of 50 shared; nothing else discoverable | Automated; **R7 extends** the test to search, export, workspace counts, automation jobs and the member's API token. |
| 4. 0.12.x upgrade | Automated upgrade/migration tests; real 0.12.x installations: upgrade report (owner). |
| 5. Two workspaces | Automated; **R7 adds** billing tied to the right workspace. |
| 6. Payment edge cases, seats, suspension | Automated. |
| 7. Owner handles a case without shell/SQL | **R7 adds** one chained test (find, billing, audited override, webhook problem resolved, audit trail). |
| 8. Failure recovery | Automated except sleep/wake (pilot script; lease design covers it). |
Details and gaps: [r7/integration-matrix.md](r7/integration-matrix.md).

## Performance (DEV machine: 2 vCPU, 8 GB; not the reference device)
- API metadata reads p95 **24 ms** at normal load, 222 ms at this machine's saturation (~350 reads/s); session cycle
  p95 84 ms; **15-minute soak: 0 errors in ~276,000 requests, p95 107–124 ms per minute, no memory growth**.
- Local search over 10,000 rows (release): p95 **50 ms** (target 200 ms). CI's release measurement was running zero
  tests; fixed.
- Profile open → interactive (headless Chromium): p95 418–460 ms with 5–10 open; memory ~110–240 MB per profile (PSS).
- Website LCP 1.0–1.4 s, CLS ≤ 0.02 (mobile lab); portal usable content 3.0 s → **1.7 s** after enabling compression
  in the production proxy (change made).
- Reference device and VPS measurements: owner. Report: [r7/performance-report.md](r7/performance-report.md).

## Observability and scaling
Console → Operations → **Health** (sign-ups, checkout pending age, open and unrenewed leases, snapshot saves and
failures, queued jobs, archiving); alerts `queue_backlog`, `backup_failing`, `sync_failures` (worker, every minute)
and `restore_failed` (restore drill), cleared automatically; no third-party analytics; single VPS recorded as the
failure domain. [r7/observability.md](r7/observability.md).

## Feature retirement gate
The desktop production bundle no longer contains the demo backend; CI inspects every production bundle for demo and
fixture code. Old records and API fields kept; cleanup only after an observation window.
[r7/retirement-gate.md](r7/retirement-gate.md).

## Pilot and launch
Plan with consent, roles, targets and pause criteria: [r7/pilot-plan.md](r7/pilot-plan.md). Launch evidence and its
state: [r7/launch-checklist.md](r7/launch-checklist.md). Support: [r7/support-runbooks.md](r7/support-runbooks.md).

## Server steps for the owner
Migration 0018 runs with `vps-setup.sh`. Everything else is in the consolidated owner list (R5–R7).
