# Developer setup

Goal (milestone 01 exit criterion): a new developer starts the fixtures from documented commands.

## 1. Install toolchains

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 LTS (`.nvmrc`) | `nvm use` or fnm/volta |
| pnpm | 10.34.6 | `corepack enable` (Node's corepack reads `packageManager`) |
| Rust | 1.97.0 (`rust-toolchain.toml`) | rustup installs it automatically on first `cargo` command |
| PostgreSQL | 18 | via Docker (below) or a native install |
| Docker | any current | optional, for PostgreSQL 18 + MinIO |
| Tauri prerequisites | per OS | Windows: WebView2 + MSVC build tools. macOS: Xcode command-line tools. Linux (CI/dev only): `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev` |

## 2. Start services and fixtures

```bash
git clone <repo> project-browser && cd project-browser
corepack enable
pnpm install

# Database: either Docker...
docker compose -f infra/docker-compose.yml up -d
# ...or a native PostgreSQL (run the bootstrap once as a superuser):
#   psql -U postgres -f infra/db/bootstrap-local.sql

pnpm db:reset            # migrations + two fixture tenants (Acme Agency, Beta Studio) in pb_dev
pnpm dev:api             # http://127.0.0.1:8080/v1/health
pnpm dev:worker          # outbox worker (separate terminal)
```

Try the API with a fixture identity:

```bash
TOKEN=$(pnpm --silent --filter @pb/api dev-token acmeOwner)
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/me
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/orgs/org_01J9ZSEED0ACME000000000000/profiles
# Wrong tenant -> 404 NOT_FOUND
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/orgs/org_01J9ZSEED0BETA000000000000/profiles
```

Fixture users: `acmeOwner`, `acmeOperator`, `acmeViewer`, `betaOwner` (`services/api/src/fixtures.ts`).

## 3. Desktop manager

```bash
pnpm --filter @pb/desktop build          # bundle the trusted UI
cargo run -p pb-desktop                  # opens the manager window
# optional, debug builds only: point at a local Chromium build for launching profiles
PB_DEV_BROWSER=/path/to/chromium cargo run -p pb-desktop
pnpm dev:desktop-ui                      # UI alone in a browser with demo data
```

## 4. Checks (same as CI)

```bash
pnpm lint && pnpm typecheck && pnpm test      # tests use the separate pb_test database
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
pnpm licenses                                  # docs/licenses/summary.md
pnpm openapi                                   # regenerates docs/openapi.json
```

## 5. Spikes

See [docs/spikes/README.md](spikes/README.md). Run as a **non-root** user so the Chromium sandbox stays on.

## Environments

| | dev | test | staging | prod |
|---|---|---|---|---|
| Database | `pb_dev` local | `pb_test` local/CI | managed, own account | managed, own account |
| Identity | dev HS256 tokens | dev tokens | staging OIDC tenant | prod OIDC tenant |
| Bucket | `pb-snapshots-dev` (MinIO) | none | `pb-snapshots-staging` | `pb-snapshots-prod` |
| Secrets | fixtures in repo | fixtures in repo | secret manager | secret manager |

`packages/config` refuses to start staging/prod with dev auth, a repository fixture secret, a localhost database, or a bucket not suffixed with the environment name. Provisioning the staging/prod cloud accounts, IdP tenants and buckets is an owner action that cannot be done from the repository (see milestone-01-status.md).
