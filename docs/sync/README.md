# Encrypted backups and synchronization (milestone 07)

| Document | What it covers |
|---|---|
| [ADR-0014](../adr/0014-encrypted-snapshots-and-sync.md) | Decisions: three-level envelope encryption (root → organization key version → data key), the sealed file format, upload/verify/commit, restore and switch, conflicts, local sealed backups, retention, quotas and trash |
| [crypto-design-review.md](crypto-design-review.md) | Primitives and libraries, nonce uniqueness, what the associated data binds, key custody, protocol threats and their tests, residual risks |
| [backup-restore-report.md](backup-restore-report.md) | Exit-criterion evidence: round trips, the cross-device labels, interruptions at every phase, concurrent commits, tampering; measurements |
| [key-recovery-runbook.md](key-recovery-runbook.md) | Offline copy of the root key, rotation (`scripts/deploy/root-key.sh`), recovery after losing the server, a lost computer, irreversible deletion |
| [Portability matrix](../portability-matrix.md) | Real Chromium on Windows, macOS and Linux through a sealed file: what survives on the same and on another computer, and the label the app shows |
| [Security model](../security-model.md) | Where snapshots, data keys and the root key live, and what is not protected |

## Journeys and where they live
| Journey | Desktop | API |
|---|---|---|
| Back up an organization profile | Automatic after a clean close (Profile → Backups → "Back up automatically after it closes"), or "Upload backup now" | `POST …/profiles/{id}/lease`, `POST …/snapshots/init`, `POST …/snapshots/{snapshot}/parts`, signed part uploads, `POST …/snapshots/{snapshot}/commit`, `GET /v1/orgs/{org}/sync-operations/{op}` |
| See progress and why it waits | Profile → Backups (phase, bytes, "Waiting for …" in plain language) | — (local job store) |
| Restore the newest or an older version | Profile → Backups → "Restore newest…" or "Version history…" → Restore / Restore as copy | `GET …/profiles/{id}/snapshots`, `POST …/profiles/{id}/restore-plans`, signed download |
| Put an organization profile on this computer | Organization → Profiles → "Put on this computer" | `POST …/restore-plans` |
| Resolve a conflict | Profile → Backups: "Keep mine as the newest", "Replace mine with the newer one", "Open the newer one as a copy" | `init` with the newer base, or a restore plan |
| Retention, trash, storage used | Organization → Backups (owners and admins) | `GET/PATCH /v1/orgs/{org}/backup-policy`, `GET …/trash`, `POST …/profiles/{id}/undelete` |
| Rotate the organization key | Organization → Backups → "Rotate key…" (owner, after confirming the sign-in) | `GET /v1/orgs/{org}/keys`, `POST …/keys/rotate` |
| Local last-good copy, sealed | Profile → Recover (milestone 03), now encrypted with this computer's key | — |
| Root key (server operator) | — | `scripts/deploy/root-key.sh status \| rotate \| retire <id>` |

The handoff file names the routes `/v1/profiles/{id}/snapshots/…`; they live under the organization like every
milestone 06 route (`/v1/orgs/{org}/profiles/{id}/…`), so tenant resolution happens before anything else.

## Where the code is
| Part | Path |
|---|---|
| Sealed format, archive rules | `crates/seal` |
| Upload and download transfers (signed URLs) | `crates/cloud/src/transfer.rs` |
| Sync engine (state machine, resume, restore, portability labels), REST client, fault-injecting fake server | `crates/sync` |
| Desktop jobs, worker thread, switch, conflicts, keychain key | `apps/desktop/src-tauri/src/sync.rs`, `crates/storage/src/sync.rs`, `crates/runtime/src/backup.rs` |
| Window | `apps/desktop/src/backups.tsx` |
| API routes, keys, verification, retention jobs | `services/api/src/routes/snapshots.ts`, `services/api/src/backup/` |
| Test server storage and root key | `scripts/deploy/vps-setup.sh`, `scripts/deploy/root-key.sh`, `services/api/scripts/{storage-check,snapshot-smoke}.ts` |

## Known limitations
1. **Not end-to-end encrypted.** Whoever holds the server's root key file can decrypt organization backups; every
   restore is recorded in Activity. Stated in the app.
2. **Sign-ins do not move between computers.** Website data comes back on another computer; cookies protected by
   the OS (Windows DPAPI, macOS Keychain) do not, so the app says "Sign-in may be required on websites". Same-computer
   restores keep sign-ins.
3. **Team handoff (milestone 08).** Opening a shared profile takes its session lease; its closing backup uploads under
   that lease and the next person gets it ([team/README.md](../team/README.md)). Uploads stay fenced (one winner).
4. **Root key in a file** on the server (`local` provider). A managed KMS/HSM and an independent review are paid
   launch gates. Losing the file without an offline copy loses every organization backup.
5. **Uploads need the storage port.** On the test server the app reaches storage through the SSH tunnel on port 8333.
6. **One backup at a time per computer.** Jobs run one after another; a large profile delays the next one.
7. **Local backups without a keychain stay plain copies**, as in milestone 03 (never a key in a file).
