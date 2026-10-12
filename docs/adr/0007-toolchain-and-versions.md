# 0007 — Toolchain and package versions
Status: **Accepted**. Date: 2026-10-12. Owner: technical lead.

## Decision
Exact versions are pinned in `package.json` files (`save-exact`), `pnpm-lock.yaml`, `Cargo.lock` and `rust-toolchain.toml`. The full table with release URLs is in [docs/version-manifest.md](../version-manifest.md). Upgrades go through a pull request that updates the manifest and passes CI.

Choices that differ from "newest available":
- **Node.js 24 LTS**, not the newer Current line (roadmap guidance).
- **pnpm 10.34.6** rather than pnpm 12: the corepack bundled with Node 22/24 could not launch pnpm 12 in verification. Revisit when corepack is updated.
- **Tauri 2.x**, not the 3.0 alpha.
- **TypeScript 7.0.2** (current stable, native compiler). Code is restricted to erasable syntax so Node runs `.ts` files directly without a build step.
- **PostgreSQL 18** in CI and production; schema avoids version-specific features so PostgreSQL 16+ also works.

## Verification environment deviations (recorded, not hidden)
The 2026-10-12 verification sandbox had Node 22.22.0, PostgreSQL 16.15 and Rust 1.97.0 preinstalled and no access to download Node 24, PostgreSQL 18 or newer Rust. All tests passed there. CI runs the pinned Node 24 and PostgreSQL 18; the first CI run is the confirmation for those versions. `rust-toolchain.toml` pins 1.97.0, the compiler actually verified; bump to the current stable at kickoff after confirming CI.
