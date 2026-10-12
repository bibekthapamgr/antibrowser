# Milestone 01 — status against the handoff file

Checked 2026-10-12 against the roadmap (project instructions) and `01-Architecture-and-Foundation.md`.
**Verdict: engineering deliverables complete; milestone not yet "delivered"** because three items need owner action (decisions and accounts) that cannot be done from the repository. 02 can start in parallel on the parts it consumes that are already fixed (contracts, IPC pattern, repository).

## Build steps
| Step | Status | Evidence |
|---|---|---|
| 1. Monorepo with apps/desktop, apps/web-admin, services/api, services/worker, packages/contracts, packages/ui, packages/config, infra, docs/adr; Rust workspace owns runtime, storage, update crates; pinned Rust, Node, package manager | Done | Repository layout; `rust-toolchain.toml`, `.nvmrc`, `packageManager`, lockfiles; [ADR-0007](adr/0007-toolchain-and-versions.md) |
| 2. Format/lint/type checks, clippy, secret scanning, dependency/license inventory; PR checks compile desktop targets and run tests | Done (CI defined; first GitHub run pending) | `.github/workflows/ci.yml` (Windows + macOS arm64 compile), `.gitleaks.toml`, `pnpm licenses` → [licenses/summary.md](licenses/summary.md): 591 packages, none outside the allow-list |
| 3. dev/staging/prod identities, databases, buckets; no prod secrets in fixtures; two seeded tenants | **Partly**: dev/test done; staging/prod are config-enforced but **not provisioned** | `infra/env/*.example`, `packages/config` refuses unsafe staging/prod config (5 tests); two fixture tenants seeded |
| 4. Spike: two sandboxed Chromium instances, distinct directories, cookie/localStorage/IndexedDB isolation | Done (Linux harness); Windows/macOS re-run with chosen runtime pending | [spikes/01-step4](spikes/01-step4-storage-isolation.md): 6/6 checks pass |
| 5. Spike: Tauri→Rust launch IPC rejects invalid profile/path before starting any process | Done | [spikes/01-step5](spikes/01-step5-ipc-validation.md): 18 malicious requests, 0 processes, 0 directories |
| 6. Spike: closed-profile snapshot/restore same device and across a second device; record constraints | Same device done; **cross-device Windows/macOS pending** | [spikes/01-step6](spikes/01-step6-snapshot-restore.md); stop gate applied in [ADR-0002](adr/0002-profile-portability.md) |
| 7. ADRs: runtime distribution, profile portability, encryption trust model, identity provider, regions, supported OS | Written; 0002/0006/0007/0008 accepted, **0001/0003/0005 proposed** (need sign-off) | [docs/adr](adr/README.md) |

## Deliverables
| Deliverable | Where |
|---|---|
| Setup guide | [setup.md](setup.md) |
| Architecture diagram | [architecture.md](architecture.md) |
| Permission matrix draft | [permission-matrix.md](permission-matrix.md) (generated from contracts) |
| OpenAPI skeleton | [openapi.json](openapi.json) (OpenAPI 3.1, 10 paths, generated from route schemas) |
| Database migrations | `infra/db/migrations/0001_foundation.sql`, `0002_worker_maintenance.sql` |
| Version manifest | [version-manifest.md](version-manifest.md) |
| Spike reports | [spikes/](spikes/README.md) with raw JSON in `spikes/results/` |

## Pass criteria
| Criterion | Result |
|---|---|
| New developer starts fixtures from documented commands | **Pass**: fresh `git clone` → `pnpm install` → bootstrap → `pnpm db:reset` → API, worker, fixture token, own-tenant list, wrong-tenant 404, outbox → audit entry |
| Wrong-tenant fixture requests fail | **Pass**: 404 at the API for list/get/patch/lease across tenants; row-level security returns nothing without context and rejects cross-tenant writes (10 tests) |
| Two profiles demonstrably isolate storage | **Pass** on the Linux harness (sandbox on) |
| Restore limitations documented | **Pass**: ADR-0002, spike 6 report, security model |

## Test totals (fresh clone)
TypeScript 47 passed (config 5, contracts 6, ui 5, api 25, worker 6). Rust 19 passed plus 1 measurement. Lint, type checks, `cargo fmt`, `clippy -D warnings`: clean.
Local search baseline: 10,000 rows, p95 2.13 ms (target <= 200 ms; sandbox VM, release build — not the reference device).

## Owner actions before 01 counts as delivered
1. **Choose the browser runtime** and ratify the security-update SLA (ADR-0001). Then re-run spikes 4 and 6 on Windows 11 and macOS arm64 with it.
2. **Sign off ADR-0003** (key custody) and **ADR-0005** (region; needs expected customer locations).
3. **Provision staging and prod**: cloud accounts, managed PostgreSQL 18, private buckets (`pb-snapshots-staging`, `pb-snapshots-prod`), OIDC tenants, secret manager entries.
4. Push to a GitHub repository so CI runs once (confirms Node 24 and PostgreSQL 18, Windows/macOS compile).
5. Start Apple Developer Program enrollment (D-U-N-S) and Windows code signing; 02 requires signed internal builds.

## Requirements handed to later milestones
- **03:** exclusive OS-level lock per profile before launch (spike 4 found the browser allows a second process on a directory in use); replace `PB_DEV_BROWSER` with the pinned runtime.
- **06:** user provisioning, invitations; IdP vendor; per-profile grants question in the permission matrix.
- **07:** KMS key wrapping, ciphertext upload, refuse restore into older browser versions, local→server id reconciliation (ADR-0008 item 8).
- **08:** handoff UX tells users when they must sign in again (ADR-0002).
