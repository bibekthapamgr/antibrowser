# Milestone 12 — status against the handoff file

Production security, updates and recovery. Version 0.12.0.
- **Decisions:** [ADR-0019](adr/0019-production-security-updates-and-recovery.md).
- **Entry point:** the [security report](security/report.md).
- **Deliverables:**
  - [threat model](security/threat-model.md);
  - [findings register](security/findings.md);
  - [update runbook](security/update-runbook.md);
  - [DR runbook](security/dr-runbook.md) with restore evidence;
  - [incident response and contacts](security/incident-response.md);
  - [customer-facing limitations and retention](security/limitations.md);
  - [SECURITY.md](../SECURITY.md);
  - SBOM and provenance (CI per commit, attested per release).

**Outcome.**
- A fix can reach every computer through signed channels, and a bad build can be paused or withdrawn in minutes
  without touching customer data.
- The server can be rebuilt from an encrypted off-site copy, with recovery measured.
- Staff emergency access is short, scoped and provable afterwards.

Owner decisions (14 October 2026):
- GitHub Releases for updates;
- Cloudflare R2 for off-site backups;
- no Windows certificate yet, and macOS ad-hoc signed;
- security contact official.bibekthapa@gmail.com.

## Requirements

| Required | Implemented |
|---|---|
| Threat model covering manager IPC, browser boundary, local secrets, tenant access, object downloads, extensions, updater, automation, billing, support console; session theft, cross-tenant, supply chain | [threat-model.md](security/threat-model.md): every boundary with its defence, the test that proves it and the residual risk, plus three cross-cutting scenarios |
| Independent review of tenant authorization, cryptography and the desktop boundary; severity, owner, remediation | Three reviewers who had not seen the code, each limited to one area. 0 critical, 0 high, 2 medium (tracked, before paid launch: signing-key custody D1, staff second factor S1), 12 low (10 fixed and tested, 2 tracked). [findings.md](security/findings.md). A third-party test is still required before the paid launch. |
| Signed desktop and runtime manifests; OS signing; checksums; SBOM; provenance; keys in restricted infrastructure | **Manifests:** signed channel manifests and per-artifact signatures bound to version and file; the runtime manifest Ed25519-signed (milestone 03). **Supply chain:** `SHA256SUMS`, CycloneDX SBOM and build-provenance attestations per release; an SBOM per commit in CI. **Keys:** the release key only in the protected `release` environment, and build jobs hold no secrets. **OS signing:** not yet (owner decision); disclosed; the pipeline is ready. |
| dev / canary / stable; interrupted updates, wrong signatures, stale-manifest replay; anti-rollback | **Channels and replay:** three channels; increasing sequence; manifests valid 30 days (the app refuses more than 45); weekly re-signing; never an older version. **Downloads:** resumable and verified for size, then SHA-256, then signature, and again before installing. **Install:** only with profiles closed. **Tests:** `crates/update` (35) and `tests/updates.rs` (9). |
| Runtime upgrades staged against compatibility fixtures; pre-migration snapshot; recovery to a compatible snapshot | **Before the upgrade:** a sealed copy kept 90 days, made before the first launch on a newer Chromium major. **Recovery:** "Restore the copy made before the upgrade"; a copy written by a newer browser is refused; revoked runtimes are neither installed nor opened. **Staging:** the runtime pipeline opens an old-runtime profile with the new runtime. |
| Pause and revoke releases without wiping data | **In the release workflow:** `pause` / `resume` / `revoke` (every channel) / `minimum`. **On the server:** `MIN_DESKTOP_VERSION` returns `426 CLIENT_UPDATE_REQUIRED`. None of these touches profiles, backups or settings. |
| Database PITR; object versioning and retention; separate backup permissions | **Database:** pgBackRest to R2 (encrypted on the server, log at least every 60 s, 4 weekly full backups). **Objects:** rclone every 10 minutes with a read-only storage identity; deleted objects kept 30 days. **Permissions:** root-only credentials and a `pb-backup` user (CI checks that `pb` and `pb-backup` cannot read each other's credentials). **Bucket safety:** setup refuses a bucket holding another database. |
| Incident procedures; retention and deletion testing; residual retention statements | **Procedures:** [incident-response.md](security/incident-response.md). **Testing:** trash, purge and retention tests, plus an off-site deleted-object check in CI. **Statements:** the residual periods in [limitations.md](security/limitations.md#data-retention). |
| RPO ≤ 15 min, RTO ≤ 4 h | Measured by the restore drill and the whole-server restore (CI, [report](security/report.md#restore-evidence)). The owner repeats the drill on the server. |
| Break-glass: short expiry, reason, immutable audit export | **Grant:** only `staff.ts break-glass` on the server, with 5–60 minutes, a reason and 1–10 named organizations. **Use:** every use recorded in both logs and alerted; another admin resolves the alert. **Audit:** the platform audit is append-only and hash-chained, with a verifiable export (console and script). |
| No "view every user's cookies" dashboard | No route or screen exposes browser session data; staff cannot decrypt snapshots |
| Restores need recent authentication and tenant scope | **Recent sign-in** is required for non-head and recovery restores, undelete, key rotation and export. **Never qualify:** tokens without `auth_time`, development tokens and API tokens. **Tenant scope:** checked on every route. |
| Health status only; no debug endpoints; crash dumps limited | **Endpoints:** no documentation, debug, metrics or profiling routes; status-only health; no `server` header. **Crash dumps:** Chromium's `--disable-breakpad`; manager crash reports local, opt-in and scrubbed. |

## Test gate

| Gate | Evidence |
|---|---|
| Restore staging into an isolated environment and prove linkage for two tenants | Restore drill in `deploy-scripts.yml`: an isolated cluster from the R2 stand-in, row ↔ object ↔ key for two tenants, and five isolation checks |
| Expired signing certificate, signature mismatch, corrupt update, interrupted download | Named tests in the [security report](security/report.md#failure-exercises-required-by-the-test-gate) |
| Unavailable KMS, failed migration | `security.test.ts`; `crates/storage` migration recovery |
| No unresolved critical or high findings | Met ([findings](security/findings.md)) |

## Checks run for this milestone
- API: 534 passed, 13 skipped (needing external services).
- Desktop: updates (9), IPC, browser and the upgrade fixture.
- `crates/update`: 35.
- Release tooling: 9.
- Desktop UI end to end: 180.
- Console end to end: 8.
- `deploy-scripts.yml` on a fresh VM ([run 38540671668](https://github.com/bibekthapamgr/antibrowser/actions/runs/38540671668)):
  - backups to a TLS R2 stand-in;
  - the restore drill: recovery point 1 s, recovery time 11 s;
  - deleted-object retention;
  - a whole-server restore in 80 s, then the remaining server checks against the restored server.
- CI per commit includes a CycloneDX SBOM: 614 Rust crates and 255 npm packages.

## Owner steps (in this order)
1. **Update the server:** run `\cp -f /home/pb/antibrowser/scripts/deploy/vps-setup.sh /root/ && bash /root/vps-setup.sh`
   **twice**. This applies migrations 0010–0011 and turns off SeaweedFS's unused catalog ports. Backups report
   "not set up yet" until step 3.
2. **Create the R2 bucket and token**, and add the lifecycle rule (`objects-deleted/`, 30 days) and the optional
   bucket lock on `pgbackrest/`. See [DR runbook → setting up](security/dr-runbook.md#setting-up-off-site-backups-owner-once).
3. **Fill in the backup settings:** `nano /etc/project-browser/backup.env` on the server (never in chat), then run
   vps-setup.sh **twice** again.
4. **Build the offline kit:** copy `kms-root.json`, `backup-cipher-pass` and `keycloak-admin` from the server to two
   offline places.
5. **Run the restore drill:**
   `\cp -f /home/pb/antibrowser/scripts/deploy/restore-drill.sh /root/ && bash /root/restore-drill.sh`, and keep the
   report.
6. **Set up the release key** ([update runbook → first-time setup](security/update-runbook.md#first-time-setup-owner-once)):
   - generate it on your computer;
   - commit its **public** key with `add-release-key.mjs`, or send the `.pub` content to be committed (it is not
     secret);
   - create the `release` environment with the two secrets.
7. **Publish the first release:** `release` → canary → install 0.12.0 by hand once → test → `promote` to stable.
8. **Staff second factor (S1):** for each staff account run `bash /root/keycloak-setup.sh reset-password EMAIL --otp`.
   This issues a new temporary password and requires an authenticator app at the next sign-in; from then on Keycloak
   asks for a one-time code at every sign-in.
9. **Protect the key (D1):** before the paid launch, add a second reviewer with "prevent self-review", turn off
   admin bypass, require reviews for workflow changes, and use hardware-key 2FA.
10. **On GitHub:** *Settings → Code security → Private vulnerability reporting → Enable* (named in SECURITY.md).
11. **Optional:** set `MIN_DESKTOP_VERSION=0.12.0` in `/etc/project-browser/api.env` once everyone has 0.12, then
    `systemctl restart pb-api`.

## Known limits
- **First installs are not OS-signed:** Windows warns, and macOS needs right-click → Open. Updates are verified by
  the app.
- **D1 and S1 are open until the owner actions are done** (S1 also needs API enforcement before the paid launch).
  T3 and C-L4 are tracked for milestone 13.
- **No one-click restore for a single organization.** The DR runbook describes the manual procedure. It needs
  rehearsal before the paid launch.
- **Recent snapshots may be missing after a total server loss:** those uploaded within 10 minutes before it need
  uploading again from the computer that made them.
