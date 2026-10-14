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
| Browser runtime | Chrome for Testing **155.0.8059.39** (revision 1697595), pinned in the signed `runtimes/manifest.json` (signed 2026-10-12 after Windows/macOS/Linux compatibility passed; internal alpha only, ADR-0010) | docs/runtime-pipeline.md |
| ed25519-dalek / ureq (rustls, platform verifier) | 3.0.0 / 3.4.x | crates/update |
| csv / zip (deflate only) | 1.4.0 / 9.0.2 | crates/import (milestone 04) |
| unicode-normalization | 0.1.25 | crates/storage name folding (milestone 04) |

## Backend
| Component | Pinned | Reference |
|---|---|---|
| Fastify | 5.12.5 | https://fastify.dev/docs/latest/Reference/LTS/ |
| @fastify/swagger | 9.9.2 | https://github.com/fastify/fastify-swagger |
| @fastify/type-provider-typebox / typebox | 6.2.0 / 1.3.36 | https://github.com/sinclairzx81/typebox |
| pg (node-postgres) | 8.23.1 | https://node-postgres.com |
| jose | 6.2.12 | https://github.com/panva/jose |
| Vitest | 5.0.3 | https://vitest.dev |

## Backups and sync (milestone 07)
| Component | Pinned | Reference |
|---|---|---|
| aes-gcm / aead-stream (RustCrypto) | =0.11.1 / =0.6.0 | https://github.com/RustCrypto/AEADs |
| zstd (level 3) / tar | 0.13.3 / 0.4.46 | crates/seal |
| sha2 / zeroize | 0.10.9 / 1.9.1 | crates/seal |
| @aws-sdk/client-s3 / s3-request-presigner | 3.1142.0 / 3.1142.0 | services/api (signed part uploads and downloads) |
| SeaweedFS (S3-compatible storage: test server, CI, docker-compose) | 4.48, release archives pinned by SHA-256 (amd64 `4a7d1083…a9561124`, arm64 `557e92c3…d09f03a07`) | https://github.com/seaweedfs/seaweedfs/releases/tag/4.48 |
| Root key provider | `local` (a mode-600 JSON file, ADR-0014) | A managed KMS/HSM is a paid launch gate |

## Identity (milestone 06)
| Component | Pinned | Reference |
|---|---|---|
| Keycloak (reference OIDC provider: CI and the test server) | 26.6.2 | https://www.keycloak.org |

## Developer API and automation (milestone 10)
| Component | Pinned | Reference |
|---|---|---|
| tungstenite (WebSocket handshake for the loopback broker; no TLS, no client features) | 0.30.0 | crates/devtools |
| windows-sys (Win32 pipes for `--remote-debugging-io-pipes`) | 0.61.2 | crates/devtools (Windows only) |
| libc (descriptor placement in the child, Unix) | 0.2.190 | crates/devtools (Unix only) |
| playwright-core (compatibility test only, dev dependency) | 1.63.0 | packages/sdk |
| Chromium for DevTools pipe tests | chrome-headless-shell, current stable in CI; Chrome for Testing upstream stable in the runtime pipeline's compatibility jobs | crates/devtools/tests, apps/desktop/src-tauri/tests/browser.rs |
| Webhook signatures | Standard Webhooks (HMAC-SHA256, `webhook-id`/`-timestamp`/`-signature`) | https://www.standardwebhooks.com |

## Not yet versioned (chosen in later milestones)
Cloud provider/region (ADR-0005), managed KMS/HSM (ADR-0003/0014), production object storage service, OpenTelemetry SDK (13).
