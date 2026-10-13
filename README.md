# Project Browser (brand undecided)

Desktop multi-profile browser for **authorized business account work**: isolated sessions, client workspaces, controlled team access, reliable handoff and optional encrypted sync.

> Separate profiles separate **stored website data**. They do not make profiles appear as different devices or networks, and this product makes no invisibility or ban-prevention claims.

**Status:** milestones 01–07 delivered (desktop 0.7.0, local engineering alpha; organizations and encrypted backups
against your own server for testing). Latest: [docs/milestone-07-status.md](docs/milestone-07-status.md) — encryption,
backups and cloud synchronization ([docs/sync/](docs/sync/README.md)). Earlier: [01](docs/milestone-01-status.md),
[02](docs/milestone-02-status.md), [03](docs/milestone-03-status.md), [04](docs/milestone-04-status.md),
[05](docs/milestone-05-status.md), [06](docs/milestone-06-status.md).

## Start here
1. [docs/setup.md](docs/setup.md) — toolchains, database, fixtures, checks
2. [docs/architecture.md](docs/architecture.md) — diagram, boundaries, data ownership, code map
3. [docs/contracts.md](docs/contracts.md) — ids, errors, pagination, versions, idempotency, events, leases (apply to all milestones)
4. [docs/adr/](docs/adr/README.md) — decisions; shared assumptions change only through an ADR
5. [docs/spikes/](docs/spikes/README.md) — isolation, IPC validation and snapshot/restore evidence
6. [docs/security-model.md](docs/security-model.md) — protections, disclosures, findings

## Layout
```
apps/desktop          Tauri 2 shell (src-tauri) + React manager UI
apps/web-admin        admin console shell
services/api          Fastify 5 API (/v1), migrations runner, fixtures
services/worker       PostgreSQL outbox worker; snapshot verification, retention, key work
packages/contracts    shared contracts (TypeScript + JSON Schema)
packages/config       environment schema and safety checks
packages/ui           design tokens and shared components
crates/runtime        profile ids, directory layout, launch, locks, process trees, last-good copies
crates/storage        SQLite WAL local store
crates/update         pinned runtime manifest + artifact verification
crates/import         configuration import/export (milestone 04)
crates/netproxy       per-profile proxy gateway (milestone 05)
crates/cloud          sign-in (PKCE), API client, signed transfers (milestones 06–07)
crates/seal           sealed profile archives: tar + zstd + AES-256-GCM STREAM (milestone 07)
crates/sync           encrypted snapshot upload/restore engine (milestone 07)
infra                 migrations, local bootstrap, env examples, docker-compose (PostgreSQL, SeaweedFS)
spikes                milestone 01 feasibility harnesses
docs                  setup, architecture, contracts, ADRs, spike reports, OpenAPI
```

## Common commands
```bash
pnpm install && pnpm db:reset && pnpm dev:api
pnpm lint && pnpm typecheck && pnpm test
cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```
