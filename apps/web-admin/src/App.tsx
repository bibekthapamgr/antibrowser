/**
 * The support console (milestone 11, ADR-0018): sign-in, then search → organization overview, access requests, alerts
 * and the platform audit. What a staff member may do comes from the server on every request; the screens only hide
 * actions their roles cannot take.
 */
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
import { type ConsoleApi, ConsoleError, type Session, type Staff } from './api.ts';
import { minutesLeft, ROLE_LABEL, STATE_LABEL, when } from './format.ts';
import { AlertsPage, AuditPage, RequestsPage } from './lists.tsx';
import { OrgPage } from './org.tsx';

// ---------------------------------------------------------------- routing (hash, so the server serves one page)
export type Route =
  | { page: 'search' }
  | { page: 'org'; id: string }
  | { page: 'requests' }
  | { page: 'alerts' }
  | { page: 'audit'; org: string | null };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [head, arg] = parts;
  if (head === 'orgs' && arg && /^org_[0-9A-HJKMNP-TV-Z]{26}$/.test(arg)) return { page: 'org', id: arg };
  if (head === 'requests') return { page: 'requests' };
  if (head === 'alerts') return { page: 'alerts' };
  if (head === 'audit')
    return { page: 'audit', org: arg && /^org_[0-9A-HJKMNP-TV-Z]{26}$/.test(arg) ? arg : null };
  return { page: 'search' };
}

export const href = {
  search: '#/',
  org: (id: string) => `#/orgs/${id}`,
  requests: '#/requests',
  alerts: '#/alerts',
  audit: (org?: string) => (org ? `#/audit/${org}` : '#/audit'),
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
    <p className="problem" role="alert">
      {text}
    </p>
  );
}

export function StateBadge({ state }: { state: keyof typeof STATE_LABEL }) {
  return (
    <span className="state" data-state={state}>
      {STATE_LABEL[state]}
    </span>
  );
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
      <main className="signin" aria-busy="true">
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
      <div className="signin-card">
        <p className="brand">Project Browser</p>
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
          <p className="demo-note" role="note">
            Demo build: fictional organizations, nothing leaves this page.
          </p>
        )}
        <Problem text={problem} />
        <button type="button" className="pb-button" data-variant="primary" disabled={busy} onClick={start}>
          {busy ? 'Signing in…' : 'Sign in with your staff account'}
        </button>
      </div>
    </main>
  );
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
  const ctx: Ctx = { api, staff: session.staff, has, explain };
  const signOut = async () => {
    await api.signOut();
    onEnd('You signed out.');
  };

  const nav: { key: Route['page']; label: string; to: string; show: boolean }[] = [
    { key: 'search', label: 'Organizations', to: href.search, show: true },
    { key: 'requests', label: 'Access requests', to: href.requests, show: true },
    { key: 'alerts', label: 'Alerts', to: href.alerts, show: has('support_lead', 'billing_admin') },
    { key: 'audit', label: 'Audit', to: href.audit(), show: has('support_lead', 'billing_admin') },
  ];
  const navKey = route.page === 'org' ? 'search' : route.page;

  return (
    <ConsoleCtx.Provider value={ctx}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <p className="brand">
          Project Browser <span>Support console</span>
          {api.demo && <span className="demo-tag">Demo</span>}
        </p>
        <div className="who">
          <span>
            {session.staff.display_name} · {session.staff.roles.map((r) => ROLE_LABEL[r]).join(', ')}
          </span>
          <span className={left <= 5 ? 'session session--ending' : 'session'} role="timer" aria-live="off">
            Session ends in {left} min
          </span>
          <button type="button" className="pb-button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <nav className="tabs" aria-label="Console">
        {nav
          .filter((n) => n.show)
          .map((n) => (
            <a key={n.key} href={n.to} aria-current={navKey === n.key ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
      </nav>
      <main id="main" className="content">
        {left <= 5 && (
          <p className="warn" role="status">
            The session ends in {left} minute{left === 1 ? '' : 's'}; sign in again afterwards.
          </p>
        )}
        {route.page === 'search' && <SearchPage />}
        {route.page === 'org' && <OrgPage key={route.id} orgId={route.id} />}
        {route.page === 'requests' && <RequestsPage />}
        {route.page === 'alerts' && <AlertsPage />}
        {route.page === 'audit' && <AuditPage key={route.org ?? ''} org={route.org} />}
      </main>
    </ConsoleCtx.Provider>
  );
}

// ---------------------------------------------------------------- search
function SearchPage() {
  const { api, explain } = useConsole();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<SupportSearchResult | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      setResult(await api.search(q.trim()));
    } catch (err) {
      setResult(null);
      setProblem(explain(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="search-title" className="stack">
      <PageTitle>
        <span id="search-title">Find an organization</span>
      </PageTitle>
      <search>
        <form className="search" onSubmit={submit}>
          <label htmlFor="q">
            Organization id, payment customer id (cus_…) or a member’s exact e-mail address
          </label>
          <div className="row">
            <input
              id="q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              minLength={3}
              maxLength={254}
              required
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="pb-button" data-variant="primary" disabled={busy}>
              Search
            </button>
          </div>
          <p className="muted small">
            Searches are recorded (e-mail addresses masked). There is no browsing or partial matching.
          </p>
        </form>
      </search>
      <Problem text={problem} />
      {result && (
        <section aria-labelledby="results-title">
          <h2 id="results-title">
            {result.items.length === 0
              ? 'No organization found'
              : `${result.items.length} organization${result.items.length === 1 ? '' : 's'}`}
          </h2>
          {result.items.length > 0 && (
            <table>
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
                      <a href={href.org(o.id)}>{o.name}</a>
                    </td>
                    <td className="mono">{o.id}</td>
                    <td>
                      <StateBadge state={o.state} />
                    </td>
                    <td>{when(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </section>
  );
}
