/**
 * R5 (ADR-0024): the business owner's screens — dashboard, customers, plans, operations and staff. What a staff member
 * may do comes from their roles (the same mapping the server enforces); the server checks every request again and
 * needs a session opened with a one-time code.
 */
import type {
  AdminCatalog,
  AdminCustomer,
  AdminCustomerDetail,
  AdminMetrics,
  AdminOperations,
  AdminStaff,
  DraftPrice,
  PlanDraft,
  PublishedPlan,
  Restriction,
  StaffPermission,
} from '@pb/contracts/admin';
import {
  BILLING_STATES,
  type BillingState,
  PLAN_FEATURES,
  PLAN_LIMIT_KEYS,
  type PlanFeatures,
  type PlanLimits,
} from '@pb/contracts/billing';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { href, PageTitle, Problem, StateBadge, useConsole } from './App.tsx';
import {
  ALERT_LABEL,
  ALERT_SEVERITY,
  bytes,
  day,
  initials,
  LIMIT_LABEL,
  limitValue,
  money,
  REASON_LABEL,
  ROLE_LABEL,
  SEVERITY_LABEL,
  STATE_LABEL,
  when,
} from './format.ts';
import {
  Callout,
  EmptyState,
  Icon,
  Meter,
  PageHeader,
  Panel,
  Pill,
  Skeleton,
  Stat,
  Toast,
  type Tone,
  toneOf,
} from './ui.tsx';

const FEATURE_LABEL: Record<string, string> = {
  team_sessions: 'Shared profiles',
  automation: 'Automation',
  api_tokens: 'API tokens',
  webhooks: 'Webhooks',
};

/** Loads with explicit loading / error states; `reload` fetches again. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const { explain } = useConsole();
  const [data, setData] = useState<T | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = useCallback(async () => {
    try {
      setData(await load());
      setProblem(null);
    } catch (e) {
      setProblem(explain(e));
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: callers pass their own dependency list
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, problem, reload: run };
}

/** A wide table that scrolls sideways on small screens; focusable so keyboard users can scroll it (axe). */
export function Scroll({ children, tall }: { children: ReactNode; tall?: boolean }) {
  const cls = tall ? 'table-wrap table-wrap--tall' : 'table-wrap';
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
    // biome-ignore lint/a11y/useSemanticElements: a section would add a landmark per table
    <div className={cls} tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)">
      {children}
    </div>
  );
}

function Loading({ problem }: { problem: string | null }) {
  return problem ? <Problem text={problem} /> : <Skeleton />;
}

const sumText = (items: { currency: string; amount_minor: number }[]) =>
  items.length === 0 ? '—' : items.map((m) => money(m.amount_minor, m.currency)).join(' · ');

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- dashboard
export function DashboardPage() {
  const { api } = useConsole();
  const { data: m, problem } = useLoad<AdminMetrics>(() => api.metrics(), [api]);
  return (
    <section className="stack" aria-labelledby="dash-title">
      <PageHeader
        title={
          <PageTitle>
            <span id="dash-title">Dashboard</span>
          </PageTitle>
        }
        meta={
          m && (
            <span className="asof">
              <Icon name="clock" size={14} /> Numbers as of {when(m.generated_at)}
            </span>
          )
        }
        description="Billing states as last observed by the worker (at most a few minutes old). Internal and test workspaces are not counted."
      />
      {!m ? (
        <Loading problem={problem} />
      ) : (
        <>
          <ul className="stats" aria-label="Customers">
            <Stat
              icon="users"
              label="Active customers"
              value={m.workspaces.active_customers.toLocaleString()}
              hint="trial, active, past due, grace"
            />
            <Stat
              icon="card"
              label="Paying"
              value={m.workspaces.paying.toLocaleString()}
              hint="active provider subscription"
            />
            <Stat
              icon="activity"
              label="New in 30 days"
              value={m.workspaces.new_last_30_days.toLocaleString()}
              hint={`${m.workspaces.complimentary.toLocaleString()} complimentary (beta and other no-charge plans)`}
            />
            <Stat
              icon="bell"
              label="Open alerts"
              value={m.alerts.open.toLocaleString()}
              tone={m.alerts.open > 0 ? 'bad' : 'good'}
              status={m.alerts.open > 0 ? 'Needs attention' : 'All clear'}
            />
          </ul>

          <Panel
            id="mix-title"
            icon="users"
            title="Customers by billing state"
            description={`${m.workspaces.total.toLocaleString()} workspaces in all.`}
          >
            <StateMix byState={m.workspaces.by_state} />
          </Panel>

          <div className="grid-main">
            <Panel
              id="mrr-title"
              icon="card"
              title="Monthly recurring revenue"
              description="Active provider subscriptions at their list price × quantity, per month (yearly ÷ 12). Each currency on its own line — never converted."
            >
              {m.mrr.length === 0 ? (
                <EmptyState icon="card" title="No paying subscriptions yet">
                  Revenue appears here once a customer completes checkout.
                </EmptyState>
              ) : (
                <Scroll>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Currency</th>
                        <th scope="col" className="num">
                          Recurring revenue
                        </th>
                        <th scope="col" className="num">
                          Subscriptions
                        </th>
                        <th scope="col" className="num">
                          Of which canceling
                        </th>
                        <th scope="col" className="num">
                          At risk (past due, grace)
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.mrr.map((r) => (
                        <tr key={r.currency}>
                          <th scope="row">{r.currency.toUpperCase()}</th>
                          <td className="num strong">{money(r.amount_minor, r.currency)}</td>
                          <td className="num">{r.subscriptions}</td>
                          <td className="num">{money(r.canceling_amount_minor, r.currency)}</td>
                          <td className={r.at_risk_amount_minor > 0 ? 'num warn-text' : 'num'}>
                            {money(r.at_risk_amount_minor, r.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroll>
              )}
              <dl className="facts facts--inline">
                <div>
                  <dt>Cash collected, last 30 days</dt>
                  <dd>{sumText(m.cash_collected_30d)}</dd>
                </div>
                <div>
                  <dt>Refunds, last 30 days</dt>
                  <dd>{sumText(m.refunds_30d)}</dd>
                </div>
              </dl>
              {m.gaps.length > 0 && (
                <Callout tone="info" title="Known gaps">
                  <ul className="bullets">
                    {m.gaps.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </Callout>
              )}
            </Panel>

            <div className="stack">
              <Panel
                id="dash-alerts-title"
                icon="bell"
                title="Payment alerts"
                actions={
                  <a className="link-action" href={href.alerts}>
                    Open alerts
                    <Icon name="chevron" size={14} />
                  </a>
                }
              >
                {m.alerts.open === 0 ? (
                  <EmptyState icon="check" title="No open alerts.">
                    The billing worker raises one when the provider and this server disagree.
                  </EmptyState>
                ) : (
                  <ul className="alert-list">
                    {Object.entries(m.alerts.by_kind)
                      .sort(([a], [b]) => sevRank(a) - sevRank(b))
                      .map(([k, n]) => {
                        const sev = ALERT_SEVERITY[k as keyof typeof ALERT_SEVERITY] ?? 'warning';
                        return (
                          <li key={k}>
                            <SeverityPill severity={sev} />
                            <span className="alert-list__name">
                              {ALERT_LABEL[k as keyof typeof ALERT_LABEL] ?? k}
                            </span>
                            <span className="count">{n}</span>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </Panel>

              <Panel id="fresh-title" icon="refresh" title="Data freshness">
                <dl className="health">
                  <HealthRow
                    label="Last provider event applied"
                    tone={m.freshness.last_webhook_processed ? 'good' : 'neutral'}
                  >
                    {when(m.freshness.last_webhook_processed)}
                  </HealthRow>
                  <HealthRow
                    label="Oldest provider confirmation"
                    tone={m.freshness.oldest_subscription_sync ? 'good' : 'neutral'}
                  >
                    {when(m.freshness.oldest_subscription_sync)}
                  </HealthRow>
                  <HealthRow
                    label="Events waiting / failed"
                    tone={
                      m.freshness.webhooks_failed > 0
                        ? 'bad'
                        : m.freshness.webhooks_pending > 0
                          ? 'warn'
                          : 'good'
                    }
                  >
                    {m.freshness.webhooks_pending} / {m.freshness.webhooks_failed}
                  </HealthRow>
                </dl>
              </Panel>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

const sevRank = (kind: string) =>
  ({ critical: 0, warning: 1, notice: 2 })[ALERT_SEVERITY[kind as keyof typeof ALERT_SEVERITY] ?? 'warning'];

export function SeverityPill({ severity }: { severity: 'critical' | 'warning' | 'notice' }) {
  const tone: Tone = severity === 'critical' ? 'bad' : severity === 'warning' ? 'warn' : 'info';
  return <Pill tone={tone}>{SEVERITY_LABEL[severity]}</Pill>;
}

function HealthRow({ label, tone, children }: { label: string; tone: Tone; children: ReactNode }) {
  return (
    <div className="health__row" data-tone={tone}>
      <dt>
        <span className="health__dot" aria-hidden="true" />
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Share of workspaces in each billing state: one stacked bar plus a legend that carries every number. */
const MIX_ORDER: BillingState[] = ['active', 'trial', 'past_due', 'grace', 'restricted', 'canceled'];
function StateMix({ byState }: { byState: Record<BillingState, number> }) {
  const total = MIX_ORDER.reduce((n, s) => n + (byState[s] ?? 0), 0);
  const segments: { state: BillingState; x: number; w: number; n: number }[] = [];
  let x = 0;
  const shown = MIX_ORDER.filter((s) => (byState[s] ?? 0) > 0);
  const gap = 0.5;
  const usable = 100 - gap * Math.max(0, shown.length - 1);
  for (const s of shown) {
    const n = byState[s] ?? 0;
    const w = total ? (n / total) * usable : 0;
    segments.push({ state: s, x, w, n });
    x += w + gap;
  }
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : '0%');
  return (
    <div className="mix">
      {total > 0 && (
        <svg
          className="mix__bar"
          viewBox="0 0 100 10"
          preserveAspectRatio="none"
          role="img"
          aria-label="Share of workspaces by billing state (numbers in the list below)"
        >
          {segments.map((g) => (
            <rect
              key={g.state}
              className="mix__seg"
              data-state={g.state}
              x={g.x}
              y="0"
              width={g.w}
              height="10"
            >
              <title>{`${STATE_LABEL[g.state]}: ${g.n} (${pct(g.n)})`}</title>
            </rect>
          ))}
        </svg>
      )}
      <ul className="mix__legend">
        {MIX_ORDER.map((s) => (
          <li key={s} data-empty={(byState[s] ?? 0) === 0 ? 'true' : undefined}>
            <span className="mix__swatch" data-state={s} aria-hidden="true" />
            <span className="mix__label">{s === 'trial' ? 'On trial' : STATE_LABEL[s]}</span>
            <span className="mix__n">{(byState[s] ?? 0).toLocaleString()}</span>
            <span className="mix__pct">{pct(byState[s] ?? 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- customers
export function CustomersPage({ initial = '' }: { initial?: string }) {
  const { api, explain, can } = useConsole();
  const [q, setQ] = useState(initial);
  const [state, setState] = useState('');
  const [plan, setPlan] = useState('');
  const [items, setItems] = useState<AdminCustomer[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor: string | null) => {
      setBusy(true);
      setProblem(null);
      try {
        const page = await api.customers({
          ...(q.trim() ? { q: q.trim() } : {}),
          ...(state ? { state: state as BillingState } : {}),
          ...(plan.trim() ? { plan: plan.trim() } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 25,
        });
        setItems((prev) => (cursor && prev ? [...prev, ...page.items] : page.items));
        setNext(page.next_cursor);
      } catch (e) {
        setProblem(explain(e));
      } finally {
        setBusy(false);
      }
    },
    [api, q, state, plan, explain],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first page loads once; filters apply on submit
  useEffect(() => {
    void load(null);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void load(null);
  };
  const filtered = Boolean(q.trim() || state || plan.trim());

  return (
    <section className="stack" aria-labelledby="customers-title">
      <PageHeader
        title={
          <PageTitle>
            <span id="customers-title">Customers</span>
          </PageTitle>
        }
        description={
          <>
            Every page you open is recorded in the platform audit.
            {!can('admin.customers.contact') && ' Owner addresses are masked for your role.'}
          </>
        }
      />
      <div className="card card--flush">
        <form className="filters" onSubmit={submit} aria-label="Find customers">
          <label className="filters__grow">
            Search
            <span className="input-icon">
              <Icon name="search" size={16} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                maxLength={120}
                placeholder="Name, org_…, cus_… or an owner’s e-mail"
                spellCheck={false}
              />
            </span>
          </label>
          <label>
            State
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Any</option>
              {BILLING_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Plan
            <input value={plan} onChange={(e) => setPlan(e.target.value)} maxLength={32} placeholder="team" />
          </label>
          <button type="submit" className="pb-button" data-variant="primary" disabled={busy}>
            Show
          </button>
        </form>
        <Problem text={problem} />
        {items === null ? (
          !problem && <Skeleton variant="rows" />
        ) : items.length === 0 ? (
          <EmptyState icon="users" title="No customers match.">
            {filtered
              ? 'Try fewer filters, the start of the workspace name, or the owner’s full e-mail address.'
              : 'Workspaces appear here as soon as someone signs up.'}
          </EmptyState>
        ) : (
          <>
            <Scroll tall>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Workspace</th>
                    <th scope="col">Plan</th>
                    <th scope="col">State</th>
                    <th scope="col" className="num">
                      Members
                    </th>
                    <th scope="col" className="num">
                      Profiles
                    </th>
                    <th scope="col">Owner</th>
                    <th scope="col">Last active</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.id}>
                      <th scope="row">
                        <span className="cell-entity">
                          <span className="entity-avatar" aria-hidden="true">
                            {initials(c.name)}
                          </span>
                          <a className="row-link" href={href.customer(c.id)}>
                            {c.name}
                          </a>
                          {c.suspended && <Pill tone="bad">Suspended</Pill>}
                          {c.restricted && <Pill tone="bad">Restricted</Pill>}
                        </span>
                      </th>
                      <td>
                        {c.plan_name} <span className="muted small mono">@{c.plan_version}</span>
                      </td>
                      <td>
                        <StateBadge state={c.state} />
                      </td>
                      <td className="num">{c.member_count}</td>
                      <td className="num">{c.profile_count}</td>
                      <td className="mono small">{c.owner_email ?? '—'}</td>
                      <td className="nowrap">{when(c.last_active_at)}</td>
                      <td className="nowrap">{day(c.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
            <div className="table-foot">
              <span className="muted small">
                Showing {plural(items.length, 'workspace')}
                {next ? ' — more available' : ''}
              </span>
              {next && (
                <button type="button" className="pb-button" disabled={busy} onClick={() => void load(next)}>
                  Show more
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- one customer
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <p className="back">
      <a href={to}>
        <Icon name="back" size={15} />
        {children}
      </a>
    </p>
  );
}

export function CustomerPage({ orgId }: { orgId: string }) {
  const { api, can, has } = useConsole();
  const { data: d, problem, reload } = useLoad<AdminCustomerDetail>(() => api.customer(orgId), [api, orgId]);
  if (!d) {
    return (
      <section className="stack">
        <BackLink to={href.customers}>All customers</BackLink>
        <Loading problem={problem} />
      </section>
    );
  }
  const b = d.billing;
  const priceText = b.price
    ? `${money(b.price.amount_minor * b.price.quantity, b.price.currency)} every ${b.price.interval_count > 1 ? `${b.price.interval_count} ` : ''}${b.price.interval}${b.price.interval_count > 1 ? 's' : ''}`
    : '—';
  return (
    <article className="stack" aria-labelledby="customer-title">
      <BackLink to={href.customers}>All customers</BackLink>
      <div className="detail-head">
        <span className="entity-avatar entity-avatar--lg" aria-hidden="true">
          {initials(d.customer.name)}
        </span>
        <div className="detail-head__text">
          <div className="detail-head__title">
            <PageTitle>
              <span id="customer-title">{d.customer.name}</span>
            </PageTitle>
            <StateBadge state={b.state} />
          </div>
          <p className="detail-head__meta">
            <span className="mono">{d.customer.id}</span>
            <span>created {day(d.customer.created_at)}</span>
            <span>
              owner <span className="mono">{d.customer.owner_email ?? '—'}</span>
            </span>
          </p>
        </div>
        {has('support', 'support_lead', 'billing_admin', 'platform_owner', 'business_admin') && (
          <div className="detail-head__actions">
            <a className="pb-button" href={href.org(d.customer.id)}>
              <Icon name="building" size={15} />
              Support view (members with approval, overrides)
            </a>
          </div>
        )}
      </div>
      <Problem text={problem} />

      <dl className="keyfacts">
        <div>
          <dt>Plan</dt>
          <dd>{b.plan_name}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>{priceText}</dd>
        </div>
        <div>
          <dt>Current period ends</dt>
          <dd>{day(b.current_period_end)}</dd>
        </div>
        <div>
          <dt>Signed-in computers</dt>
          <dd>{d.devices.active}</dd>
        </div>
      </dl>

      <div className="grid-2">
        <Panel
          id="c-billing-title"
          icon="card"
          title="Billing"
          actions={
            can('admin.operations.act') && b.provider_customer_id ? <Resync orgId={d.customer.id} /> : null
          }
        >
          <dl className="facts">
            <div>
              <dt>Plan</dt>
              <dd>
                {b.plan_name}{' '}
                <span className="mono muted">
                  ({b.plan_id}@{b.plan_version})
                </span>
              </dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                {STATE_LABEL[b.state]} — {REASON_LABEL[b.reason]}
                {b.until && ` until ${when(b.until)}`}
              </dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>{priceText}</dd>
            </div>
            <div>
              <dt>Current period ends</dt>
              <dd>
                {when(b.current_period_end)}
                {b.cancel_at_period_end && ' (cancels then)'}
              </dd>
            </div>
            <div>
              <dt>Payment customer</dt>
              <dd className="mono">{b.provider_customer_id ?? '—'}</dd>
            </div>
            <div>
              <dt>Last confirmed with provider</dt>
              <dd>{when(b.synced_at)}</dd>
            </div>
          </dl>
        </Panel>

        <Panel id="c-usage-title" icon="sliders" title="Usage">
          <table className="table table--usage">
            <thead>
              <tr>
                <th scope="col">Limit</th>
                <th scope="col" className="num">
                  Used
                </th>
                <th scope="col" className="num">
                  Allowed
                </th>
              </tr>
            </thead>
            <tbody>
              {(['profiles', 'seats', 'storage_bytes'] as const).map((k) => (
                <tr key={k}>
                  <th scope="row">
                    {LIMIT_LABEL[k]}
                    <Meter value={d.usage[k]} max={b.limits[k]} tone={usageTone(d.usage[k], b.limits[k])} />
                  </th>
                  <td className="num">{limitValue(k, d.usage[k])}</td>
                  <td className="num">{limitValue(k, b.limits[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="panel__note">
            Members by role:{' '}
            {Object.entries(d.members_by_role)
              .map(([r, n]) => `${n} ${r}`)
              .join(', ') || 'none'}
            . Signed-in computers: {d.devices.active}
            {Object.keys(d.devices.by_platform).length > 0 &&
              ` (${Object.entries(d.devices.by_platform)
                .map(([p, n]) => `${n} ${p}`)
                .join(', ')})`}
            . Names and addresses of members need approved access in the support view.
          </p>
        </Panel>
      </div>

      <Restrictions detail={d} onChanged={reload} />
      {can('admin.notes.read') && <Notes detail={d} onChanged={reload} />}

      <div className="grid-2">
        <Panel id="c-invoices-title" icon="card" title="Invoices">
          {d.invoices.length === 0 ? (
            <EmptyState title="No invoices yet.">The first invoice appears after checkout.</EmptyState>
          ) : (
            <Scroll>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Number</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Due
                    </th>
                    <th scope="col" className="num">
                      Paid
                    </th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {d.invoices.map((i) => (
                    <tr key={i.id}>
                      <td className="mono">{i.number ?? i.id}</td>
                      <td>
                        <Pill tone={toneOf(i.status)}>{i.status}</Pill>
                      </td>
                      <td className="num">{money(i.amount_due_minor, i.currency)}</td>
                      <td className="num">{money(i.amount_paid_minor, i.currency)}</td>
                      <td className="nowrap">{when(i.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          )}
        </Panel>

        <Panel id="c-events-title" icon="zap" title="Payment provider events">
          {d.events.length === 0 ? (
            <EmptyState title="No events.">
              Events arrive when the payment provider reports a change.
            </EmptyState>
          ) : (
            <ul className="timeline">
              {d.events.map((e) => (
                <li key={e.provider_event_id}>
                  <span className="timeline__dot" data-tone={toneOf(e.status)} aria-hidden="true" />
                  <div>
                    <p>
                      <span className="mono">{e.type}</span> — <Pill tone={toneOf(e.status)}>{e.status}</Pill>
                    </p>
                    <p className="muted small">
                      {when(e.received_at)}
                      {e.error && ` · ${e.error}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel id="c-audit-title" icon="audit" title="Support audit">
        {d.audit.length === 0 ? (
          <EmptyState icon="audit" title="Nothing recorded yet." />
        ) : (
          <ul className="timeline">
            {d.audit.map((a) => (
              <li key={`${a.at}-${a.action}-${a.target ?? ''}`}>
                <span className="timeline__dot" aria-hidden="true" />
                <div>
                  <p className="mono small">{a.action}</p>
                  <p className="muted small">{when(a.at)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </article>
  );
}

export const usageTone = (used: number, max: number | null): Tone =>
  max === null ? 'neutral' : used > max ? 'bad' : used >= max * 0.85 ? 'warn' : 'accent';

function Resync({ orgId }: { orgId: string }) {
  const { api, explain } = useConsole();
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async () => {
    setProblem(null);
    try {
      const queued = await api.adminResync(orgId);
      setNote(
        queued ? 'Queued: confirmed with the payment provider within a few minutes.' : 'Nothing to confirm.',
      );
    } catch (e) {
      setProblem(explain(e));
    }
  };
  return (
    <>
      <button type="button" className="pb-button" data-size="sm" onClick={run}>
        <Icon name="refresh" size={14} />
        Confirm with the payment provider now
      </button>
      <Toast text={note} onDismiss={() => setNote(null)} />
      {problem && (
        <span className="problem-inline" role="alert">
          {problem}
        </span>
      )}
    </>
  );
}

function Restrictions({
  detail,
  onChanged,
}: {
  detail: AdminCustomerDetail;
  onChanged: () => Promise<void>;
}) {
  const { api, explain, can } = useConsole();
  const canPay = can('admin.restrictions.payment');
  const canSec = can('admin.restrictions.security');
  const [kind, setKind] = useState<'payment' | 'security'>('payment');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('');
  const [notify, setNotify] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [lifting, setLifting] = useState<Restriction | null>(null);
  const [liftReason, setLiftReason] = useState('');

  const apply = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    setDone(null);
    try {
      const n = Number(days);
      await api.restrict({
        kind,
        scope: 'workspace',
        org_id: detail.customer.id,
        reason: reason.trim(),
        ...(days && n > 0 ? { expires_at: new Date(Date.now() + n * 86_400_000).toISOString() } : {}),
        notify,
      });
      setDone(
        kind === 'payment'
          ? 'Restricted: creating and opening profiles stopped; everything else keeps working.'
          : 'Suspended: all access stopped, open profiles were closed and API tokens revoked.',
      );
      setReason('');
      setDays('');
      await onChanged();
    } catch (err) {
      setProblem(explain(err));
    }
  };
  const lift = async (e: FormEvent) => {
    e.preventDefault();
    if (!lifting) return;
    setProblem(null);
    try {
      await api.liftRestriction(lifting.id, liftReason.trim());
      setDone('Lifted. The owners were told by e-mail.');
      setLifting(null);
      setLiftReason('');
      await onChanged();
    } catch (err) {
      setProblem(explain(err));
    }
  };
  const active = detail.restrictions.filter((r) => r.active);
  return (
    <Panel
      id="c-restr-title"
      icon="ban"
      title="Restrictions"
      description="Nothing is ever deleted. Each change is recorded and visible to the workspace’s owners."
    >
      {detail.restrictions.length === 0 ? (
        <p className="muted none">None.</p>
      ) : (
        <ul className="rows">
          {detail.restrictions.map((r) => (
            <li key={r.id} className="rows__item">
              <div className="rows__main">
                <p>
                  <strong>{r.kind === 'payment' ? 'Payment restriction' : 'Security suspension'}</strong>{' '}
                  {r.scope === 'account' && '(one account) '}—{' '}
                  <Pill tone={r.active ? 'bad' : 'neutral'}>
                    {r.active ? 'active' : r.lifted_at ? 'lifted' : 'expired'}
                  </Pill>
                  {r.expires_at && r.active && `, until ${when(r.expires_at)}`}
                </p>
                <p className="muted small">
                  {r.reason} · {when(r.created_at)}
                </p>
              </div>
              {r.active && ((r.kind === 'payment' && canPay) || (r.kind === 'security' && canSec)) && (
                <button
                  type="button"
                  className="pb-button"
                  data-size="sm"
                  aria-label={`Lift ${r.kind} restriction`}
                  onClick={() => setLifting(r)}
                >
                  Lift…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {lifting && (
        <form className="form form--inset" onSubmit={lift} aria-label="Lift the restriction">
          <div className="field">
            <label htmlFor="lift-reason">Why is it lifted? (at least 20 characters)</label>
            <textarea
              id="lift-reason"
              value={liftReason}
              minLength={20}
              maxLength={500}
              required
              onChange={(e) => setLiftReason(e.target.value)}
            />
          </div>
          <div className="actions">
            <button
              type="submit"
              className="pb-button"
              data-variant="primary"
              disabled={liftReason.trim().length < 20}
            >
              Lift restriction
            </button>
            <button type="button" className="pb-button" onClick={() => setLifting(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {(canPay || canSec) && active.length < 2 && (
        <form className="form form--danger" onSubmit={apply} aria-label="Restrict this workspace">
          <fieldset>
            <legend>Restrict this workspace</legend>
            <div className="choices">
              {canPay && (
                <label className="choice choice--card">
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === 'payment'}
                    onChange={() => setKind('payment')}
                  />{' '}
                  <span>
                    <strong>Payment restriction</strong> — stop creating and opening profiles; data, export
                    and billing stay available
                  </span>
                </label>
              )}
              {canSec && (
                <label className="choice choice--card">
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === 'security'}
                    onChange={() => setKind('security')}
                  />{' '}
                  <span>
                    <strong>Security suspension</strong> — stop all access now, close open profiles, revoke
                    API tokens
                  </span>
                </label>
              )}
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="restr-reason">Reason (recorded; not sent to the customer)</label>
            <textarea
              id="restr-reason"
              value={reason}
              minLength={20}
              maxLength={500}
              required
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="restr-days">Ends after how many days? (empty: until lifted)</label>
              <input
                id="restr-days"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
            <label className="choice">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> E-mail
              the workspace’s owners
            </label>
          </div>
          <div className="actions">
            <button
              type="submit"
              className="pb-button"
              data-variant="danger"
              disabled={reason.trim().length < 20 || (kind === 'payment' ? !canPay : !canSec)}
            >
              {kind === 'payment' ? 'Restrict workspace' : 'Suspend workspace'}
            </button>
          </div>
        </form>
      )}
      <Toast text={done} onDismiss={() => setDone(null)} />
      <Problem text={problem} />
    </Panel>
  );
}

function Notes({ detail, onChanged }: { detail: AdminCustomerDetail; onChanged: () => Promise<void> }) {
  const { api, explain, can } = useConsole();
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    try {
      const n = await api.addNote(detail.customer.id, body.trim());
      setDone(
        n.redacted ? 'Saved. Card numbers, passwords or keys in it were replaced with [redacted].' : 'Saved.',
      );
      setBody('');
      await onChanged();
    } catch (err) {
      setProblem(explain(err));
    }
  };
  return (
    <Panel id="c-notes-title" icon="note" title="Case notes">
      {detail.notes.length === 0 ? (
        <p className="muted none">No notes yet.</p>
      ) : (
        <ul className="notes">
          {detail.notes.map((n) => (
            <li key={n.id}>
              <span className="avatar avatar--sm" aria-hidden="true">
                {initials(n.author_name)}
              </span>
              <div>
                <p className="notes__meta">
                  <strong>{n.author_name}</strong> · {when(n.created_at)}
                  {n.redacted && ' · redacted'}
                </p>
                <p className="notes__body">{n.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {can('admin.notes.write') && (
        <form className="form form--inset" onSubmit={add}>
          <div className="field">
            <label htmlFor="note-body">Add a note (never paste card numbers, passwords or keys)</label>
            <textarea
              id="note-body"
              value={body}
              maxLength={2000}
              required
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="actions">
            <button type="submit" className="pb-button" disabled={body.trim().length < 3}>
              Add note
            </button>
          </div>
        </form>
      )}
      <Toast text={done} onDismiss={() => setDone(null)} />
      <Problem text={problem} />
    </Panel>
  );
}

// ---------------------------------------------------------------- plans
const digitsOf = (currency: string) => {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
};
const toMinor = (major: string, currency: string): number | null => {
  const v = Number(major);
  if (!major.trim() || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 10 ** digitsOf(currency));
};
const toMajor = (minor: number, currency: string) => String(minor / 10 ** digitsOf(currency));
const GiB = 1024 ** 3;

export function PlansPage() {
  const { api, can, explain } = useConsole();
  const { data: cat, problem, reload } = useLoad<AdminCatalog>(() => api.catalog(), [api]);
  const [editing, setEditing] = useState<PlanDraft | null>(null);
  const [newId, setNewId] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startDraft = async (planId: string, fromPublished: boolean) => {
    setError(null);
    setNote(null);
    try {
      const d = await api.createDraft(
        fromPublished
          ? { plan_id: planId, from_published: true }
          : {
              plan_id: planId,
              from_published: false,
              name: planId.charAt(0).toUpperCase() + planId.slice(1),
              description: '',
              purchasable: false,
              limits: { profiles: 100, seats: 1, storage_bytes: 10 * GiB, automation_concurrency: 1 },
              features: { team_sessions: false, automation: false, api_tokens: false, webhooks: false },
              prices: [],
            },
      );
      setEditing(d);
      await reload();
    } catch (e) {
      setError(explain(e));
    }
  };

  const header = (
    <PageHeader
      title={
        <PageTitle>
          <span id="plans-title">Plans</span>
        </PageTitle>
      }
      description={
        // Shown once the catalog has loaded, so the page reads as ready only when the plans are there.
        cat ? (
          <>
            A published plan version never changes. Changes are made in a draft and published as a new
            version: new purchases use it, while workspaces keep the version and price they bought.
            {!cat.provider &&
              ' The payment provider is not configured on this server: only plans without prices can be published.'}
          </>
        ) : undefined
      }
    />
  );
  if (!cat) {
    return (
      <section className="stack" aria-labelledby="plans-title">
        {header}
        <Loading problem={problem} />
      </section>
    );
  }
  const current = cat.plans.filter((p) => p.current);
  const older = cat.plans.filter((p) => !p.current);
  return (
    <section className="stack" aria-labelledby="plans-title">
      {header}
      <Toast text={note} onDismiss={() => setNote(null)} />
      <Problem text={error} />
      <Panel
        id="catalog-title"
        icon="layers"
        title="Current plans"
        actions={
          can('admin.catalog.edit') && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void startDraft(newId.trim(), false);
              }}
              aria-label="New plan"
            >
              <label htmlFor="new-plan">New plan id</label>
              <input
                id="new-plan"
                className="inline-form__input"
                value={newId}
                onChange={(e) => setNewId(e.target.value.toLowerCase())}
                pattern="[a-z][a-z0-9_]{1,31}"
                placeholder="pro"
                required
              />
              <button type="submit" className="pb-button" data-size="sm">
                Start a new plan
              </button>
            </form>
          )
        }
      >
        <Scroll>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Sold</th>
                <th scope="col">Prices</th>
                <th scope="col">Profiles / seats / storage</th>
                <th scope="col" className="num">
                  Workspaces
                </th>
                <th scope="col">Published</th>
                {can('admin.catalog.edit') && (
                  <th scope="col">
                    <span className="pb-sr-only">Change</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {current.map((p) => (
                <PlanRow key={`${p.id}@${p.version}`} p={p} onDraft={() => void startDraft(p.id, true)} />
              ))}
            </tbody>
          </table>
        </Scroll>
        {older.length > 0 && (
          <details className="disclosure">
            <summary>Earlier versions ({older.length})</summary>
            <Scroll>
              <table className="table">
                <tbody>
                  {older.map((p) => (
                    <PlanRow key={`${p.id}@${p.version}`} p={p} />
                  ))}
                </tbody>
              </table>
            </Scroll>
          </details>
        )}
      </Panel>

      <Panel id="drafts-title" icon="note" title="Drafts">
        {cat.drafts.length === 0 ? (
          <EmptyState icon="note" title="No open drafts.">
            Start one with “New version…” on a plan, or a new plan id.
          </EmptyState>
        ) : (
          <ul className="rows">
            {cat.drafts.map((d) => (
              <li key={d.id} className="rows__item">
                <div className="rows__main">
                  <p>
                    <strong>{d.name}</strong>{' '}
                    <span className="mono muted small">
                      ({d.plan_id}, from {d.base_version ? `@${d.base_version}` : 'new'})
                    </span>{' '}
                    <Pill tone={d.state === 'publishing' ? 'warn' : 'neutral'}>
                      {d.state === 'publishing' ? 'publishing…' : 'draft'}
                    </Pill>
                  </p>
                  {d.last_error && <p className="problem-inline">Last attempt failed: {d.last_error}</p>}
                </div>
                {can('admin.catalog.edit') && d.state === 'draft' && (
                  <button
                    type="button"
                    className="pb-button"
                    data-size="sm"
                    onClick={() => setEditing(d)}
                    aria-label={`Edit draft ${d.name}`}
                  >
                    Edit
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {editing && (
        <DraftEditor
          key={editing.id}
          draft={editing}
          provider={cat.provider}
          onDone={async (msg, d) => {
            setEditing(d);
            if (msg) setNote(msg);
            await reload();
          }}
        />
      )}

      <Panel id="pubs-title" icon="history" title="Publication history">
        {cat.publications.length === 0 ? (
          <EmptyState icon="history" title="Nothing published from the console yet." />
        ) : (
          <ul className="timeline">
            {cat.publications.map((p) => (
              <li key={p.id}>
                <span className="timeline__dot" data-tone={toneOf(p.state)} aria-hidden="true" />
                <div>
                  <p>
                    <span className="mono">
                      {p.plan_id}@{p.version}
                    </span>{' '}
                    — <Pill tone={toneOf(p.state)}>{p.state}</Pill>
                    {p.error && <span className="muted"> ({p.error})</span>}
                  </p>
                  <p className="muted small">{when(p.started_at)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}

function PlanRow({ p, onDraft }: { p: PublishedPlan; onDraft?: () => void }) {
  const { can } = useConsole();
  return (
    <tr>
      <th scope="row">
        <span className="plan-name">{p.name}</span>{' '}
        <span className="mono small muted">
          {p.id}@{p.version}
        </span>
      </th>
      <td>{p.purchasable ? <Pill tone="good">Yes</Pill> : <Pill>No</Pill>}</td>
      <td className="nowrap">
        {p.prices.length === 0
          ? p.purchasable
            ? 'Server setting'
            : '—'
          : p.prices.map((x) => `${money(x.amount_minor, x.currency)}/${x.interval}`).join(' · ')}
      </td>
      <td>
        {limitValue('profiles', p.limits.profiles)} / {limitValue('seats', p.limits.seats)} /{' '}
        {p.limits.storage_bytes === null ? 'No limit' : bytes(p.limits.storage_bytes)}
      </td>
      <td className="num">{p.subscribers}</td>
      <td className="nowrap">
        {day(p.published_at)} <span className="muted small">{p.source === 'seed' ? 'seed' : 'console'}</span>
      </td>
      {onDraft && can('admin.catalog.edit') && (
        <td className="row-actions">
          <button
            type="button"
            className="pb-button"
            data-size="sm"
            onClick={onDraft}
            aria-label={`New version of ${p.name}`}
          >
            New version…
          </button>
        </td>
      )}
    </tr>
  );
}

function DraftEditor({
  draft,
  provider,
  onDone,
}: {
  draft: PlanDraft;
  provider: boolean;
  onDone: (message: string | null, d: PlanDraft | null) => Promise<void>;
}) {
  const { api, explain, can } = useConsole();
  const price = (i: 'month' | 'year') => draft.prices.find((p) => p.interval === i);
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [purchasable, setPurchasable] = useState(draft.purchasable);
  const [limits, setLimits] = useState<Record<string, string>>(
    Object.fromEntries(
      PLAN_LIMIT_KEYS.map((k) => {
        const v = draft.limits[k];
        return [k, v === null ? '' : k === 'storage_bytes' ? String(v / GiB) : String(v)];
      }),
    ),
  );
  const [features, setFeatures] = useState<PlanFeatures>(draft.features);
  const [currency, setCurrency] = useState(draft.prices[0]?.currency ?? 'usd');
  const [monthly, setMonthly] = useState(
    price('month') ? toMajor(price('month')?.amount_minor ?? 0, currency) : '',
  );
  const [yearly, setYearly] = useState(
    price('year') ? toMajor(price('year')?.amount_minor ?? 0, currency) : '',
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const body = () => {
    const prices: DraftPrice[] = [];
    const m = toMinor(monthly, currency);
    const y = toMinor(yearly, currency);
    if (m) prices.push({ interval: 'month', currency, amount_minor: m });
    if (y) prices.push({ interval: 'year', currency, amount_minor: y });
    const lim = Object.fromEntries(
      PLAN_LIMIT_KEYS.map((k) => {
        const raw = (limits[k] ?? '').trim();
        if (!raw) return [k, null];
        const n = Number(raw);
        return [k, k === 'storage_bytes' ? Math.round(n * GiB) : Math.round(n)];
      }),
    ) as PlanLimits;
    return { name: name.trim(), description: description.trim(), purchasable, limits: lim, features, prices };
  };

  const save = async (): Promise<PlanDraft | null> => {
    setProblem(null);
    try {
      return await api.updateDraft(draft.id, { revision: draft.revision, ...body() });
    } catch (e) {
      setProblem(explain(e));
      return null;
    }
  };

  const publish = async () => {
    setBusy(true);
    const saved = await save();
    if (!saved) {
      setBusy(false);
      return;
    }
    try {
      const pub = await api.publishDraft(saved.id, saved.revision);
      await onDone(`Published ${pub.plan_id}@${pub.version}. New purchases use it from now on.`, null);
    } catch (e) {
      setProblem(explain(e));
      setConfirming(false);
      await onDone(null, { ...saved, state: 'draft' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel editor" aria-labelledby="editor-title">
      <div className="panel__head">
        <div className="panel__title">
          <Icon name="note" className="panel__icon" />
          <h2 id="editor-title">
            Draft: {draft.plan_id}{' '}
            {draft.base_version ? `(after version ${draft.base_version})` : '(new plan)'}
          </h2>
        </div>
      </div>
      <div className="panel__body">
        <div className="form form--grid">
          <div className="field">
            <label htmlFor="d-name">Name</label>
            <input id="d-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="d-desc">Description</label>
            <input
              id="d-desc"
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <fieldset className="fieldset">
            <legend>Limits (empty: no limit)</legend>
            <div className="inline-fields">
              {PLAN_LIMIT_KEYS.map((k) => (
                <label key={k} className="inline">
                  {LIMIT_LABEL[k]}
                  {k === 'storage_bytes' ? ' (GB)' : ''}
                  <input
                    type="number"
                    min={0}
                    value={limits[k] ?? ''}
                    onChange={(e) => setLimits({ ...limits, [k]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="fieldset">
            <legend>Features</legend>
            <div className="inline-fields">
              {PLAN_FEATURES.map((f) => (
                <label key={f} className="choice">
                  <input
                    type="checkbox"
                    checked={features[f]}
                    onChange={(e) => setFeatures({ ...features, [f]: e.target.checked })}
                  />{' '}
                  {FEATURE_LABEL[f]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="fieldset">
            <legend>Prices (before tax; the payment provider charges them)</legend>
            <label className="choice">
              <input
                type="checkbox"
                checked={purchasable}
                onChange={(e) => setPurchasable(e.target.checked)}
              />{' '}
              Sell this plan through checkout
            </label>
            <div className="inline-fields">
              <label className="inline">
                Currency
                <input
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value.toLowerCase())}
                />
              </label>
              <label className="inline">
                Monthly
                <input
                  inputMode="decimal"
                  value={monthly}
                  onChange={(e) => setMonthly(e.target.value)}
                  placeholder="49"
                />
              </label>
              <label className="inline">
                Yearly (optional)
                <input
                  inputMode="decimal"
                  value={yearly}
                  onChange={(e) => setYearly(e.target.value)}
                  placeholder="490"
                />
              </label>
            </div>
            {!provider && <p className="hint">No payment provider here: leave prices empty.</p>}
          </fieldset>
        </div>
        {confirming ? (
          <div className="confirm" role="alertdialog" aria-labelledby="confirm-title">
            <Icon name="alert" size={20} className="confirm__icon" />
            <div>
              <h3 id="confirm-title">Publish {draft.plan_id} as a new version?</h3>
              <p>
                {purchasable
                  ? `It will be sold at ${[monthly && `${monthly} ${currency.toUpperCase()} a month`, yearly && `${yearly} ${currency.toUpperCase()} a year`].filter(Boolean).join(' and ')}.`
                  : 'It will not be sold through checkout.'}{' '}
                New prices are created at the payment provider and cannot be changed afterwards. Existing
                workspaces keep what they bought.
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="pb-button"
                  data-variant="primary"
                  disabled={busy}
                  onClick={publish}
                >
                  {busy ? 'Publishing…' : 'Publish now'}
                </button>
                <button
                  type="button"
                  className="pb-button"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  Back
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="actions actions--bar">
            {can('admin.catalog.publish') && (
              <button
                type="button"
                className="pb-button"
                data-variant="primary"
                onClick={() => setConfirming(true)}
              >
                Publish…
              </button>
            )}
            <button
              type="button"
              className="pb-button"
              onClick={async () => {
                const d = await save();
                if (d) await onDone('Draft saved.', d);
              }}
            >
              Save draft
            </button>
            <button
              type="button"
              className="pb-button"
              data-variant="ghost"
              onClick={async () => {
                try {
                  await api.discardDraft(draft.id, draft.revision);
                  await onDone('Draft discarded.', null);
                } catch (e) {
                  setProblem(explain(e));
                }
              }}
            >
              Discard
            </button>
          </div>
        )}
        <Problem text={problem} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- operations
export function OperationsPage() {
  const { api, explain, can } = useConsole();
  const { data: o, problem, reload } = useLoad<AdminOperations>(() => api.operations(), [api]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState('pause_channel');
  const [version, setVersion] = useState('');
  const [reason, setReason] = useState('');

  const retry = async (id: string) => {
    setError(null);
    try {
      await api.retryEmail(id);
      setNote('Queued again: the worker sends it within a minute.');
      await reload();
    } catch (e) {
      setError(explain(e));
    }
  };
  const request = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.requestRelease({
        action,
        ...(action === 'publish_version' ? { version } : {}),
        reason: reason.trim(),
      });
      setNote('Recorded. The signed release pipeline carries it out; nothing was changed here.');
      setReason('');
      await reload();
    } catch (err) {
      setError(explain(err));
    }
  };

  const workerStale = (w: string | null) => !w || Date.parse(w) < Date.now() - 5 * 60_000;

  return (
    <section className="stack" aria-labelledby="ops-title">
      <PageHeader
        title={
          <PageTitle>
            <span id="ops-title">Operations</span>
          </PageTitle>
        }
        meta={
          o && (
            <span className="asof">
              <Icon name="server" size={14} /> API {o.server.api_version} · {o.server.environment}
              {o.server.database_migration && ` · database ${o.server.database_migration}`}
            </span>
          )
        }
        description="Health of the service, its queues and backups. Counts and times only — no names or addresses."
      />
      <Toast text={note} onDismiss={() => setNote(null)} />
      <Problem text={error} />
      {!o ? (
        <Loading problem={problem} />
      ) : (
        <>
          <ul className="stats stats--health" aria-label="Health">
            <Stat
              icon="users"
              label="Sign-ups finished"
              value={o.health.signups_24h.toLocaleString()}
              hint={`in 24 hours · ${o.health.signups_7d} in 7 days`}
            />
            <Stat
              icon="card"
              label="Checkouts waiting at the provider"
              value={o.health.checkouts_open.toLocaleString()}
              hint={
                o.health.checkout_oldest_open
                  ? `oldest ${when(o.health.checkout_oldest_open)}`
                  : 'none waiting'
              }
            />
            <Stat
              icon="key"
              label="Open profiles"
              value={o.health.leases_active.toLocaleString()}
              tone={o.health.leases_expired_unreleased > 0 ? 'warn' : 'good'}
              status={
                o.health.leases_expired_unreleased > 0
                  ? `${o.health.leases_expired_unreleased} ran out without renewal (24 h)`
                  : 'No lost leases (24 h)'
              }
            />
            <Stat
              icon="refresh"
              label="Cloud backups (24 h)"
              value={`${o.health.snapshots_committed_24h} saved`}
              tone={o.health.snapshots_failed_24h > 0 ? 'bad' : 'good'}
              status={`${o.health.snapshots_failed_24h} failed`}
            />
            <Stat
              icon="layers"
              label="Automation jobs waiting"
              value={o.health.jobs_queued.toLocaleString()}
              hint={o.health.job_oldest_queued ? `oldest ${when(o.health.job_oldest_queued)}` : 'queue empty'}
            />
            <Stat
              icon="server"
              label="Off-site archiving"
              value={o.health.archiving_failing ? 'Failing' : 'Healthy'}
              tone={o.health.archiving_failing ? 'bad' : 'good'}
              status={o.health.archiving_failing ? 'Failing now (see Alerts)' : 'No failure'}
            />
          </ul>

          <div className="grid-2">
            <Panel id="ops-sys-title" icon="server" title="Service">
              <dl className="health">
                <HealthRow
                  label="Worker last ran"
                  tone={workerStale(o.server.worker_last_seen) ? 'bad' : 'good'}
                >
                  {when(o.server.worker_last_seen)}
                </HealthRow>
                <HealthRow
                  label="Last profile backup"
                  tone={o.backups.last_profile_backup ? 'good' : 'neutral'}
                >
                  {when(o.backups.last_profile_backup)}
                </HealthRow>
                <HealthRow
                  label="Off-site database backup"
                  tone={o.backups.offsite ? toneOf(o.backups.offsite.status) : 'neutral'}
                >
                  {o.backups.offsite
                    ? `${o.backups.offsite.status}, last ${when(o.backups.offsite.last_success)}`
                    : 'Not reported on this server'}
                </HealthRow>
                <HealthRow label="Outbox" tone={o.outbox.retrying > 0 ? 'warn' : 'good'}>
                  {o.outbox.pending} waiting ({o.outbox.retrying} retrying)
                  {o.outbox.oldest_pending && `, oldest ${when(o.outbox.oldest_pending)}`}
                </HealthRow>
              </dl>
            </Panel>
            <Panel id="ops-inbox-title" icon="inbox" title="Waiting for an answer">
              <ul className="stats stats--mini" aria-label="Waiting for an answer">
                <Stat
                  label="Account deletion requests"
                  value={o.inbox.deletion_requests_pending}
                  hint={`account deletion request${o.inbox.deletion_requests_pending === 1 ? '' : 's'}`}
                />
                <Stat
                  label="Contact messages"
                  value={o.inbox.contact_requests_unhandled}
                  hint={`contact message${o.inbox.contact_requests_unhandled === 1 ? '' : 's'} (sent to the support address)`}
                />
              </ul>
            </Panel>
          </div>

          <Panel
            id="ops-hooks-title"
            icon="zap"
            title="Payment provider events"
            actions={
              <span className="panel__counts">
                <Pill tone={o.webhooks.pending > 0 ? 'warn' : 'neutral'}>{o.webhooks.pending} waiting</Pill>
                <Pill tone={o.webhooks.failed > 0 ? 'bad' : 'neutral'}>{o.webhooks.failed} failed</Pill>
              </span>
            }
          >
            {o.webhooks.oldest_pending && (
              <p className="panel__note">Oldest waiting since {when(o.webhooks.oldest_pending)}.</p>
            )}
            {o.webhooks.recent_failures.length === 0 ? (
              <EmptyState icon="check" title="No failing events.">
                Events the worker cannot apply are listed here with their last error.
              </EmptyState>
            ) : (
              <Scroll>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Event</th>
                      <th scope="col">Error</th>
                      <th scope="col" className="num">
                        Attempts
                      </th>
                      <th scope="col">Received</th>
                      <th scope="col">
                        <span className="pb-sr-only">Customer</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.webhooks.recent_failures.map((w) => (
                      <tr key={w.provider_event_id}>
                        <td className="mono">{w.type}</td>
                        <td className="mono small">{w.error ?? '—'}</td>
                        <td className="num">{w.attempts}</td>
                        <td className="nowrap">{when(w.received_at)}</td>
                        <td className="row-actions">
                          {w.org_id && <a href={href.customer(w.org_id)}>customer</a>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </Panel>

          <Panel
            id="ops-mail-title"
            icon="mail"
            title="E-mail"
            description="Addresses and contents are never shown here."
            actions={
              <span className="panel__counts">
                <Pill tone={o.email.configured ? 'good' : 'warn'}>
                  {o.email.configured ? 'Queue enabled' : 'E-mail is not set up on this server'}
                </Pill>
              </span>
            }
          >
            <p className="panel__note">
              {o.email.pending} waiting · {o.email.failed} failed · {o.email.sent_24h} sent in 24 hours
            </p>
            {o.email.recent_failures.length > 0 && (
              <Scroll>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Kind</th>
                      <th scope="col">Error</th>
                      <th scope="col" className="num">
                        Attempts
                      </th>
                      <th scope="col">Queued</th>
                      <th scope="col">
                        <span className="pb-sr-only">Action</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.email.recent_failures.map((m) => (
                      <tr key={m.id}>
                        <td>{m.kind.replace(/_/g, ' ')}</td>
                        <td className="mono small">{m.error ?? '—'}</td>
                        <td className="num">{m.attempts}</td>
                        <td className="nowrap">{when(m.created_at)}</td>
                        <td className="row-actions">
                          {m.retryable && can('admin.operations.act') ? (
                            <button
                              type="button"
                              className="pb-button"
                              data-size="sm"
                              onClick={() => void retry(m.id)}
                              aria-label={`Retry ${m.kind.replace(/_/g, ' ')} e-mail`}
                            >
                              <Icon name="refresh" size={14} />
                              Retry
                            </button>
                          ) : (
                            <span className="muted small">{m.retryable ? '—' : 'expired'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </Panel>

          <Panel
            id="ops-release-title"
            icon="package"
            title="Desktop releases"
            actions={
              <Pill tone={o.release.status === 'available' ? 'good' : 'warn'}>
                Stable channel:{' '}
                {o.release.status === 'available'
                  ? `version ${o.release.version}`
                  : o.release.status.replace(/_/g, ' ')}
              </Pill>
            }
          >
            {o.release.checked_at && <p className="panel__note">Checked {when(o.release.checked_at)}.</p>}
            {o.release.requests.length > 0 && (
              <ul className="timeline">
                {o.release.requests.map((r) => (
                  <li key={r.id}>
                    <span className="timeline__dot" data-tone={toneOf(r.state)} aria-hidden="true" />
                    <div>
                      <p>
                        <span>{r.action.replace(/_/g, ' ')}</span> —{' '}
                        <Pill tone={toneOf(r.state)}>{r.state}</Pill>
                      </p>
                      <p className="muted small">
                        {r.reason} · {when(r.created_at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {can('admin.releases.request') && (
              <form className="form form--inset" onSubmit={request} aria-label="Request a release action">
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="rel-action">Request</label>
                    <select id="rel-action" value={action} onChange={(e) => setAction(e.target.value)}>
                      <option value="pause_channel">Pause downloads and updates</option>
                      <option value="resume_channel">Resume downloads and updates</option>
                      <option value="publish_version">Publish a built version</option>
                    </select>
                  </div>
                  {action === 'publish_version' && (
                    <div className="field">
                      <label htmlFor="rel-version">Version</label>
                      <input
                        id="rel-version"
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                        placeholder="1.2.0"
                      />
                    </div>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="rel-reason">Why? (at least 20 characters)</label>
                  <textarea
                    id="rel-reason"
                    value={reason}
                    minLength={20}
                    maxLength={500}
                    required
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <div className="actions">
                  <button type="submit" className="pb-button" disabled={reason.trim().length < 20}>
                    Record request
                  </button>
                  <p className="hint">
                    Releases are built and signed by the release pipeline only; this records what you want
                    done.
                  </p>
                </div>
              </form>
            )}
          </Panel>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- staff
export function StaffPage() {
  const { api } = useConsole();
  const { data, problem } = useLoad<AdminStaff>(() => api.staffList(), [api]);
  return (
    <section className="stack" aria-labelledby="staff-title">
      <PageHeader
        title={
          <PageTitle>
            <span id="staff-title">Staff</span>
          </PageTitle>
        }
        description="Staff are added, changed and removed on the server (staff.ts); the last platform owner cannot be removed."
      />
      {!data ? (
        <Loading problem={problem} />
      ) : (
        <>
          <Panel id="staff-list-title" icon="shield" title={plural(data.items.length, 'staff account')}>
            <Scroll>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">E-mail</th>
                    <th scope="col">Roles</th>
                    <th scope="col">Last sign-in</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr key={s.user_id} data-disabled={s.disabled ? 'true' : undefined}>
                      <th scope="row">
                        <span className="cell-entity">
                          <span className="avatar avatar--sm" aria-hidden="true">
                            {initials(s.display_name)}
                          </span>
                          {s.display_name}
                          {s.disabled && <span className="muted"> (removed)</span>}
                        </span>
                      </th>
                      <td className="mono small">{s.email ?? '—'}</td>
                      <td>
                        <span className="tags">
                          {s.roles.map((r) => (
                            <span key={r} className="tag">
                              {ROLE_LABEL[r]}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="nowrap">{when(s.last_sign_in)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          </Panel>
          <details className="disclosure card">
            <summary>What each role may do (mapping version {data.mapping_version})</summary>
            <dl className="perms">
              {Object.entries(data.role_permissions).map(([role, perms]) => (
                <div key={role}>
                  <dt>{ROLE_LABEL[role as keyof typeof ROLE_LABEL]}</dt>
                  <dd>
                    {(perms as StaffPermission[]).length === 0 ? (
                      <span className="muted">support tools only</span>
                    ) : (
                      <span className="tags">
                        {(perms as StaffPermission[]).map((p) => (
                          <span key={p} className="tag tag--mono">
                            {p.replace('admin.', '')}
                          </span>
                        ))}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </section>
  );
}
