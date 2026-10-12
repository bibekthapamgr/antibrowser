import { ClientBadge } from '@pb/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type {
  AppView,
  Backend,
  Permission,
  ProfileStatus,
  ProfileView,
  RuntimeStatus,
  SettingValue,
} from './backend/types.ts';
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
    const action = primaryAction(p);
    try {
      if (action === 'open') {
        await backend.profiles.launch(p.id);
        notify(`Opening ${p.name}…`);
      } else if (action === 'close') {
        await backend.profiles.stop(p.id);
        notify(`Closing ${p.name}…`);
      } else if (action === 'force') {
        await backend.profiles.stop(p.id, true);
        notify(`Force closing ${p.name}…`);
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
                      <ClientBadge label={p.client_label} colour={p.client_colour} />
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
                      data-variant={primaryAction(p) === 'force' ? 'danger' : undefined}
                      disabled={primaryAction(p) === 'wait'}
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggle(p);
                      }}
                    >
                      {ACTION_LABEL[primaryAction(p)]}
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
          refreshKey={props.refreshKey}
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

type Action = 'open' | 'close' | 'force' | 'wait';
const ACTION_LABEL: Record<Action, string> = {
  open: 'Open',
  close: 'Close',
  force: 'Force close',
  wait: 'Wait…',
};

function primaryAction(p: ProfileView): Action {
  switch (p.state) {
    case 'stopped':
    case 'crashed':
      return 'open';
    case 'starting':
    case 'running':
      return 'close';
    case 'stopping':
      return p.force_available ? 'force' : 'wait';
    default:
      return 'wait';
  }
}

/** Plain-language text for the machine codes stored in `last_error` (never shown raw). */
export const LAST_ERROR: Record<string, string> = {
  CRASHED: 'The browser closed unexpectedly.',
  EXITED_EARLY: 'The browser closed right after starting.',
  START_INTERRUPTED: 'The last start was interrupted because the manager closed. Open it again.',
  CRASHED_WHILE_MANAGER_CLOSED: 'The browser closed unexpectedly while the manager was closed.',
  RECOVERY_INTERRUPTED: 'A recovery was interrupted. Run it again.',
  PROFILE_DATA_UNREADABLE: 'This profile’s browser data looks damaged.',
  SLOW_START: 'The browser took unusually long to start.',
  LOW_DISK_SPACE: 'There was not enough free disk space.',
  BACKUP_FAILED: 'A safety copy could not be made.',
  SPAWN_FAILED: 'The browser program could not be started.',
  NO_BACKUP: 'There is no backup to restore.',
  BACKUP_IO_ERROR: 'The backup could not be read or written.',
};

function StatusText({ p }: { p: ProfileView }) {
  switch (p.state) {
    case 'stopped':
      return <span className="muted">Closed</span>;
    case 'starting':
      return <span className="warn">Opening…</span>;
    case 'stopping':
      return <span className="warn">{p.force_available ? 'Not responding' : 'Closing…'}</span>;
    case 'crashed':
      return <span className="error">Closed unexpectedly</span>;
    case 'recovering':
      return <span className="warn">Recovering…</span>;
    default:
      return (
        <span className="ok" title={p.adopted ? 'Opened before the manager restarted' : undefined}>
          {p.window_open ? 'Open' : 'Running (no window)'}
          {p.adopted ? ' · kept open while the manager was closed' : ''}
        </span>
      );
  }
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

const PERMISSIONS: [keyof ProfileView['permissions'], string][] = [
  ['camera', 'Camera'],
  ['microphone', 'Microphone'],
  ['location', 'Location'],
];
const PERMISSION_LABEL: Record<Permission, string> = {
  ask: 'Ask each time',
  block: 'Block',
  allow: 'Allow',
};

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function ProfileSettings(props: {
  backend: Backend;
  profile: ProfileView;
  refreshKey: number;
  notify: Notify;
  onToggle: (p: ProfileView) => void;
  onSaved: (p: ProfileView) => void;
  onClose: () => void;
}) {
  const { backend, notify } = props;
  const [status, setStatus] = useState<ProfileStatus | null>(null);
  const p = status?.profile ?? props.profile;
  const [name, setName] = useState(p.name);
  const [client, setClient] = useState(p.client_label ?? '');
  const [colour, setColour] = useState<string | null>(p.client_colour);
  const [urls, setUrls] = useState(p.start_urls.join('\n'));
  const [perms, setPerms] = useState(p.permissions);
  const [notes, setNotes] = useState(p.notes);
  const [error, setError] = useState<string | null>(null);
  const [confirmFresh, setConfirmFresh] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads status on profile events
  useEffect(() => {
    let live = true;
    backend.profiles
      .status(props.profile.id)
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [backend, props.profile.id, props.refreshKey]);

  const reload = async () => {
    const s = await backend.profiles.status(p.id);
    setStatus(s);
    props.onSaved(s.profile);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const startUrls = urls
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);
    try {
      const saved = await backend.profiles.update(p.id, {
        expectedVersion: p.version,
        ...(name !== p.name ? { name } : {}),
        ...(client.trim() === '' && p.client_label ? { clearClientLabel: true } : {}),
        ...(client.trim() !== '' && client !== p.client_label ? { clientLabel: client } : {}),
        ...(colour === null && p.client_colour ? { clearClientColour: true } : {}),
        ...(colour !== null && colour !== p.client_colour ? { clientColour: colour } : {}),
        ...(startUrls.join('\n') !== p.start_urls.join('\n') ? { startUrls } : {}),
        ...(perms.camera !== p.permissions.camera ? { camera: perms.camera } : {}),
        ...(perms.microphone !== p.permissions.microphone ? { microphone: perms.microphone } : {}),
        ...(perms.location !== p.permissions.location ? { location: perms.location } : {}),
        ...(notes !== p.notes ? { notes } : {}),
      });
      props.onSaved(saved);
      setStatus((s) => (s ? { ...s, profile: saved } : s));
      notify(
        p.state === 'stopped' || p.state === 'crashed'
          ? 'Profile settings saved.'
          : 'Profile settings saved. They apply the next time the profile opens.',
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const recover = async (action: 'reopen' | 'restore_backup' | 'start_fresh' | 'backup_now') => {
    try {
      await backend.profiles.recover(p.id, action);
      notify(
        {
          reopen: `Opening ${p.name}…`,
          restore_backup: 'Restoring the last good copy…',
          start_fresh: 'Starting with empty browser data…',
          backup_now: 'Making a backup…',
        }[action],
      );
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  const chooseDownloads = async () => {
    try {
      const r = await backend.profiles.selectDownloadDirectory(p.id);
      if (r.path) {
        await reload();
        notify('Download folder saved.');
      }
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  const useDefaultDownloads = async () => {
    try {
      const saved = await backend.profiles.update(p.id, {
        expectedVersion: p.version,
        clearDownloadDir: true,
      });
      props.onSaved(saved);
      setStatus((s) => (s ? { ...s, profile: saved } : s));
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  const action = primaryAction(p);
  const closed = p.state === 'stopped' || p.state === 'crashed';
  const backup = status?.backup ?? null;
  const problem = p.last_error ? (LAST_ERROR[p.last_error] ?? 'Something went wrong last time.') : null;

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
        <dt>Browser</dt>
        <dd>{p.runtime_version ?? 'Not opened yet'}</dd>
        <dt>Last opened</dt>
        <dd>{when(p.last_started_at)}</dd>
        <dt>Last closed normally</dt>
        <dd>{when(p.last_clean_shutdown_at)}</dd>
        <dt>Backup</dt>
        <dd>{backup ? new Date(backup.created_at_unix * 1000).toLocaleString() : 'None yet'}</dd>
      </dl>
      {problem && (
        <p className="warn" role="status">
          {problem}
          {p.crash_count > 1 ? ` (${p.crash_count} times in a row)` : ''}
        </p>
      )}
      <button
        type="button"
        className="pb-button"
        data-variant={action === 'open' ? 'primary' : action === 'force' ? 'danger' : undefined}
        disabled={action === 'wait'}
        onClick={() => props.onToggle(p)}
      >
        {{ open: 'Open profile', close: 'Close profile', force: 'Force close', wait: 'Please wait…' }[action]}
      </button>
      {action === 'force' && (
        <p className="muted small">
          The browser did not close when asked. Force closing ends it immediately; pages may lose unsaved
          work.
        </p>
      )}

      {closed && (
        <fieldset>
          <legend>Recover</legend>
          {p.state === 'crashed' && (
            <p className="small">
              {status?.suggested_recovery === 'restore_backup'
                ? 'This profile keeps closing unexpectedly. Restoring the last good copy is recommended.'
                : status?.suggested_recovery === 'start_fresh'
                  ? 'There is no backup. You can start this profile with empty browser data.'
                  : 'You can open it again. If it keeps failing, restore the last good copy.'}
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="pb-button"
              disabled={!backup}
              onClick={() => recover('restore_backup')}
            >
              Restore last good copy
            </button>
            <button type="button" className="pb-button" onClick={() => setConfirmFresh(true)}>
              Start with empty data…
            </button>
            <button type="button" className="pb-button" onClick={() => recover('backup_now')}>
              Back up now
            </button>
          </div>
          <p className="muted small">
            Recovery never deletes the current data: it is moved aside first. Sign-ins may need to be
            repeated.
          </p>
        </fieldset>
      )}

      <form className="stack" onSubmit={save} aria-label="Edit profile">
        <label>
          Name
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Client
          <input maxLength={120} value={client} onChange={(e) => setClient(e.target.value)} />
        </label>
        <div className="row">
          <label className="choice">
            <input
              type="color"
              aria-label="Client colour"
              value={colour ?? '#7c3aed'}
              onChange={(e) => setColour(e.target.value.toLowerCase())}
            />
            Client colour {colour ? '' : '(automatic)'}
          </label>
          {colour && (
            <button type="button" className="pb-button" onClick={() => setColour(null)}>
              Use automatic colour
            </button>
          )}
        </div>
        <label>
          Start pages (one address per line, up to 10)
          <textarea
            rows={3}
            value={urls}
            placeholder="https://"
            spellCheck={false}
            onChange={(e) => setUrls(e.target.value)}
          />
        </label>
        <fieldset>
          <legend>Website permissions</legend>
          {PERMISSIONS.map(([key, label]) => (
            <label key={key}>
              {label}
              <select
                value={perms[key]}
                onChange={(e) => setPerms({ ...perms, [key]: e.target.value as Permission })}
              >
                {(Object.keys(PERMISSION_LABEL) as Permission[]).map((v) => (
                  <option key={v} value={v}>
                    {PERMISSION_LABEL[v]}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </fieldset>
        <label>
          Notes
          <textarea maxLength={2000} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
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

      <fieldset>
        <legend>Downloads</legend>
        <p className="mono small">{p.download_dir ?? 'Same as the app setting'}</p>
        <div className="row">
          <button type="button" className="pb-button" onClick={chooseDownloads}>
            Choose folder…
          </button>
          {p.download_dir && (
            <button type="button" className="pb-button" onClick={useDefaultDownloads}>
              Use app setting
            </button>
          )}
        </div>
      </fieldset>

      <p className="muted small">
        Separate profiles keep stored website data apart. They do not make profiles look like different
        devices or networks to websites.
      </p>
      {confirmFresh && (
        <Dialog
          role="alertdialog"
          title="Start with empty browser data?"
          description="The current browser data is moved aside (not deleted) and the profile opens like new. You will need to sign in to websites again."
          onClose={() => setConfirmFresh(false)}
          initialFocus="[data-cancel]"
        >
          <div className="row row--end">
            <button type="button" className="pb-button" data-cancel onClick={() => setConfirmFresh(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="danger"
              onClick={() => {
                setConfirmFresh(false);
                void recover('start_fresh');
              }}
            >
              Start with empty data
            </button>
          </div>
        </Dialog>
      )}
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

  const install = async (version: string) => {
    try {
      await backend.system.installRuntime(version);
      notify('Downloading the browser…');
      setStatus(await backend.system.runtimeStatus());
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

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
        <RuntimeSummary status={status} onInstall={install} />
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
  install_runtime: 'Installing the browser',
  recover_profile: 'Recovering a profile',
  backup_profile: 'Backing up a profile',
};

function RuntimeSummary({
  status,
  onInstall,
}: {
  status: RuntimeStatus;
  onInstall: (version: string) => void;
}) {
  const b = status.browser;
  const m = b.manifest;
  const installOp = status.operations.find((o) => o.kind === 'install_runtime' && o.status === 'running');
  return (
    <>
      {b.configured ? (
        <p>
          <span className="ok">Ready</span> —{' '}
          {b.source === 'development_override' ? 'developer browser' : m?.distribution} {b.version ?? ''}
        </p>
      ) : b.manifest_status.status !== 'verified' ? (
        <p>
          <span className="warn">No approved browser in this build.</span>{' '}
          {b.manifest_status.status === 'invalid'
            ? 'The browser list failed its signature check, so nothing will be downloaded.'
            : 'This development build was made before a signed browser list existed.'}
        </p>
      ) : m && !m.platform_supported ? (
        <p>
          <span className="warn">Not available for this computer.</span> This build has no browser for this
          system.
        </p>
      ) : (
        <div className="stack">
          <p>
            <span className="warn">Not installed yet.</span> Profiles open once the browser is installed.
          </p>
          {installOp || b.installing ? (
            <progress aria-label="Installing the browser" value={installOp?.progress ?? undefined} max={1} />
          ) : (
            m && (
              <button
                type="button"
                className="pb-button"
                data-variant="primary"
                onClick={() => onInstall(m.version)}
              >
                Install browser {m.version}
                {m.size_bytes ? ` (${formatBytes(m.size_bytes)} download)` : ''}
              </button>
            )
          )}
        </div>
      )}
      {m && (
        <p className="muted small">
          {m.distribution} {m.version}, {m.channel}. The download is checked against a signed list before it
          is used.
          {m.customer_distribution ? '' : ' Internal testing build: not for customers.'}
        </p>
      )}
    </>
  );
}

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
  /** Profiles that did not close when asked (shown after "Close all and quit" timed out). */
  unresponsive: number;
  onClose: () => void;
  notify: Notify;
}) {
  type Choice = 'cancel' | 'leave_running' | 'close_all' | 'force_close_all';
  const choose = async (choice: Choice) => {
    try {
      await props.backend.system.resolveQuit(choice);
      if (choice === 'close_all') props.notify('Closing all profiles, then quitting…');
      if (choice === 'force_close_all') props.notify('Force closing the remaining profiles, then quitting…');
    } catch (e) {
      props.notify(errorMessage(e), 'error');
    }
    props.onClose();
  };
  const n = props.running;
  const stuck = props.unresponsive;
  return (
    <Dialog
      role="alertdialog"
      title={
        stuck > 0
          ? `${stuck} profile${stuck === 1 ? ' is' : 's are'} not responding`
          : `${n} profile${n === 1 ? ' is' : 's are'} still open`
      }
      description={
        stuck > 0
          ? 'They did not close when asked. Force closing ends them immediately; pages may lose unsaved work.'
          : 'Quitting the manager does not have to close your profiles. Open profiles are picked up again the next time you start the manager.'
      }
      onClose={() => choose('cancel')}
      initialFocus="[data-cancel]"
    >
      <div className="stack">
        {stuck > 0 ? (
          <button
            type="button"
            className="pb-button"
            data-variant="danger"
            onClick={() => choose('force_close_all')}
          >
            Force close and quit
          </button>
        ) : (
          <button
            type="button"
            className="pb-button"
            data-variant="primary"
            onClick={() => choose('close_all')}
          >
            Close all profiles and quit
          </button>
        )}
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
