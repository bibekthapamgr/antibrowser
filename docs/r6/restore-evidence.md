# R6 — Restore evidence

What a restore proves, how to run it and where the results go. Targets (ADR-0019): **RPO ≤ 15 minutes, RTO ≤ 4 hours**
for the metadata database; a real report must meet them, or the launch scope/targets are revised here explicitly.

## What is rehearsed
- **Isolated restore** (`restore-drill.sh`): the database from the real off-site path (pgBackRest in R2, point in time
  to the end of the archived log) into a new cluster on port 5499 without a network listener or archiving; snapshot
  objects from the off-site copy; then checks and a JSON report in `/var/lib/pb-backup/drills/`. The running service
  and production database are never touched; every restored file is deleted afterwards.
- **One workspace** (`--workspace org_…`, R6): every profile's newest committed snapshot of that workspace — the row,
  its object (size, SHA-256, sealed header naming the same workspace/profile/snapshot/key version) and its keys (the
  workspace key unwraps under the root key; the snapshot's data key under its own binding). The report adds the
  member and profile counts and the **snapshot lag**: how much newer the live workspace's newest snapshot was than the
  restored one.
- **Two tenants, no crossing** (when two workspaces have snapshots): neither key unwraps the other's data, and
  row-level security shows the app role only its own rows.
- **Whole server** (`backup-setup.sh restore-server`, ADR-0019): replaces a lost or corrupted server's database and
  objects from R2 — not a casual test.

## Linkage: database, objects, keys
| Recovered | From | Bound to |
|---|---|---|
| metadata rows (`snapshot_manifests`, keys, members, profiles) | pgBackRest full/diff + WAL in R2 (encrypted with the backup passphrase) | the marker written just before the restore (recovery point) |
| snapshot objects | `r2:<bucket>/objects/pb-snapshots-<env>` (rclone copy every 2 minutes) | `object_key`, size and SHA-256 in the row; sealed header |
| workspace keys | rows (wrapped) + root key `kms-root.json` (**offline kit only**, never in R2) | `kms_key_id`, workspace id, key version |

Snapshot lag has two parts: a snapshot committed after the newest archived log is not in the restored database
(bounded by RPO), and an object written after the last object copy (≤ 2 minutes) may be missing — the check reports
it per profile instead of passing silently.

## How to run (staging, realistic copy)
1. Staging restored from a recent production backup or loaded with a realistic volume (owner's real R2 path and
   bucket naming for that environment).
2. `bash /root/restore-drill.sh --workspace org_…` (a real workspace id from the console).
3. Copy the summary lines and the report into the table below.

## CI evidence (every change to the scripts)
`deploy-scripts.yml` → "Off-site backups and restore drill" (two tenants, isolation, marker, RPO < 900 s), "A failed
backup is reported" (R2 down → ALERT, recovery), "Whole-server restore". Unit: `security.test.ts` → restore
verification incl. `checkWorkspace` (missing object, wrong root key).

## Reports of record
| Date | Environment | Workspace | Profiles checked | Members | Recovery point | Recovery time | Snapshot lag | Result |
|---|---|---|---|---|---|---|---|---|
| _(to be filled from the staging rehearsal)_ | staging | | | | | | | |
