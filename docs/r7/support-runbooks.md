# R7 — Support runbooks and known limitations

Short answers for the questions customers will ask, and what the owner checks. Nothing here needs shell or SQL
unless it says "server".

## Runbooks
| Customer says | Check (console) | Answer / action |
|---|---|---|
| "I never got the verification e-mail" | Operations → E-mail (failed?); preflight `email_delivery` | Ask them to check spam; resend from the sign-in page ("verify again"); if e-mail fails for everyone: mail provider (server `smtp.env`, `keycloak-setup.sh email-status`) |
| "I paid but the app still says trial" | Customer → billing; Operations → payment provider events; alert `paid_not_active` | Usually the provider's event is late: **Resync** on the customer page; if it stays, a temporary override (with reason and expiry) while it is fixed |
| "My teammate cannot see a profile" | Customer → people and access (they see only what was shared) | The owner shares the profile (or folder) with them; Members never see unshared profiles — by design |
| "The profile is open somewhere else" | Health → open profiles | The other person closes it, or the owner/admin takes it over from the profile page; a lease of a sleeping laptop ends by itself |
| "My cloud backup failed" | Health → failed backups; alert `sync_failures` | Ask for Diagnostics; disk space and network first; the previous backup is always kept |
| "The app wants an update / won't update" | Release status on Operations | Pausing or a minimum version is deliberate after a problem; otherwise ask for Diagnostics |
| "Delete my account / export my data" | Operations → waiting for an answer | Handle under the deletion policy; exports from the profile page (owners) |
| "Someone got into my workspace" | Treat as **severity 1** ([incident-and-rollback.md](../r6/incident-and-rollback.md)) | Security suspension (closes profiles, revokes tokens), preserve audit export, contact them |

## Known limitations (tell customers plainly)
- Separate profiles keep separate stored data; they do **not** make a person invisible or prevent bans. Device and
  network signals are not changed beyond the profile's proxy and the documented settings.
- Not end-to-end encrypted: the server operator holds the backup root key (offline copy); every restore is recorded.
- Windows x64 and macOS Apple Silicon only. Until OS signing is bought, installers show an "unknown publisher" warning
  (unsigned pilot builds are labelled so).
- The browser runtime is Chrome for Testing for the pilot; it is not licensed for general customer distribution
  (ADR-0010) — public launch waits for that decision.
- One server: an outage is downtime until it is restored (targets RPO 15 min, RTO 4 h).
- No phone alerts yet; the owner watches the console.
- Performance numbers are measured on the machines named in the performance report, not promised for every computer;
  no fixed memory per profile is promised.

## Supported versions (record at each release)
| Component | Version |
|---|---|
| Desktop app | 0.12.x (pilot builds), minimum set by the release workflow |
| API | 0.19.0 |
| Database schema | `0018_operations_watch.sql` |
| Browser runtime | from `runtimes/manifest.json` |
| Server OS | AlmaLinux 8/9, Rocky 8/9, RHEL 8/9, Debian 12+, Ubuntu 22.04+ (vps-setup.sh) |
