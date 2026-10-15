# R6 — Incidents, escalation and rollback

## Contacts and status page
| Role | Who | How |
|---|---|---|
| Incident lead and security contact | project owner | `SECURITY.md` address; phone in the offline kit |
| Hosting (VPS) | provider support | provider panel |
| Mail, payments, R2 | provider support pages | provider dashboards |
| Status page | `STATUS_URL` in `/etc/project-browser/site.env` (linked from the website footer and the portal) | update it first in any customer-visible incident |

Fill the real names and numbers in the offline kit, not in this repository.

## Severity and first steps
| Severity | Examples | First hour |
|---|---|---|
| 1 — security | leaked secret, unauthorized access, a signed bad build | contain (rotate the secret, suspend the workspace or staff, `pause`/`revoke` the update channel), preserve logs and the platform audit export, status page |
| 2 — outage | site/API down, sign-in down, backups failing | `systemctl status pb-proxy pb-api pb-worker keycloak postgresql-18`, `/v1/ready`, preflight, `pb-backup status` |
| 3 — degraded | e-mail delayed, worker stale, one customer affected | staff console → Operations |

## Rollback
- **App code:** check out the previous commit on the server (`git -C /home/pb/antibrowser checkout <commit>` as `pb`)
  and run the services again (`systemctl restart pb-api pb-worker`). Allowed only within migration compatibility:
  migrations are additive and run before new code, so the previous code still runs on the newer schema; never roll the
  database back to undo a release — data and outbox events are kept. `/v1/ready` says `behind` if code is newer than
  the schema.
- **Desktop updates:** `desktop release` → `pause` the channel (stops offering), `revoke` bad versions, `minimum` to
  force an update; customer data is never touched ([update runbook](../security/update-runbook.md)).
- **Configuration:** the setup scripts regenerate generated files; your files (`public.env`, `smtp.env`,
  `billing.env`, `backup.env`, `site.env`) are never overwritten.
- **Data:** restore rules in [restore-evidence.md](restore-evidence.md) and the DR runbook; production is replaced only
  by `restore-server --yes-replace-this-database` after the decision is recorded.

## Patch coverage
- OS packages: the distribution's security updates (`dnf upgrade --security` / unattended-upgrades), monthly and on
  advisories; reboot window announced on the status page.
- Pinned components (Node 24 LTS, PostgreSQL 18, Keycloak, Caddy, SeaweedFS, Stripe CLI on dev only): versions and
  SHA-256 in the setup scripts; update them in the repository and re-run `vps-setup.sh`.
- Application dependencies: lockfile, CI audit; the browser runtime follows ADR-0010.
