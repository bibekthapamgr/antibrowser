# R6 — Owner operational guide (staging and production)

Plain steps for the owner. Commands run on the server as `root`. Never paste a key, password or secret into a chat,
ticket or e-mail; type them into the files on the server with `nano`.

## 1. Before you start (outside the server)
1. **Domain.** Choose four names per environment, e.g. for production `browser.example.com` (site),
   `admin.browser.example.com` (staff), `id.browser.example.com` (sign-in), `files.browser.example.com` (snapshots).
   Create an `A` record for each pointing at the server's IP (and `AAAA` if it has IPv6).
2. **Server.** About 4 GB of memory for production (Keycloak + PostgreSQL + storage on one machine). Ports 80 and 443
   must be allowed in the hosting provider's firewall panel too.
3. **Prices, legal contact.** Final prices, the support e-mail and the legal pages' contact details. Placeholders are
   fine on staging only.
4. **Mail provider.** An SMTP account whose sender domain is verified (SPF/DKIM at your DNS provider).
5. **Stripe.** Staging: test mode. Production: live mode keys and a live webhook endpoint (step 4).
6. **Cloudflare R2.** A bucket per environment and a token limited to it (no bucket lock: pgBackRest rewrites its index).

## 2. Set up (or update) a server
```
\cp -f /home/pb/antibrowser/scripts/deploy/vps-setup.sh /root/ && PB_ENV=prod bash /root/vps-setup.sh
```
- The first run stops and asks you to fill in `/etc/project-browser/public.env` (the four names and your e-mail). Fill
  it in and run the same command again.
- It then installs everything, gets the certificates, sets up sign-in for this environment and ends with the
  **preflight report**. Later updates: the same command without `PB_ENV=` (the server remembers it).
- A test server can become staging/prod this way; the old test data stays unused. Staging/prod never become dev.

## 3. E-mail
Write `/etc/project-browser/smtp.env` (format in `keycloak-setup.sh --help`), run `vps-setup.sh` again. Then send a
message through the website's contact form: the preflight's `email_delivery` passes once it was delivered.
Self-registration is switched on only when e-mail works.

## 4. Stripe
1. Put your key into `/etc/project-browser/billing.env` (`sk_live_…` for prod, `sk_test_…` for staging).
2. Create products and prices: the `stripe-setup.ts` command written in that file.
3. Stripe Dashboard → Developers → Webhooks → Add endpoint `https://SITE_HOST/v1/webhooks/billing` with the events listed
   by `vps-setup.sh`; copy its signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRETS` in `billing.env`.
4. Run `vps-setup.sh` again; send a test event from the webhook page. Do the whole purchase flow on **staging** first.

## 5. Staff and the first owner
```
bash /root/.pb-keycloak-setup.sh add-user you@example.com --otp
```
Sign in once at `https://ADMIN_HOST/console/` (password + authenticator app), then:
```
runuser -u pb -- bash -c "cd /home/pb/antibrowser/services/api && /opt/node/bin/node --env-file=/etc/project-browser/api.env scripts/staff.ts bootstrap-owner you@example.com"
```
Every staff sign-in needs the one-time code; the server refuses password-only sign-ins.

## 6. Off-site backups and the restore rehearsal
- Fill `/etc/project-browser/backup.env` (R2), run `vps-setup.sh` again. Status: `bash /usr/local/libexec/pb-backup status`
  (it prints an `ALERT` line and exits 3 while backups fail).
- Keep the offline recovery kit current (root key `kms-root.json`, backup passphrase, `backup.env`).
- Rehearse once a month and before launch, on **staging with a realistic copy**:
  `\cp -f /home/pb/antibrowser/scripts/deploy/restore-drill.sh /root/ && bash /root/restore-drill.sh --workspace org_…`
  It restores into an isolated, temporary cluster and never touches the running database. Record the result in
  [restore-evidence.md](restore-evidence.md).

## 7. The preflight
`bash /home/pb/antibrowser/scripts/deploy/preflight.sh` — every line is PASS, FAIL or WARN with a reason; the meaning
and fix of each check is in [preflight-report.md](preflight-report.md). Customers come only when there is no FAIL.

## 8. Desktop releases (GitHub → Actions → desktop release)
1. Repository variables (Settings → Secrets and variables → Actions → Variables): `PB_DEFAULT_SERVER=https://SITE_HOST`;
   `PB_OS_SIGNING=true` only once Windows signing and Apple notarization work; or `PB_UNSIGNED_PILOT=true` for a
   labelled unsigned pilot.
2. Release key: generate it on your own computer and add its public half ([update runbook](../security/update-runbook.md)).
3. `release` to **canary** → install and test on a clean computer → `promote` canary → **stable** (the same files).
   Stable is refused until the runtime licensing gate (ADR-0010) and the settings above are satisfied. Evidence:
   [release-evidence.md](release-evidence.md).

## 9. When something goes wrong
[incident-and-rollback.md](incident-and-rollback.md): who to contact, the status page, pausing an update channel,
rolling back code, restoring.
