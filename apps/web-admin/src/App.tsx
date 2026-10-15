/**
 * The support console (milestone 11, ADR-0018): sign-in, then search → organization overview, access requests, alerts
 * and the platform audit. What a staff member may do comes from the server on every request; the screens only hide
 * actions their roles cannot take.
 */
import { type StaffPermission, staffCan } from '@pb/contracts/admin';
import { BILLING_TIMING, type StaffRole, type SupportSearchResult } from '@pb/contracts/billing';
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  CustomerPage,
  CustomersPage,
  DashboardPage,
  OperationsPage,
  PlansPage,
  StaffPage,
} from './admin.tsx';
import { type ConsoleApi, ConsoleError, type Session, type Staff } from './api.ts';
import { minutesLeft, ROLE_LABEL, STATE_LABEL, when } from './format.ts';
import { AlertsPage, AuditPage, RequestsPage } from './lists.tsx';
import { OrgPage } from './org.tsx';
import {
  BrandMark,
  Callout,
  EmptyState,
  Icon,
  type IconName,
  PageHeader,
  Panel,
  Pill,
  ProfileStack,
  Skeleton,
  type Tone,
} from './ui.tsx';

// ---------------------------------------------------------------- routing (hash, so the server serves one page)
export type Route =
  | { page: 'search'; q?: string }
  | { page: 'org'; id: string }
  | { page: 'requests' }
  | { page: 'alerts' }
  | { page: 'audit'; org: string | null }
  // R5: business administration.
  | { page: 'dashboard' }
  | { page: 'customers'; q?: string }
  | { page: 'customer'; id: string }
  | { page: 'plans' }
  | { page: 'operations' }
  | { page: 'staff' };

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const [head, arg] = parts;
  // The top bar's search hands its words to the customer list or the organization search (?q=…).
  const q = new URLSearchParams(query).get('q')?.trim().slice(0, 254) || undefined;
  if (head === 'orgs' && arg && /^org_[0-9A-HJKMNP-TV-Z]{26}$/.test(arg)) return { page: 'org', id: arg };
  if (head === 'requests') return { page: 'requests' };
  if (head === 'alerts') return { page: 'alerts' };
  if (head === 'audit')
    return { page: 'audit', org: arg && /^org_[0-9A-HJKMNP-TV-Z]{26}$/.test(arg) ? arg : null };
  if (head === 'dashboard') return { page: 'dashboard' };
  if (head === 'customers' && arg && /^org_[0-9A-HJKMNP-TV-Z]{26}$/.test(arg))
    return { page: 'customer', id: arg };
  if (head === 'customers') return q ? { page: 'customers', q } : { page: 'customers' };
  if (head === 'plans') return { page: 'plans' };
  if (head === 'operations') return { page: 'operations' };
  if (head === 'staff') return { page: 'staff' };
  return q ? { page: 'search', q } : { page: 'search' };
}

export const href = {
  search: '#/',
  org: (id: string) => `#/orgs/${id}`,
  requests: '#/requests',
  alerts: '#/alerts',
  audit: (org?: string) => (org ? `#/audit/${org}` : '#/audit'),
  dashboard: '#/dashboard',
  customers: '#/customers',
  customer: (id: string) => `#/customers/${id}`,
  plans: '#/plans',
  operations: '#/operations',
  staff: '#/staff',
};

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

// ---------------------------------------------------------------- shared context
interface Ctx {
  api: ConsoleApi;
  staff: Staff;
  has: (...roles: StaffRole[]) => boolean;
  /** R5: a staff permission (STAFF_ROLE_PERMISSIONS; the server checks it again). */
  can: (permission: StaffPermission) => boolean;
  /** A message for an error; a signed-out answer ends the session instead. */
  explain: (e: unknown) => string;
}
const ConsoleCtx = createContext<Ctx | null>(null);
export function useConsole(): Ctx {
  const c = useContext(ConsoleCtx);
  if (!c) throw new Error('outside the console');
  return c;
}

export function errorText(e: unknown): string {
  if (e instanceof ConsoleError) {
    const issues = (e.details.issues as { path: string; message: string }[] | undefined) ?? [];
    const extra = issues.length
      ? ` (${issues.map((i) => `${i.path || 'value'} ${i.message}`).join('; ')})`
      : '';
    return `${e.message}${extra}${e.requestId ? ` · reference ${e.requestId}` : ''}`;
  }
  return 'Something went wrong';
}

/** A page heading that takes focus when the page changes, so keyboard and screen reader users land on it. */
export function PageTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className="page-title">
      {children}
    </h1>
  );
}

export function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Callout tone="danger" role="alert">
      <p className="problem">{text}</p>
    </Callout>
  );
}

const STATE_TONE: Record<keyof typeof STATE_LABEL, Tone> = {
  trial: 'info',
  active: 'good',
  past_due: 'warn',
  grace: 'warn',
  restricted: 'bad',
  canceled: 'neutral',
};
export const stateTone = (state: keyof typeof STATE_LABEL): Tone => STATE_TONE[state];

export function StateBadge({ state }: { state: keyof typeof STATE_LABEL }) {
  return <Pill tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Pill>;
}

/** Where this console runs, from its address (the demo build says so itself). */
function environment(demo: boolean): { label: string; kind: 'demo' | 'local' | 'staging' | 'production' } {
  if (demo) return { label: 'Demo', kind: 'demo' };
  const host = window.location.hostname;
  if (/^(localhost|127\.|\[::1\])/.test(host)) return { label: 'Local', kind: 'local' };
  if (/(staging|stage|preview|test|dev)/i.test(host)) return { label: 'Staging', kind: 'staging' };
  return { label: 'Production', kind: 'production' };
}

// ---------------------------------------------------------------- app
export function App({ api }: { api: ConsoleApi }) {
  const [session, setSession] = useState<Session | null>(null);
  const [phase, setPhase] = useState<'loading' | 'out' | 'in'>('loading');
  const [message, setMessage] = useState<string | null>(null);

  const end = useCallback((why: string | null) => {
    setSession(null);
    setPhase('out');
    setMessage(why);
  }, []);

  useEffect(() => {
    let live = true;
    api
      .resume()
      .then((s) => {
        if (!live) return;
        if (s) {
          setSession(s);
          setPhase('in');
        } else setPhase('out');
      })
      .catch((e: unknown) => {
        if (live) end(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [api, end]);

  if (phase === 'loading') {
    return (
      <main className="boot" aria-busy="true">
        <BrandMark size={36} />
        <p>Loading…</p>
      </main>
    );
  }
  if (phase === 'out' || !session) {
    return (
      <SignIn
        api={api}
        message={message}
        onSignedIn={(s) => {
          setSession(s);
          setMessage(null);
          setPhase('in');
        }}
      />
    );
  }
  return <Shell api={api} session={session} onEnd={end} />;
}

function SignIn({
  api,
  message,
  onSignedIn,
}: {
  api: ConsoleApi;
  message: string | null;
  onSignedIn: (s: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(message);
  const env = environment(api.demo);
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const s = await api.signIn();
      if (s) onSignedIn(s);
    } catch (e) {
      setProblem(errorText(e));
      setBusy(false);
    }
  };
  return (
    <main className="signin">
      <div className="signin__brand">
        <div className="signin__logo">
          <BrandMark size={32} />
          <span>Project Browser</span>
          <span className="env" data-env={env.kind}>
            {env.label}
          </span>
        </div>
        <ProfileStack />
        <div className="signin__pitch">
          <p className="signin__lead">The staff console for customers, billing and platform health.</p>
          <ul className="signin__points">
            <li>
              <Icon name="lock" size={18} />
              <span>Member details open only with time-bound approval from a second support lead.</span>
            </li>
            <li>
              <Icon name="audit" size={18} />
              <span>Searches, views and changes land in a hash-chained platform audit.</span>
            </li>
            <li>
              <Icon name="clock" size={18} />
              <span>
                Sessions last {BILLING_TIMING.staffSessionMinutes} minutes and need a recent sign-in.
              </span>
            </li>
          </ul>
        </div>
      </div>
      <div className="signin__panel">
        <div className="signin-card">
          <h1>Support console</h1>
          <p>
            For Project Browser staff. Sign in with your staff account; the sign-in must be recent and the
            session lasts {BILLING_TIMING.staffSessionMinutes} minutes. Staff accounts are added on the server
            by an operator.
          </p>
          <p className="muted">
            Every search and view is recorded. Members and activity of an organization stay hidden until a
            different support lead approves time-bound access. Browser session data is never available here.
          </p>
          {api.demo && (
            <Callout tone="info" role="note">
              Demo build: fictional organizations, nothing leaves this page.
            </Callout>
          )}
          <Problem text={problem} />
          <button
            type="button"
            className="pb-button signin-card__go"
            data-variant="primary"
            disabled={busy}
            onClick={start}
          >
            {busy ? 'Signing in…' : 'Sign in with your staff account'}
          </button>
        </div>
      </div>
    </main>
  );
}

interface NavItem {
  key: Route['page'];
  label: string;
  to: string;
  icon: IconName;
  show: boolean;
}

function Shell({
  api,
  session,
  onEnd,
}: {
  api: ConsoleApi;
  session: Session;
  onEnd: (why: string | null) => void;
}) {
  const route = useRoute();
  const [left, setLeft] = useState(() => minutesLeft(session.expiresAt));
  useEffect(() => {
    const t = window.setInterval(() => {
      const m = minutesLeft(session.expiresAt);
      setLeft(m);
      if (m <= 0) onEnd('Your 30-minute session ended. Sign in again to continue.');
    }, 15_000);
    return () => window.clearInterval(t);
  }, [session.expiresAt, onEnd]);

  const has = useCallback(
    (...roles: StaffRole[]) => roles.some((r) => session.staff.roles.includes(r)),
    [session.staff.roles],
  );
  const explain = useCallback(
    (e: unknown) => {
      if (e instanceof ConsoleError && e.code === 'UNAUTHENTICATED') {
        onEnd('Your session ended. Sign in again to continue.');
      }
      return errorText(e);
    },
    [onEnd],
  );
  const can = useCallback(
    (permission: StaffPermission) => staffCan(session.staff.roles, permission),
    [session.staff.roles],
  );
  const ctx: Ctx = { api, staff: session.staff, has, can, explain };
  // R5: whether this session was opened with a one-time code (admin screens need it).
  const [mfa, setMfa] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api
      .adminMe()
      .then((me) => live && setMfa(me.mfa))
      .catch(() => live && setMfa(null));
    return () => {
      live = false;
    };
  }, [api]);
  const business = has('platform_owner', 'business_admin', 'business_analyst');
  const signOut = async () => {
    await api.signOut();
    onEnd('You signed out.');
  };

  const support = has('support', 'support_lead', 'billing_admin', 'platform_owner', 'business_admin');
  const groups: { id: string; label: string; items: NavItem[] }[] = [
    {
      id: 'nav-business',
      label: 'Business',
      items: [
        {
          key: 'dashboard',
          label: 'Dashboard',
          to: href.dashboard,
          icon: 'dashboard',
          show: can('admin.metrics.read'),
        },
        {
          key: 'customers',
          label: 'Customers',
          to: href.customers,
          icon: 'users',
          show: can('admin.customers.read'),
        },
        { key: 'plans', label: 'Plans', to: href.plans, icon: 'layers', show: can('admin.catalog.read') },
      ],
    },
    {
      id: 'nav-support',
      label: 'Support',
      items: [
        { key: 'search', label: 'Organizations', to: href.search, icon: 'building', show: support },
        { key: 'requests', label: 'Access requests', to: href.requests, icon: 'key', show: true },
        {
          key: 'alerts',
          label: 'Alerts',
          to: href.alerts,
          icon: 'bell',
          show: has('support_lead', 'billing_admin', 'platform_owner', 'business_admin', 'business_analyst'),
        },
        {
          key: 'audit',
          label: 'Audit',
          to: href.audit(),
          icon: 'audit',
          show: has('support_lead', 'billing_admin', 'platform_owner'),
        },
      ],
    },
    {
      id: 'nav-platform',
      label: 'Platform',
      items: [
        {
          key: 'operations',
          label: 'Operations',
          to: href.operations,
          icon: 'activity',
          show: can('admin.operations.read'),
        },
        { key: 'staff', label: 'Staff', to: href.staff, icon: 'shield', show: can('admin.staff.read') },
      ],
    },
  ];
  const navKey = route.page === 'org' ? 'search' : route.page === 'customer' ? 'customers' : route.page;
  // The first page: the dashboard for business roles, the organization search for support.
  const page: Route =
    route.page === 'search' && window.location.hash.replace(/^#\/?/, '') === '' && can('admin.metrics.read')
      ? { page: 'dashboard' }
      : route;
  const current = page.page === 'dashboard' ? 'dashboard' : navKey;
  const env = environment(api.demo);

  // The top bar's search: the customer list for business roles, the exact-match organization search for support.
  const searchTarget = can('admin.customers.read') ? 'customers' : support ? 'search' : null;
  const [gq, setGq] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (!searchRef.current) return;
      e.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const globalSearch = (e: FormEvent) => {
    e.preventDefault();
    const q = gq.trim();
    if (!q || !searchTarget) return;
    window.location.hash = `#/${searchTarget}?q=${encodeURIComponent(q)}`;
    setGq('');
  };

  const initials = session.staff.display_name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const sessionPct = Math.max(0, Math.min(100, (left / BILLING_TIMING.staffSessionMinutes) * 100));

  return (
    <ConsoleCtx.Provider value={ctx}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="app">
        <div className="sidebar">
          <div className="sidebar__brand">
            <BrandMark size={30} />
            <span className="sidebar__name">
              Project Browser <span className="sidebar__product">Admin</span>
            </span>
          </div>
          <p className="sidebar__env">
            <span className="env" data-env={env.kind}>
              {env.label}
            </span>
          </p>
          <nav className="tabs sidenav" aria-label="Console">
            {groups
              .map((g) => ({ ...g, items: g.items.filter((n) => n.show) }))
              .filter((g) => g.items.length > 0)
              .map((g) => (
                <div key={g.id} className="sidenav__group">
                  <p className="sidenav__label" id={g.id}>
                    {g.label}
                  </p>
                  <ul aria-labelledby={g.id}>
                    {g.items.map((n) => (
                      <li key={n.key}>
                        <a href={n.to} aria-current={current === n.key ? 'page' : undefined}>
                          <Icon name={n.icon} size={17} />
                          {n.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </nav>
          <p className="sidebar__foot">
            <Icon name="audit" size={15} />
            <span>Every view is recorded in the platform audit.</span>
          </p>
        </div>
        <div className="frame">
          <header className="topbar">
            {searchTarget ? (
              <search className="gsearch">
                <form onSubmit={globalSearch}>
                  <label htmlFor="global-q" className="pb-sr-only">
                    {searchTarget === 'customers' ? 'Search customers' : 'Find an organization'}
                  </label>
                  <Icon name="search" size={16} className="gsearch__icon" />
                  <input
                    ref={searchRef}
                    id="global-q"
                    type="search"
                    value={gq}
                    onChange={(e) => setGq(e.target.value)}
                    maxLength={254}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      searchTarget === 'customers'
                        ? 'Search customers by name, org_…, cus_… or e-mail'
                        : 'Find an organization by id, cus_… or exact e-mail'
                    }
                  />
                  <span className="gsearch__key" aria-hidden="true">
                    /
                  </span>
                </form>
              </search>
            ) : (
              <span />
            )}
            <div className="who">
              <span
                className={left <= 5 ? 'session session--ending' : 'session'}
                role="timer"
                aria-live="off"
              >
                <Icon name="clock" size={15} />
                <span>Session ends in {left} min</span>
                <svg
                  className="session__meter"
                  viewBox="0 0 100 4"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <rect className="session__track" width="100" height="4" rx="2" />
                  <rect className="session__fill" width={sessionPct} height="4" rx="2" />
                </svg>
              </span>
              <span className="who__chip">
                <span className="avatar" aria-hidden="true">
                  {initials}
                </span>
                <span className="who__text">
                  <strong>{session.staff.display_name}</strong> ·{' '}
                  <span className="who__roles">
                    {session.staff.roles.map((r) => ROLE_LABEL[r]).join(', ')}
                  </span>
                </span>
              </span>
              <button type="button" className="pb-button signout" onClick={signOut}>
                <Icon name="logout" size={15} />
                Sign out
              </button>
            </div>
          </header>
          <main id="main" className="content">
            {(left <= 5 || (business && mfa === false)) && (
              <div className="notices">
                {left <= 5 && (
                  <Callout tone="warn" role="status">
                    The session ends in {left} minute{left === 1 ? '' : 's'}; sign in again afterwards.
                  </Callout>
                )}
                {business && mfa === false && (
                  <Callout tone="warn" role="alert">
                    This session was opened without your one-time code. Business screens stay closed: sign out
                    and sign in again with your code.
                  </Callout>
                )}
              </div>
            )}
            {page.page === 'search' && <SearchPage key={page.q ?? ''} initial={page.q ?? ''} />}
            {page.page === 'org' && <OrgPage key={page.id} orgId={page.id} />}
            {page.page === 'requests' && <RequestsPage />}
            {page.page === 'alerts' && <AlertsPage />}
            {page.page === 'audit' && <AuditPage key={page.org ?? ''} org={page.org} />}
            {page.page === 'dashboard' && <DashboardPage />}
            {page.page === 'customers' && <CustomersPage key={page.q ?? ''} initial={page.q ?? ''} />}
            {page.page === 'customer' && <CustomerPage key={page.id} orgId={page.id} />}
            {page.page === 'plans' && <PlansPage />}
            {page.page === 'operations' && <OperationsPage />}
            {page.page === 'staff' && <StaffPage />}
          </main>
        </div>
      </div>
    </ConsoleCtx.Provider>
  );
}

// ---------------------------------------------------------------- search
function SearchPage({ initial }: { initial: string }) {
  const { api, explain } = useConsole();
  const [q, setQ] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<SupportSearchResult | null>(null);

  const run = useCallback(
    async (text: string) => {
      setBusy(true);
      setProblem(null);
      setResult(null);
      try {
        setResult(await api.search(text.trim()));
      } catch (err) {
        setResult(null);
        setProblem(explain(err));
      } finally {
        setBusy(false);
      }
    },
    [api, explain],
  );
  // A search handed over from the top bar runs once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for the initial words only
  useEffect(() => {
    if (initial.trim().length >= 3) void run(initial);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await run(q);
  };

  return (
    <section aria-labelledby="search-title" className="stack">
      <PageHeader
        title={
          <PageTitle>
            <span id="search-title">Find an organization</span>
          </PageTitle>
        }
        description="Look up one organization by an exact identifier to see its billing, limits and history."
      />
      <search className="card search-card">
        <form className="search" onSubmit={submit}>
          <label htmlFor="q">
            Organization id, payment customer id (cus_…) or a member’s exact e-mail address
          </label>
          <div className="search__row">
            <span className="input-icon">
              <Icon name="search" size={16} />
              <input
                id="q"
                className="search__input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                minLength={3}
                maxLength={254}
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="owner@company.com"
              />
            </span>
            <button type="submit" className="pb-button" data-variant="primary" data-size="lg" disabled={busy}>
              Search
            </button>
          </div>
          <p className="hint">
            <Icon name="lock" size={14} />
            Searches are recorded (e-mail addresses masked). There is no browsing or partial matching.
          </p>
        </form>
      </search>
      <Problem text={problem} />
      {busy && <Skeleton variant="rows" />}
      {result && (
        <Panel
          id="results-title"
          icon="building"
          title={
            result.items.length === 0
              ? 'No organization found'
              : `${result.items.length} organization${result.items.length === 1 ? '' : 's'}`
          }
        >
          {result.items.length === 0 ? (
            <EmptyState icon="search" title="Nothing matches those exact words">
              Check the spelling, or ask the customer for their organization id or the e-mail address they
              sign in with.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Organization</th>
                    <th scope="col">Id</th>
                    <th scope="col">Billing</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <a className="row-link" href={href.org(o.id)}>
                          {o.name}
                        </a>
                      </td>
                      <td className="mono">{o.id}</td>
                      <td>
                        <StateBadge state={o.state} />
                      </td>
                      <td className="num">{when(o.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
      {!result && !busy && !problem && (
        <EmptyState icon="building" title="Search to open an organization">
          Paste an id such as org_01J… or cus_…, or the exact e-mail address of a member. Partial names are
          not searched, so nothing is listed until you ask.
        </EmptyState>
      )}
    </section>
  );
}
