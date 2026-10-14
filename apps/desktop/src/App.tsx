import type { Workspaces } from '@pb/contracts/resources';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountScreen } from './account.tsx';
import type { AccountView, AppView, Backend, Operation } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { get, ROLE_LABEL } from './cloud.ts';
import { HealthScreen, type HealthTab } from './health.tsx';
import { useLauncher } from './launch.tsx';
import { PROXY_ERROR_HELP, ProxiesScreen } from './network.tsx';
import { NoticeCentre, ReconnectBanner, Toasts, useNotifications } from './notices.tsx';
import { OrganizationScreen } from './org.tsx';
import { type Command, CommandPalette, MOD, ShortcutsHelp, useShortcuts } from './palette.tsx';
import { ProfilesScreen } from './profiles.tsx';
import {
  CrashPrompt,
  DatabaseRecovery,
  DownloadsScreen,
  QuitPrompt,
  SettingsScreen,
  Welcome,
} from './screens.tsx';
import { withClient } from './status.tsx';

type View = 'profiles' | 'proxies' | 'downloads' | 'health' | 'account' | 'settings' | 'organization';
const NAV: [View, string][] = [
  ['profiles', 'Profiles'],
  ['proxies', 'Proxies'],
  ['downloads', 'Downloads and updates'],
  ['health', 'Health'],
  ['account', 'Account'],
  ['settings', 'Settings'],
];
type OrgWorkspace = Workspaces['items'][number];

export function App({ backend }: { backend: Backend }) {
  const [app, setApp] = useState<AppView | null>(null);
  const [view, setView] = useState<View>('profiles');
  const [refreshKey, setRefreshKey] = useState(0);
  const { toasts, notices, notify, raise, resolve } = useNotifications();
  const [healthTab, setHealthTab] = useState<HealthTab>('health');
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [showProfile, setShowProfile] = useState<{ id: string; nonce: number } | null>(null);
  const [quit, setQuit] = useState<{ running: number; unresponsive: number } | null>(null);
  const [importOp, setImportOp] = useState<Operation | null>(null);
  const [folderSlot, setFolderSlot] = useState<HTMLElement | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [orgs, setOrgs] = useState<OrgWorkspace[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const reported = useRef(false);
  const launcher = useLauncher(backend, notify);
  const go = useCallback((v: View, tab?: HealthTab) => {
    setView(v);
    if (tab) setHealthTab(tab);
  }, []);
  /** Profile names in notices: "Shop admin (Client North)", or a fallback when it cannot be read. */
  const nameOf = useCallback(
    async (id: string) => {
      try {
        return `“${withClient((await backend.profiles.status(id)).profile)}”`;
      } catch {
        return 'A profile';
      }
    },
    [backend],
  );

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

  /** The account and, when signed in (or showing an ended session), the organizations to switch to. */
  const refreshAccount = useCallback(async () => {
    try {
      const a = await backend.account.get();
      setAccount(a);
      if (a.status === 'signed_out') {
        setOrgs([]);
        return;
      }
      const res = await get<Workspaces>(backend, '/v1/me/workspaces');
      setOrgs(res.data.items);
    } catch {
      setOrgs((o) => o);
    }
  }, [backend]);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  // An organization the person no longer belongs to (left, removed, signed out) closes its screen.
  useEffect(() => {
    if (orgId && account && !orgs.some((o) => o.org_id === orgId)) {
      setOrgId(null);
      setView((v) => (v === 'organization' ? 'profiles' : v));
    }
  }, [orgs, orgId, account]);

  useEffect(
    () =>
      backend.on('account', (e) => {
        void refreshAccount();
        setRefreshKey((k) => k + 1);
        if (e.status === 'failed') notify(e.message ?? 'Sign-in did not complete.', 'error');
        else if (e.status === 'signed_in' && !e.reauth) notify('Signed in.');
        else if (e.status === 'expired')
          notify(
            'Your session ended. Sign in again in Account. Your local profiles are not affected.',
            'error',
          );
      }),
    [backend, notify, refreshAccount],
  );

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
      if (op.kind === 'import_profiles') setImportOp(op.status === 'running' ? op : null);
      if (op.status === 'running') return;
      setRefreshKey((k) => k + 1);
      if (op.status === 'failed') notify(op.message ?? 'The action failed.', 'error');
      else if (op.kind === 'stop_profile') notify('Profile closed.');
      else if (op.kind === 'launch_profile') notify('Profile opened.');
      else if (op.kind === 'close_all') notify('All profiles closed.');
      else if (op.kind === 'install_runtime') notify('The browser is installed.');
      else if (op.kind === 'recover_profile') notify('Profile recovered.');
      else if (op.kind === 'backup_profile') notify('Backup saved.');
      else if (op.kind === 'import_profiles')
        notify('Import finished. Details are in Downloads and updates.');
    });
    const offChanged = backend.on('profiles-changed', (p) => {
      setRefreshKey((k) => k + 1);
      setApp((a) => (a ? { ...a, running_count: p.running } : a));
    });
    // Milestone 08: shared sessions move on in the background; the list and drawer follow, and the person is told
    // about what needs them (a request, a lost connection, a takeover) or is done (handoff ready).
    const offTeam = backend.on('team', (e) => {
      setRefreshKey((k) => k + 1);
      const say = (text: (name: string) => string, tone?: 'error') =>
        void backend.profiles
          .status(e.profile_id)
          .then((s) => notify(text(`“${s.profile.name}”`), tone))
          .catch(() => notify(text('A shared profile'), tone));
      if (e.kind === 'requests') {
        const who = e.requests?.[e.requests.length - 1]?.requested_by_name || 'A teammate';
        say(
          (n) => `${who} asks for ${n}. Close and hand it off when you are ready; nothing closes by itself.`,
        );
      } else if (e.kind === 'handoff_ready') say((n) => `${n} is saved and free for the next person.`);
      else if (e.kind === 'phase' && e.phase === 'lost')
        say(
          (n) =>
            `Connection lost: ${n} was closed so nobody’s work is overwritten. Its backup continues when you are online.`,
          'error',
        );
      else if (e.kind === 'phase' && e.phase === 'taken_over')
        say((n) => `An admin took over ${n}. It was closed here; your copy was kept aside.`, 'error');
      else if (e.kind === 'phase' && e.phase === 'revoked')
        say(
          (n) => `Your access to ${n} was removed. It was closed; the data on this computer was kept.`,
          'error',
        );
      // Milestone 09: what needs the person stays in the notification centre until it is resolved.
      const key = `team:${e.profile_id}`;
      if (
        e.kind === 'phase' &&
        (e.phase === 'lost' || e.phase === 'pending' || e.phase === 'taken_over' || e.phase === 'revoked')
      ) {
        const phase = e.phase;
        void nameOf(e.profile_id).then((n) =>
          raise({
            key,
            tone: 'error',
            text:
              phase === 'lost'
                ? `${n}: the shared session's connection was lost. It reconnects by itself when you are online.`
                : phase === 'pending'
                  ? `${n}: the handoff is waiting for a decision.`
                  : phase === 'taken_over'
                    ? `${n} was taken over by an admin; your copy was kept aside.`
                    : `${n}: your access was removed; the data on this computer was kept.`,
            action: { label: 'Show profiles', run: () => go('profiles') },
          }),
        );
      } else if (
        e.kind === 'reconnected' ||
        e.kind === 'handoff_ready' ||
        (e.kind === 'phase' && (e.phase === 'running' || e.phase === null))
      )
        resolve(key);
    });
    const offSync = backend.on('sync', (e) => {
      const key = `sync:${e.profile_id}`;
      if (e.state === 'failed' || e.state === 'conflict') {
        const conflict = e.state === 'conflict';
        void nameOf(e.profile_id).then((n) =>
          raise({
            key,
            tone: 'error',
            text: conflict
              ? `${n}: a newer backup was made on another computer. Choose which copy to keep in the profile's backups.`
              : `${n}: the ${e.kind === 'restore' ? 'restore' : 'backup'} failed. It is retried; check the profile's backups if it keeps failing.`,
            action: { label: 'Show profiles', run: () => go('profiles') },
          }),
        );
      } else if (e.state === 'committed' || e.state === 'done') resolve(key);
    });
    const offQuit = backend.on('quit-requested', (p) => setQuit(p));
    const offWarning = backend.on('warning', (w) => {
      if (w.code === 'LOW_DISK_SPACE') {
        notify('Your disk is almost full. Close profiles soon so their data can be saved safely.', 'error');
        raise({
          key: 'disk',
          tone: 'error',
          text: 'Your disk is almost full. Close profiles soon so their data can be saved safely; backups are skipped until there is room.',
          action: { label: 'Show health', run: () => go('health', 'health') },
        });
      } else if (w.code === 'EXTENSIONS_DISABLED' || w.code === 'EXTENSIONS_NOT_APPROVED') {
        const names = w.extensions.map((x) => x.name).join(', ');
        const disabled = w.code === 'EXTENSIONS_DISABLED';
        void nameOf(w.profile_id).then((n) => {
          const text = disabled
            ? `${n} opened with extensions turned off: your organization has not approved ${names}.`
            : `${n} has extensions your organization has not approved: ${names}.`;
          notify(text, disabled ? 'error' : 'info');
          raise({
            key: `ext:${w.profile_id}`,
            tone: disabled ? 'error' : 'info',
            text,
            action: { label: 'Show extensions', run: () => go('health', 'extensions') },
          });
        });
      } else if (w.code === 'EXTENSION_PERMISSIONS_ADDED') {
        void nameOf(w.profile_id).then((n) =>
          raise({
            key: `extperm:${w.profile_id}:${w.extension_id}`,
            tone: 'info',
            text: `${n}: an extension update asks for more access (${w.permissions.join(', ')}). Review it.`,
            action: { label: 'Review', run: () => go('health', 'extensions') },
          }),
        );
      } else if (w.code === 'OPEN_REMINDER') {
        void nameOf(w.profile_id).then((n) =>
          raise({
            key: `open:${w.profile_id}`,
            tone: 'info',
            text: `${n} has been open for over ${w.hours} hours. Save your work in its windows first, then close it if you are done; it is never closed for you.`,
            action: {
              label: 'Close it',
              run: async () => {
                try {
                  await backend.profiles.stop(w.profile_id);
                  resolve(`open:${w.profile_id}`);
                } catch (e) {
                  notify(errorMessage(e), 'error');
                }
              },
            },
          }),
        );
      } else if (w.code === 'PROXY_FAILING')
        notify(
          `A profile's proxy stopped working. ${PROXY_ERROR_HELP[w.error] ?? ''} ${
            w.fail_closed ? 'Its traffic is blocked until the proxy works again.' : ''
          }`.trim(),
          'error',
        );
      else if (w.code === 'PROXY_BYPASSED')
        notify(
          "A profile's proxy cannot be reached, so its traffic is going through this computer's own connection (fail-closed is off for it).",
          'error',
        );
      else if (w.code === 'PROXY_CONNECTION_LOST')
        notify("A profile's proxy connection could not be restored. Close and reopen that profile.", 'error');
      else if (w.code === 'PROXY_EXPIRED' || w.code === 'PROXY_EXPIRING') {
        notify(
          w.code === 'PROXY_EXPIRED'
            ? `A proxy's expiry date (${w.expires_at ?? ''}) has passed. Check it with your provider; profiles keep using it until you change it.`
            : `A proxy expires ${w.days_left === 0 ? 'today' : `in ${w.days_left} days`}. Renew it or choose another one; nothing changes automatically.`,
        );
        setRefreshKey((k) => k + 1);
      }
    });
    return () => {
      offOp();
      offChanged();
      offTeam();
      offSync();
      offQuit();
      offWarning();
    };
  }, [backend, notify, raise, resolve, nameOf, go]);

  useShortcuts({
    palette: () => setPalette(true),
    help: () => setShortcuts(true),
    nav: (i) => {
      const target = NAV[i];
      if (target) go(target[0]);
    },
  });

  const commands: Command[] = [
    ...NAV.map(
      ([id, label]): Command => ({
        id: `go-${id}`,
        label: `Go to ${label}`,
        hint: 'Screen',
        run: () => go(id),
      }),
    ),
    {
      id: 'health-ext',
      label: 'Show extensions',
      keywords: 'addons plugins',
      hint: 'Health',
      run: () => go('health', 'extensions'),
    },
    {
      id: 'health-res',
      label: 'Show memory and processes',
      keywords: 'resources ram cpu',
      hint: 'Health',
      run: () => go('health', 'resources'),
    },
    {
      id: 'health-diag',
      label: 'Save a diagnostics report',
      keywords: 'support logs',
      hint: 'Health',
      run: () => go('health', 'diagnostics'),
    },
    {
      id: 'check-server',
      label: 'Check the server connection',
      keywords: 'online offline reconnect',
      hint: 'Check',
      run: () => {
        go('health', 'health');
        void backend.agency.runCheck('server').then(
          (h) => notify(h.cards.find((c) => c.id === 'connectivity')?.summary ?? 'Checked.'),
          (e) => notify(errorMessage(e), 'error'),
        );
      },
    },
    {
      id: 'check-proxies',
      label: 'Check all proxies',
      hint: 'Check',
      run: () => {
        go('health', 'health');
        void backend.agency.runCheck('proxies').then(
          () => setRefreshKey((k) => k + 1),
          (e) => notify(errorMessage(e), 'error'),
        );
      },
    },
    {
      id: 'notifications',
      label: `Show notifications (${notices.length})`,
      hint: 'App',
      run: () => setNoticesOpen(true),
    },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      keywords: 'keys help',
      hint: 'Help',
      run: () => setShortcuts(true),
    },
    ...orgs.map(
      (o): Command => ({
        id: `org-${o.org_id}`,
        label: `Go to organization ${o.name}`,
        hint: 'Organization',
        run: () => {
          setOrgId(o.org_id);
          setView('organization');
        },
      }),
    ),
  ];

  if (!app) {
    return (
      <p role="status" className="loading">
        Loading…
      </p>
    );
  }

  const live = <Toasts toasts={toasts} />;
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
            value={
              orgId && view === 'organization' ? `org:${orgId}` : `local:${app.active_workspace_id ?? ''}`
            }
            onChange={async (e) => {
              const [kind, id] = e.target.value.split(':');
              if (kind === 'org' && id) {
                setOrgId(id);
                setView('organization');
                return;
              }
              try {
                if (id) await backend.workspaces.setActiveWorkspace(id);
                await refresh();
                setRefreshKey((k) => k + 1);
                setView((v) => (v === 'organization' ? 'profiles' : v));
              } catch (err) {
                notify(errorMessage(err), 'error');
              }
            }}
          >
            <optgroup label="On this computer">
              {app.workspaces.map((w) => (
                <option key={w.id} value={`local:${w.id}`}>
                  {w.name}
                </option>
              ))}
            </optgroup>
            {orgs.length > 0 && (
              <optgroup label="Organizations">
                {orgs.map((o) => (
                  <option key={o.org_id} value={`org:${o.org_id}`}>
                    {o.name} ({ROLE_LABEL[o.role]})
                  </option>
                ))}
              </optgroup>
            )}
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
                    if (id === 'account') void refreshAccount();
                  }}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div ref={setFolderSlot} className="sidebar__folders" hidden={view !== 'profiles'} />
        {importOp && (
          <div className="sidebar__import" role="status">
            Importing profiles…
            <progress aria-label="Import progress" value={importOp.progress ?? undefined} max={1} />
          </div>
        )}
        <button
          type="button"
          className="nav-item notices-button"
          aria-label={`Notifications: ${notices.length === 0 ? 'none' : notices.length}`}
          onClick={() => setNoticesOpen(true)}
        >
          Notifications{notices.length > 0 ? ` (${notices.length})` : ''}
        </button>
        <p className="sidebar__hint">
          <kbd>{MOD()}K</kbd> finds anything · <kbd>?</kbd> shortcuts
        </p>
        <div className="sidebar__status" role="status">
          {app.running_count === 0
            ? 'No profiles open'
            : `${app.running_count} profile${app.running_count === 1 ? '' : 's'} open`}
          <span className="sidebar__hint">Profiles can stay open when the manager is closed.</span>
        </div>
        <p className="sidebar__note">
          Internal build {app.app.version}
          {account?.status === 'signed_in' && account.user
            ? ` · signed in as ${account.user.display_name}`
            : ''}
        </p>
      </aside>

      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable (axe scrollable-region-focusable, WCAG 2.1.1) */}
      <main className="main" id="main" tabIndex={0} aria-label="Content">
        <ReconnectBanner backend={backend} account={account} refreshKey={refreshKey} />
        {view === 'profiles' && (
          <ProfilesScreen
            backend={backend}
            refreshKey={refreshKey}
            notify={notify}
            runningCount={app.running_count}
            folderSlot={folderSlot}
            showProfile={showProfile}
          />
        )}
        {view === 'proxies' && <ProxiesScreen backend={backend} refreshKey={refreshKey} notify={notify} />}
        {view === 'downloads' && (
          <DownloadsScreen backend={backend} refreshKey={refreshKey} notify={notify} />
        )}
        {view === 'health' && (
          <HealthScreen
            backend={backend}
            notify={notify}
            refreshKey={refreshKey}
            tab={healthTab}
            onTab={setHealthTab}
            onNavigate={(v) => go(v)}
          />
        )}
        {view === 'account' && (
          <AccountScreen
            backend={backend}
            account={account}
            refreshKey={refreshKey}
            notify={notify}
            onChanged={refreshAccount}
            onOpenOrganization={async (id) => {
              await refreshAccount();
              setOrgId(id);
              setView('organization');
            }}
          />
        )}
        {view === 'organization' && orgId && account && (
          <OrganizationScreen
            key={orgId}
            backend={backend}
            orgId={orgId}
            app={app}
            account={account}
            refreshKey={refreshKey}
            notify={notify}
            onChanged={refreshAccount}
            onLeft={() => {
              setOrgId(null);
              setView('profiles');
              void refreshAccount();
            }}
          />
        )}
        {view === 'settings' && (
          <SettingsScreen
            backend={backend}
            app={app}
            refreshKey={refreshKey}
            onChanged={refresh}
            notify={notify}
            signedIn={account?.status === 'signed_in'}
          />
        )}
      </main>

      {app.recovery.previous_session_crashed && (
        <CrashPrompt
          backend={backend}
          app={app}
          onDone={refresh}
          onDiagnostics={() => go('health', 'diagnostics')}
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
      {palette && (
        <CommandPalette
          backend={backend}
          commands={commands}
          onClose={() => setPalette(false)}
          onOpenProfile={(p) => void launcher.open([p])}
          onShowProfile={(p) => {
            setView('profiles');
            setShowProfile({ id: p.id, nonce: Date.now() });
          }}
        />
      )}
      {shortcuts && <ShortcutsHelp screens={NAV.map(([, l]) => l)} onClose={() => setShortcuts(false)} />}
      {noticesOpen && (
        <NoticeCentre notices={notices} onDismiss={resolve} onClose={() => setNoticesOpen(false)} />
      )}
      {launcher.dialog}
      {live}
    </div>
  );
}
