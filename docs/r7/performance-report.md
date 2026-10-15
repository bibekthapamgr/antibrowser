# R7 — Performance report

Targets are proposals until measured on the declared reference device. Every result below names its machine; none of
them is a promise for every computer or a capacity claim for the production VPS.

## Machines
| Id | What | Hardware / software |
|---|---|---|
| **DEV** | development container (2026-10-15) | 2 vCPU Intel Xeon @ 2.10 GHz, 8 GB RAM, Linux 6.18; Node 22.22; PostgreSQL 16.15; Chromium 141 (Playwright build 1194) for browser and Lighthouse runs. API, database and load generator on the **same** 2 vCPU. |
| **REF** | reference device (to do) | 16 GB RAM, SSD, modern 4+ cores; Windows 11 x64 and macOS (Apple Silicon); record exact model, OS build, browser revision, power mode |
| **VPS** | production server | today 1 CPU / 1.8 GB (AlmaLinux 8.10) — below the 4 GB recommended for production; measure after the upgrade |

## Results
### API (DEV) — `pnpm --filter @pb/api perf`, workspace of 10,000 profiles, real HTTP to 127.0.0.1
| Scenario | Requests | Errors | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| Metadata reads, light load (4 clients, reads one after another) | 10,172 | 0 | 339/s | 10.7 ms | **23.6 ms** | 31.3 ms |
| — list 50 of 10,000 / search by name / one profile / my workspaces | | | | 10 / 18 / 9 / 8 ms | 17 / 30 / 16 / 15 ms | |
| Metadata reads, saturation (16 clients × 4 parallel reads) | 10,820 | 0 | 361/s | 148 ms | 222 ms | 255 ms |
| Session cycle (open, renew ×2, close, list), 16 clients | 8,600 | 0 | 287/s | 55 ms | 84 ms | 100 ms |
| **Soak 15 min**, mixed (session cycle + reads), 16 clients, token refresh like the app | 276,500 | **0** | 285–322/s per minute | 67–75 ms | **107–124 ms** (per minute) | 128–151 ms |

Findings:
- Target "metadata read p95 ≤ 250 ms" is met with a wide margin at normal load (24 ms) and still met at the
  saturation point of this 2 vCPU machine (222 ms).
- **Ceiling (DEV):** about 340–360 metadata reads per second; beyond that requests queue (latency grows, nothing
  fails). The 15-minute soak shows no drift and no memory growth (API process 363–364 MB resident throughout).
- Leave headroom: plan production for at most about half of the measured ceiling of its own machine. The 1-CPU VPS
  will have a lower ceiling than DEV; measure it there (same command against a staging copy, never production data).
- The 1 million profiles / 100 requests per second scenario remains an **expansion benchmark**, not a single-VPS
  capacity statement.

### Local search (CI and DEV) — `crates/storage/tests/search_latency.rs`, release build
10,000 profiles, text search + filters + sort + one page with total: **p50 26.9 ms, p95 49.8 ms** (DEV; target
p95 ≤ 200 ms). CI now really runs the release measurement on every change (the earlier step filtered to zero tests).

### Website and portal (DEV) — Lighthouse 13.5, mobile preset (simulated slow 4G, mid-tier phone CPU), lab data only
| Page | Served by | LCP | CLS | Performance / Accessibility |
|---|---|---|---|---|
| Home | static, uncompressed | 1.3 s | 0 | 100 / 100 |
| Pricing | static, uncompressed | 1.0 s | 0.015 | 100 / 100 |
| Download | static, uncompressed | 1.2 s | 0.018 | 100 / 100 |
| Home | Caddy with compression | 1.4 s | 0 | 100 / 100 |
| Portal `/app/` (usable content) | static, uncompressed | 3.0 s | 0.048 | 90 / 100 |
| Portal `/app/` (usable content) | **Caddy with compression** | **1.7 s** | 0.048 | 99 / 100 |
| Portal `/app/`, desktop preset | static | 0.6 s | 0.022 | 100 / 100 |
Targets: LCP ≤ 2.5 s and CLS ≤ 0.1 on the public pages (met); portal usable content ≤ 2 s (met **with compression**).
**Change made:** the production proxy now compresses text responses (`encode zstd gzip`; not the encrypted snapshot
files). The portal's script goes from 366 KB to about 110 KB on the wire. No field data has been collected (no
analytics); these are lab numbers only.

### Desktop — browser profiles (DEV, headless Chromium) — `perf_profiles_open_to_interactive_and_memory`
Existing local blank profile → first page interactive (a local page, no internet time), Chromium 141 headless with
its sandbox, release build; memory is PSS (shared pages split fairly), the browsers apart from the manager core:

| Profiles open | Cold open → interactive p50 / p95 | Warm (opened again) p50 / p95 | Browsers' memory (total / per profile) | Manager core |
|---|---|---|---|---|
| 1 | 532 / 532 ms (1 sample) | 324 / 324 ms | 241 MB / 241 MB | 10 MB |
| 5 | 340 / 418 ms | 346 / 451 ms | 616 MB / 123 MB | 11 MB |
| 10 | 361 / 460 ms | 334 / 365 ms | 1,101 MB / 110 MB | 13 MB |

Target "profile → interactive p95 ≤ 4 s" is met with a wide margin here; samples are small (1/5/10) and headless
Linux is not the customer's desktop, so REF must repeat it with ≥ 20 opens. Memory per profile falls as profiles share
browser code; **no fixed memory per profile is promised** — real sites use far more than a blank page. The manager
window itself (webview) is not part of this number: on REF read Diagnostics (`manager_startup_ms`, browser spawn/ready
p50/p95) and the OS task manager for the manager's own memory (target idle ≤ 200 MB, baseline first).

### Not measured here (REF, owner)
- Manager cold and warm launch, p95 over ≥ 20 starts each, Windows and macOS.
- Existing local blank profile → interactive, p95 over ≥ 20 opens; 1 / 5 / 10 profiles; manager vs browser memory.
- First download / snapshot restore, measured separately (never called "warm launch").
- Realistic owned pages (the team's own test sites) next to blank pages.

## How to repeat
```
pnpm --filter @pb/api perf                                    # PB_PERF_SECONDS, PB_PERF_CONCURRENCY,
                                                              # PB_PERF_PROFILES, PB_PERF_SOAK_MINUTES, PB_PERF_OUT
cargo test --release -p pb-storage --test search_latency -- --nocapture
PB_TEST_BROWSER=<chrome> cargo test --release -p pb-desktop --test browser perf_ -- --ignored --nocapture
npx lighthouse@13.5.0 https://SITE_HOST/ --only-categories=performance,accessibility
```
Raw results of these runs: `docs/r7/results/`.
