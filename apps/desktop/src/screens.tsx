import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { AppView, Backend, RuntimeStatus, SettingValue } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { Dialog, formatBytes } from './components.tsx';
import { DiagnosticsExport } from './diagnostics.tsx';
import { ImportHistory } from './importer.tsx';
import { LibraryManager } from './library.tsx';
import type { Notify } from './status.tsx';

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

// ------------------------------------------------------------------------------------------------ settings

function setting(app: AppView, key: string): SettingValue | undefined {
  return app.settings.find((s) => s.key === key);
}

export function SettingsScreen(props: {
  backend: Backend;
  app: AppView;
  refreshKey: number;
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
  const retention = String(setting(app, 'profiles.trash_retention_days')?.value ?? '30');
  const localProxies = setting(app, 'proxies.allow_private_addresses')?.value === true;
  const perClient = setting(app, 'downloads.per_client_folders')?.value === true;
  const reminder = String(setting(app, 'profiles.open_reminder_hours')?.value ?? 'off');
  const memoryWarning = setting(app, 'resources.memory_warning')?.value !== false;

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
        <label className="choice">
          <input
            type="checkbox"
            checked={perClient}
            onChange={(e) => update('downloads.per_client_folders', e.target.checked)}
          />
          Give each client its own folder inside it
        </label>
        <p className="muted small">
          The folder is named after the client (characters a folder name cannot have are replaced). A client
          can also have a folder of its own (Profiles → choose the client → Client overview), and a profile
          one of its own. Changes apply the next time a profile opens; nothing already downloaded is moved.
        </p>
      </fieldset>

      <fieldset>
        <legend>Open profiles</legend>
        <label>
          Remind me when a profile has been open for
          <select value={reminder} onChange={(e) => update('profiles.open_reminder_hours', e.target.value)}>
            <option value="off">Never</option>
            {['4', '8', '12', '24'].map((h) => (
              <option key={h} value={h}>
                {h} hours
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          A reminder only: profiles are never closed for you, because the app cannot see unsaved work in a
          page.
        </p>
        <label className="choice">
          <input
            type="checkbox"
            checked={memoryWarning}
            onChange={(e) => update('resources.memory_warning', e.target.checked)}
          />
          Warn before opening profiles when free memory looks too low
        </label>
        <p className="muted small">
          Based on what profiles used on this computer (Health → Resources), not on any one website.
        </p>
      </fieldset>

      <fieldset>
        <legend>Trash</legend>
        <label>
          Delete profiles in the trash permanently after
          <select value={retention} onChange={(e) => update('profiles.trash_retention_days', e.target.value)}>
            {['7', '30', '90'].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Applies to profiles moved to the trash from now on. Permanent deletion removes a profile’s sign-ins
          and site data from this device; open profiles are never deleted.
        </p>
      </fieldset>

      <fieldset>
        <legend>Proxies</legend>
        <label className="choice">
          <input
            type="checkbox"
            checked={localProxies}
            onChange={(e) => update('proxies.allow_private_addresses', e.target.checked)}
          />
          Allow proxies on this computer or my local network
        </label>
        <p className="muted small">
          Off by default. Turn it on to use a proxy running on this computer (127.0.0.1) or another device on
          your network. Link-local and cloud metadata addresses (such as 169.254.169.254) are never allowed.
        </p>
      </fieldset>

      <h2 className="section-title">Clients, tags and templates</h2>
      <LibraryManager backend={backend} notify={notify} refreshKey={props.refreshKey} />

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
        <h2>Profile imports</h2>
        <ImportHistory backend={backend} refreshKey={props.refreshKey} notify={notify} />
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
  import_profiles: 'Importing profiles',
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
    <section className="stack" aria-labelledby="diag-title">
      <header className="row">
        <h2 id="diag-title" className="grow">
          This computer
        </h2>
        <DiagnosticsExport backend={backend} notify={notify} />
      </header>
      <p className="muted small">
        Manager figures exclude the browser; browser figures are shown separately. The saved report includes
        versions, operation ids and summarized errors, with personal details and secrets removed; you see it
        before it is saved.
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
          <DiagnosticsExport
            backend={props.backend}
            notify={props.notify}
            label="Save a diagnostics report…"
          />
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
          : 'Quitting the manager does not have to close your profiles. Open profiles are picked up again the next time you start the manager. Profiles that use a proxy have no connection while the manager is closed (nothing is sent without the proxy).'
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
