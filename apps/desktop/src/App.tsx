import type { OnboardingResult } from '@pb/contracts/onboarding';
import type { Organization, Workspaces } from '@pb/contracts/resources';
import type { FeatureSettings } from '@pb/contracts/workspace';
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { AccountScreen } from './account.tsx';
import type { AccountView, AppView, Backend, Operation } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { BillingBanner } from './billing.tsx';
import { ApiFailure, can, get, getAll, ROLE_LABEL } from './cloud.ts';
import {
  OfflineGate,
  PlanGate,
  recentPlanOk,
  rememberPlanOk,
  SetupGate,
  SignInGate,
  USABLE_PLAN,
} from './gate.tsx';
import { HealthScreen, type HealthTab } from './health.tsx';
import {
  LOCATION_CHANGED,
  LocationChangeDialog,
  type LocationWarning,
  locationNoticeText,
  useLauncher,
} from './launch.tsx';
import { PROXY_ERROR_HELP, ProxiesScreen } from './network.tsx';
import { NoticeCentre, ReconnectBanner, Toasts, useNotifications } from './notices.tsx';
import {
  completeOnboarding,
  OnboardingDialog,
  type OnboardingNeed,
  onboardingMessage,
} from './onboarding.tsx';
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
import { seatUsage, TeamScreen } from './team-access.tsx';
import { initials } from './ui.tsx';
import { UpdateBanner } from './updates.tsx';
import {
  AgencyTools,
  LocalProfilesBanner,
  SubscriptionScreen,
  ThisComputerBanner,
  WorkspaceProfiles,
  WorkspaceSettings,
} from './workspace.tsx';

type View =
  | 'profiles'
  | 'proxies'
  | 'downloads'
  | 'health'
  | 'account'
  | 'settings'
  | 'organization'
  | 'team'
  | 'subscription'
  | 'agency';
/** The earlier screens (the `ui.unified_profiles` rollback switch turned off). */
const CLASSIC_NAV: [View, string][] = [
  ['profiles', 'Profiles'],
  ['proxies', 'Proxies'],
  ['downloads', 'Downloads and updates'],
  ['health', 'Health'],
  ['account', 'Account'],
  ['settings', 'Settings'],
];
/** R3 (ADR-0022): the default navigation. */
const UNIFIED_NAV: [View, string][] = [
  ['profiles', 'Profiles'],
  ['proxies', 'Proxies'],
  ['team', 'Team'],
  ['subscription', 'Subscription'],
  ['settings', 'Settings'],
];
/** Navigation icons (24×24 outline, drawn with currentColor; decorative, the label names the screen). */
const NAV_ICON: Partial<Record<View, string>> = {
  profiles: 'M4 6h16M4 12h16M4 18h10',
  proxies:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9Z',
  team: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.6a3 3 0 0 1 0 5.8',
  subscription: 'M3 7h18v11H3zM3 11h18M7 15h3',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  agency: 'M4 20V8l8-4 8 4v12M9 20v-6h6v6',
};
const BELL = 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Zm4 4a2 2 0 0 0 4 0';
function NavIcon({ view }: { view: View }) {
  const d = NAV_ICON[view];
  if (!d) return null;
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

type SettingsTab = 'general' | 'account' | 'updates' | 'health' | 'workspace';
const SETTINGS_TABS: [SettingsTab, string][] = [
  ['general', 'General'],
  ['account', 'Account'],
  ['updates', 'Updates and downloads'],
  ['health', 'Health and diagnostics'],
  ['workspace', 'Workspace'],
];
/** Icons of the settings sections (same outline style as the sidebar). */
const SETTINGS_ICON: Record<SettingsTab, string> = {
  general: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 20c1.5-3.5 4.4-5 8-5s6.5 1.5 8 5',
  updates: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14',
  health: 'M3 12h4l2.5-6 5 12 2.5-6h4',
  workspace: 'M4 20V8l8-4 8 4v12M9 20v-6h6v6',
};
type OrgWorkspace = Workspaces['items'][number];
/** What the current account workspace offers this person (loaded per workspace; never shown for another one). */
interface Scope {
  orgId: string;
  org: Organization;
  agency: boolean;
  developerTools: boolean;
  seats: { used: number; allowed: number | null } | null;
  profilesAllowed: number | null;
}
const COMPUTER = 'computer';
/** The workspace chosen in this window (a per-window convenience; the server keeps the person's default). */
function rememberedScope(): string | null {
  try {
    return sessionStorage.getItem('pb.scope');
  } catch {
    return null;
  }
}
function rememberScope(v: string): void {
  try {
    sessionStorage.setItem('pb.scope', v);
  } catch {
    // Not kept: the default workspace opens next time.
  }
}

export function App({ backend, requireAccount = true }: { backend: Backend; requireAccount?: boolean }) {
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
  // ADR-0029: an open that waits for the person because its proxy's location changed.
  const [locationChange, setLocationChange] = useState<{ w: LocationWarning; name: string } | null>(null);
  const [importOp, setImportOp] = useState<Operation | null>(null);
  const [folderSlot, setFolderSlot] = useState<HTMLElement | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [orgs, setOrgs] = useState<OrgWorkspace[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  // Account gate: each workspace's plan (null until checked) and whether the server answered.
  const [orgDetails, setOrgDetails] = useState<Organization[] | null>(null);
  const [reach, setReach] = useState<'ok' | 'offline'>('ok');
  const [gateBusy, setGateBusy] = useState(false);
  const reported = useRef(false);
  const launcher = useLauncher(backend, notify);
  const unified = app?.settings.find((x) => x.key === 'ui.unified_profiles')?.value !== false;
  const unifiedRef = useRef(unified);
  unifiedRef.current = unified;
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  // R3: the one active-workspace context. `COMPUTER` is the local-only view; otherwise an account workspace id.
  const [scopeChoice, setScopeChoice] = useState<string | null>(rememberedScope);
  const [defaultOrg, setDefaultOrg] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [scopeNonce, setScopeNonce] = useState(0);
  const go = useCallback((v: View, tab?: HealthTab) => {
    if (unifiedRef.current) {
      // Earlier destinations now live under Settings (deep links and notices keep working).
      if (v === 'downloads') {
        setSettingsTab('updates');
        setView('settings');
        return;
      }
      if (v === 'health') {
        setSettingsTab('health');
        if (tab) setHealthTab(tab);
        setView('settings');
        return;
      }
      if (v === 'account') {
        setSettingsTab('account');
        setView('settings');
        return;
      }
      if (v === 'organization') {
        setView('profiles');
        return;
      }
    }
    setView(v);
    if (tab) setHealthTab(tab);
  }, []);
  const chooseScope = useCallback((v: string) => {
    rememberScope(v);
    setScopeChoice(v);
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
      if (a.status !== 'signed_in') {
        setOrgs([]);
        setOrgDetails(null);
        return;
      }
      const res = await get<Workspaces>(backend, '/v1/me/workspaces');
      setOrgs(res.data.items);
      setReach(res.stale ? 'offline' : 'ok');
      // The plan of each workspace (the list itself carries none); a workspace that cannot be read counts as none.
      if (!requireAccount) return;
      const details = await Promise.all(
        res.data.items.slice(0, 20).map((o) =>
          get<Organization>(backend, `/v1/orgs/${o.org_id}`)
            .then((r) => r.data)
            .catch(() => null),
        ),
      );
      setOrgDetails(details.filter((d): d is Organization => d !== null));
      // R3: the workspace the person's apps open first (R2 onboarding keeps it on the server).
      void get<{ default_org_id: string | null }>(backend, '/v1/onboarding/status')
        .then((r) => setDefaultOrg(r.data.default_org_id))
        .catch(() => undefined);
    } catch (e) {
      setOrgs((o) => o);
      if (!(e instanceof ApiFailure)) setReach('offline');
    }
  }, [backend, requireAccount]);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  // The plan is checked again every 15 minutes, so an ended plan or a new payment shows without restarting.
  useEffect(() => {
    if (!requireAccount || account?.status !== 'signed_in') return;
    const t = setInterval(() => void refreshAccount(), 15 * 60_000);
    return () => clearInterval(t);
  }, [requireAccount, account?.status, refreshAccount]);

  // A confirmed usable plan lets this computer keep working for a while when the server cannot be reached.
  useEffect(() => {
    if (reach === 'ok' && orgDetails?.some((o) => !o.billing || USABLE_PLAN.has(o.billing.state)))
      rememberPlanOk();
  }, [reach, orgDetails]);

  // R2: after signing in, onboarding completes by itself and the person lands on Profiles; a dialog appears only when
  // the server needs a decision (terms for a new workspace, a waiting invitation, which owned workspace first).
  const [onboardingNeed, setOnboardingNeed] = useState<OnboardingNeed | null>(null);
  const onboarded = useCallback(
    (r: OnboardingResult) => {
      setOnboardingNeed(null);
      notify(onboardingMessage(r));
      setView('profiles');
      // A new or joined workspace opens at once on its profiles (an invited member sees what was shared).
      if (r.status.default_org_id) {
        setDefaultOrg(r.status.default_org_id);
        chooseScope(r.status.default_org_id);
      }
      void refreshAccount();
      setRefreshKey((k) => k + 1);
    },
    [notify, refreshAccount, chooseScope],
  );
  const finishOnboarding = useCallback(async () => {
    try {
      const r = await completeOnboarding(backend);
      if (r.done) onboarded(r.done);
      else setOnboardingNeed(r.need);
    } catch (err) {
      // An older server without self-service onboarding: signing in still works as before.
      notify(
        err instanceof ApiFailure && err.status === 404 ? 'Signed in.' : errorMessage(err),
        err instanceof ApiFailure && err.status === 404 ? 'info' : 'error',
      );
    }
  }, [backend, notify, onboarded]);

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
        else if (e.status === 'signed_in' && !e.reauth) void finishOnboarding();
        else if (e.status === 'expired')
          notify(
            'Your session ended. Sign in again in Account. Your local profiles are not affected.',
            'error',
          );
      }),
    [backend, notify, refreshAccount, finishOnboarding],
  );

  // With the account gate there is no "This computer" view (local-only profiles sit outside any plan): profiles made
  // on this computer before are counted, so the workspace can offer to move them in.
  const [localProfiles, setLocalProfiles] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads
  useEffect(() => {
    if (!requireAccount || !app) return;
    let live = true;
    backend.profiles
      .query({ limit: 500 })
      .then((r) => live && setLocalProfiles(r.rows.filter((p) => p.sync_status !== 'shared').length))
      .catch(() => live && setLocalProfiles(0));
    return () => {
      live = false;
    };
  }, [backend, requireAccount, app?.active_workspace_id, refreshKey]);
  const showComputer = !requireAccount || orgs.length === 0;

  // R3: the effective workspace: the one chosen in this window if it is still one of the person's, else their default
  // workspace, else the first; signed out (or with no workspace) it is this computer.
  const signedIn = account?.status === 'signed_in';
  const scopeId =
    !signedIn || orgs.length === 0
      ? COMPUTER
      : scopeChoice === COMPUTER && showComputer
        ? COMPUTER
        : orgs.some((o) => o.org_id === scopeChoice)
          ? (scopeChoice as string)
          : orgs.some((o) => o.org_id === defaultOrg)
            ? (defaultOrg as string)
            : (orgs[0]?.org_id ?? COMPUTER);
  // Loads what the workspace offers. Switching drops the previous workspace's data at once (no old rows or status can
  // show), and an answer for a workspace that is no longer current is ignored.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeNonce and refreshKey reload
  useEffect(() => {
    setScope((s) => (s && s.orgId === scopeId ? s : null));
    if (!unified || scopeId === COMPUTER) return;
    let live = true;
    const id = scopeId;
    (async () => {
      try {
        const org = (await get<Organization>(backend, `/v1/orgs/${id}`)).data;
        const [features, clients, seats, usage] = await Promise.all([
          get<FeatureSettings>(backend, `/v1/orgs/${id}/feature-settings`).catch(() => null),
          can(org.role, 'clients.read')
            ? getAll<{ id: string }>(backend, `/v1/orgs/${id}/clients`, [], 1).catch(() => null)
            : Promise.resolve(null),
          seatUsage(backend, id, org.role),
          can(org.role, 'billing.read')
            ? get<{ limits: { profiles: number | null } }>(backend, `/v1/orgs/${id}/billing/usage`).catch(
                () => null,
              )
            : Promise.resolve(null),
        ]);
        if (!live) return;
        const flag = (k: string) => features?.data.settings.find((x) => x.key === k)?.value === true;
        setScope({
          orgId: id,
          org,
          agency:
            can(org.role, 'clients.read') && (flag('modules.agency') || (clients?.items.length ?? 0) > 0),
          developerTools: flag('modules.automation'),
          seats,
          profilesAllowed: usage?.data.limits.profiles ?? null,
        });
      } catch (e) {
        if (live) notify(errorMessage(e, 'The workspace could not be loaded.'), 'error');
      }
    })();
    return () => {
      live = false;
    };
  }, [backend, scopeId, unified, scopeNonce, notify]);
  // The R3 default navigation has no Organization, Account, Health or Downloads screens of its own.
  useEffect(() => {
    if (unified)
      setView((v) => (['organization', 'downloads', 'health', 'account'].includes(v) ? 'profiles' : v));
    else setView((v) => (['team', 'subscription', 'agency'].includes(v) ? 'profiles' : v));
  }, [unified]);
  // First run of the R3 app: a local container for this computer's copies is made without asking.
  const madeLocal = useRef(false);
  useEffect(() => {
    if (!app || !unified || !app.first_run || madeLocal.current) return;
    madeLocal.current = true;
    void backend.workspaces
      .createWorkspace('This computer')
      .then(() => refresh())
      .catch((e) => notify(errorMessage(e), 'error'));
  }, [app, unified, backend, refresh, notify]);

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
      // The proxy location lock asks in its own dialog (from the warning sent with the failure).
      if (op.status === 'failed' && op.error_code === LOCATION_CHANGED) return;
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
      else if (w.code === 'PROXY_MATCH_UNAVAILABLE')
        void nameOf(w.profile_id).then((n) =>
          notify(
            `${n} opened without ${w.partial ? 'all of ' : ''}its proxy's time zone and language: ${
              w.reason === 'NO_LOCATION'
                ? 'the check service gave no location for the proxy (it needs your account server).'
                : `the proxy check did not work. ${PROXY_ERROR_HELP[w.reason] ?? ''}`.trim()
            } WebRTC still uses only the proxy, and websites are still refused this computer's location unless you allowed it.`,
            'error',
          ),
        );
      else if (w.code === 'PROXY_LOCATION_CHANGED')
        void nameOf(w.profile_id).then((name) => setLocationChange({ w, name }));
      else if (w.code === 'PROXY_LOCATION_NOTICE')
        void nameOf(w.profile_id).then((n) => {
          const text = locationNoticeText(n, w);
          notify(text);
          raise({ key: `location:${w.profile_id}`, tone: 'info', text });
        });
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

  const orgScope = unified && scopeId !== COMPUTER ? scopeId : null;
  const NAV: [View, string][] = unified
    ? [
        ...UNIFIED_NAV.slice(0, 2),
        ...(scope?.agency && scope.orgId === orgScope
          ? ([['agency', 'Agency tools']] as [View, string][])
          : []),
        ...UNIFIED_NAV.slice(2),
      ]
    : CLASSIC_NAV;

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
        label: unified ? `Switch to workspace ${o.name}` : `Go to organization ${o.name}`,
        hint: unified ? 'Workspace' : 'Organization',
        run: () => {
          if (unified) {
            chooseScope(o.org_id);
            setView('profiles');
            return;
          }
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
  if (app.first_run && unified) {
    return (
      <p role="status" className="loading">
        Getting ready…
      </p>
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

  // Shared by both layouts: prompts and dialogs over the screens.
  const overlays = (
    <>
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
            if (unified && showComputer) chooseScope(COMPUTER);
            setView('profiles');
            setShowProfile({ id: p.id, nonce: Date.now() });
          }}
        />
      )}
      {shortcuts && <ShortcutsHelp screens={NAV.map(([, l]) => l)} onClose={() => setShortcuts(false)} />}
      {onboardingNeed && (
        <OnboardingDialog
          backend={backend}
          need={onboardingNeed}
          onDone={onboarded}
          onNeed={setOnboardingNeed}
          onClose={() => setOnboardingNeed(null)}
          onSignInAgain={() => {
            setOnboardingNeed(null);
            void backend.account.signIn().catch((e) => notify(errorMessage(e), 'error'));
          }}
        />
      )}
      {noticesOpen && (
        <NoticeCentre notices={notices} onDismiss={resolve} onClose={() => setNoticesOpen(false)} />
      )}
      {launcher.dialog}
      {locationChange && (
        <LocationChangeDialog
          change={locationChange.w}
          name={locationChange.name}
          onCancel={() => {
            setLocationChange(null);
            notify(`${locationChange.name} was not opened.`);
          }}
          onOpenAnyway={() => {
            const { w, name } = locationChange;
            setLocationChange(null);
            backend.profiles.launch(w.profile_id, { allowLocationChange: true }).then(
              () => notify(`Opening ${name}…`),
              (e) => notify(errorMessage(e), 'error'),
            );
          }}
        />
      )}
      {live}
    </>
  );

  // Account gate: nothing but these screens until the person is signed in with a workspace that has a usable plan.
  if (requireAccount) {
    const signOut = async () => {
      try {
        await backend.account.signOut();
      } catch (e) {
        notify(errorMessage(e), 'error');
      }
      void refreshAccount();
    };
    let gate: ReactNode = null;
    if (!account) {
      gate = (
        <p role="status" className="loading">
          Loading…
        </p>
      );
    } else if (account.status !== 'signed_in') {
      gate = <SignInGate backend={backend} account={account} notify={notify} onChanged={refreshAccount} />;
    } else if (reach === 'offline') {
      if (!recentPlanOk())
        gate = <OfflineGate onRetry={() => void refreshAccount()} onSignOut={() => void signOut()} />;
    } else if (orgDetails === null) {
      gate = (
        <p role="status" className="loading">
          Checking your plan…
        </p>
      );
    } else if (orgs.length === 0) {
      gate = (
        <SetupGate
          busy={gateBusy}
          onContinue={async () => {
            setGateBusy(true);
            await finishOnboarding();
            setGateBusy(false);
          }}
          onSignOut={() => void signOut()}
        />
      );
    } else if (!orgDetails.some((o) => !o.billing || USABLE_PLAN.has(o.billing.state))) {
      const org = orgDetails.find((o) => can(o.role, 'billing.manage')) ?? orgDetails[0];
      if (org)
        gate = (
          <PlanGate
            backend={backend}
            org={org}
            me={account.user?.id ?? ''}
            notify={notify}
            onChanged={() => void refreshAccount()}
            onSignOut={() => void signOut()}
          />
        );
    }
    if (gate)
      return (
        <>
          {gate}
          {onboardingNeed && (
            <OnboardingDialog
              backend={backend}
              need={onboardingNeed}
              onDone={onboarded}
              onNeed={setOnboardingNeed}
              onClose={() => setOnboardingNeed(null)}
              onSignInAgain={() => {
                setOnboardingNeed(null);
                void backend.account.signIn().catch((e) => notify(errorMessage(e), 'error'));
              }}
            />
          )}
          {live}
        </>
      );
  }

  if (unified) {
    const ready = orgScope ? (scope?.orgId === orgScope ? scope : null) : null;
    const common = ready
      ? {
          backend,
          orgId: ready.orgId,
          role: ready.org.role,
          notify,
          offline: false,
          me: account?.user?.id ?? '',
        }
      : null;
    const signIn = () => go('account');
    const needWorkspace = (what: string) => (
      <section className="screen stack" aria-labelledby="need-title">
        <h1 id="need-title">{what}</h1>
        <p className="muted">
          {signedIn
            ? 'Choose an account workspace in the sidebar. “This computer” has no team or subscription.'
            : 'Sign in or create an account to share profiles with a team. Your workspace’s plan covers everyone in it.'}
        </p>
        {!signedIn && (
          <div className="row">
            <button type="button" className="pb-button" data-variant="primary" onClick={signIn}>
              Sign in or create an account
            </button>
          </div>
        )}
      </section>
    );
    const loadingWorkspace = (
      <p role="status" className="loading">
        Loading workspace…
      </p>
    );
    return (
      <div className="layout">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <aside className="sidebar" aria-label="Workspace and navigation">
          <div className="sidebar__brand">
            <span className="brand-mark" aria-hidden="true" />
            Project Browser
          </div>
          <label className="workspace">
            <span className="sidebar__label">Workspace</span>
            <select
              value={orgScope ? `org:${orgScope}` : `local:${app.active_workspace_id ?? ''}`}
              onChange={async (e) => {
                const [kind, id] = e.target.value.split(':');
                if (kind === 'org' && id) {
                  chooseScope(id);
                  return;
                }
                try {
                  if (id && id !== app.active_workspace_id) await backend.workspaces.setActiveWorkspace(id);
                  chooseScope(COMPUTER);
                  await refresh();
                  setRefreshKey((k) => k + 1);
                } catch (err) {
                  notify(errorMessage(err), 'error');
                }
              }}
            >
              {orgs.length > 0 && (
                <optgroup label="Account workspaces">
                  {orgs.map((o) => (
                    <option key={o.org_id} value={`org:${o.org_id}`}>
                      {o.name} ({ROLE_LABEL[o.role]})
                    </option>
                  ))}
                </optgroup>
              )}
              {(showComputer || !orgScope) && (
                <optgroup label="This computer only">
                  {app.workspaces.map((w) => (
                    <option key={w.id} value={`local:${w.id}`}>
                      {app.workspaces.length === 1 ? 'This computer' : `This computer: ${w.name}`}
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
                      if (id === 'settings') {
                        void refresh();
                        void refreshAccount();
                      }
                    }}
                  >
                    <NavIcon view={id} />
                    {label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div ref={setFolderSlot} className="sidebar__folders" hidden={view !== 'profiles' || !!orgScope} />
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
            <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d={BELL} />
            </svg>
            Notifications{notices.length > 0 ? ` (${notices.length})` : ''}
          </button>
          <p className="sidebar__hint">
            <kbd>{MOD()}K</kbd> finds anything · <kbd>?</kbd> shortcuts
          </p>
          <div className="sidebar__status" role="status">
            {app.running_count === 0
              ? 'No profiles open'
              : `${app.running_count} profile${app.running_count === 1 ? '' : 's'} open on this computer`}
            <span className="sidebar__hint">Profiles run in a browser on this computer.</span>
          </div>
          {signedIn && account?.user ? (
            <button type="button" className="account-chip" title="Account" onClick={() => go('account')}>
              <span className="account-chip__avatar" aria-hidden="true">
                {initials(account.user.display_name)}
              </span>
              <span className="account-chip__text">
                <span className="account-chip__name">{account.user.display_name}</span>
                <span className="account-chip__meta">
                  {ready?.org.billing ? ready.org.billing.plan_name : (account.user.email ?? '')}
                </span>
              </span>
            </button>
          ) : null}
          <p className="sidebar__note">Version {app.app.version}</p>
        </aside>

        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable (axe scrollable-region-focusable, WCAG 2.1.1) */}
        <main className="main" id="main" tabIndex={0} aria-label="Content">
          <Fragment key={orgScope ?? `local:${app.active_workspace_id ?? ''}`}>
            <ReconnectBanner backend={backend} account={account} refreshKey={refreshKey} />
            <UpdateBanner
              backend={backend}
              refreshKey={refreshKey}
              onOpen={() => {
                setSettingsTab('updates');
                setView('settings');
              }}
            />
            {ready && (
              <BillingBanner
                billing={ready.org.billing}
                role={ready.org.role}
                onOpenBilling={() => setView('subscription')}
              />
            )}
            {view === 'profiles' &&
              (orgScope ? (
                ready && common ? (
                  <>
                    {requireAccount && localProfiles > 0 && can(ready.org.role, 'profile.create') && (
                      <LocalProfilesBanner
                        backend={backend}
                        app={app}
                        org={{ org_id: ready.orgId, name: ready.org.name }}
                        count={localProfiles}
                        notify={notify}
                        onMoved={() => setRefreshKey((k) => k + 1)}
                      />
                    )}
                    <WorkspaceProfiles
                      backend={backend}
                      orgId={ready.orgId}
                      org={ready.org}
                      refreshKey={refreshKey}
                      notify={notify}
                      me={common.me}
                      allowed={ready.profilesAllowed}
                      onOpenSubscription={() => setView('subscription')}
                    />
                  </>
                ) : (
                  loadingWorkspace
                )
              ) : (
                <>
                  <ThisComputerBanner
                    backend={backend}
                    app={app}
                    orgs={orgs}
                    notify={notify}
                    signedIn={signedIn}
                    onSignIn={signIn}
                    onMoved={(id) => {
                      chooseScope(id);
                      setRefreshKey((k) => k + 1);
                    }}
                  />
                  <ProfilesScreen
                    backend={backend}
                    refreshKey={refreshKey}
                    notify={notify}
                    runningCount={app.running_count}
                    folderSlot={folderSlot}
                    showProfile={showProfile}
                  />
                </>
              ))}
            {view === 'proxies' && (
              <ProxiesScreen backend={backend} refreshKey={refreshKey} notify={notify} />
            )}
            {view === 'agency' && (common ? <AgencyTools {...common} /> : loadingWorkspace)}
            {view === 'team' &&
              (!orgScope ? (
                needWorkspace('Team')
              ) : ready && common ? (
                <TeamScreen
                  {...common}
                  seats={ready.seats}
                  onLeft={() => {
                    chooseScope(COMPUTER);
                    setView('profiles');
                    void refreshAccount();
                  }}
                  onChanged={() => setScopeNonce((n) => n + 1)}
                />
              ) : (
                loadingWorkspace
              ))}
            {view === 'subscription' &&
              (!orgScope ? (
                needWorkspace('Subscription')
              ) : ready && common ? (
                <SubscriptionScreen
                  {...common}
                  org={ready.org}
                  onChanged={() => setScopeNonce((n) => n + 1)}
                />
              ) : (
                loadingWorkspace
              ))}
            {view === 'settings' && (
              <div className="settings-layout">
                <nav aria-label="Settings sections" className="settings-nav">
                  <p className="settings-nav__title" aria-hidden="true">
                    Settings
                  </p>
                  <ul>
                    {SETTINGS_TABS.filter(([t]) => t !== 'workspace' || !!ready).map(([id, label]) => (
                      <li key={id}>
                        <button
                          type="button"
                          className="settings-nav__item"
                          aria-current={settingsTab === id ? 'page' : undefined}
                          onClick={() => setSettingsTab(id)}
                        >
                          <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path d={SETTINGS_ICON[id]} />
                          </svg>
                          {label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
                <div className="settings-layout__content">
                  {settingsTab === 'general' && (
                    <SettingsScreen
                      backend={backend}
                      app={app}
                      refreshKey={refreshKey}
                      onChanged={refresh}
                      notify={notify}
                      signedIn={signedIn}
                    />
                  )}
                  {settingsTab === 'account' && (
                    <AccountScreen
                      backend={backend}
                      account={account}
                      refreshKey={refreshKey}
                      notify={notify}
                      onChanged={refreshAccount}
                      onOpenOrganization={async (id) => {
                        await refreshAccount();
                        chooseScope(id);
                        setView('profiles');
                      }}
                    />
                  )}
                  {settingsTab === 'updates' && (
                    <DownloadsScreen backend={backend} refreshKey={refreshKey} notify={notify} />
                  )}
                  {settingsTab === 'health' && (
                    <HealthScreen
                      backend={backend}
                      notify={notify}
                      refreshKey={refreshKey}
                      tab={healthTab}
                      onTab={setHealthTab}
                      onNavigate={(v) => go(v)}
                    />
                  )}
                  {settingsTab === 'workspace' && ready && common && (
                    <section className="screen stack" aria-labelledby="ws-settings-title">
                      <header className="toolbar">
                        <div className="toolbar__title">
                          <h1 id="ws-settings-title">Workspace</h1>
                          <p className="muted small">
                            Settings of {ready.org.name}, shared by everyone in it.
                          </p>
                        </div>
                      </header>
                      <WorkspaceSettings
                        {...common}
                        org={ready.org}
                        app={app}
                        developerTools={ready.developerTools}
                        onChanged={() => {
                          setScopeNonce((n) => n + 1);
                          void refreshAccount();
                        }}
                      />
                    </section>
                  )}
                </div>
              </div>
            )}
          </Fragment>
        </main>
        {overlays}
      </div>
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
        <UpdateBanner backend={backend} refreshKey={refreshKey} onOpen={() => go('downloads')} />
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
      {overlays}
    </div>
  );
}
