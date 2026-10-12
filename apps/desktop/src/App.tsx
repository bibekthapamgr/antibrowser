import { ClientBadge } from '@pb/ui';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isIpcError, type LocalProfile } from './api.ts';

const WORKSPACES = [{ id: 'local', name: 'This device', note: 'Local profiles' }];
const NAV = ['Profiles', 'Clients', 'Activity', 'Settings'] as const;

export function App() {
  const [workspace, setWorkspace] = useState('local');
  const [query, setQuery] = useState('');
  const [profiles, setProfiles] = useState<LocalProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async (q: string) => {
    try {
      setProfiles(await api.listProfiles(q));
    } catch (e) {
      setStatus({ kind: 'error', text: isIpcError(e) ? e.message : 'Could not load profiles.' });
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refresh(query), 120);
    return () => clearTimeout(t);
  }, [query, refresh]);

  const selected = useMemo(() => profiles.find((p) => p.id === selectedId) ?? null, [profiles, selectedId]);

  const launch = async (p: LocalProfile) => {
    setStatus(null);
    try {
      await api.launchProfile(p.id);
      setStatus({ kind: 'info', text: `${p.name} opened.` });
      await refresh(query);
    } catch (e) {
      setStatus({ kind: 'error', text: isIpcError(e) ? e.message : 'The profile could not be opened.' });
    }
  };

  return (
    <div className="layout">
      <aside className="sidebar" aria-label="Workspace and navigation">
        <label className="workspace">
          <span className="pb-sr-only">Workspace</span>
          <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            {WORKSPACES.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <nav>
          <ul>
            {NAV.map((item) => (
              <li key={item}>
                <a href={`#${item.toLowerCase()}`} aria-current={item === 'Profiles' ? 'page' : undefined}>
                  {item}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <p className="sidebar__note">Engineering preview · local profiles only</p>
      </aside>

      <main className="main">
        <header className="toolbar">
          <h1>Profiles</h1>
          <input
            type="search"
            placeholder="Search name or client"
            aria-label="Search profiles"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            onClick={() => setCreating(true)}
          >
            New profile
          </button>
        </header>

        {status && (
          <div
            role={status.kind === 'error' ? 'alert' : 'status'}
            className={`banner banner--${status.kind}`}
          >
            {status.text}
          </div>
        )}

        <table className="profiles">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Client</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id} aria-selected={p.id === selectedId} onClick={() => setSelectedId(p.id)}>
                <td>
                  <button type="button" className="link" onClick={() => setSelectedId(p.id)}>
                    {p.name}
                  </button>
                </td>
                <td>
                  {p.client_label ? <ClientBadge label={p.client_label} /> : <span className="muted">—</span>}
                </td>
                <td>
                  {p.running_pid ? <span className="ok">Open</span> : <span className="muted">Closed</span>}
                </td>
                <td className="actions">
                  <button
                    type="button"
                    className="pb-button"
                    disabled={!!p.running_pid}
                    onClick={() => void launch(p)}
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
            {profiles.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  No profiles match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </main>

      {selected && <DetailDrawer profile={selected} onClose={() => setSelectedId(null)} onOpen={launch} />}
      {creating && (
        <CreateDialog
          onCancel={() => setCreating(false)}
          onCreated={async (p) => {
            setCreating(false);
            await refresh(query);
            setSelectedId(p.id);
          }}
        />
      )}
    </div>
  );
}

function DetailDrawer(props: {
  profile: LocalProfile;
  onClose: () => void;
  onOpen: (p: LocalProfile) => void;
}) {
  const { profile: p } = props;
  return (
    <aside className="drawer" aria-label={`Details for ${p.name}`}>
      <header>
        <h2>{p.name}</h2>
        <button type="button" className="pb-button" onClick={props.onClose} aria-label="Close details">
          ×
        </button>
      </header>
      <dl>
        <dt>Client</dt>
        <dd>{p.client_label ? <ClientBadge label={p.client_label} /> : 'None'}</dd>
        <dt>Status</dt>
        <dd>{p.running_pid ? 'Open on this device' : 'Closed'}</dd>
        <dt>Created</dt>
        <dd>{new Date(p.created_at).toLocaleString()}</dd>
        <dt>Storage</dt>
        <dd>Separate cookies, site storage and cache on this device.</dd>
      </dl>
      <p className="muted small">
        Separate profiles keep stored website data apart. They do not make profiles look like different
        devices or networks to websites.
      </p>
      <button
        type="button"
        className="pb-button"
        data-variant="primary"
        disabled={!!p.running_pid}
        onClick={() => props.onOpen(p)}
      >
        Open profile
      </button>
    </aside>
  );
}

function CreateDialog(props: { onCancel: () => void; onCreated: (p: LocalProfile) => void }) {
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // Move focus into the dialog when it opens (keyboard and screen-reader users land on the first field).
  useEffect(() => nameRef.current?.focus(), []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      props.onCreated(await api.createLocalProfile(name, client));
    } catch (err) {
      setError(isIpcError(err) ? err.message : 'Could not create the profile.');
    }
  };
  return (
    <div className="scrim">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
        onSubmit={submit}
      >
        <h2 id="create-title">New profile</h2>
        <label>
          Name
          <input
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            ref={nameRef}
          />
        </label>
        <label>
          Client (optional)
          <input maxLength={120} value={client} onChange={(e) => setClient(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog__actions">
          <button type="button" className="pb-button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary">
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
