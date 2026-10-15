# R6 — Domain and service map

One environment per server ([ADR-0025](../adr/0025-public-deployment-and-release-readiness.md)). Names below are the
four values of `/etc/project-browser/public.env`; use different names for staging and production (for example
`browser.example.com` / `staging.browser.example.com`).

## Public (through the TLS proxy `pb-proxy`, ports 80 → 443 redirect, 443)

| Name | Serves | Refused (404) | Backend |
|---|---|---|---|
| `SITE_HOST` | website `/`, customer portal `/app/`, API `/v1/…` (the desktop app's server), Stripe webhook `/v1/webhooks/billing`, readiness `/v1/ready` | `/console/`, `/v1/support/…`, `/v1/admin/…` | API `127.0.0.1:8080` |
| `ADMIN_HOST` | staff console `/console/`, `/v1/support/…`, `/v1/admin/…`, `/v1/health`, `/v1/ready` | everything else (`/` redirects to `/console/`) | API `127.0.0.1:8080` |
| `ID_HOST` | Keycloak realm `project-browser-<env>` (sign-in, registration, account page) | `/admin`, `/realms/master`, `/metrics`, `/health` | Keycloak `127.0.0.1:8081` |
| `FILES_HOST` | presigned upload/download links of `pb-snapshots-<env>` only | `/`, every other bucket | SeaweedFS S3 `127.0.0.1:8333` |

Optional `SITE_ALIASES` (comma-separated, e.g. `www.example.com` or an earlier `SITE_HOST`) answer with a permanent
redirect (308, path and query kept) to `SITE_HOST`; a name whose DNS does not point at the server yet is left out.

Certificates: Caddy (pinned 2.11.4), ACME with `ACME_EMAIL`, renewed automatically, stored in `/var/lib/pb-proxy`.
Headers: HSTS one year, `X-Content-Type-Options`, no `Server`. Text responses are compressed (zstd/gzip, R7) except on `FILES_HOST`. No access log (links carry one-time codes and
signatures). The proxy replaces `X-Forwarded-For`; the API trusts one hop.

## Private (127.0.0.1 only; reach with an SSH tunnel)

| Service | Port(s) | Unit | Notes |
|---|---|---|---|
| PostgreSQL 18 | 5432 | `postgresql-18` | databases `pb_<env>`, `keycloak`; roles `pb_owner`, `pb_app`, `pb_worker` (random passwords, rotated on every setup run) |
| API | 8080 | `pb-api` | `APP_ENV=<env>`, `HOST=127.0.0.1`, `TRUST_PROXY_HOPS=1` |
| Worker | — | `pb-worker` | outbound only; private networks refused by `pb-egress` |
| Keycloak | 8081 | `keycloak` | administration via tunnel: `ssh -N -L 8081:127.0.0.1:8081 root@<server>` → `http://127.0.0.1:8081/admin/` |
| SeaweedFS | 8333, 9333, 19333, 8090, 18090, 8888, 18888 | `pb-storage` | snapshot storage |
| Backups | — | `pb-backup-db.timer`, `pb-backup-objects.timer` | pgBackRest + rclone to Cloudflare R2 |

The preflight's `private_ports` check fails if any of these listens on a public address.

## Configuration files (`/etc/project-browser`)

| File | Who writes it | Mode |
|---|---|---|
| `environment` | vps-setup.sh (`PB_ENV`) | 644 |
| `public.env` | **owner** (from `scripts/deploy/public.env.example`) | 600 root |
| `api.env` | vps-setup.sh (regenerated every run) | 640 root:pb |
| `oidc.env` | keycloak-setup.sh (issuer, clients, session key, billing return address) | 600 root |
| `smtp.env` | **owner** (mail server) | 600 root (enforced) |
| `email.env` | keycloak-setup.sh from smtp.env | 600 root |
| `billing.env` | **owner** (Stripe key, prices, webhook secret) | 640 root:pb |
| `site.env` | **owner** (support e-mail, status page) | 640 root:pb |
| `backup.env` | **owner** (R2) | 600 root |
| `kms-root.json` | vps-setup.sh, once (backup root key; keep an offline copy) | 600 pb |
| `public-ca.pem` | public-setup.sh, only with `TLS_MODE=internal` (tests) | 644 |

## Desktop app and downloads
- Production builds have `PB_DEFAULT_SERVER=https://SITE_HOST` compiled in (repository variable): customers never type
  a server address.
- Updates: signed channel manifests on GitHub Releases (`channel-canary`, `channel-stable`), verified against
  `release-keys.json` compiled into the app. The website's download page offers only a verified stable release.
