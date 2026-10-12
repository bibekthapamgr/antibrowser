import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppView, Backend } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { LiveRegion } from './components.tsx';
import {
  CrashPrompt,
  DatabaseRecovery,
  DiagnosticsScreen,
  DownloadsScreen,
  ProfilesScreen,
  QuitPrompt,
  SettingsScreen,
  Welcome,
} from './screens.tsx';

type View = 'profiles' | 'downloads' | 'diagnostics' | 'settings';
const NAV: [View, string][] = [
  ['profiles', 'Profiles'],
  ['downloads', 'Downloads and updates'],
  ['diagnostics', 'Diagnostics'],
  ['settings', 'Settings'],
];

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export function App({ backend }: { backend: Backend }) {
  const [app, setApp] = useState<AppView | null>(null);
  const [view, setView] = useState<View>('profiles');
  const [refreshKey, setRefreshKey] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [quit, setQuit] = useState<{ running: number; unresponsive: number } | null>(null);
  const toastSeq = useRef(0);
  const reported = useRef(false);

  const notify = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setApp(await backend.workspaces.appState());
    } catch (e) {
      notify(errorMessage(e, 'Could not load the app state.'), 'error');
    }
  }, [backend, notify]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Record manager startup time once the first real screen has rendered (kept separate from browser timings).
  useEffect(() => {
    if (app && !reported.current) {
      reported.current = true;
      requestAnimationFrame(() => void backend.system.reportUiReady().catch(() => undefined));
    }
  }, [app, backend]);

  // Theme preference: system (default), light or dark.
  const theme = app?.settings.find((s) => s.key === 'appearance.theme')?.value;
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
  }, [theme]);

  useEffect(() => {
    const offOp = backend.on('operation', (op) => {
      if (op.status === 'running') return;
      setRefreshKey((k) => k + 1);
      if (op.status === 'failed') notify(op.message ?? 'The action failed.', 'error');
      else if (op.kind === 'stop_profile') notify('Profile closed.');
      else if (op.kind === 'launch_profile') notify('Profile opened.');
      else if (op.kind === 'close_all') notify('All profiles closed.');
      else if (op.kind === 'install_runtime') notify('The browser is installed.');
      else if (op.kind === 'recover_profile') notify('Profile recovered.');
      else if (op.kind === 'backup_profile') notify('Backup saved.');
    });
    const offChanged = backend.on('profiles-changed', (p) => {
      setRefreshKey((k) => k + 1);
      setApp((a) => (a ? { ...a, running_count: p.running } : a));
    });
    const offQuit = backend.on('quit-requested', (p) => setQuit(p));
    const offWarning = backend.on('warning', (w) => {
      if (w.code === 'LOW_DISK_SPACE')
        notify('Your disk is almost full. Close profiles soon so their data can be saved safely.', 'error');
    });
    return () => {
      offOp();
      offChanged();
      offQuit();
      offWarning();
    };
  }, [backend, notify]);

  if (!app) {
    return (
      <p role="status" className="loading">
        Loading…
      </p>
    );
  }

  const live = <LiveRegion messages={toasts} />;
  if (app.store.status === 'failed') {
    return (
      <>
        <DatabaseRecovery backend={backend} app={app} onRecovered={refresh} notify={notify} />
        {live}
      </>
    );
  }
  if (app.first_run) {
    return (
      <>
        <Welcome backend={backend} onDone={refresh} notify={notify} />
        {live}
      </>
    );
  }

  return (
    <div className="layout">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace and navigation">
        <label className="workspace">
          <span className="sidebar__label">Workspace</span>
          <select
            value={app.active_workspace_id ?? ''}
            onChange={async (e) => {
              try {
                await backend.workspaces.setActiveWorkspace(e.target.value);
                await refresh();
                setRefreshKey((k) => k + 1);
              } catch (err) {
                notify(errorMessage(err), 'error');
              }
            }}
          >
            {app.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Main">
          <ul>
            {NAV.map(([id, label]) => (
              <li key={id}>
                <button
                  type="button"
                  className="nav-item"
                  aria-current={view === id ? 'page' : undefined}
                  onClick={() => {
                    setView(id);
                    if (id === 'settings') void refresh();
                  }}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidebar__status" role="status">
          {app.running_count === 0
            ? 'No profiles open'
            : `${app.running_count} profile${app.running_count === 1 ? '' : 's'} open`}
          <span className="sidebar__hint">Profiles can stay open when the manager is closed.</span>
        </div>
        <p className="sidebar__note">Internal build {app.app.version} · local profiles only</p>
      </aside>

      <main className="main" id="main" tabIndex={-1}>
        {view === 'profiles' && (
          <ProfilesScreen
            backend={backend}
            refreshKey={refreshKey}
            notify={notify}
            runningCount={app.running_count}
          />
        )}
        {view === 'downloads' && (
          <DownloadsScreen backend={backend} refreshKey={refreshKey} notify={notify} />
        )}
        {view === 'diagnostics' && <DiagnosticsScreen backend={backend} notify={notify} />}
        {view === 'settings' && (
          <SettingsScreen backend={backend} app={app} onChanged={refresh} notify={notify} />
        )}
      </main>

      {app.recovery.previous_session_crashed && (
        <CrashPrompt
          backend={backend}
          app={app}
          onDone={refresh}
          onDiagnostics={() => setView('diagnostics')}
        />
      )}
      {quit !== null && (
        <QuitPrompt
          backend={backend}
          running={quit.running}
          unresponsive={quit.unresponsive}
          notify={notify}
          onClose={() => setQuit(null)}
        />
      )}
      {live}
    </div>
  );
}
