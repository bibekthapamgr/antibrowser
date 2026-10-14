# Incident response

What to do when something security-relevant happens: a vulnerability report, a leak, a compromise, a bad release or a
cross-tenant bug. Getting data and service back is covered in the [DR runbook](dr-runbook.md). Release actions are
in the [update runbook](update-runbook.md).

## Contacts

| Role | Who | How |
|---|---|---|
| Security contact, incident lead, release owner | Project owner | **official.bibekthapa@gmail.com** (published in [SECURITY.md](../../SECURITY.md)) |
| Server operator (test server 64.247.179.24) | Project owner | SSH as root. VPS provider support through its control panel |
| Off-site backups | Cloudflare account owner | Cloudflare dashboard → R2 (tokens, bucket rules) |
| Code, releases, signing environment | GitHub repository admin | GitHub settings; GitHub Support for account recovery |
| Payments | Stripe account owner (Ten Tech Solutions LLC) | Stripe Dashboard (keys, webhooks, disputes) |
| Sign-in provider | Keycloak administrator | `/etc/project-browser/keycloak-admin` on the server (root only) |

Until a team exists, one person holds every role. Name a **backup person** with access to the offline kit and the
GitHub organization before the paid launch, and add them here. An incident must not depend on one person being
reachable.

## Severity

| Level | Examples | First response | Customer notice |
|---|---|---|---|
| **SEV-1** | Cross-tenant data exposure; release key or root key exposed; a malicious release published; server compromise; active account takeovers | Immediately; work until contained | As soon as the facts are known, and within any legal deadline that applies |
| **SEV-2** | A leaked API, refresh or staff token; a critical or high vulnerability report with no sign of use; backups failing for more than 24 h | Within 4 hours | If customer data may be affected |
| **SEV-3** | A medium or low vulnerability; a suspicious but unconfirmed event | Within 3 business days | Usually not needed |

## The procedure

1. **Open a record.** A private note, or a private GitHub security advisory for vulnerabilities. Record the time,
   who reported it, what is known and the severity. Write down every action with the time as you go.
2. **Preserve evidence before changing anything:**
   - Platform audit export (support lead): console → *Audit* → *Export a verifiable copy*, or on the server
     `runuser -u pb -- bash -c "cd /home/pb/antibrowser/services/api && /opt/node/bin/node --env-file=/etc/project-browser/api.env scripts/audit-export.ts --out /root/audit-$(date +%F).ndjson"`.
     Copy it off the server.
   - The affected organization's activity log (owners can export it; staff can read it with approved access).
   - `journalctl -u pb-api -u pb-worker -u keycloak --since "-48h" > /root/journal-$(date +%F).txt`.
   - GitHub: *Settings → Audit log* (organization) and the repository's *Actions* runs.
   - Cloudflare: R2 token activity. Stripe: *Developers → Logs*.
3. **Contain:** use the playbooks below. Prefer actions that can be undone: revoke, pause, disable.
4. **Eradicate and recover:**
   - fix the cause;
   - release or redeploy;
   - restore data if needed ([DR runbook](dr-runbook.md));
   - rotate every credential the attacker could have seen.
5. **Communicate:**
   - affected customers: what happened, what data, what we did, what they should do;
   - regulators where the law requires it.

   Personal data breaches can have legal notification deadlines (for example 72 hours under the GDPR). Check the
   obligations that apply with legal counsel.
6. **Review within 2 weeks:**
   - write a blameless review: timeline, cause, what worked, what to change;
   - add the findings to the [findings register](findings.md);
   - update the [threat model](threat-model.md).

## Browser security patches
Chromium is the largest attack surface the product ships. These are the proposed operational targets from the
roadmap (milestone 12). They hold only with staffed on-call coverage.

| Situation | Target |
|---|---|
| A Chromium vulnerability **exploited in the wild** (for example in Chrome release notes, or in the CISA Known Exploited Vulnerabilities catalog) | Assess within **24 hours** of notice. Roll out a supported fix within **72 hours** of the upstream fix, after the emergency tests. |
| Other High or Critical Chromium fixes | In a released manager within **7 days** (ADR-0001) |
| Deferring an update | Only with a named owner who accepts the risk, recorded in the findings register |

**On-call owner:** the project owner (security contact above) until a team exists. Name a backup person before the
paid launch.

**Sources to watch:**
- the Chrome Releases blog (stable channel updates and their security fixes);
- the CISA Known Exploited Vulnerabilities catalog;
- the weekly `runtime pipeline` run, which warns when upstream stable has moved.

**Emergency rollout.** The runtime manifest is compiled into the manager, so a new browser ships in a manager
release:
1. Actions → **runtime pipeline** → *Run workflow* (`sign` ticked). It runs the real-browser compatibility set,
   including a profile created by the previous runtime, on Windows, macOS and Linux, then signs the manifest
   ([runtime pipeline](../runtime-pipeline.md)).
2. Commit the new `runtimes/manifest.json` and its `.sig`, and set a new manager version
   (`node scripts/release/set-version.mjs …`).
3. **desktop release** → `release` on canary. Test on one computer, then `promote` to stable
   ([update runbook](update-runbook.md)).
4. Once the fixed release is offered:
   - `revoke` the vulnerable runtime's archive SHA-256, so it is neither installed nor opened;
   - if the old manager must not be used, run `minimum` and set `MIN_DESKTOP_VERSION` on the server.

   Profiles that the old runtime already upgraded keep a before-upgrade copy.
5. Record the timeline (notice → assessment → release → stable) in the incident record. It is the evidence for the
   24/72-hour targets.

## Playbooks

### A vulnerability report arrives (SECURITY.md)
1. Acknowledge within 3 business days.
2. Reproduce on the test server, never on customer data.
3. Rate it using the severity table above, add it to the findings register (private until fixed), and fix it.
4. Release through canary, then stable.
5. Use `minimum` if old versions are dangerous.
6. Credit the reporter if they wish.

### A leaked API token
- **Contain:** the owner revokes it (*Organization → Automation → API tokens*). If the owner is unreachable, or many
  tokens may be affected, use **break-glass** on that organization only: `staff.ts break-glass … --org org_…`, then
  *Revoke all API tokens* in the console. Another billing admin reviews the alert.
- **Assess:** the organization's activity log shows the token's actions; webhook deliveries show where data was
  sent.

### A stolen session (refresh token or device)
1. The person signs that device out (*Account → Devices*), or an admin removes the member.
2. Refresh-token reuse already ends the session automatically.
3. Recent-sign-in actions (old-version restores, undelete, key rotation, export) could not have been used without
   the person's password and provider MFA.
4. Check the organization's activity log for restores and downloads.

### A staff account may be compromised
1. Remove the staff member at once:
   ```bash
   runuser -u pb -- bash -c "cd /home/pb/antibrowser/services/api && /opt/node/bin/node --env-file=/etc/project-browser/api.env scripts/staff.ts remove EMAIL"
   ```
   This ends their console sessions and any break-glass grant.
2. Reset their Keycloak password: `bash /root/keycloak-setup.sh reset-password EMAIL`.
3. Review the platform audit export from their sign-in onward. Check the hash chain against your last kept export.
   A chain that does not continue from your earlier export means tampering: treat it as SEV-1.

### The release key may be exposed, or a malicious release was published
1. `pause` every channel, then `revoke` the affected versions (all channels).
2. Rotate the key ([update runbook → rotating the key](update-runbook.md#rotating-the-key)).
3. Review the GitHub audit log for environment, branch-protection and workflow changes.
4. Publish a security advisory naming the safe version, and how to check an installer
   (`gh attestation verify`, `verify.mjs`).

### The server may be compromised
1. Treat every secret on it as exposed:
   - API database passwords and S3 credentials (vps-setup.sh makes new ones on every run);
   - the session signing key (`/etc/project-browser/oidc.env`: delete its `SESSION_SIGNING_KEY` line and re-run
     keycloak-setup.sh, which makes a new one and ends every access token);
   - the backup root key;
   - the R2 token;
   - the Stripe keys and webhook secret;
   - the Keycloak admin password.
2. Isolate the server: provider firewall, or shut it down after preserving evidence.
3. Revoke the R2 token in Cloudflare first, so backups cannot be deleted.
4. Rebuild on a new server from the off-site backups ([DR runbook, scenario 1](dr-runbook.md#1-the-server-is-lost-hardware-provider-or-regional-outage-unrecoverable-compromise)).
5. After the restore:
   - rotate the root key (`root-key.sh rotate`, then `retire` the old one);
   - replace the Stripe keys and webhook secret;
   - create a new R2 token;
   - make every user sign in again.
6. Snapshots stay sealed under organization keys. An attacker who had the root key file could have unwrapped those
   keys, so tell customers which snapshots existed during the exposure.

### A cross-tenant exposure bug
1. Contain by turning off the affected route or feature (hotfix or `minimum`).
2. Use the API logs and audit trails to list which organizations' data was returned to whom.
3. This is SEV-1: notify the affected organizations.
4. Add a regression case to `cross-tenant.test.ts`.

### The backup passphrase or the R2 token leaked
- **R2 token:**
  1. Create a new token, put it into `backup.env`, and run vps-setup.sh twice.
  2. Delete the old token.
  3. Check that the backups are still complete (`bash /usr/local/libexec/pb-backup status`). If any are missing,
     run `backup-now full` at once.
- **Passphrase alone:** it only matters together with R2 access. Revoke the R2 token, and check the bucket's
  access logs.
- **Both together:** someone may have copied the database backups. Treat it as a database exposure (SEV-1). Note
  that snapshot contents still need the root key.

## Practice
Practise once before the paid launch, then twice a year:
- a tabletop exercise of one SEV-1 playbook;
- a real restore drill;
- a `pause`/`resume` on the dev channel.

Keep the dates and outcomes in the review notes.
