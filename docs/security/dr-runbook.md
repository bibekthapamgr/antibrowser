# Disaster recovery runbook

How the service is backed up, how to prove it restores, and what to do in each failure scenario. The design is in
[ADR-0019](../adr/0019-production-security-updates-and-recovery.md) section 4. Security incidents (a leak, a
compromise) start in [incident response](incident-response.md). This page covers getting service and data back.

**Targets** (proposed in the roadmap and measured by the drill):
- **RPO ≤ 15 minutes:** at most this much of the newest database changes may be lost.
- **RTO ≤ 4 hours:** from the decision to restore until service is back.

## What is backed up

| Data | How | Where | Kept |
|---|---|---|---|
| PostgreSQL: the app database and Keycloak's | pgBackRest. Full backup weekly (Sunday), differential daily (03:17 UTC), write-ahead log at least every 60 s. Encrypted on the server (AES-256) before upload. | R2 `pgbackrest/` | 4 full backups with their log: point-in-time recovery for about the last 4–5 weeks |
| Snapshot objects (sealed profile backups) | rclone every 10 minutes, using a read-only storage identity | R2 `objects/pb-snapshots-dev/` | As long as they exist on the server |
| Snapshot objects deleted on the server | Moved aside by the same copy | R2 `objects-deleted/<date>/` | 30 days, removed by the R2 lifecycle rule |
| Root key, backup passphrase | **Not** in R2 | Your offline kit (below) | Always |

The objects are already sealed with organization keys, and the root key that unlocks those keys is never in R2.
Someone holding the bucket alone can read neither the database backups (passphrase) nor the snapshots (root key).

## The offline kit
Keep two copies in separate places, for example a password manager plus an encrypted USB drive. Without the first
two items, the backups cannot be used.

| Item | File on the server | Without it |
|---|---|---|
| Backup root key | `/etc/project-browser/kms-root.json` | Every organization's snapshots are unreadable forever |
| Backup passphrase | `/etc/project-browser/backup-cipher-pass` | The database backups in R2 cannot be read |
| Keycloak administrator password | `/etc/project-browser/keycloak-admin` | After a restore onto a new server, `keycloak-setup.sh` cannot sign in to the restored Keycloak |
| Cloudflare account access | (the dashboard) | Recreate the R2 token |
| Release key | Not on the server ([update runbook](update-runbook.md)) | Not needed for a restore |

Copy the files from your computer (they are root-only on the server, so do not paste them anywhere):
```bash
scp root@64.247.179.24:/etc/project-browser/kms-root.json ./
scp root@64.247.179.24:/etc/project-browser/backup-cipher-pass ./
scp root@64.247.179.24:/etc/project-browser/keycloak-admin ./
```

**After every root-key rotation** (`root-key.sh rotate` / `retire`), copy `kms-root.json` again, and **keep the
previous copy for 6 weeks**. A database restored from a backup made before the rotation still needs the old key.

## Setting up off-site backups (owner, once)
1. **Create the bucket.** In the Cloudflare dashboard: R2 → *Create bucket* (for example `pb-backups-test`), no
   public access.
2. **Create a token.** R2 → *Manage API tokens* → *Create API token*: *Object Read & Write*, *Apply to specific
   buckets only* → that bucket. Note the Access Key ID, the Secret Access Key (shown once) and your Account ID.
3. **Add lifecycle rules.** In the bucket's settings:
   - a lifecycle rule: prefix `objects-deleted/`, delete after **30 days**;
   - recommended: a bucket lock rule, prefix `pgbackrest/`, **7 days**, so nobody can delete fresh backups.
4. **Fill in the backup settings** on the server: `nano /etc/project-browser/backup.env`. vps-setup.sh wrote the
   template. Fill in `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Never paste these
   values into a chat.
5. **Run the server update twice:**
   `\cp -f /home/pb/antibrowser/scripts/deploy/vps-setup.sh /root/ && bash /root/vps-setup.sh`. It installs
   pgBackRest and rclone, turns on log archiving, makes the first full backup and starts the timers.
6. **Copy the passphrase into the offline kit.** It is created on the first run; the script reminds you.
7. **Run the restore drill** (next section) and keep its report.

## Checking backups

| When | Command | What to look for |
|---|---|---|
| Weekly | `bash /usr/local/libexec/pb-backup status` | A full backup within 8 days, `failed 0` (or no recent failure) in log archiving, an object copy in the last 10 minutes |
| After setup, then quarterly, and after any change to backups | `\cp -f /home/pb/antibrowser/scripts/deploy/restore-drill.sh /root/ && bash /root/restore-drill.sh` | `restore drill passed` with the recovery point and time. The report is in `/var/lib/pb-backup/drills/`. |
| Any time | `bash /usr/local/libexec/pb-backup backup-now full` | A manual full backup and object copy (before risky maintenance) |

**What the drill does:**
1. Makes a fresh snapshot for each of the two fixture organizations and writes a marker into the live database.
2. Restores the database from R2 into a **separate, temporary cluster** (port 5499, socket only, no archiving), and
   the snapshot objects from R2.
3. Proves row ↔ object ↔ key linkage for both organizations, and that neither can reach the other.
4. Measures:
   - **RPO:** how old the marker was when the restore began;
   - **RTO:** how long the restore and checks took.
5. Deletes everything it restored. The live service is not touched.

CI runs the drill on every change to the deployment scripts, against an R2 stand-in (`deploy-scripts.yml`). It also
runs a whole-server restore over the live server (`restore-server`, below), re-runs setup and checks that sessions,
snapshots and backups continue.

## Scenarios

### 1. The server is lost (hardware, provider or regional outage, unrecoverable compromise)
Estimated time: 1–2 hours, most of it installation. Restoring the data itself takes minutes at the current size.

1. **Make sure the old server cannot write to the backups.** Turn it off in the provider panel, or, if you can still
   reach it, disable its timers and log archiving. Two servers archiving to one bucket damage the backups. If the
   server was **compromised**, first make a new R2 token and delete the old one (incident response).
2. **Create a new server** with the same OS family (AlmaLinux 8/9 or Ubuntu 24.04), and point DNS or the tunnel at
   it.
3. **Put the offline kit in place before anything else:**
   ```bash
   install -d -m 750 /etc/project-browser
   install -m 600 kms-root.json /etc/project-browser/kms-root.json
   install -m 600 backup-cipher-pass /etc/project-browser/backup-cipher-pass
   ```
   Keep `keycloak-admin` aside for step 7.
4. **Install fresh.** Follow the server setup in [docs/setup.md](../setup.md): `vps-setup.sh`, then
   `keycloak-setup.sh`. It keeps the root key you placed. Backups are reported as "not set up yet"; that is
   expected.
5. **Fill in `/etc/project-browser/backup.env`** with the same bucket and a working token. Do **not** run
   vps-setup.sh now. It would refuse anyway, because the bucket holds another database's backups.
6. **Restore:**
   ```bash
   bash /home/pb/antibrowser/scripts/deploy/backup-setup.sh restore-server --yes-replace-this-database
   ```
   This shows the backups it found and stops the app. It replaces the database with the newest restorable point and
   copies every snapshot object back. The fresh database is kept aside as `…/data.before-restore-<time>`; delete it
   when done.
7. **Bring the old Keycloak administrator back:**
   `install -m 600 keycloak-admin /etc/project-browser/keycloak-admin`.
8. **Run setup again:**
   - `vps-setup.sh` **twice**. It sets new passwords for the restored database roles, turns log archiving on again
     and starts the services.
   - Then `keycloak-setup.sh`.
9. **Check:**
   - `bash /usr/local/libexec/pb-backup status` shows backups resuming on a new timeline;
   - sign in from the desktop app;
   - open a profile from the organization backups;
   - run the restore drill.
10. **Tell customers** what was lost, if anything (incident response, communication).

What may be missing:
- database changes from the last minute or so before the loss (the log is archived at least every 60 s);
- snapshots uploaded in the last 10 minutes, if the object copy had not run yet. Their rows can come back without
  their objects. The drill's checks would name them; the computer that uploaded them still has the profile, and
  its next backup replaces them.

### 2. Data corruption, a bad migration or a destructive mistake (the server itself is fine)
Point-in-time restore on the same server to just before the problem:
```bash
bash /home/pb/antibrowser/scripts/deploy/backup-setup.sh restore-server --target '2026-10-14 08:30:00+00' --yes-replace-this-database
```
Then run `vps-setup.sh` twice and `keycloak-setup.sh`, as in scenario 1.

**This rolls back every organization's changes** after the target time, including sign-ups, uploads and settings.
Use it only when the damage is broad and recent, and announce it. Without `--target`, the script first sends the
newest log off-site, then restores to the end of it. Use that to recover from a damaged data folder without losing
anything.

### 3. Accidental deletion of one organization's data
- **A profile deleted in the app:** it stays in the trash for the organization's trash period (1–90 days, default
  30). An owner or admin restores it from *Organization → Backups → Trash*. A recent sign-in is required, and nothing else changes.
- **A profile already purged, or rows destroyed by an operator mistake:** v1 has no one-click restore for a single
  organization.
  1. Run the drill's restore steps (or `pgbackrest restore --pg1-path=<new folder> --type=time --target=…` with
     `hot_standby = off`) to bring back an **isolated** copy from before the mistake.
  2. Copy back that organization's rows with SQL as the schema owner, and its objects from `objects/` or
     `objects-deleted/<date>/` in R2.

  This needs a database engineer. Rehearse it before the paid launch. Within 30 days of a purge the objects are
  still in R2 under `objects-deleted/`.

### 4. The key service is unavailable (root key file missing, unreadable or damaged)
- **What users see:** creating snapshots and restoring answer `503 UNAVAILABLE` (retryable). Everything else keeps
  working: lists, sign-in, sessions, health.
- **Fix:** put the file back from the offline kit with
  `install -m 600 -o pb -g pb kms-root.json /etc/project-browser/kms-root.json`, then
  `systemctl restart pb-api pb-worker`.
- **If no copy of the active root key exists anywhere,** every snapshot sealed under it is lost:
  1. Make a new root key (`root-key.sh rotate` adds a key, but needs the old one to re-wrap).
  2. Organizations must upload fresh backups from their computers, which still hold the profiles.
  3. Tell customers.

### 5. A lost or stolen computer (customer)
1. The person (or, from another computer, the same account): *Account → Devices → Sign out device* for that computer.
   Its sessions end at the next request, and its refresh token in the keychain becomes useless.
2. If the person leaves: remove the member. Their grants and API tokens stop working.
3. Profiles on that disk are readable by whoever has the unlocked OS account (disclosed limitation). Change the
   passwords of the website accounts used in those profiles. Full-disk encryption is the customer's protection.
4. Organization backups are unaffected. Restore the profiles on a new computer.

### 6. A computer's local backup key is lost (OS keychain reset)
- Local last-good copies sealed with that key show "key not available". They cannot be opened, by design.
- Organization backups use organization keys and restore normally.

### 7. A leaked API token
1. The organization owner revokes it in *Organization → Automation → API tokens*. It stops at the next request.
2. If the owner cannot be reached, or many tokens may be affected, staff use break-glass:
   ```bash
   runuser -u pb -- bash -c "cd /home/pb/antibrowser/services/api && /opt/node/bin/node --env-file=/etc/project-browser/api.env scripts/staff.ts break-glass STAFF_EMAIL --org org_… --reason 'Token posted publicly, owner unreachable (ticket …)' --minutes 15"
   ```
   Then use *Revoke all API tokens* on that organization in the support console. Another billing admin reviews the
   alert.
3. Check the organization's activity log for what the token did.

### 8. A bad or compromised desktop release
Follow [update runbook → emergency actions](update-runbook.md#emergency-actions): `pause`, then `revoke`, then a
fixed release. If the release key may be exposed, rotate it ([update runbook](update-runbook.md#rotating-the-key)).
Customer data is never touched by these actions.

### 9. R2 is unavailable
- Uploads pause.
- PostgreSQL keeps up to 2 GiB of log waiting. Past that, pgBackRest drops the oldest waiting log and reports the
  gap; the disk is never filled.
- When R2 is back, run `bash /usr/local/libexec/pb-backup backup-now full`, so point-in-time recovery starts again
  from a complete backup.

## Data retention after deletion
These figures go into the customer-facing statement in [limitations](limitations.md#data-retention).

| What | Primary copy | Residual copies |
|---|---|---|
| A deleted profile and its snapshots | Restorable during the trash period (1–90 days, default 30), then purged from the database and storage | Database backups: up to about 5 weeks after the purge (4 weekly full backups with their log). Snapshot objects: 30 days in `objects-deleted/` in R2. Both stay encrypted. |
| Older snapshot versions (retention policy) | Erased by the worker when past the organization's retention | As above |
| Automation screenshots | 7 days | Database backups (as above) |
| Finished automation jobs, webhook deliveries | 30 days | Database backups (as above) |
| An organization after cancellation | Kept (no automatic deletion in v1; `BILLING_RETENTION_DAYS` states the owner's policy) | — |
| Platform audit and organization activity logs | Kept (append-only) | Database backups. They hold actions and ids, never browsing data or secrets. |
| Data on customers' computers | The customer's | Not reachable by us |
