/**
 * Encrypted backups (milestone 07): the profile drawer's backup section (organization backup state, progress,
 * conflicts, restore and version history, the local last-good copy) and the organization's backup settings (policy,
 * trash, key versions). Uploads and restores run in the background; this screen follows them through `sync` events.
 */
import type { BackupPolicy, OrgKeys, Role, Snapshot, TrashedProfile } from '@pb/contracts/resources';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { Backend, ProfileView, SyncStatus } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { ApiFailure, can, get, send } from './cloud.ts';
import { Dialog, formatBytes } from './components.tsx';
import { day, type Notify, relative, when } from './status.tsx';
import { RecoveryCopiesSection } from './team.tsx';

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** Why an unfinished job waits, in words. */
const WAITING: Record<string, string> = {
  CLOUD_OFFLINE: 'Waiting for the connection to the organization server.',
  STORAGE_OFFLINE: 'Waiting for the connection to backup storage. It continues by itself.',
  CLOUD_SIGNED_OUT: 'Sign in to continue.',
  CLOUD_UNAVAILABLE: 'The organization server is not answering. It is tried again every minute.',
  PROFILE_NOT_CLOSED: 'Waiting until the profile is closed normally.',
  LEASE_HELD: 'The profile is in use on another computer. It is tried again later.',
  STORAGE_REFUSED: 'Backup storage refused the transfer. It is tried again later.',
  RATE_LIMITED: 'The server asked to slow down. It is tried again shortly.',
  LEASE_LOST:
    'Waiting to confirm this computer still holds the profile. It continues when the connection is back.',
};

/** Why a job failed, in words (unknown codes fall back to a generic sentence). */
const FAILED: Record<string, string> = {
  QUOTA_EXCEEDED:
    'The organization has used all its backup storage. An admin can free space or raise the limit.',
  SNAPSHOT_TOO_LARGE: 'This profile is larger than the organization allows for one backup.',
  LOW_DISK_SPACE: 'There is not enough free disk space on this computer.',
  NOT_FOUND: 'The backup or the profile no longer exists, or you no longer have access to it.',
  FORBIDDEN: 'Your role does not allow this. Ask an admin for access.',
  DIGEST_MISMATCH: 'The downloaded backup did not match its checksum and was not used. Nothing was changed.',
  SEAL_AUTHENTICATION_FAILED: 'The backup could not be verified (damaged or modified). Nothing was changed.',
  SEAL_WRONG_BINDING: 'The file does not belong to this profile and was refused. Nothing was changed.',
  SNAPSHOT_CHANGED: 'The backup changed while it was being restored and was not used.',
  SNAPSHOT_UNAVAILABLE: 'That version was removed by the retention policy.',
  CLIENT_UPDATE_REQUIRED:
    'The server no longer accepts this version of Project Browser. Update it (Downloads and updates), then try again.',
  REAUTHENTICATION_REQUIRED:
    'Restoring an older version or a recovery copy needs a recent sign-in. Sign in again, then restore it again.',
  RUNTIME_TOO_OLD: 'This backup was made with a newer browser. Update the browser on this computer first.',
  NO_RUNTIME: 'Install the browser on this computer first.',
  UNKNOWN_PLATFORM: 'This backup was made on a system this app does not support.',
  SNAPSHOT_FORMAT_TOO_NEW: 'This backup was made by a newer version of the app. Update the app first.',
  PROFILE_NEVER_OPENED: 'This profile has never been opened, so there is nothing to back up yet.',
  CANCELED: 'Canceled. The previous backup is still the newest.',
  LEASE_TAKEN_OVER:
    'An admin took this profile over. This computer’s copy was kept aside; nothing was overwritten.',
  LEASE_REVOKED:
    'Access to this profile was removed. This computer’s copy was kept; nothing was overwritten.',
  LEASE_SUPERSEDED: 'The profile was opened again elsewhere. Nothing was overwritten.',
};

const PHASE: Record<string, string> = {
  sealing: 'Encrypting',
  uploading: 'Uploading',
  downloading: 'Downloading',
  opening: 'Checking and unpacking',
};

const STATE: Record<string, string> = {
  local_dirty: 'Waiting to start',
  preparing: 'Preparing',
  uploading: 'Uploading',
  verifying: 'The server is checking the upload',
  planning: 'Preparing the restore',
  downloading: 'Downloading',
  opening: 'Checking and unpacking',
  ready: 'Switching folders',
};

const isRunning = (s: SyncStatus) =>
  !!s.job && !['committed', 'conflict', 'failed', 'canceled', 'done'].includes(s.job.state);

/** The drawer's backup section for one local profile. */
export function BackupSection(props: {
  backend: Backend;
  profile: ProfileView;
  refreshKey: number;
  notify: Notify;
}) {
  const { backend, profile: p, notify } = props;
  const [s, setS] = useState<SyncStatus | null>(null);
  const [confirm, setConfirm] = useState<'restore' | null>(null);
  const [history, setHistory] = useState(false);

  const load = useCallback(() => {
    backend.sync
      .status(p.id)
      .then(setS)
      .catch(() => undefined);
  }, [backend, p.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads on profile events
  useEffect(load, [load, props.refreshKey]);
  useEffect(
    () =>
      backend.on('sync', (e) => {
        if (e.profile_id !== p.id) return;
        load();
        if (e.state === 'restored') {
          notify(
            e.portability === 'supported'
              ? `Restored version ${e.version ?? ''}.`
              : `Restored version ${e.version ?? ''}. Sign-in may be required on websites: sign-ins only carry over on the computer that made the backup.`,
          );
        }
      }),
    [backend, p.id, load, notify],
  );
  // While something runs, progress is polled (events mark state changes only).
  useEffect(() => {
    if (!s || !isRunning(s)) return;
    const t = setInterval(load, 700);
    return () => clearInterval(t);
  }, [s, load]);

  const act = async (f: () => Promise<SyncStatus>, done?: string) => {
    try {
      setS(await f());
      if (done) notify(done);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  if (!s) return null;
  const closed = p.state === 'stopped';
  const running = isRunning(s);
  const job = s.job;
  const local = s.local_backup;

  return (
    <fieldset aria-labelledby="backup-legend">
      <legend id="backup-legend">Backups</legend>
      {s.linked ? (
        <>
          <p className="small">
            <strong>Organization backup:</strong>{' '}
            {s.synced_version > 0
              ? `version ${s.synced_version}, ${relative(s.synced_at).toLowerCase()}`
              : 'not backed up yet'}
            {s.synced_version > 0 && s.dirty && !running ? ' · changed since' : ''}
          </p>
          {s.conflict_head !== null && (
            <div className="notice" role="alert">
              <p>
                A newer backup (version {s.conflict_head}) was made on another computer. Nothing was
                overwritten: this computer still has its own data. Choose what to keep.
              </p>
              <div className="row">
                <ConflictButton
                  label="Keep mine as the newest"
                  disabled={!closed}
                  onClick={() =>
                    act(
                      () => backend.sync.resolveConflict(p.id, 'upload_mine'),
                      'Backing up this computer’s data as the newest version…',
                    )
                  }
                />
                <ConflictButton
                  label="Replace mine with the newer one"
                  disabled={!closed}
                  onClick={() =>
                    act(
                      () => backend.sync.resolveConflict(p.id, 'use_newer'),
                      'Restoring the newer backup. Your current data is kept aside.',
                    )
                  }
                />
                <ConflictButton
                  label="Open the newer one as a copy"
                  onClick={() =>
                    act(
                      () => backend.sync.resolveConflict(p.id, 'open_newer_as_copy'),
                      'Restoring the newer backup into a separate copy…',
                    )
                  }
                />
              </div>
              {!closed && <p className="muted small">Close the profile to keep or replace its data.</p>}
            </div>
          )}
          {running && job && (
            <div className="stack" role="status">
              <p className="small">
                {s.progress.phase ? PHASE[s.progress.phase] : (STATE[job.state] ?? 'Working')}
                {s.progress.total > 0 && s.progress.phase && s.progress.phase !== 'sealing'
                  ? ` ${formatBytes(s.progress.done)} of ${formatBytes(s.progress.total)}`
                  : '…'}
              </p>
              <progress
                aria-label={job.kind === 'upload' ? 'Backup progress' : 'Restore progress'}
                value={s.progress.total > 0 ? s.progress.done : undefined}
                max={s.progress.total > 0 ? s.progress.total : undefined}
              />
              {s.progress.waiting_for && (
                <p className="warn small">{WAITING[s.progress.waiting_for] ?? 'Waiting to continue.'}</p>
              )}
            </div>
          )}
          {!running && job?.state === 'failed' && (
            <p className="warn small" role="status">
              {job.kind === 'upload' ? 'The last backup failed. ' : 'The last restore failed. '}
              {FAILED[job.error_code ?? ''] ?? 'Nothing was changed. Try again later.'}
              {job.error_code === 'REAUTHENTICATION_REQUIRED' && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="pb-button"
                    onClick={() => void props.backend.account.signIn(true).catch(() => undefined)}
                  >
                    Sign in again
                  </button>
                </>
              )}
            </p>
          )}
          {!running && job?.kind === 'restore' && job.state === 'done' && job.portability && (
            <p className="muted small">
              {job.portability === 'supported'
                ? `Version ${job.version ?? ''} restored on the computer that made it: sign-ins were kept.`
                : `Version ${job.version ?? ''} restored from another computer: website data is back, but sign in to websites again.`}
            </p>
          )}
          <div className="row">
            {running ? (
              <button
                type="button"
                className="pb-button"
                onClick={() => act(() => backend.sync.cancel(p.id), 'Canceled.')}
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                className="pb-button"
                disabled={!closed || s.conflict_head !== null}
                onClick={() => act(() => backend.sync.backupNow(p.id), 'Backing up…')}
              >
                Upload backup now
              </button>
            )}
            <button
              type="button"
              className="pb-button"
              disabled={running || s.synced_version === 0 || !closed}
              onClick={() => setConfirm('restore')}
            >
              Restore newest…
            </button>
            <button
              type="button"
              className="pb-button"
              disabled={s.synced_version === 0}
              onClick={() => setHistory(true)}
            >
              Version history…
            </button>
          </div>
          {!closed && !running && (
            <p className="muted small">
              Backups are made only of a closed profile: it is backed up after you close it.
            </p>
          )}
          <label className="choice">
            <input
              type="checkbox"
              checked={s.auto_backup}
              onChange={(e) => act(() => backend.sync.setAutoBackup(p.id, e.target.checked))}
            />
            Back up automatically after it closes
          </label>
          <p className="muted small">
            Backups are compressed and encrypted on this computer before upload, with keys managed by your
            organization's server (it can decrypt them for authorized restores; this is not end-to-end
            encryption). Restoring on another computer brings back website data, but you sign in to websites
            again.
          </p>
        </>
      ) : (
        <p className="small">
          <strong>Organization backup:</strong> none. This profile is only on this computer; copy its
          workspace to an organization to back it up there.
        </p>
      )}
      <p className="small">
        <strong>Last good copy on this computer:</strong>{' '}
        {local ? new Date(local.created_at_unix * 1000).toLocaleString() : 'none yet'}
        {local &&
          (local.sealed
            ? local.openable
              ? ' · encrypted with this computer’s key'
              : ' · made with a key this computer no longer has (its keychain was reset); it cannot be restored'
            : ' · not encrypted (no keychain was available)')}
      </p>
      {!s.local_backups_sealed && (
        <p className="muted small">
          This computer's keychain is not available, so local copies are not encrypted. Use disk encryption.
        </p>
      )}

      {confirm === 'restore' && (
        <Dialog
          role="alertdialog"
          title="Restore the newest backup?"
          description="The profile's current browser data is moved aside (kept, not deleted) and replaced with the newest organization backup. The profile cannot be opened until the restore finishes."
          onClose={() => setConfirm(null)}
          initialFocus="[data-cancel]"
        >
          <div className="row row--end">
            <button type="button" className="pb-button" data-cancel onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="danger"
              onClick={() => {
                setConfirm(null);
                void act(() => backend.sync.restore(p.id, null, false), 'Restoring…');
              }}
            >
              Restore
            </button>
          </div>
        </Dialog>
      )}
      {history && s.org_id && s.org_profile_id && (
        <VersionHistory
          backend={backend}
          orgId={s.org_id}
          orgProfileId={s.org_profile_id}
          current={s.synced_version}
          closed={closed}
          notify={notify}
          onRestore={(id, asCopy) => {
            setHistory(false);
            void act(
              () => backend.sync.restore(p.id, id, asCopy),
              asCopy ? 'Restoring that version into a separate copy…' : 'Restoring that version…',
            );
          }}
          onClose={() => setHistory(false)}
        />
      )}
    </fieldset>
  );
}

function ConflictButton(props: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="pb-button" disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

/** Committed versions of an organization profile; any of them can be restored here or as a copy. */
function VersionHistory(props: {
  backend: Backend;
  orgId: string;
  orgProfileId: string;
  current: number;
  closed: boolean;
  notify: Notify;
  onRestore: (snapshotId: string, asCopy: boolean) => void;
  onClose: () => void;
}) {
  const { backend, notify } = props;
  const [rows, setRows] = useState<Snapshot[] | null>(null);
  useEffect(() => {
    get<Page<Snapshot>>(backend, `/v1/orgs/${props.orgId}/profiles/${props.orgProfileId}/snapshots`, [
      ['limit', '50'],
    ])
      .then((r) => setRows(r.data.items))
      .catch((e) => {
        notify(errorMessage(e, 'Could not load the version history.'), 'error');
        setRows([]);
      });
  }, [backend, notify, props.orgId, props.orgProfileId]);

  return (
    <Dialog
      title="Version history"
      description="Versions kept by the organization's retention policy. Restoring an older version keeps the current data aside; restoring as a copy leaves this profile unchanged."
      onClose={props.onClose}
      wide
    >
      {rows === null ? (
        <p role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No versions yet.</p>
      ) : (
        <table className="simple records">
          <caption className="pb-sr-only">Backup versions</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Made</th>
              <th scope="col">Size</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id}>
                <th scope="row">
                  {v.version}
                  {v.version === props.current ? <span className="muted small"> (this computer)</span> : null}
                </th>
                <td>{when(v.committed_at ?? v.created_at)}</td>
                <td>{formatBytes(v.plaintext_size)}</td>
                <td>
                  <div className="cell-actions">
                    <button
                      type="button"
                      className="pb-button"
                      disabled={!props.closed}
                      onClick={() => props.onRestore(v.id, false)}
                    >
                      Restore<span className="pb-sr-only"> version {v.version}</span>
                    </button>
                    <button type="button" className="pb-button" onClick={() => props.onRestore(v.id, true)}>
                      Restore as copy<span className="pb-sr-only"> of version {v.version}</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row row--end">
        <button type="button" className="pb-button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- organization backup settings
/** The organization's backup policy, trash and key versions (owners and admins). */
export function OrgBackupsSection(props: {
  backend: Backend;
  orgId: string;
  role: Role;
  notify: Notify;
  offline: boolean;
}) {
  const { backend, orgId, role, notify, offline } = props;
  const [policy, setPolicy] = useState<BackupPolicy | null>(null);
  const [trash, setTrash] = useState<TrashedProfile[] | null>(null);
  const [keys, setKeys] = useState<OrgKeys | null>(null);
  const [form, setForm] = useState({ retention: '', trash: '' });
  const [rotate, setRotate] = useState<'confirm' | 'identity' | 'waiting' | null>(null);

  const load = useCallback(() => {
    get<BackupPolicy>(backend, `/v1/orgs/${orgId}/backup-policy`)
      .then((r) => {
        setPolicy(r.data);
        setForm({ retention: String(r.data.retention_days), trash: String(r.data.trash_days) });
      })
      .catch((e) => notify(errorMessage(e, 'Could not load the backup policy.'), 'error'));
    get<Page<TrashedProfile>>(backend, `/v1/orgs/${orgId}/trash`, [['limit', '100']])
      .then((r) => setTrash(r.data.items))
      .catch(() => setTrash([]));
    get<OrgKeys>(backend, `/v1/orgs/${orgId}/keys`)
      .then((r) => setKeys(r.data))
      .catch(() => setKeys(null));
  }, [backend, orgId, notify]);
  useEffect(load, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await send<BackupPolicy>(backend, 'PATCH', `/v1/orgs/${orgId}/backup-policy`, {
        retention_days: Number(form.retention),
        trash_days: Number(form.trash),
      });
      setPolicy(r.data);
      notify('Backup policy saved.');
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  // Milestone 12: restoring from the trash needs a recent sign-in; after it, the restore continues by itself.
  const [pendingUndelete, setPendingUndelete] = useState<TrashedProfile | null>(null);
  const undelete = useCallback(
    async (t: TrashedProfile) => {
      try {
        await send(backend, 'POST', `/v1/orgs/${orgId}/profiles/${t.profile.id}/undelete`);
        notify(`Restored ${t.profile.name} from the trash, with its backups.`);
        load();
      } catch (err) {
        if (err instanceof ApiFailure && err.code === 'REAUTHENTICATION_REQUIRED') {
          setPendingUndelete(t);
          notify(
            'Restoring from the trash needs a recent sign-in. Sign in again in your browser to continue.',
          );
          void backend.account.signIn(true).catch(() => setPendingUndelete(null));
        } else notify(errorMessage(err), 'error');
      }
    },
    [backend, orgId, notify, load],
  );
  useEffect(() => {
    if (!pendingUndelete) return;
    return backend.on('account', (e) => {
      if (e.status === 'signed_in' && e.reauth) {
        setPendingUndelete(null);
        void undelete(pendingUndelete);
      } else if (e.status === 'failed') {
        setPendingUndelete(null);
        notify(e.message ?? 'Sign-in did not complete.', 'error');
      }
    });
  }, [backend, notify, pendingUndelete, undelete]);

  const runRotate = useCallback(async () => {
    try {
      const r = await send<OrgKeys>(backend, 'POST', `/v1/orgs/${orgId}/keys/rotate`);
      setKeys(r.data);
      setRotate(null);
      notify('The organization key was rotated. Existing backups are re-wrapped in the background.');
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'REAUTHENTICATION_REQUIRED') setRotate('identity');
      else {
        setRotate(null);
        notify(errorMessage(err), 'error');
      }
    }
  }, [backend, orgId, notify]);

  useEffect(() => {
    if (rotate !== 'waiting') return;
    return backend.on('account', (e) => {
      if (e.status === 'signed_in' && e.reauth) void runRotate();
      else if (e.status === 'failed') {
        notify(e.message ?? 'Sign-in did not complete.', 'error');
        setRotate('identity');
      }
    });
  }, [backend, notify, rotate, runRotate]);

  const used = policy ? Math.min(1, policy.used_bytes / policy.quota_bytes) : 0;

  return (
    <section className="stack" aria-labelledby="org-backups-title">
      <h2 id="org-backups-title">Backups</h2>
      <p className="muted small">
        Profile backups are encrypted on members' computers before upload. Their keys are wrapped by this
        organization's key on your server, which can decrypt them for authorized restores (service-managed
        encryption, not end-to-end). Every restore is recorded in Activity.
      </p>

      {policy && (
        <form className="stack" onSubmit={save} aria-labelledby="org-policy-title">
          <h3 id="org-policy-title">Retention</h3>
          <p className="small">
            Storage used: {formatBytes(policy.used_bytes)} of {formatBytes(policy.quota_bytes)}
          </p>
          <progress aria-label="Backup storage used" value={used} max={1} />
          <p className="muted small">Largest single backup: {formatBytes(policy.max_snapshot_bytes)}.</p>
          <fieldset className="plain" disabled={offline || !can(role, 'backups.manage')}>
            <label>
              Keep one backup per day for (days)
              <input
                type="number"
                min={1}
                max={90}
                required
                value={form.retention}
                onChange={(e) => setForm((f) => ({ ...f, retention: e.target.value }))}
              />
            </label>
            <label>
              Keep deleted profiles in the trash for (days)
              <input
                type="number"
                min={1}
                max={90}
                required
                value={form.trash}
                onChange={(e) => setForm((f) => ({ ...f, trash: e.target.value }))}
              />
            </label>
            <p className="muted small">
              The newest backup of each profile and everything from the last 24 hours are always kept.
            </p>
            <button type="submit" className="pb-button" data-variant="primary">
              Save retention
            </button>
          </fieldset>
        </form>
      )}

      <h3 id="org-trash-title">Trash</h3>
      {trash === null ? (
        <p role="status">Loading…</p>
      ) : trash.length === 0 ? (
        <p className="muted">No deleted profiles.</p>
      ) : (
        <table className="simple records" aria-labelledby="org-trash-title">
          <thead>
            <tr>
              <th scope="col">Profile</th>
              <th scope="col">Deleted</th>
              <th scope="col">Erased on</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {trash.map((t) => (
              <tr key={t.profile.id}>
                <th scope="row">{t.profile.name}</th>
                <td>{relative(t.deleted_at)}</td>
                <td>{day(t.purge_after)}</td>
                <td>
                  <button type="button" className="pb-button" disabled={offline} onClick={() => undelete(t)}>
                    Restore<span className="pb-sr-only"> {t.profile.name}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <RecoveryCopiesSection backend={backend} orgId={orgId} role={role} notify={notify} offline={offline} />

      <h3 id="org-keys-title">Organization key</h3>
      {keys ? (
        <>
          <table className="simple records" aria-labelledby="org-keys-title">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Backups</th>
              </tr>
            </thead>
            <tbody>
              {keys.keys.map((k) => (
                <tr key={k.id}>
                  <th scope="row">{k.version}</th>
                  <td>
                    {k.status === 'active'
                      ? 'In use'
                      : k.status === 'retired'
                        ? `Retired · destroyed after ${day(k.destroy_after)}`
                        : `Destroyed ${day(k.destroyed_at)}`}
                  </td>
                  <td>{day(k.created_at)}</td>
                  <td>{k.snapshots}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {can(role, 'keys.manage') && (
            <button
              type="button"
              className="pb-button"
              disabled={offline}
              onClick={() => setRotate('confirm')}
            >
              Rotate key…
            </button>
          )}
        </>
      ) : (
        <p className="muted">Key information is not available.</p>
      )}

      {rotate && (
        <Dialog
          role="alertdialog"
          title="Rotate the organization key?"
          description="New backups use a new key version. Existing backups are re-wrapped in the background; the old version is destroyed 30 days after nothing uses it. Backups stay restorable throughout."
          onClose={() => setRotate(null)}
          initialFocus="[data-cancel]"
        >
          {rotate === 'confirm' ? (
            <div className="row row--end">
              <button type="button" className="pb-button" data-cancel onClick={() => setRotate(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="pb-button"
                data-variant="primary"
                onClick={() => void runRotate()}
              >
                Rotate key
              </button>
            </div>
          ) : (
            <div className="stack">
              <p role="status">
                {rotate === 'waiting'
                  ? 'Confirm in your browser. The rotation continues when you are back.'
                  : 'For your security, sign in again to confirm it is you. Your sign-in page opens in your browser.'}
              </p>
              <div className="row row--end">
                <button type="button" className="pb-button" data-cancel onClick={() => setRotate(null)}>
                  Cancel
                </button>
                {rotate === 'identity' && (
                  <button
                    type="button"
                    className="pb-button"
                    data-variant="primary"
                    onClick={async () => {
                      try {
                        setRotate('waiting');
                        await backend.account.signIn(true);
                      } catch (err) {
                        notify(errorMessage(err), 'error');
                        setRotate('identity');
                      }
                    }}
                  >
                    Confirm it's me
                  </button>
                )}
              </div>
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
}
