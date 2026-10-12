import { ClientBadge } from '@pb/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { AppView, Backend, ProfileView, RuntimeStatus, SettingValue } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { Cell, Dialog, formatBytes, useDebounced, useElementHeight, VirtualList } from './components.tsx';

type Notify = (text: string, tone?: 'info' | 'error') => void;
const HELP_URL = 'https://github.com/bibekthapamgr/antibrowser';

// ------------------------------------------------------------------------------------------------ welcome

export function Welcome({
  backend,
  onDone,
  notify,
}: {
  backend: Backend;
  onDone: () => void;
  notify: Notify;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('My workspace');
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  useEffect(() => {
    if (creating) nameRef.current?.focus();
  }, [creating]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await backend.workspaces.createWorkspace(name);
      notify(`Workspace “${name.trim()}” created.`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <main className="welcome" id="main">
      <div className="welcome__card">
        <h1 ref={headingRef} tabIndex={-1}>
          Welcome to Project Browser
        </h1>
        <p>
          Keep the browser sessions for each client account in separate profiles. Each profile has its own
          cookies, site storage and cache on this device.
        </p>
        <p className="muted small">
          Separate profiles keep stored website data apart. They do not make profiles look like different
          devices or networks to websites.
        </p>
        {!creating ? (
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            onClick={() => setCreating(true)}
          >
            Create a local workspace
          </button>
        ) : (
          <form className="stack" onSubmit={submit} aria-label="Create workspace">
            <label>
              Workspace name
              <input
                ref={nameRef}
                value={name}
                maxLength={80}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="row">
              <button type="submit" className="pb-button" data-variant="primary">
                Create workspace
              </button>
              <button type="button" className="pb-button" onClick={() => setCreating(false)}>
                Back
              </button>
            </div>
          </form>
        )}
        <p className="muted small">
          A local workspace lives only on this device. Team workspaces arrive later.
        </p>
      </div>
    </main>
  );
}

// ------------------------------------------------------------------------------------------------ profiles

const ROW_HEIGHT = 52;

export function ProfilesScreen(props: {
  backend: Backend;
  refreshKey: number;
  notify: Notify;
  runningCount: number;
}) {
  const { backend, notify } = props;
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 150);
  const [profiles, setProfiles] = useState<ProfileView[] | null>(null);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<ProfileView | null>(null);
  const [creating, setCreating] = useState(false);
  const [listRef, listHeight] = useElementHeight<HTMLDivElement>(420);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-runs the query on profile events
  useEffect(() => {
    let live = true;
    backend.profiles
      .list(debounced)
      .then((rows) => {
        if (!live) return;
        setProfiles(rows);
        setActive((i) => Math.min(i, Math.max(0, rows.length - 1)));
        setSelected((s) => (s ? (rows.find((r) => r.id === s.id) ?? s) : s));
      })
      .catch((e) => notify(errorMessage(e, 'Could not load profiles.'), 'error'));
    return () => {
      live = false;
    };
  }, [backend, debounced, props.refreshKey, notify]);

  const toggle = async (p: ProfileView) => {
    try {
      if (p.status === 'closed') {
        await backend.profiles.launch(p.id);
        notify(`Opening ${p.name}…`);
      } else {
        await backend.profiles.stop(p.id);
        notify(`Closing ${p.name}…`);
      }
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  const empty = profiles !== null && profiles.length === 0 && !query;
  return (
    <section className="screen" aria-labelledby="profiles-title">
      <header className="toolbar">
        <h1 id="profiles-title">Profiles</h1>
        <label className="search">
          <span className="pb-sr-only">Search profiles</span>
          <input
            type="search"
            placeholder="Search name or client"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {props.runningCount > 0 && (
          <button
            type="button"
            className="pb-button"
            onClick={() => backend.profiles.closeAll().catch((e) => notify(errorMessage(e), 'error'))}
          >
            Close all ({props.runningCount})
          </button>
        )}
        <button type="button" className="pb-button" data-variant="primary" onClick={() => setCreating(true)}>
          New profile
        </button>
      </header>

      {profiles === null ? (
        <p role="status">Loading profiles…</p>
      ) : empty ? (
        <div className="empty-state">
          <h2>No profiles yet</h2>
          <p className="muted">
            Create a profile for each account you manage. Each one keeps its own sign-ins.
          </p>
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            onClick={() => setCreating(true)}
          >
            Create your first profile
          </button>
        </div>
      ) : (
        <div className="table" ref={listRef}>
          <div className="table__head" aria-hidden="true">
            <span>Name</span>
            <span>Client</span>
            <span>Status</span>
            <span />
          </div>
          {profiles.length === 0 ? (
            <p className="empty">No profiles match “{query}”.</p>
          ) : (
            <VirtualList
              items={profiles}
              rowHeight={ROW_HEIGHT}
              height={Math.max(160, listHeight - 40)}
              label={`Profiles, ${profiles.length} shown. Use arrow keys to move, Enter for profile settings.`}
              getKey={(p) => p.id}
              activeIndex={active}
              onActiveIndexChange={setActive}
              onActivate={(p) => setSelected(p)}
              renderRow={(p, i, isActive) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users press Enter on the grid (VirtualList)
                // biome-ignore lint/a11y/noStaticElementInteractions: mouse convenience; the keyboard path is the grid itself
                <div
                  className={`trow${isActive ? ' trow--active' : ''}`}
                  onClick={() => {
                    setActive(i);
                    setSelected(p);
                  }}
                >
                  <Cell className="trow__name">{p.name}</Cell>
                  <Cell>
                    {p.client_label ? (
                      <ClientBadge label={p.client_label} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </Cell>
                  <Cell>
                    <StatusText p={p} />
                  </Cell>
                  <Cell className="trow__actions">
                    <button
                      type="button"
                      tabIndex={-1}
                      className="pb-button"
                      disabled={p.status === 'stopping'}
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggle(p);
                      }}
                    >
                      {p.status === 'closed' ? 'Open' : 'Close'}
                      <span className="pb-sr-only"> {p.name}</span>
                    </button>
                  </Cell>
                </div>
              )}
            />
          )}
        </div>
      )}

      {selected && (
        <ProfileSettings
          key={selected.id}
          backend={backend}
          profile={selected}
          notify={notify}
          onToggle={toggle}
          onSaved={(p) => {
            setSelected(p);
            setProfiles((rows) => rows?.map((r) => (r.id === p.id ? p : r)) ?? rows);
          }}
          onClose={() => setSelected(null)}
        />
      )}
      {creating && (
        <CreateProfileDialog
          backend={backend}
          onCancel={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            setProfiles((rows) => [...(rows ?? []), p].sort((a, b) => a.name.localeCompare(b.name)));
            notify(`Profile “${p.name}” created.`);
          }}
        />
      )}
    </section>
  );
}

function StatusText({ p }: { p: ProfileView }) {
  if (p.status === 'closed') return <span className="muted">Closed</span>;
  if (p.status === 'stopping') return <span className="warn">Closing…</span>;
  return (
    <span className="ok" title={p.adopted ? 'Opened before the manager restarted' : undefined}>
      Open{p.adopted ? ' · kept open while the manager was closed' : ''}
    </span>
  );
}

function CreateProfileDialog(props: {
  backend: Backend;
  onCancel: () => void;
  onCreated: (p: ProfileView) => void;
}) {
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      props.onCreated(await props.backend.profiles.create(name, client || undefined));
    } catch (err) {
      setError(errorMessage(err, 'Could not create the profile.'));
    }
  };
  return (
    <Dialog title="New profile" onClose={props.onCancel} initialFocus="input">
      <form className="stack" onSubmit={submit}>
        <label>
          Name
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
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
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="primary">
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ProfileSettings(props: {
  backend: Backend;
  profile: ProfileView;
  notify: Notify;
  onToggle: (p: ProfileView) => void;
  onSaved: (p: ProfileView) => void;
  onClose: () => void;
}) {
  const { profile: p } = props;
  const [name, setName] = useState(p.name);
  const [client, setClient] = useState(p.client_label ?? '');
  const [notes, setNotes] = useState(p.notes);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const saved = await props.backend.profiles.update(p.id, {
        expectedVersion: p.version,
        ...(name !== p.name ? { name } : {}),
        ...(client.trim() === '' && p.client_label ? { clearClientLabel: true } : {}),
        ...(client.trim() !== '' && client !== p.client_label ? { clientLabel: client } : {}),
        ...(notes !== p.notes ? { notes } : {}),
      });
      props.onSaved(saved);
      props.notify('Profile settings saved.');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <aside
      className="drawer"
      aria-labelledby="profile-settings-title"
      onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
    >
      <header>
        <h2 id="profile-settings-title" ref={headingRef} tabIndex={-1}>
          Profile settings
        </h2>
        <button
          type="button"
          className="pb-button"
          onClick={props.onClose}
          aria-label="Close profile settings"
        >
          ×
        </button>
      </header>
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          <StatusText p={p} />
        </dd>
        <dt>Storage</dt>
        <dd>Separate cookies, site storage and cache on this device.</dd>
      </dl>
      <button
        type="button"
        className="pb-button"
        data-variant={p.status === 'closed' ? 'primary' : undefined}
        disabled={p.status === 'stopping'}
        onClick={() => props.onToggle(p)}
      >
        {p.status === 'closed' ? 'Open profile' : 'Close profile'}
      </button>
      <form className="stack" onSubmit={save} aria-label="Edit profile">
        <label>
          Name
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Client
          <input maxLength={120} value={client} onChange={(e) => setClient(e.target.value)} />
        </label>
        <label>
          Notes
          <textarea maxLength={2000} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" className="pb-button" data-variant="primary">
          Save changes
        </button>
      </form>
      <p className="muted small">
        Separate profiles keep stored website data apart. They do not make profiles look like different
        devices or networks to websites.
      </p>
    </aside>
  );
}

// ------------------------------------------------------------------------------------------------ settings

function setting(app: AppView, key: string): SettingValue | undefined {
  return app.settings.find((s) => s.key === key);
}

export function SettingsScreen(props: {
  backend: Backend;
  app: AppView;
  onChanged: () => void;
  notify: Notify;
}) {
  const { backend, app, notify } = props;
  const [confirming, setConfirming] = useState(false);

  const update = async (key: string, value: unknown) => {
    try {
      await backend.system.updateSetting(key, value, setting(app, key)?.version);
      props.onChanged();
    } catch (e) {
      notify(errorMessage(e), 'error');
      props.onChanged();
    }
  };
  const theme = String(setting(app, 'appearance.theme')?.value ?? 'system');
  const close = String(setting(app, 'manager.close_behavior')?.value ?? 'ask');
  const crash = setting(app, 'privacy.crash_reports')?.value === true;
  const downloads = setting(app, 'downloads.directory')?.value as string | null | undefined;

  return (
    <section className="screen settings" aria-labelledby="settings-title">
      <h1 id="settings-title">Settings</h1>

      <fieldset>
        <legend>Appearance</legend>
        {(['system', 'light', 'dark'] as const).map((v) => (
          <label key={v} className="choice">
            <input
              type="radio"
              name="theme"
              checked={theme === v}
              onChange={() => update('appearance.theme', v)}
            />
            {v === 'system' ? 'Match system' : v === 'light' ? 'Light' : 'Dark'}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>When quitting with profiles open</legend>
        {(
          [
            ['ask', 'Ask me each time'],
            ['keep_running', 'Leave profiles open and quit the manager'],
            ['close_all', 'Close all profiles, then quit'],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="choice">
            <input
              type="radio"
              name="close"
              checked={close === v}
              onChange={() => update('manager.close_behavior', v)}
            />
            {label}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Downloads</legend>
        <p className="muted small">Where files downloaded in profiles will be saved.</p>
        <p>
          <span className="mono">{downloads ?? 'Not chosen yet'}</span>
        </p>
        <button
          type="button"
          className="pb-button"
          onClick={async () => {
            try {
              const r = await backend.system.selectDownloadDirectory();
              if (r.path) notify('Download folder updated.');
              props.onChanged();
            } catch (e) {
              notify(errorMessage(e), 'error');
            }
          }}
        >
          Choose folder…
        </button>
      </fieldset>

      <fieldset>
        <legend>Privacy</legend>
        <label className="choice">
          <input
            type="checkbox"
            checked={crash}
            onChange={(e) => update('privacy.crash_reports', e.target.checked)}
          />
          Allow sending crash reports
        </label>
        <p className="muted small">
          Off by default. Crash reports are saved on this device with personal details removed. Nothing is
          sent unless you turn this on, and no sending service exists yet.
        </p>
        <p className="small">
          Secure storage (system keychain):{' '}
          {app.keychain.available ? (
            <span className="ok">available</span>
          ) : (
            <span className="warn">
              not available — sign-ins will not be remembered on this device (
              {app.keychain.reason ?? 'unknown'})
            </span>
          )}
        </p>
      </fieldset>

      <fieldset>
        <legend>Help</legend>
        <button
          type="button"
          className="pb-button"
          onClick={() => backend.system.openExternal(HELP_URL).catch((e) => notify(errorMessage(e), 'error'))}
        >
          Project documentation (opens your browser)
        </button>
      </fieldset>

      <fieldset className="danger">
        <legend>Remove local data</legend>
        <p className="muted small">
          Deletes every profile, its sign-ins and site data, and all settings on this device. Use this before
          removing the app if you do not want to keep your profiles. This cannot be undone.
        </p>
        <button type="button" className="pb-button" data-variant="danger" onClick={() => setConfirming(true)}>
          Remove all local data…
        </button>
      </fieldset>
      {confirming && (
        <RemoveDataDialog backend={backend} notify={notify} onClose={() => setConfirming(false)} />
      )}
    </section>
  );
}

function RemoveDataDialog(props: { backend: Backend; notify: Notify; onClose: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      role="alertdialog"
      title="Remove all local data?"
      description="Type DELETE to remove every profile and setting on this device. The app restarts afterwards."
      onClose={props.onClose}
      initialFocus="input"
    >
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await props.backend.system.removeLocalData(text);
            props.notify('Local data removed.');
            props.onClose();
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <label>
          Confirmation
          <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="row row--end">
          <button type="button" className="pb-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="pb-button" data-variant="danger" disabled={text !== 'DELETE'}>
            Remove everything
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ downloads

export function DownloadsScreen(props: { backend: Backend; refreshKey: number; notify: Notify }) {
  const { backend, notify } = props;
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-reads status on operation events
  useEffect(() => {
    backend.system
      .runtimeStatus()
      .then(setStatus)
      .catch((e) => notify(errorMessage(e), 'error'));
  }, [backend, props.refreshKey, notify]);
  if (!status) return <p role="status">Loading…</p>;

  const discard = async (id: string) => {
    try {
      await backend.system.recovery('discard_interrupted', id);
      notify('Interrupted download removed.');
      setStatus(await backend.system.runtimeStatus());
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  return (
    <section className="screen" aria-labelledby="downloads-title">
      <h1 id="downloads-title">Downloads and updates</h1>

      <div className="card">
        <h2>Browser runtime</h2>
        {status.browser.configured ? (
          <p>
            <span className="ok">Ready</span> — development build ({status.browser.revision})
          </p>
        ) : (
          <p>
            <span className="warn">Not installed yet.</span> Profiles cannot be opened until a browser runtime
            is installed. Runtime downloads arrive with the next update.
          </p>
        )}
        {status.installations.length > 0 && (
          <table className="simple">
            <caption className="pb-sr-only">Installed runtimes</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Platform</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {status.installations.map((r) => (
                <tr key={`${r.version}-${r.platform}`}>
                  <td>{r.version}</td>
                  <td>{r.platform}</td>
                  <td>
                    {r.status === 'quarantined' ? (
                      <span className="warn">Blocked (failed verification)</span>
                    ) : (
                      r.status
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {status.quarantined > 0 && (
          <p className="warn">
            {status.quarantined} download(s) failed verification and were blocked. They will never be opened.
          </p>
        )}
        {status.interrupted.map((i) => (
          <div key={i.id} className="row">
            <span>
              An install of <span className="mono">{i.id}</span> was interrupted while {i.stage}.
            </span>
            <button type="button" className="pb-button" onClick={() => discard(i.id)}>
              Discard and start over
            </button>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Activity</h2>
        {status.operations.length === 0 ? (
          <p className="muted">Nothing in progress.</p>
        ) : (
          <ul className="ops">
            {status.operations.slice(0, 20).map((o) => (
              <li key={o.operation_id}>
                <span>{OP_LABELS[o.kind]}</span>
                {o.status === 'running' ? (
                  <progress
                    aria-label={`${OP_LABELS[o.kind]} progress`}
                    value={o.progress ?? undefined}
                    max={1}
                  />
                ) : o.status === 'succeeded' ? (
                  <span className="ok">Done</span>
                ) : (
                  <span className="error">{o.message ?? 'Failed'}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>App updates</h2>
        <p className="muted">Internal build. Automatic updates are off. {status.manager_updates.note}</p>
      </div>
    </section>
  );
}

const OP_LABELS: Record<string, string> = {
  launch_profile: 'Opening a profile',
  stop_profile: 'Closing a profile',
  close_all: 'Closing all profiles',
  verify_runtime: 'Checking the browser runtime',
};

// ------------------------------------------------------------------------------------------------ diagnostics

export function DiagnosticsScreen(props: { backend: Backend; notify: Notify }) {
  const { backend, notify } = props;
  const [d, setD] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    backend.system
      .diagnostics()
      .then(setD)
      .catch((e) => notify(errorMessage(e), 'error'));
  }, [backend, notify]);
  if (!d) return <p role="status">Loading diagnostics…</p>;
  const get = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        d,
      );
  const ms = (v: unknown) => {
    const s = v as { last_ms?: number | null; p95_ms?: number | null; count?: number } | null | undefined;
    return s?.count
      ? `${Math.round(s.last_ms ?? 0)} ms last, ${Math.round(s.p95_ms ?? 0)} ms p95 (${s.count} runs)`
      : '—';
  };
  const rows: [string, string][] = [
    ['App version', String(get('app.version') ?? '—')],
    ['System', `${String(get('app.os') ?? '')} (${String(get('app.arch') ?? '')})`],
    [
      'Local database',
      `${String(get('store.status'))}, schema v${String(get('store.schema_version') ?? '?')}, ${String(get('store.journal_mode') ?? '?')}`,
    ],
    ['Database check', get('store.integrity_ok') === true ? 'OK' : String(get('store.integrity_ok') ?? '—')],
    ['Manager start time', ms(get('manager.startup_ms'))],
    ['Database open time', ms(get('manager.store_open_ms'))],
    ['Manager memory', formatBytes(get('manager.rss_bytes'))],
    ['Open profiles', String(get('browsers.running') ?? 0)],
    ['Browser process start (separate from manager)', ms(get('browsers.spawn_ms'))],
    ['Browser memory (main processes)', formatBytes(get('browsers.main_process_rss_bytes'))],
    ['Free disk space', formatBytes(get('disk_free_bytes'))],
    [
      'Secure storage',
      get('keychain.available') === true
        ? 'Available'
        : `Not available (${String(get('keychain.reason') ?? '?')})`,
    ],
    ['Saved crash reports', String(get('crash_reports') ?? 0)],
  ];
  return (
    <section className="screen" aria-labelledby="diag-title">
      <header className="toolbar">
        <h1 id="diag-title">Diagnostics</h1>
        <button
          type="button"
          className="pb-button"
          onClick={async () => {
            try {
              const r = await backend.system.exportDiagnostics();
              if (r.path) notify(`Diagnostics saved to ${r.path}.`);
            } catch (e) {
              notify(errorMessage(e), 'error');
            }
          }}
        >
          Save report…
        </button>
      </header>
      <p className="muted small">
        Manager figures exclude the browser; browser figures are shown separately. The saved report has
        personal details removed.
      </p>
      <table className="simple">
        <caption className="pb-sr-only">Diagnostics</caption>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ recovery

export function DatabaseRecovery(props: {
  backend: Backend;
  app: AppView;
  onRecovered: () => void;
  notify: Notify;
}) {
  const failure = props.app.store.failure;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const act = async (action: 'retry_open' | 'restore_backup') => {
    try {
      await props.backend.system.recovery(action);
      props.notify(action === 'retry_open' ? 'Local data opened.' : 'Backup restored.');
      props.onRecovered();
    } catch (e) {
      props.notify(errorMessage(e), 'error');
    }
  };
  const tooNew = failure?.code === 'DATABASE_TOO_NEW';
  return (
    <main className="welcome" id="main">
      <div className="welcome__card">
        <h1 ref={headingRef} tabIndex={-1}>
          Your local data needs attention
        </h1>
        <p>
          {tooNew
            ? 'This data was saved by a newer version of the app. Install the newer version to open it; nothing has been changed.'
            : 'The app could not finish updating its local data. Your previous data was kept unchanged.'}
        </p>
        <div className="row">
          {!tooNew && (
            <button
              type="button"
              className="pb-button"
              data-variant="primary"
              onClick={() => act('retry_open')}
            >
              Try again
            </button>
          )}
          {failure?.backup_available && (
            <button type="button" className="pb-button" onClick={() => act('restore_backup')}>
              Restore the copy made before the update
            </button>
          )}
          <button
            type="button"
            className="pb-button"
            onClick={() => props.backend.system.exportDiagnostics().catch(() => undefined)}
          >
            Save a diagnostics report…
          </button>
        </div>
        <p className="muted small">Error code: {failure?.code ?? 'unknown'}</p>
      </div>
    </main>
  );
}

export function CrashPrompt(props: {
  backend: Backend;
  app: AppView;
  onDone: () => void;
  onDiagnostics: () => void;
}) {
  const dismiss = async () => {
    await props.backend.system.recovery('dismiss_crash').catch(() => undefined);
    props.onDone();
  };
  const r = props.app.recovery;
  return (
    <Dialog
      title="Project Browser closed unexpectedly last time"
      description="Your profiles and settings were kept. Profiles that were still open have been checked again."
      onClose={dismiss}
    >
      <ul className="small">
        {r.adopted_profiles > 0 && (
          <li>{r.adopted_profiles} profile(s) were still open and are shown as open.</li>
        )}
        {r.cleared_stale_processes > 0 && (
          <li>{r.cleared_stale_processes} profile(s) had closed and were marked closed.</li>
        )}
        {r.interrupted_installs > 0 && (
          <li>An interrupted download can be resumed from Downloads and updates.</li>
        )}
        <li>
          A crash report with personal details removed was saved on this device. It is not sent anywhere.
        </li>
      </ul>
      <div className="row row--end">
        <button
          type="button"
          className="pb-button"
          onClick={async () => {
            await dismiss();
            props.onDiagnostics();
          }}
        >
          View diagnostics
        </button>
        <button type="button" className="pb-button" data-variant="primary" onClick={dismiss}>
          Continue
        </button>
      </div>
    </Dialog>
  );
}

export function QuitPrompt(props: {
  backend: Backend;
  running: number;
  onClose: () => void;
  notify: Notify;
}) {
  const choose = async (choice: 'cancel' | 'leave_running' | 'close_all') => {
    try {
      await props.backend.system.resolveQuit(choice);
      if (choice === 'close_all') props.notify('Closing all profiles, then quitting…');
    } catch (e) {
      props.notify(errorMessage(e), 'error');
    }
    props.onClose();
  };
  const n = props.running;
  return (
    <Dialog
      role="alertdialog"
      title={`${n} profile${n === 1 ? ' is' : 's are'} still open`}
      description="Quitting the manager does not have to close your profiles. Open profiles are picked up again the next time you start the manager."
      onClose={() => choose('cancel')}
      initialFocus="[data-cancel]"
    >
      <div className="stack">
        <button
          type="button"
          className="pb-button"
          data-variant="primary"
          onClick={() => choose('close_all')}
        >
          Close all profiles and quit
        </button>
        <button type="button" className="pb-button" onClick={() => choose('leave_running')}>
          Leave profiles open and quit
        </button>
        <button type="button" className="pb-button" data-cancel onClick={() => choose('cancel')}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
