# Version manifest

Recorded 2026-10-12 (milestone 01). Exact versions are locked in `pnpm-lock.yaml`, `Cargo.lock` and `rust-toolchain.toml`; this table is the human-readable record the roadmap asks for. Re-verify security patch levels at kickoff and on every upgrade PR.

## Runtimes and toolchains
| Component | Pinned | Verified in sandbox | Release / support reference |
|---|---|---|---|
| Node.js | 24 LTS (`.nvmrc`, `engines >=24 <25`) | 22.22.0 (24 not downloadable in sandbox; CI uses 24) | https://github.com/nodejs/Release |
| pnpm | 10.34.6 (`packageManager`) | 10.34.6 | https://pnpm.io |
| Rust | 1.97.0 (`rust-toolchain.toml`) | 1.97.0 | https://blog.rust-lang.org/releases |
| PostgreSQL | 18 (CI service, docker-compose) | 16.15 (schema is 16+ compatible; CI uses 18) | https://www.postgresql.org/support/versioning/ |
| TypeScript | 7.0.2 | 7.0.2 | https://www.npmjs.com/package/typescript |
| Biome (lint/format) | 2.5.15 | 2.5.15 | https://biomejs.dev |

## Desktop
| Component | Pinned | Reference |
|---|---|---|
| Tauri (crate) | 2.12.3 (`"2"` in Cargo.toml, locked) | https://v2.tauri.app/security/ |
| tauri-build | 2.7.2 | https://v2.tauri.app |
| @tauri-apps/api / cli | 2.12.3 / 2.12.2 | https://v2.tauri.app |
| rusqlite (bundled SQLite) | 0.40.2 (libsqlite3-sys 0.38.2) | https://crates.io/crates/rusqlite |
| React / React DOM | 19.3.0 | https://react.dev/versions |
| Vite / @vitejs/plugin-react | 8.3.4 / 6.1.2 | https://vite.dev |
| Browser runtime | **Not chosen** (ADR-0001). Spike harness: headless Chromium 153.0.8010.0 from `@sparticuz/chromium@153.0.0` | ADR-0001 |

## Backend
| Component | Pinned | Reference |
|---|---|---|
| Fastify | 5.12.5 | https://fastify.dev/docs/latest/Reference/LTS/ |
| @fastify/swagger | 9.9.2 | https://github.com/fastify/fastify-swagger |
| @fastify/type-provider-typebox / typebox | 6.2.0 / 1.3.36 | https://github.com/sinclairzx81/typebox |
| pg (node-postgres) | 8.23.1 | https://node-postgres.com |
| jose | 6.2.12 | https://github.com/panva/jose |
| Vitest | 5.0.3 | https://vitest.dev |

## Not yet versioned (chosen in later milestones)
OIDC provider (ADR-0004), cloud provider/region (ADR-0005), KMS (ADR-0003), object storage service, OpenTelemetry SDK (13), MinIO image tag for local dev (pin a dated RELEASE tag at kickoff).
