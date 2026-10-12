# Project Browser (brand undecided)

Desktop multi-profile browser for **authorized business account work**: isolated sessions, client workspaces, controlled team access, reliable handoff and optional encrypted sync.

> Separate profiles separate **stored website data**. They do not make profiles appear as different devices or networks, and this product makes no invisibility or ban-prevention claims.

**Status:** milestone 01 (architecture, contracts and repository foundation). See [docs/milestone-01-status.md](docs/milestone-01-status.md) for exit criteria and what is still open.

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
services/worker       PostgreSQL outbox worker
packages/contracts    shared contracts (TypeScript + JSON Schema)
packages/config       environment schema and safety checks
packages/ui           design tokens and shared components
crates/runtime        profile ids, directory layout, launch validation
crates/storage        SQLite WAL local store
crates/update         pinned runtime manifest + artifact verification
infra                 migrations, local bootstrap, env examples, docker-compose
spikes                milestone 01 feasibility harnesses
docs                  setup, architecture, contracts, ADRs, spike reports, OpenAPI
```

## Common commands
```bash
pnpm install && pnpm db:reset && pnpm dev:api
pnpm lint && pnpm typecheck && pnpm test
cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```
