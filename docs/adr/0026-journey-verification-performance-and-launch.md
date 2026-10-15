# 0026 — Full journey verification, performance, pilot and launch (R7)
Status: **Accepted (revised-roadmap track)**. Date: 2026-10-15. Owner: product owner with the backend, desktop and
security leads. Replaces the remaining execution of original milestones 13 and 14 while keeping their targets and
release gates. Builds on ADR-0025.

## Decision
1. **Integration matrix first.** Eight customer journeys are the launch definition
   ([r7/integration-matrix.md](../r7/integration-matrix.md)). Each has named automated evidence; what only real
   devices and people can show (install on Windows/macOS, sleep/wake, a real new user) is part of the pilot and the
   launch checklist, not assumed.
2. **Measure, label, do not promise.** Targets stay proposals until measured on the declared reference device
   (16 GB RAM, SSD, 4+ cores). Every number in the performance report names its machine, OS, browser, sample count
   and conditions. The repository gains repeatable measurements: the API workload and soak
   (`pnpm --filter @pb/api perf`), the 10,000-row local search (release build in CI), the real-browser
   open-to-interactive and memory test for 1/5/10 profiles (`perf_profiles_open_to_interactive_and_memory`), and
   website Lighthouse runs. Initial download and snapshot restore are measured apart from warm launch. The
   1 million profiles / 100 requests per second scenario is an expansion benchmark, not a single-VPS promise.
3. **Observability without new infrastructure.** Health figures in the console (sign-ups, checkout pending age, open
   and unrenewed leases, snapshot saves/failures, queued work, archiving) and four operations alerts raised and
   cleared by the worker every minute (`queue_backlog`, `backup_failing`, `sync_failures`) or by the restore drill
   (`restore_failed`), in the existing alert table. Desktop timings stay local (Diagnostics); no third-party analytics;
   non-essential analytics would need opt-in consent. Optimize queries, indexes, caching and worker concurrency before
   splitting; access and lease decisions stay on PostgreSQL; the single VPS is recorded as the failure domain.
4. **Retirement gate.** Production bundles carry no demo or fixture code, proven by artifact inspection in CI; old
   records and API fields are kept; cleanup only after a usage observation window and an ADR.
5. **Pilot and staged rollout** with consent, 5–10 users across the three roles, explicit pause criteria (data loss,
   authorization violation, broken paid entitlement, elevated crashes/sync failures), canary then staged stable of the
   exact files ([r7/pilot-plan.md](../r7/pilot-plan.md)).
6. **Launch is evidence, not demos.** Launch is complete only when the checklist in
   [r7/launch-checklist.md](../r7/launch-checklist.md) is filled with real results — including one real new user
   finishing website → app → shared profile without manual account creation — and the R6 owner gates are closed.

## Consequences
The code side of R7 is done and repeatable; the launch itself waits for owner actions (domain, providers, signing,
runtime licensing, external review, reference-device measurements, the pilot). The checklist says which.
