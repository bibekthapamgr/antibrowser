# R7 — Final launch evidence

Launch is **not** complete while any line below is open. Screenshots or demos do not count. State on 2026-10-15:
the code side is done; the open lines are owner actions or real-device/pilot runs.

| # | Evidence | State | Where / who |
|---|---|---|---|
| 1 | End-to-end results on Windows x64 and macOS arm64 (integration matrix rows 1–8 on real computers) | **open** — automated parts green in CI; device runs need the signed (or labelled pilot) build | owner + pilot, [integration-matrix.md](integration-matrix.md) |
| 2 | Upgrade/migration report (0.12.x installation → new build, each OS) | **open** — automated upgrade tests green | owner, table below |
| 3 | Web/mobile layout and accessibility check | done for code: website, portal and console e2e include phone widths and axe checks; **open**: a person checks on a real phone | owner |
| 4 | Provider billing test evidence | done in CI with the provider stand-in and the Stripe sandbox suite (when its secret is set); **open**: one real test-mode purchase on staging, then live product check | owner, [r6 operations guide](../r6/operations-guide.md) §4 |
| 5 | Genuine runtime and signing release proof | **open** — runtime licensing (ADR-0010), release key, OS signing or the labelled pilot exception | owner, [r6/release-evidence.md](../r6/release-evidence.md) |
| 6 | Owner/admin guide | done — [r6/operations-guide.md](../r6/operations-guide.md), [support-runbooks.md](support-runbooks.md), [r5 admin guide](../r5/README.md) | — |
| 7 | External review closures | **open** — review not commissioned; S1 closed, T3/C-L4 residuals dated, D1 owner action | owner, [r6/security-closure.md](../r6/security-closure.md) |
| 8 | Real backup restore | **open** — CI drills pass; the staging rehearsal of record (`--workspace`) is an owner run | owner, [r6/restore-evidence.md](../r6/restore-evidence.md) |
| 9 | Performance report with hardware | done for the development machine and CI; **open**: the reference device (16 GB / SSD / 4+ cores) on Windows and macOS | owner, [performance-report.md](performance-report.md) |
| 10 | Known limitations and support runbooks | done — [support-runbooks.md](support-runbooks.md) | — |
| 11 | One real new user: website → app → shared profile, no manual account creation | **open** | pilot |
| 12 | Pilot report (5–10 users, targets, issues) | **open** | [pilot-plan.md](pilot-plan.md) |
| 13 | Tagged release, docs updated, supported versions recorded | docs and versions done ([support-runbooks.md](support-runbooks.md#supported-versions-record-at-each-release)); **tag** after the pilot: `git tag -s v1.0.0` on the released commit | owner |
| 14 | Rollback rehearsed | **open** — procedure in [r6/incident-and-rollback.md](../r6/incident-and-rollback.md); rehearse on staging: deploy, roll code back one commit, `/v1/ready` stays ready, data kept; pause/resume a canary channel | owner |
| 15 | Owner operates the dashboard and handles an incident | **open** — a tabletop exercise with the runbooks (a failed webhook, a restore drill alert, a suspected leak) | owner |

## Upgrade report
| Date | OS | From version | To version | Linked profiles duplicated? | Local-only stayed local? | Snapshots/keys OK? | Agency records OK? | By |
|---|---|---|---|---|---|---|---|---|
| | Windows x64 | 0.12.x | | | | | | |
| | macOS arm64 | 0.12.x | | | | | | |
