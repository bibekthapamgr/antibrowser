/**
 * R3 unified Profiles (ADR-0022): one list per account workspace. A row is a workspace profile; this computer's copy
 * of it (found through the R1 identity mapping) adds its run state, download and backup status — one row per
 * profile, never a second row for the local copy. Opening goes through the one existing path (lease, newest backup,
 * browser on this computer); closing is the usual clean close, whose backup is saved for the next person.
 *
 * Also here: Create Profile (name, optional folder, optional proxy on this computer), moving a profile between folders
 * with its access impact shown first, the Subscription page, the workspace part of Settings, Agency tools and the
 * "This computer" view of local-only profiles with the optional move into the workspace.
 */
import type { MigrationPlan } from '@pb/contracts/ipc';
import type { FolderMoveImpact, Organization, Profile as OrgProfile, Role } from '@pb/contracts/resources';
import type { Folder } from '@pb/contracts/workspace';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { OrgAutomationSection } from './automation.tsx';
import type { AppView, Backend, Library, ProfileView, ProxyView, WorkspaceCopy } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { OrgBackupsSection } from './backups.tsx';
import { OrgBillingSection } from './billing.tsx';
import { ApiFailure, can, codeOf, getAll, send } from './cloud.ts';
import { Dialog, useDebounced } from './components.tsx';
import { ProfileDrawer } from './drawer.tsx';
import { OrgExtensionsSection } from './extensions-org.tsx';
import { useLauncher } from './launch.tsx';
import { ActivitySection, ClientsSection, type SectionProps, SettingsSection, Stale } from './org.tsx';
import { type Notify, plural, relative, when } from './status.tsx';
import { OPEN_REFUSED, TakeoverDialog } from './team.tsx';

// ------------------------------------------------------------------------------------------------ status
export type RowStatusKey =
  | 'available'
  | 'downloading'
  | 'running'
  | 'in_use'
  | 'sync_pending'
  | 'sign_in'
  | 'recovery';
export interface RowStatus {
  key: RowStatusKey;
  label: string;
  detail: string;
  tone?: 'warn' | 'error' | 'ok' | undefined;
}
const RUNNING_UPLOAD = ['local_dirty', 'preparing', 'uploading', 'verifying'];
const RUNNING_RESTORE = ['planning', 'downloading', 'opening', 'ready'];

/** The one status a row shows, from the workspace profile and this computer's copy (if any). */
export function rowStatus(p: OrgProfile, c: WorkspaceCopy | undefined): RowStatus {
  const v = c?.profile;
  const s = c?.sync;
  if (v?.team_phase === 'taken_over' || v?.team_phase === 'revoked')
    return {
      key: 'recovery',
      label: 'Recovery needed',
      detail:
        v.team_phase === 'taken_over'
          ? 'An admin took it over; your copy was kept aside on this computer.'
          : 'Your access was removed; the data on this computer was kept aside.',
      tone: 'error',
    };
  if (v?.team_phase === 'pending' || v?.team_phase === 'lost')
    return {
      key: 'recovery',
      label: 'Recovery needed',
      detail:
        v.team_phase === 'lost'
          ? 'The connection was lost while it was open; it reconnects when you are online.'
          : 'Its closing backup is waiting for a decision. Open Details.',
      tone: 'warn',
    };
  if (s && s.conflict_head !== null)
    return {
      key: 'recovery',
      label: 'Recovery needed',
      detail: 'A newer backup was made on another computer. Choose which copy to keep in Details.',
      tone: 'warn',
    };
  if (s?.job?.kind === 'restore' && s.job.state === 'failed')
    return {
      key: 'recovery',
      label: 'Recovery needed',
      detail: 'The download did not finish. Try opening it again.',
      tone: 'error',
    };
  if (s && (s.restoring || (s.job?.kind === 'restore' && RUNNING_RESTORE.includes(s.job.state)))) {
    const pct = s.progress.total > 0 ? Math.round((100 * s.progress.done) / s.progress.total) : null;
    return {
      key: 'downloading',
      label: pct !== null ? `Downloading ${pct}%` : 'Downloading',
      detail: 'Its newest backup is downloading to this computer; it can be opened when done.',
    };
  }
  if (v && v.state !== 'stopped' && v.state !== 'crashed')
    return {
      key: 'running',
      label: v.state === 'starting' ? 'Opening…' : v.state === 'stopping' ? 'Closing…' : 'Running',
      detail: 'Open on this computer.',
      tone: 'ok',
    };
  if (p.in_use && !p.in_use.mine)
    return {
      key: 'in_use',
      label: 'In use by teammate',
      detail: `${p.in_use.holder_name || 'Someone'} has it open on ${p.in_use.device_name || 'another computer'}${
        p.in_use.state === 'uncertain' ? ' (not closed properly)' : ''
      }.`,
      tone: p.in_use.state === 'uncertain' ? 'warn' : undefined,
    };
  if (p.in_use?.mine && !v)
    return {
      key: 'in_use',
      label: 'Open on your other computer',
      detail: `You have it open on ${p.in_use.device_name || 'another computer'}. Close it there first.`,
    };
  if (
    s &&
    ((s.job?.kind === 'upload' && (RUNNING_UPLOAD.includes(s.job.state) || s.job.state === 'failed')) ||
      s.progress.waiting_for)
  )
    return {
      key: 'sync_pending',
      label: 'Sync pending',
      detail:
        s.job?.state === 'failed'
          ? 'Its last backup did not finish; it is retried. Nothing was lost on this computer.'
          : s.progress.waiting_for
            ? 'Its backup waits for the connection.'
            : 'Its backup is being saved for the next person.',
      tone: s.job?.state === 'failed' ? 'warn' : undefined,
    };
  if (s?.job?.kind === 'restore' && s.job.state === 'done' && s.job.portability === 'sign_in_required')
    return {
      key: 'sign_in',
      label: 'Sign-in needed',
      detail: 'Its last backup came from another computer: websites may ask you to sign in again.',
    };
  return {
    key: 'available',
    label: 'Available',
    detail: c
      ? 'On this computer.'
      : p.snapshot_version > 0
        ? 'Downloads its newest backup when you open it.'
        : 'Starts empty on this computer when you open it.',
  };
}

const openErrorText = (e: unknown, name: string): string => {
  const code = codeOf(e);
  if (code && OPEN_REFUSED[code]) return `${name}: ${OPEN_REFUSED[code]}`;
  switch (code) {
    case 'CLOUD_UNAVAILABLE':
    case 'CLOUD_OFFLINE':
    case 'SHARED_OFFLINE':
    case 'NOT_SIGNED_IN':
      return `${name} cannot open while the server cannot be reached. Check your connection and try again; nothing was changed.`;
    case 'SYNC_FORBIDDEN':
    case 'NO_ACCESS':
      return `${name} is not shared with you any more. Ask an admin for access.`;
    case 'DISK_FULL':
    case 'LOW_DISK_SPACE':
      return `There is not enough free disk space to put ${name} on this computer. Free some space and try again.`;
    default:
      return errorMessage(e, `${name} could not be opened. Try again.`);
  }
};

// ------------------------------------------------------------------------------------------------ profiles
export function WorkspaceProfiles(props: {
  backend: Backend;
  orgId: string;
  org: Organization;
  refreshKey: number;
  notify: Notify;
  me: string;
  /** Plan usage: profiles allowed (owners and billing managers can read it). */
  allowed: number | null;
  onOpenSubscription: () => void;
}) {
  const { backend, orgId, org, notify } = props;
  const role = org.role;
  const [rows, setRows] = useState<OrgProfile[] | null>(null);
  const [complete, setComplete] = useState(true);
  const [stale, setStale] = useState<string | null | false>(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [copies, setCopies] = useState<Map<string, WorkspaceCopy>>(new Map());
  const [folder, setFolder] = useState<string>('all');
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim().toLowerCase(), 150);
  const [nonce, setNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<OrgProfile | null>(null);
  const [deleting, setDeleting] = useState<OrgProfile | null>(null);
  const [takingOver, setTakingOver] = useState<OrgProfile | null>(null);
  const [details, setDetails] = useState<{ view: ProfileView; library: Library | null } | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const launcher = useLauncher(backend, notify);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // The workspace's profiles and folders (API) and this computer's copies (shell). A stale answer never replaces a
  // newer one: each load checks it is still the current one before showing anything.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and nonce reload
  useEffect(() => {
    let live = true;
    getAll<OrgProfile>(backend, `/v1/orgs/${orgId}/profiles`)
      .then((r) => {
        if (!live) return;
        setRows(r.items);
        setComplete(r.complete);
        setStale(r.stale ? r.fetchedAt : false);
        setFailed(null);
      })
      .catch((e) => live && setFailed(errorMessage(e, 'The profiles could not be loaded.')));
    getAll<Folder>(backend, `/v1/orgs/${orgId}/folders`)
      .then((r) => live && setFolders(r.items))
      .catch(() => undefined);
    backend.sync
      .copies(orgId)
      .then((c) => live && setCopies(new Map(c.map((x) => [x.org_profile_id, x]))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [backend, orgId, props.refreshKey, nonce]);
  // Downloads and backups move on in the background.
  useEffect(() => {
    const off = backend.on('sync', () => {
      void backend.sync
        .copies(orgId)
        .then((c) => setCopies(new Map(c.map((x) => [x.org_profile_id, x]))))
        .catch(() => undefined);
    });
    return off;
  }, [backend, orgId]);

  const folderName = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);
  const shown = (rows ?? []).filter(
    (p) =>
      (folder === 'all' || (folder === 'none' ? !p.folder_id : p.folder_id === folder)) &&
      (!query || p.name.toLowerCase().includes(query)),
  );
  const offline = stale !== false;
  const total = rows?.length ?? 0;
  const atLimit = props.allowed !== null && total >= props.allowed;

  const openRow = async (p: OrgProfile, c: WorkspaceCopy | undefined) => {
    try {
      if (c && !c.sync.restoring) {
        await launcher.open([c.profile]);
        return;
      }
      const r = await backend.sync.openWorkspaceProfile(orgId, p.id, p.name);
      notify(
        r.restoring
          ? `Downloading ${p.name} to this computer. It opens when the download finishes; websites may ask you to sign in again.`
          : `Opening ${p.name}…`,
      );
      reload();
    } catch (e) {
      notify(openErrorText(e, p.name), 'error');
      reload();
    }
  };
  const closeRow = async (p: OrgProfile, c: WorkspaceCopy) => {
    try {
      await backend.profiles.stop(c.profile.id, c.profile.force_available);
      notify(`Closing ${p.name}. Its backup is saved for the next person.`);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  const ask = async (p: OrgProfile) => {
    try {
      await send(backend, 'POST', `/v1/orgs/${orgId}/profiles/${p.id}/handoff-requests`, { note: '' });
      notify(
        `Asked ${p.in_use?.holder_name || 'them'} for ${p.name}. Nothing closes until they hand it off.`,
      );
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };
  const showDetails = async (c: WorkspaceCopy) => {
    let library: Library | null = null;
    try {
      library = await backend.library.library();
    } catch {
      library = null;
    }
    setDetails({ view: c.profile, library });
  };
  const remove = async (p: OrgProfile) => {
    setDeleting(null);
    try {
      await send(backend, 'DELETE', `/v1/orgs/${orgId}/profiles/${p.id}`, undefined, p.version);
      notify(`${p.name} was moved to the workspace trash. Copies already on computers are not touched.`);
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
    reload();
  };

  return (
    <section className="screen stack" aria-labelledby="profiles-title">
      <header className="toolbar">
        <div className="toolbar__title">
          <h1 id="profiles-title">Profiles</h1>
          <p className="muted small" aria-live="polite">
            {rows === null
              ? 'Loading…'
              : `${plural(total, 'profile')}${props.allowed !== null ? ` of ${props.allowed} on your plan` : ''} in ${org.name}`}
          </p>
        </div>
        {can(role, 'profile.create') && (
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            disabled={offline || rows === null}
            onClick={() => (atLimit ? props.onOpenSubscription() : setCreating(true))}
          >
            {atLimit ? 'Plan limit reached…' : 'New profile'}
          </button>
        )}
      </header>
      {offline && <Stale at={stale || null} />}
      {failed && (
        <div className="notice row" role="alert">
          <span className="grow">{failed}</span>
          <button type="button" className="pb-button" onClick={reload}>
            Try again
          </button>
        </div>
      )}
      <p className="muted small">
        Profiles open in a browser on this computer. One person at a time works in each; closing it saves its
        backup for the next person.
      </p>
      <div className="row workspace-filters">
        <label className="grow">
          Search by name
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          Folder
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="all">All folders</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            <option value="none">Not in a folder</option>
          </select>
        </label>
        {can(role, 'folders.manage') && (
          <button type="button" className="pb-button" disabled={offline} onClick={() => setNewFolder(true)}>
            New folder
          </button>
        )}
      </div>
      {rows === null ? (
        !failed && <p role="status">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="empty-state stack">
          <p className="muted">
            {query || folder !== 'all'
              ? 'No profiles match.'
              : can(role, 'profile.create')
                ? 'No profiles yet. Create one: give it a name; a folder and a proxy are optional.'
                : 'No profiles have been shared with you yet. Ask an admin of this workspace for access.'}
          </p>
        </div>
      ) : (
        <table className="simple records workspace-profiles">
          <caption className="pb-sr-only">Profiles of {org.name}</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Folder</th>
              <th scope="col">Status</th>
              <th scope="col">Last backup</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const c = copies.get(p.id);
              const st = rowStatus(p, c);
              const mayOpen = (p.capabilities ?? []).includes('launch');
              const busy =
                st.key === 'downloading' || (c && ['starting', 'stopping'].includes(c.profile.state));
              return (
                <tr key={p.id} data-status={st.key}>
                  <th scope="row">{p.name}</th>
                  <td>
                    {p.folder_id ? (folderName.get(p.folder_id) ?? '—') : <span className="muted">—</span>}
                  </td>
                  <td>
                    <span
                      className={`badge${st.tone ? ` badge--${st.tone}` : ''}`}
                      title={st.detail}
                      aria-describedby={undefined}
                    >
                      {st.label}
                    </span>
                    <span className="pb-sr-only">: {st.detail}</span>
                  </td>
                  <td>
                    {p.last_snapshot_at ? relative(p.last_snapshot_at) : <span className="muted">None</span>}
                  </td>
                  <td>
                    <div className="cell-actions">
                      {st.key === 'running' && c ? (
                        <button
                          type="button"
                          className="pb-button"
                          disabled={!!busy}
                          onClick={() => closeRow(p, c)}
                        >
                          {c.profile.force_available ? 'Force close' : 'Close'}
                          <span className="pb-sr-only"> {p.name}</span>
                        </button>
                      ) : st.key === 'in_use' && p.in_use && !p.in_use.mine ? (
                        mayOpen && (
                          <button
                            type="button"
                            className="pb-button"
                            disabled={offline}
                            onClick={() => ask(p)}
                          >
                            Ask for it<span className="pb-sr-only"> {p.name}</span>
                          </button>
                        )
                      ) : mayOpen ? (
                        <button
                          type="button"
                          className="pb-button"
                          data-variant="primary"
                          disabled={offline || !!busy || st.key === 'in_use'}
                          onClick={() => openRow(p, c)}
                        >
                          Open<span className="pb-sr-only"> {p.name}</span>
                        </button>
                      ) : (
                        <span className="muted small">View only</span>
                      )}
                      {c && (
                        <button type="button" className="pb-button" onClick={() => showDetails(c)}>
                          Details<span className="pb-sr-only"> of {p.name}</span>
                        </button>
                      )}
                      {can(role, 'profile.update') && (p.capabilities ?? []).includes('edit') && (
                        <button
                          type="button"
                          className="pb-button"
                          disabled={offline}
                          onClick={() => setMoving(p)}
                        >
                          Move…<span className="pb-sr-only"> {p.name}</span>
                        </button>
                      )}
                      {p.in_use && !p.in_use.mine && can(role, 'lease.force_release') && (
                        <button
                          type="button"
                          className="pb-button"
                          disabled={offline}
                          onClick={() => setTakingOver(p)}
                        >
                          Take over…<span className="pb-sr-only"> {p.name}</span>
                        </button>
                      )}
                      {can(role, 'profile.delete') && (
                        <button
                          type="button"
                          className="pb-button"
                          disabled={offline}
                          onClick={() => setDeleting(p)}
                        >
                          Delete<span className="pb-sr-only"> {p.name}</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {!complete && (
        <p className="muted small">
          Showing the first {plural(total, 'profile')}. Search by name or choose a folder to find the others.
        </p>
      )}
      {creating && (
        <CreateWorkspaceProfile
          backend={backend}
          orgId={orgId}
          folders={folders}
          initialFolder={folder !== 'all' && folder !== 'none' ? folder : ''}
          notify={notify}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
      {newFolder && (
        <NewFolderDialog
          backend={backend}
          orgId={orgId}
          notify={notify}
          onClose={() => setNewFolder(false)}
          onCreated={(f) => {
            setNewFolder(false);
            setFolder(f.id);
            reload();
          }}
        />
      )}
      {moving && (
        <MoveDialog
          backend={backend}
          orgId={orgId}
          profile={moving}
          folders={folders}
          notify={notify}
          onClose={() => setMoving(null)}
          onMoved={() => {
            setMoving(null);
            reload();
          }}
        />
      )}
      {takingOver?.in_use && (
        <TakeoverDialog
          backend={backend}
          orgId={orgId}
          profileId={takingOver.id}
          profileName={takingOver.name}
          holder={`${takingOver.in_use.holder_name || 'Someone'} on ${takingOver.in_use.device_name || 'another computer'}`}
          uncertain={takingOver.in_use.state === 'uncertain'}
          notify={notify}
          onClose={() => setTakingOver(null)}
          onDone={() => {
            setTakingOver(null);
            reload();
          }}
        />
      )}
      {deleting && (
        <Dialog
          title={`Delete ${deleting.name}?`}
          description="It goes to the workspace trash for everyone and can be restored from there for a while. Copies already on computers are not touched."
          role="alertdialog"
          onClose={() => setDeleting(null)}
        >
          <div className="row row--end">
            <button type="button" className="pb-button" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="danger"
              onClick={() => remove(deleting)}
            >
              Delete profile
            </button>
          </div>
        </Dialog>
      )}
      {details && (
        <ProfileDrawer
          key={details.view.id}
          backend={backend}
          profile={details.view}
          library={details.library}
          refreshKey={props.refreshKey}
          notify={notify}
          onToggle={(v) =>
            void (v.state === 'stopped' || v.state === 'crashed'
              ? launcher.open([v])
              : backend.profiles.stop(v.id).catch((e) => notify(errorMessage(e), 'error')))
          }
          onSaved={(v) => setDetails((d) => (d ? { ...d, view: v } : d))}
          onBulk={() => notify('Choose this profile in “This computer” for that.', 'info')}
          onCreated={() => reload()}
          onLibraryChanged={() => undefined}
          onClose={() => {
            setDetails(null);
            reload();
          }}
        />
      )}
      {launcher.dialog}
    </section>
  );
}

function NewFolderDialog(props: {
  backend: Backend;
  orgId: string;
  notify: Notify;
  onClose: () => void;
  onCreated: (f: Folder) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await send<Folder>(props.backend, 'POST', `/v1/orgs/${props.orgId}/folders`, {
        name: name.trim(),
      });
      props.notify(`Folder “${res.data.name}” created.`);
      props.onCreated(res.data);
    } catch (err) {
      props.notify(errorMessage(err), 'error');
      setBusy(false);
    }
  };
  return (
    <Dialog title="New folder" onClose={props.onClose} initialFocus="input">
      <form className="stack" onSubmit={submit}>
        <label>
          Folder name
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="muted small">
          Folders organize profiles. Sharing a folder with someone is a separate, explicit choice in Team.
        </p>
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy || !name.trim()}>
            Create folder
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Name, optional folder, optional proxy (this computer). No client, workspace, access or server setup. */
export function CreateWorkspaceProfile(props: {
  backend: Backend;
  orgId: string;
  folders: Folder[];
  initialFolder: string;
  notify: Notify;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { backend, orgId, notify } = props;
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(props.initialFolder);
  const [proxy, setProxy] = useState('');
  const [proxies, setProxies] = useState<ProxyView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    backend.network
      .proxies()
      .then(setProxies)
      .catch(() => setProxies([]));
  }, [backend]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let created: OrgProfile | null = null;
    try {
      created = (
        await send<OrgProfile>(backend, 'POST', `/v1/orgs/${orgId}/profiles`, {
          name: name.trim(),
          ...(folder ? { folder_id: folder } : {}),
        })
      ).data;
      await backend.sync.prepare(orgId, created.id, created.name, proxy || undefined);
      notify(`Profile “${created.name}” created. Open it when you are ready.`);
      props.onCreated();
    } catch (err) {
      if (created) {
        // The workspace profile exists; only this computer's copy (or its proxy) did not get set up.
        notify(
          `Profile “${created.name}” was created, but this computer could not prepare it: ${errorMessage(err)} Opening it tries again.`,
          'error',
        );
        props.onCreated();
        return;
      }
      setError(
        err instanceof ApiFailure && err.code === 'PLAN_LIMIT_REACHED'
          ? 'Your plan’s profile limit is reached. An owner can change the plan in Subscription.'
          : errorMessage(err),
      );
      setBusy(false);
    }
  };
  return (
    <Dialog title="New profile" onClose={props.onClose} initialFocus="input">
      <form className="stack" onSubmit={submit}>
        <label>
          Name
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Folder (optional)
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">No folder</option>
            {props.folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Proxy on this computer (optional)
          <select value={proxy} onChange={(e) => setProxy(e.target.value)}>
            <option value="">No proxy</option>
            {proxies.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          A new profile uses the browser’s usual supported settings. Proxies are kept on this computer only.
          {folder ? ' People given this folder with “profiles added later” can open it.' : ''}
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy || !name.trim()}>
            Create profile
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Moving a profile shows who gains or loses access first; without grant management such a move is refused. */
function MoveDialog(props: {
  backend: Backend;
  orgId: string;
  profile: OrgProfile;
  folders: Folder[];
  notify: Notify;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { backend, orgId, profile: p, notify } = props;
  const [target, setTarget] = useState(p.folder_id ?? 'none');
  const [impact, setImpact] = useState<FolderMoveImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const unchanged = target === (p.folder_id ?? 'none');
  useEffect(() => {
    setImpact(null);
    if (unchanged) return;
    let live = true;
    backend.account
      .request({
        method: 'GET',
        path: `/v1/orgs/${orgId}/profiles/${p.id}/folder-impact`,
        query: [['folder_id', target]],
      })
      .then((r) => live && r.status === 200 && setImpact(r.body as FolderMoveImpact))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [backend, orgId, p.id, target, unchanged]);
  const move = async () => {
    setBusy(true);
    try {
      await send(backend, 'PUT', `/v1/orgs/${orgId}/profiles/${p.id}/folder`, {
        folder_id: target === 'none' ? null : target,
      });
      notify(`${p.name} was moved.`);
      props.onMoved();
    } catch (e) {
      notify(errorMessage(e), 'error');
      setBusy(false);
    }
  };
  const names = (xs: { display_name: string }[]) => xs.map((x) => x.display_name).join(', ');
  const changes = impact ? impact.gains.length + impact.losses.length > 0 : false;
  return (
    <Dialog title={`Move ${p.name}`} onClose={props.onClose}>
      <div className="stack">
        <label>
          Folder
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="none">Not in a folder</option>
            {props.folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        {!unchanged &&
          (impact === null ? (
            <p role="status">Checking who can open it after the move…</p>
          ) : (
            <section className="card stack" aria-label="Access after the move" aria-live="polite">
              {!changes && <p>Nobody gains or loses access.</p>}
              {impact.gains.length > 0 && (
                <p>
                  <strong>Gain access:</strong> {names(impact.gains)}
                </p>
              )}
              {impact.losses.length > 0 && (
                <p>
                  <strong>Lose access:</strong> {names(impact.losses)}. If they have it open, it is closed in
                  their app; what is already on their computers stays there.
                </p>
              )}
              {!impact.allowed && (
                <p role="alert" className="error">
                  This move changes who can open the profile. Only owners and admins can do that.
                </p>
              )}
            </section>
          ))}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            disabled={busy || unchanged || !impact || !impact.allowed}
            onClick={move}
          >
            Move
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ subscription
export function SubscriptionScreen(props: SectionProps & { org: Organization; onChanged: () => void }) {
  const { org, role } = props;
  return (
    <section className="screen stack" aria-labelledby="subscription-title">
      <header className="toolbar">
        <div className="toolbar__title">
          <h1 id="subscription-title">Subscription</h1>
          <p className="muted small">
            {org.name}
            {org.billing ? `: ${org.billing.plan_name}` : ''}
            {org.billing?.until ? ` · until ${when(org.billing.until)}` : ''}
          </p>
        </div>
      </header>
      {can(role, 'billing.read') ? (
        <OrgBillingSection {...props} />
      ) : (
        <p className="muted">
          The subscription belongs to this workspace and is managed by its owners and billing managers. Your
          seat is part of it; you do not need a plan of your own.
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ workspace settings
type WsTab = 'backups' | 'extensions' | 'developer' | 'activity' | 'workspace';
export function WorkspaceSettings(
  props: SectionProps & { org: Organization; app: AppView; developerTools: boolean; onChanged: () => void },
) {
  const { role } = props;
  const tabs: [WsTab, string, boolean][] = [
    ['workspace', 'Workspace', true],
    ['backups', 'Backups', can(role, 'backups.manage')],
    ['extensions', 'Extension policy', can(role, 'org.read') && role !== 'billing'],
    ['developer', 'Developer tools', props.developerTools && can(role, 'automation.read')],
    ['activity', 'Activity', can(role, 'audit.read')],
  ];
  const visible = tabs.filter(([, , show]) => show);
  const [tab, setTab] = useState<WsTab>('workspace');
  const current = visible.some(([t]) => t === tab) ? tab : 'workspace';
  return (
    <section className="stack" aria-label="Workspace settings">
      <nav aria-label="Workspace settings" className="org-nav">
        {visible.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="pb-button"
            aria-current={current === id ? 'page' : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {current === 'workspace' && <SettingsSection {...props} />}
      {current === 'backups' && <OrgBackupsSection {...props} />}
      {current === 'extensions' && <OrgExtensionsSection {...props} />}
      {current === 'developer' && <OrgAutomationSection {...props} />}
      {current === 'activity' && <ActivitySection {...props} />}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ agency tools
export function AgencyTools(props: SectionProps) {
  return (
    <section className="screen stack" aria-labelledby="agency-title">
      <header className="toolbar">
        <div className="toolbar__title">
          <h1 id="agency-title">Agency tools</h1>
          <p className="muted small">Clients, their dashboards, tasks and shared bookmarks.</p>
        </div>
      </header>
      <ClientsSection {...props} />
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ this computer
/** The "This computer" banner over local-only profiles, with the optional move into the account workspace. */
export function ThisComputerBanner(props: {
  backend: Backend;
  app: AppView;
  orgs: { org_id: string; name: string; role: Role }[];
  notify: Notify;
  onMoved: (orgId: string) => void;
  onSignIn: () => void;
  signedIn: boolean;
}) {
  const [moving, setMoving] = useState(false);
  const targets = props.orgs.filter((o) => can(o.role, 'profile.create'));
  return (
    <div className="notice stack" role="note" aria-label="About this view">
      <p>
        <strong>This computer.</strong> These profiles stay on this computer only: they are not backed up to
        or shared through an account workspace. Nothing here is uploaded unless you move it.
      </p>
      <div className="row">
        {props.signedIn ? (
          targets.length > 0 && (
            <button type="button" className="pb-button" onClick={() => setMoving(true)}>
              Move profiles into a workspace…
            </button>
          )
        ) : (
          <button type="button" className="pb-button" data-variant="primary" onClick={props.onSignIn}>
            Sign in or create an account
          </button>
        )}
      </div>
      {moving && (
        <MoveIntoWorkspace
          backend={props.backend}
          app={props.app}
          targets={targets}
          notify={props.notify}
          onClose={() => setMoving(false)}
          onDone={(orgId) => {
            setMoving(false);
            props.onMoved(orgId);
          }}
        />
      )}
    </div>
  );
}

/** The R1 adoption: plan (nothing changes), choose, move. Local data stays; each moved profile is linked, once. */
function MoveIntoWorkspace(props: {
  backend: Backend;
  app: AppView;
  targets: { org_id: string; name: string }[];
  notify: Notify;
  onClose: () => void;
  onDone: (orgId: string) => void;
}) {
  const { backend, notify } = props;
  const wsId = props.app.active_workspace_id ?? '';
  const [orgId, setOrgId] = useState(props.targets[0]?.org_id ?? '');
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [backup, setBackup] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!orgId || !wsId) return;
    let live = true;
    setPlan(null);
    backend.migration
      .plan(wsId, orgId)
      .then((p) => {
        if (!live) return;
        setPlan(p);
        setChosen(new Set(p.entries.filter((e) => e.state === 'local_only').map((e) => e.local_id)));
      })
      .catch((e) => live && notify(errorMessage(e), 'error'));
    return () => {
      live = false;
    };
  }, [backend, orgId, wsId, notify]);
  const run = async () => {
    setBusy(true);
    try {
      const r = await backend.migration.run(wsId, orgId, [...chosen], backup);
      notify(
        `${plural(Object.keys(r.mappings).length, 'profile')} of this computer ${
          Object.keys(r.mappings).length === 1 ? 'is' : 'are'
        } now in the workspace. The data stayed on this computer.`,
      );
      props.onDone(orgId);
    } catch (e) {
      notify(errorMessage(e), 'error');
      setBusy(false);
    }
  };
  const quota = plan?.quota;
  const over =
    quota?.profiles_allowed !== null && quota !== null && quota !== undefined
      ? quota.profiles_used + chosen.size > (quota.profiles_allowed ?? Number.POSITIVE_INFINITY)
      : false;
  let list: ReactNode = <p role="status">Checking this computer’s profiles…</p>;
  if (plan)
    list = (
      <ul className="pick-list" aria-label="Profiles to move">
        {plan.entries.map((e) => (
          <li key={e.local_id}>
            <label className="choice">
              <input
                type="checkbox"
                disabled={e.state !== 'local_only'}
                checked={chosen.has(e.local_id)}
                onChange={(ev) => {
                  const next = new Set(chosen);
                  if (ev.target.checked) next.add(e.local_id);
                  else next.delete(e.local_id);
                  setChosen(next);
                }}
              />
              {e.name}
              <span className="muted small">
                {
                  {
                    local_only: '',
                    linked: ' — already in the workspace',
                    mapped_on_server: ' — already in the workspace',
                    blocked_running: ' — close it first',
                    blocked_unclean: ' — open and close it once first',
                  }[e.state]
                }
              </span>
            </label>
          </li>
        ))}
      </ul>
    );
  return (
    <Dialog title="Move profiles into a workspace" onClose={props.onClose} wide>
      <div className="stack">
        <label>
          Workspace
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {props.targets.map((t) => (
              <option key={t.org_id} value={t.org_id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {list}
        <label className="choice">
          <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
          Back each one up to the workspace after moving it (encrypted)
        </label>
        <p className="muted small">
          Moving links each profile to the workspace once; running it again never makes duplicates. The
          browser data stays on this computer.{' '}
          {quota?.profiles_allowed != null
            ? `The workspace uses ${quota.profiles_used} of ${quota.profiles_allowed} profiles on its plan.`
            : ''}
        </p>
        {over && (
          <p role="alert" className="error">
            That is more than the workspace’s plan allows. Choose fewer, or ask an owner to change the plan.
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            disabled={busy || !plan || chosen.size === 0 || over}
            onClick={run}
          >
            Move {plural(chosen.size, 'profile')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
