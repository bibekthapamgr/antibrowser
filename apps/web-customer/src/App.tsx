/**
 * R4 customer portal (ADR-0023): one page application at /app/ with hash routes (the R2 links keep working):
 *   #/welcome, #/invite/<token>, #/signin?failed=…      sign-in and onboarding (R2)
 *   #/overview, #/team, #/billing, #/billing/return?result=…, #/account
 * `?plan=<id>` on any route keeps the plan chosen on the website through signup (sessionStorage; validated by the
 * server). The active workspace is the person's default, or the one chosen in the header.
 */
import type { Organization, Workspaces } from '@pb/contracts/resources';
import { useCallback, useEffect, useState } from 'react';
import { AccountPage } from './account.tsx';
import { ApiError, type PortalApi, signInUrl } from './api.ts';
import { BillingPage, BillingReturn } from './billing.tsx';
import { ErrorBox, Loading } from './common.tsx';
import {
  Invitation,
  pendingInvite,
  SignedOut,
  SignInFailed,
  setPlanIntent,
  type WebConfig,
  Welcome,
} from './onboarding.tsx';
import { Overview } from './overview.tsx';
import { TeamPage } from './team.tsx';

interface SessionUser {
  id: string;
  display_name: string;
  email: string | null;
  email_verified: boolean;
}
interface Route {
  path: string;
  params: URLSearchParams;
}
function readRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = hash.split('?');
  return { path, params: new URLSearchParams(query) };
}
const go = (path: string) => {
  window.location.hash = `#/${path}`;
};
function chosenOrg(): string | null {
  try {
    return sessionStorage.getItem('pb.org');
  } catch {
    return null;
  }
}
function chooseOrg(id: string) {
  try {
    sessionStorage.setItem('pb.org', id);
  } catch {
    /* the default workspace opens next time */
  }
}

const NAV: [string, string][] = [
  ['overview', 'Overview'],
  ['team', 'Team'],
  ['billing', 'Billing'],
  ['account', 'Account'],
];

export function App({ api }: { api: PortalApi }) {
  const [config, setConfig] = useState<
    WebConfig & { account_url?: string | null; status_url?: string | null }
  >({
    brand: 'Project Browser',
    terms_version: '',
    terms_url: null,
    download_url: null,
    sign_in: true,
  });
  const [route, setRoute] = useState<Route>(readRoute);
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [workspaces, setWorkspaces] = useState<Workspaces['items'] | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // A plan chosen on the website travels through signup.
  useEffect(() => {
    const plan = route.params.get('plan');
    if (plan && /^[a-z][a-z0-9_]{1,31}$/.test(plan)) setPlanIntent(plan);
  }, [route]);

  const loadSession = useCallback(async () => {
    try {
      const s = await api.request<{ user: SessionUser }>('GET', '/web/auth/session');
      setUser(s.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      else setError(e);
    }
  }, [api]);
  // Signed out: a new route (back from the sign-in page) checks the session again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on route changes only
  useEffect(() => {
    if (user === null) void loadSession();
  }, [route]);
  useEffect(() => {
    api
      .request<typeof config>('GET', '/web/config')
      .then((c) => setConfig((x) => ({ ...x, ...c })))
      .catch(() => undefined);
    void loadSession();
  }, [api, loadSession]);

  // The person's workspaces; the active one is the one chosen here, else the server's default.
  const loadWorkspaces = useCallback(
    async (preferred?: string) => {
      const w = await api.request<Workspaces>('GET', '/me/workspaces');
      setWorkspaces(w.items);
      const want = preferred ?? chosenOrg();
      const pick = w.items.find((x) => x.org_id === want)?.org_id ?? w.items[0]?.org_id ?? null;
      setOrgId(pick);
      return pick;
    },
    [api],
  );
  useEffect(() => {
    if (!orgId) {
      setOrg(null);
      return;
    }
    let live = true;
    setOrg(null);
    api
      .request<Organization>('GET', `/orgs/${orgId}`)
      .then((o) => live && setOrg(o))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [api, orgId]);

  // Signed in with a workspace: the start page is the overview.
  useEffect(() => {
    if (user && workspaces && (route.path === '' || route.path === 'welcome')) go('overview');
  }, [user, workspaces, route.path]);

  const signOut = async (returnTo?: string) => {
    await api.request('POST', '/web/auth/logout').catch(() => undefined);
    setUser(null);
    if (returnTo) api.navigate(signInUrl('signin', returnTo));
    else go('welcome');
  };

  // ------------------------------------------------------------------ pages without a workspace
  let page: React.ReactNode;
  const p = route.path;
  if (error !== null)
    page = (
      <ErrorBox
        error={error}
        retry={() => {
          setError(null);
          void loadSession();
        }}
      />
    );
  else if (p === 'signin' && route.params.get('failed'))
    page = <SignInFailed api={api} reason={route.params.get('failed') ?? ''} />;
  else if (user === undefined) page = <Loading />;
  else if (p.startsWith('invite/'))
    page = (
      <Invitation
        api={api}
        config={config}
        token={p.slice('invite/'.length)}
        signedIn={user}
        onSessionChanged={loadSession}
        onSignOut={(back) => void signOut(back)}
        onJoined={(id) => {
          chooseOrg(id);
          setOutcome('joined');
          void loadWorkspaces(id).then(() => go('overview'));
        }}
      />
    );
  else if (user === null) page = <SignedOut api={api} config={config} />;
  else if (workspaces && (p === '' || p === 'welcome')) page = <Loading />;
  else if (!workspaces) {
    const invite = pendingInvite();
    page = invite ? (
      <Invitation
        api={api}
        config={config}
        token={invite}
        signedIn={user}
        onSessionChanged={loadSession}
        onSignOut={(back) => void signOut(back)}
        onJoined={(id) => {
          chooseOrg(id);
          setOutcome('joined');
          void loadWorkspaces(id).then(() => go('overview'));
        }}
      />
    ) : (
      <Welcome
        api={api}
        config={config}
        onSessionChanged={loadSession}
        onReady={(id, how) => {
          setOutcome(how);
          void loadWorkspaces(chosenOrg() ?? id);
        }}
      />
    );
  } else if (!org) page = <Loading what="Loading your workspace…" />;
  else if (p === 'team') page = <TeamPage api={api} org={org} me={user.id} />;
  else if (p === 'billing') page = <BillingPage api={api} org={org} />;
  else if (p === 'billing/return')
    page = (
      <BillingReturn
        api={api}
        org={org}
        result={route.params.get('result') ?? ''}
        onDone={() => go('billing')}
      />
    );
  else if (p === 'account')
    page = (
      <AccountPage
        api={api}
        user={user}
        accountUrl={config.account_url ?? null}
        onSignedOutEverywhere={() => {
          setUser(null);
          go('welcome');
        }}
      />
    );
  else page = <Overview api={api} org={org} outcome={outcome} go={go} />;

  const inWorkspace =
    !!user && !!workspaces && !!org && !['', 'welcome'].includes(p) && !p.startsWith('invite/');
  return (
    <>
      <button type="button" className="skip" onClick={() => document.getElementById('main')?.focus()}>
        Skip to content
      </button>
      <header className="top">
        <a className="brand" href="/">
          {config.brand}
        </a>
        {inWorkspace && workspaces && workspaces.length > 1 && (
          <label className="switcher">
            <span className="sr-only">Workspace</span>
            <select
              value={orgId ?? ''}
              onChange={(e) => {
                chooseOrg(e.target.value);
                setOrgId(e.target.value);
                setOutcome(null);
              }}
            >
              {workspaces.map((w) => (
                <option key={w.org_id} value={w.org_id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {user && (
          <div className="who">
            <span className="muted small">{user.email ?? user.display_name}</span>
            <button type="button" className="link" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        )}
      </header>
      {inWorkspace && (
        <nav aria-label="Account" className="tabs">
          {NAV.map(([path, label]) => (
            <a
              key={path}
              href={`#/${path}`}
              aria-current={p === path || (path === 'billing' && p === 'billing/return') ? 'page' : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
      )}
      <main id="main" tabIndex={-1} key={orgId ?? 'none'}>
        {page}
      </main>
      <footer className="foot">
        <a href="/help/">Help</a>
        <a href="/security/">Security</a>
        <a href="/legal/privacy/">Privacy</a>
        <a href="/legal/terms/">Terms</a>
        {config.status_url && <a href={config.status_url}>Service status</a>}
      </footer>
    </>
  );
}
