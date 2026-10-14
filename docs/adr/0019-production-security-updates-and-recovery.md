# 0019 — Production security, updates and recovery
Status: **Accepted (paid-launch track)**. Date: 2026-10-14. Owner: security owner (the project owner until staffed),
with release engineering, the backend lead and the desktop lead. Builds on ADR-0010 (runtime distribution),
ADR-0014 (sealed snapshots and keys), ADR-0017 (automation) and ADR-0018 (support staff) for milestone 12.

## Context
Before customers pay, the product must be able to:
- ship a fix to every computer quickly;
- withdraw a bad build without harming customer data;
- survive the loss of the server;
- prove what support staff did.

Each must be safe against the people who can reach it: whoever controls the network or the download host, an
attacker holding a stolen token, and staff themselves. This ADR records the decisions. The threat model
([docs/security/threat-model.md](../security/threat-model.md)) explains the reasons. The runbooks
([updates](../security/update-runbook.md), [disaster recovery](../security/dr-runbook.md),
[incidents](../security/incident-response.md)) explain the operation.

Owner decisions (2026-10-14):
- Updates are hosted on **GitHub Releases**.
- Off-site backups go to **Cloudflare R2**.
- **No Windows code-signing certificate yet**, and no Apple Developer account, so macOS builds stay ad-hoc signed.
- Security contact: **official.bibekthapa@gmail.com** (published in `SECURITY.md`).

## Decision

### 1. Manager updates: signed channels, no rollback, revocable
- **Three channels:** `dev`, `canary` and `stable`. Each is a signed manifest `channel-<ch>/<ch>.json` plus a `.sig`
  (minisign/Tauri format).
- **What a manifest carries:**
  - the release, with each artifact's URL, size, SHA-256 and its own update signature;
  - an increasing `sequence` (`run_id × 10 + attempt`);
  - `issued_at` and `expires_at`: 30 days by default, and the app refuses more than 45;
  - `paused`, `minimum_version`, `revoked_versions` and `revoked_runtime_sha256`.
- **Manifest signature binding:** the signature's trusted comment must name `file:<channel>.json`, so one channel's
  manifest cannot stand in for another's.
- **Artifact signature binding:** each artifact's signature must name its own `file:` and `version:`. A validly
  signed older installer therefore cannot be served as the new one.
- **Trusted keys** are compiled in (`apps/desktop/src-tauri/release-keys.json`), each with a validity window. Key
  rotation adds the new key before the old one ends.
- **The manager refuses:**
  - unknown or expired keys;
  - expired manifests;
  - a sequence lower than one it accepted (replay);
  - versions older than the running one (no rollback);
  - revoked versions;
  - legacy (not prehashed) signatures.
- **Downloads:** https only, under the project's release prefix, size-capped and resumable. Each download is
  verified for size, then SHA-256, then signature. It is verified again right before installing.
- **Installing** always needs the person's click with every profile closed.
  - Windows: the NSIS installer in update mode.
  - macOS: a bundle swap from an archive extracted with no `..` or absolute links, nothing written through links,
    and modes masked to `0755`.
- **Kill switches.** Each is one workflow run, and none ever touches profiles, backups or settings:
  - `pause` stops offering a channel's release;
  - `revoke` marks versions or browser runtimes known-bad on **every** channel;
  - `minimum` makes managers below a version say they must update.
- **Server-side minimum** (`MIN_DESKTOP_VERSION`): the API answers older desktop clients with
  `426 CLIENT_UPDATE_REQUIRED`, which the app shows as "update required". Scripts and the SDK are unaffected.
- **Revocations** are remembered per channel, and the app enforces their union. Switching channels or receiving an
  older manifest never forgets one.

### 2. Release pipeline: secrets only where signing happens
- **`desktop-release.yml`.** The build jobs (Windows x64, macOS Apple Silicon) hold no secrets. Only the `publish`
  job runs in the protected `release` environment, which holds the minisign key and its password.
- **Before anything is published, the `publish` job:**
  - checks the build checksums;
  - signs;
  - verifies every signature against the keys the shipped app trusts;
  - produces a CycloneDX SBOM;
  - creates GitHub build-provenance and SBOM attestations (all third-party actions pinned by commit).
- **Published releases are immutable.** A version tag that already exists stops the run, so a fix is always a new
  version.
- **OS signing.** Windows installers are unsigned until the owner buys a certificate; the planned route is a cloud
  signing service called from the `publish` job. macOS bundles are ad-hoc signed and not notarized. Both are
  disclosed as limitations. The update signatures above protect every update regardless.
- **Key custody (finding D1).** A GitHub admin-account takeover can reach the environment. Before the paid launch:
  - a second required reviewer, with "prevent self-review";
  - no admin bypass;
  - reviews required for workflow changes;
  - hardware-key 2FA for admins.

  The preferred end state is offline or hardware-backed signing. See the [update runbook](../security/update-runbook.md).

### 3. Browser runtime upgrades: a copy before, a way back
- **Before upgrading:** the first launch of a profile on a newer Chromium major first makes a sealed
  **before-upgrade copy**. It is kept 90 days, separately from the last-good copy.
- **Rolling back:** if the newer runtime is withdrawn (`revoke` with its archive SHA-256), the profile offers
  "restore the copy made before the upgrade". A copy written by a newer browser than the installed one is refused
  (`BACKUP_NEWER_THAN_RUNTIME`).
- **Revoked runtimes** are neither installed nor opened (`RUNTIME_REVOKED`).
- **Before release:** the runtime pipeline opens a profile created by the previous runtime as a compatibility fixture.

### 4. Disaster recovery
- **Database:** pgBackRest point-in-time recovery to R2.
  - Encrypted on the server (AES-256-CBC, passphrase only on the server and offline).
  - Weekly full, daily differential, and WAL pushed at least every 60 s (`archive_timeout`).
  - 4 full backups retained (about 4–5 weeks).
  - At most 2 GiB of queued WAL, so an R2 outage cannot fill the disk.
- **Snapshot objects:** rclone copies them to R2 every 2 minutes, using a **read-only** storage identity. A
  whole-server restore reports any committed snapshot whose object did not reach R2 in time.
  - Objects deleted on the server move to `objects-deleted/<date>/` in R2. An R2 lifecycle rule removes them after
    30 days.
  - Objects are already sealed with organization keys. The root key is never sent to R2; it is kept offline.
- **Separate permissions:**
  - The R2 token is limited to one bucket.
  - Credentials are root-only files.
  - A dedicated `pb-backup` user runs the object copy. The application user cannot read any backup credential, and
    the backup user cannot read any database credential (checked in CI).
- **Restore drill** (`restore-drill.sh`):
  - restores the database from R2 into a new isolated cluster (socket only, no archiving);
  - restores the objects from R2;
  - proves row ↔ object ↔ key linkage for two tenants, and that neither can reach the other;
  - measures RPO from a recovery marker and RTO end to end, against targets of RPO ≤ 15 min and RTO ≤ 4 h;
  - deletes everything it restored.

  It runs in CI on every change to the deployment scripts and must be run on the server after setup and quarterly.

### 5. Staff, audit and production surface
- **Platform audit.** The audit is append-only (triggers refuse update, delete and truncate for every role) and
  hash-chained:
  - each entry stores `sha256(prev ‖ fields joined by U+001F)`;
  - no field may contain the separator;
  - the chain head is out of the application roles' reach.

  Support leads export it (`GET /v1/support/audit/export`, or `scripts/audit-export.ts` on the server). The browser
  console re-verifies the chain, and each later export continues from the last hash.
- **Break-glass.** Only `staff.ts break-glass` on the server creates it. Each grant has:
  - a reason of at least 20 characters;
  - a lifetime of 5–60 minutes;
  - 1–10 named organizations.

  For those organizations it opens members and the activity log without a second approver, and allows one emergency
  action: revoking the organization's API tokens. Every use is recorded in the platform audit and in the
  organization's own activity log, and raises a console alert that someone other than the holder must resolve.
- **No session-data view.** No route or dashboard shows browser session data (cookies, storage, history) to staff or
  admins, and staff cannot decrypt snapshots.
- **Recent sign-in** (`auth_time` within the window; development and API tokens never qualify) is required for:
  - restoring anything other than the current version;
  - restoring a recovery copy;
  - undelete;
  - key rotation and export.
- **Production surface:**
  - no documentation, debug, metrics or profiling routes;
  - `/v1/health` and `/v1/ready` return status only;
  - no `server` header.
- **Crash data.** Chromium's own crash reporter is disabled (`--disable-breakpad`). The manager's crash reports stay
  local, opt-in and scrubbed.
- **Key service outage.** If the key service is unavailable, only operations that need snapshot keys fail
  (`503 UNAVAILABLE`, retryable); everything else keeps working.
- **Failed migrations** change nothing. On the server, all pending migrations run in one transaction and immutable
  checksums stop edited ones. On the desktop, the previous database is kept and recovery is offered.

### 6. Independent review and findings
- Three reviewers, each limited to one area: tenant authorization, cryptography, and the desktop boundary.
- Every finding goes into [docs/security/findings.md](../security/findings.md) with its severity, owner, status and
  verification.
- Release gate: no open critical or high finding.
- A third-party penetration test is required before the paid launch.

## Consequences
- **Withdrawing a bad build** takes minutes and never deletes anything. A computer learns of it at its next check
  (every 6 hours), or when it next calls the API, if the server minimum is raised.
- **A computer that cannot reach GitHub** keeps its version. If someone withholds newer manifests from it instead,
  the last one it accepted stops being trusted when it expires, after at most 45 days.
- **The release key in CI is the weakest link** until D1's owner actions are done. That is why the paid launch is
  gated on them.
- **Restores to a new server** need four things:
  - the offline root key;
  - the backup passphrase;
  - the R2 credentials;
  - this repository.

  Losing the root key makes the snapshot objects unrecoverable, by design.

## Alternatives considered
- **The Tauri updater plugin as-is.** Rejected: it has no channel manifest, sequence, replay protection, revocation,
  pause or minimum version. We kept its signature format, so the Tauri CLI signs our files.
- **TUF (The Update Framework) in full.** Deferred: it adds role separation and timestamp services the team cannot
  operate yet. Short-lived manifests with weekly re-signing cover the freeze attack well enough for v1.
- **Database dumps instead of PITR.** Rejected: they cannot meet a 15-minute RPO.
- **S3 replication by the store itself.** Rejected for now: SeaweedFS replication would need write credentials on
  both sides. rclone with a read-only identity keeps backups unable to change app data.
