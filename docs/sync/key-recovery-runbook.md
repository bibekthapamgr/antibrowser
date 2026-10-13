# Key recovery runbook — organization backups (milestone 07)

Who: the person who runs the server (test server: `root` on the VPS). Related: [ADR-0014](../adr/0014-encrypted-snapshots-and-sync.md),
[crypto design review](crypto-design-review.md), `scripts/deploy/root-key.sh`.

## What exists and what each part can recover
| Item | Where | Needed to restore backups? | If lost |
|---|---|---|---|
| **Root key file** | `/etc/project-browser/kms-root.json` (owner `pb`, mode 600), created once by `vps-setup.sh` | **Yes, always** | Every organization backup on this server is permanently unreadable, by anyone. There is no back door |
| Database (`pb_dev` on the test server) | PostgreSQL | Yes: manifests, wrapped organization keys and wrapped data keys | Backups cannot be found or unwrapped (restore the database backup) |
| Backup storage | SeaweedFS data in `/var/lib/pb-seaweedfs` (`pb-storage` service) | Yes: the encrypted files | The affected snapshots are gone; profiles keep their data on members' computers |
| Storage credentials | `/etc/pb-seaweedfs/s3.json` and `/etc/project-browser/api.env` | No: regenerated on every `vps-setup.sh` run | Re-run `vps-setup.sh` |
| A member's device key (local last-good copies) | That computer's OS keychain (`backup-key-v1`) | Only for that computer's local copies | Those local copies are reported as "made with a key this computer no longer has"; the next clean close makes a new copy. Organization backups are not affected |

## 1. Keep an offline copy of the root key (do this once, and after every rotation)
```bash
# On your computer (not the server):
scp root@<server>:/etc/project-browser/kms-root.json ./project-browser-root-key.json
```
Store it offline: an encrypted USB drive or a password manager's secure file. Never in Git, e-mail or chat. Check it
is the current one: `bash /home/pb/antibrowser/scripts/deploy/root-key.sh status` on the server shows the active id;
the same id is in your copy.

## 2. Check the state
```bash
bash /home/pb/antibrowser/scripts/deploy/root-key.sh status      # root keys, the active one, what each wraps
systemctl status pb-api pb-worker pb-storage
runuser -u pb -- bash -c 'cd /home/pb/antibrowser/services/api && /opt/node/bin/node --env-file=/etc/project-browser/api.env scripts/snapshot-smoke.ts'
```
The smoke test backs up a test profile and restores it through the running API, worker and storage.

## 3. Rotate the root key (suspected exposure, staff change, or yearly)
```bash
bash /home/pb/antibrowser/scripts/deploy/root-key.sh rotate     # new active root key; services restart
# within about a minute the worker re-wraps every organization key version with it:
bash /home/pb/antibrowser/scripts/deploy/root-key.sh status     # the old key should "wrap nothing"
bash /home/pb/antibrowser/scripts/deploy/root-key.sh retire <old-id>   # refused while anything still uses it
```
Then make a new offline copy (step 1) and destroy the old copy. Rotation never re-uploads snapshots: only the small
wrapped organization keys change. Exercised in CI (deploy-scripts workflow: rotate → re-wrap → retire → an earlier
backup still restores).

## 4. Rotate an organization's key (in the app)
Organization → Backups → Organization key → **Rotate key…** (owner, after confirming the sign-in again). New backups
use the new version; the worker re-wraps existing data keys in batches; the old version is destroyed 30 days after it
wraps nothing. Every rotation, re-wrap and destruction is in Activity (`org_key.rotated`, `org_key.root_rewrapped`,
`org_key.destroyed`).

## 5. Recover after losing the server
1. Install a new server with `vps-setup.sh` — **stop before it creates a new key**: copy your offline key first:
   ```bash
   install -d -m 750 -o root -g pb /etc/project-browser   # (vps-setup creates pb; run it once with --skip-tests if needed)
   install -m 600 -o pb -g pb project-browser-root-key.json /etc/project-browser/kms-root.json
   ```
   `vps-setup.sh` keeps an existing key file and never replaces it.
2. Restore the PostgreSQL database backup into `pb_dev` (it holds manifests and wrapped keys).
3. Restore `/var/lib/pb-seaweedfs` from its backup (stop `pb-storage` first; owner `pbstore`, mode 700).
4. Re-run `vps-setup.sh`, then the smoke test (step 2) and an app restore of one real profile.

If only the root key file is lost and no offline copy exists: the backups cannot be recovered. Members' computers
still have their local profiles; once a new key exists (re-run `vps-setup.sh`), they can back them up again
("Upload backup now"). Old manifests then point at unreadable data: delete those profiles' snapshots by deleting and
re-creating the organization profiles, or leave them to retention.

## 6. A member's computer was lost or stolen
1. The member signs the lost computer out from another computer (Account → Your devices → Sign out device); if they
   cannot, an admin removes them from the organization (Organization → Members) and invites them again. The lost
   computer's session ends at its next request; it can no longer ask for restore plans.
2. Data already restored on that computer is not protected by us (plaintext to the browser; disk encryption is the
   customer's responsibility). Rotate the organization key if you suspect a data key was copied while in use.
3. The member signs in on a new computer and uses **Put on this computer** to restore the newest backup (website data
   comes back; sign in to websites again).

## 7. Deleting data irreversibly (key destruction and backup expiry)
- A deleted profile is in the trash for the organization's trash period (default 30 days, Organization → Backups),
  restorable with its backups; then its stored objects are erased and only tombstone metadata remains.
- Older versions are erased by retention (default: newest per day for 7 days, all from the last 24 hours, and the
  newest); erasure from storage happens after the worker's grace period.
- A retired organization key version is destroyed 30 days after it wraps nothing; after that, any copy of the old
  wrapped data keys (for example in an old database backup) cannot be unwrapped by the current root key ring once the
  old root key is also retired.
- To make everything unrecoverable on purpose: delete the organization's profiles, wait for the trash period, rotate
  the organization key and wait 30 days, or — for the whole server — destroy the root key file and every copy.
