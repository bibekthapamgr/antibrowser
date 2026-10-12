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
# optional, debug builds only: use a local Chromium instead of installing the pinned runtime
PB_DEV_BROWSER=/path/to/chromium cargo run -p pb-desktop
pnpm dev:desktop-ui                      # UI alone in a browser with demo data
```

Demo modes for UI work: `?demo=fresh` (first run), `?demo=rows:10000` (large list), `?demo=crash`, `?demo=migration`, `?demo=running`.

UI end-to-end tests (keyboard, axe accessibility, 900x600 resize, 2x scale, 10,000-row virtualization) run the production bundle in headless Chromium:

```bash
pnpm --filter @pb/desktop exec browsers install chrome-headless-shell@stable --path ~/.cache/pb-chrome
PB_CHROME_PATH=<path printed above> pnpm test:e2e
PB_SCREENSHOTS=1 PB_CHROME_PATH=... pnpm test:e2e     # also refreshes docs/design/*.png
```

Installers: `pnpm --filter @pb/desktop tauri build` locally, or the *desktop internal build* workflow (see [os-setup.md](os-setup.md)).

Real-browser tests (milestone 03: isolation, crash, double launch, ten cycles, portability) need a Chromium and a
non-root user (the Chromium sandbox stays on):

```bash
PB_TEST_BROWSER=/path/to/chrome PB_TEST_BROWSER_VERSION=155.0.8059.39 \
PB_TEST_SWITCHES=--ozone-platform=headless,--disable-gpu,--password-store=basic \
  cargo test -p pb-desktop --test browser -- --test-threads=1
```
Debug builds of the manager can use a local browser with `PB_DEV_BROWSER=/path/to/chrome` (optionally
`PB_DEV_BROWSER_VERSION`). Release builds only run the runtime from the signed manifest (docs/runtime-pipeline.md).

Shortcut on macOS (Apple Silicon) or Linux: `scripts/dev/try-runtime.sh` downloads the Chrome for Testing build the
pipeline tested, checks its pinned SHA-256, and opens the manager as a debug build using it (`pnpm tauri dev`);
`scripts/dev/try-runtime.sh --tests` runs the real-browser tests instead. Run it as your normal user.

## 4. Checks (same as CI)

```bash
pnpm lint && pnpm typecheck && pnpm test      # tests use the separate pb_test database
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
pnpm licenses                                  # docs/licenses/summary.md
pnpm openapi                                   # regenerates docs/openapi.json
pnpm docs:ipc                                  # regenerates docs/ipc-schema.json
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

## Test server (Linux VPS)

`scripts/deploy/vps-setup.sh` sets up a shared test server (RHEL-family or Debian/Ubuntu): Node 24 in `/opt/node`, PostgreSQL 18, a `pb` user with a read-only GitHub deploy key, random database passwords in `/etc/project-browser/api.env`, migrations, fixture tenants, the test suite, and `pb-api` / `pb-worker` systemd services bound to `127.0.0.1`. It does not change firewall or SSH settings.

```bash
scp scripts/deploy/vps-setup.sh root@<server>:/root/
ssh root@<server> 'bash /root/vps-setup.sh'      # first run prints the deploy key to add on GitHub
ssh root@<server> 'bash /root/vps-setup.sh'      # second run deploys
# later updates, on the server: \cp -f /home/pb/antibrowser/scripts/deploy/vps-setup.sh /root/ && bash /root/vps-setup.sh
ssh -N -L 8080:127.0.0.1:8080 root@<server>      # then http://127.0.0.1:8080/v1/health on your machine
```
The server runs with `APP_ENV=dev` and development tokens, so the API must stay private until OIDC login exists (milestone 06).
