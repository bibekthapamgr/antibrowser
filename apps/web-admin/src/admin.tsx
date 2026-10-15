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
  bytes,
  day,
  LIMIT_LABEL,
  limitValue,
  money,
  REASON_LABEL,
  ROLE_LABEL,
  STATE_LABEL,
  when,
} from './format.ts';

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
function Scroll({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
    // biome-ignore lint/a11y/useSemanticElements: a section would add a landmark per table
    <div className="scroll" tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)">
      {children}
    </div>
  );
}

function Loading({ problem }: { problem: string | null }) {
  return problem ? <Problem text={problem} /> : <p aria-busy="true">Loading…</p>;
}

const sumText = (items: { currency: string; amount_minor: number }[]) =>
  items.length === 0 ? '—' : items.map((m) => money(m.amount_minor, m.currency)).join(' · ');

// ---------------------------------------------------------------- dashboard
export function DashboardPage() {
  const { api } = useConsole();
  const { data: m, problem } = useLoad<AdminMetrics>(() => api.metrics(), [api]);
  return (
    <section className="stack" aria-labelledby="dash-title">
      <PageTitle>
        <span id="dash-title">Dashboard</span>
      </PageTitle>
      {!m ? (
        <Loading problem={problem} />
      ) : (
        <>
          <p className="muted small">
            Numbers as of {when(m.generated_at)}. Billing states as last observed by the worker (at most a few
            minutes old). Internal and test workspaces are not counted.
          </p>
          <ul className="tiles" aria-label="Customers">
            <Tile
              label="Active customers"
              value={m.workspaces.active_customers}
              hint="trial, active, past due, grace"
            />
            <Tile label="Paying" value={m.workspaces.paying} hint="active provider subscription" />
            <Tile label="On trial" value={m.workspaces.by_state.trial} />
            <Tile
              label="Past due or grace"
              value={m.workspaces.by_state.past_due + m.workspaces.by_state.grace}
            />
            <Tile label="Restricted" value={m.workspaces.by_state.restricted} />
            <Tile label="Canceled" value={m.workspaces.by_state.canceled} />
            <Tile label="New in 30 days" value={m.workspaces.new_last_30_days} />
            <Tile
              label="Complimentary"
              value={m.workspaces.complimentary}
              hint="beta and other no-charge plans"
            />
          </ul>

          <section aria-labelledby="mrr-title">
            <h2 id="mrr-title">Monthly recurring revenue</h2>
            <p className="muted small">
              Active provider subscriptions at their list price × quantity, per month (yearly ÷ 12). Each
              currency on its own line — never converted.
            </p>
            {m.mrr.length === 0 ? (
              <p className="muted">No paying subscriptions yet.</p>
            ) : (
              <Scroll>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Currency</th>
                      <th scope="col">Recurring revenue</th>
                      <th scope="col">Subscriptions</th>
                      <th scope="col">Of which canceling</th>
                      <th scope="col">At risk (past due, grace)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.mrr.map((r) => (
                      <tr key={r.currency}>
                        <th scope="row">{r.currency.toUpperCase()}</th>
                        <td>{money(r.amount_minor, r.currency)}</td>
                        <td>{r.subscriptions}</td>
                        <td>{money(r.canceling_amount_minor, r.currency)}</td>
                        <td>{money(r.at_risk_amount_minor, r.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
            <dl className="facts">
              <div>
                <dt>Cash collected, last 30 days</dt>
                <dd>{sumText(m.cash_collected_30d)}</dd>
              </div>
              <div>
                <dt>Refunds, last 30 days</dt>
                <dd>{sumText(m.refunds_30d)}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="dash-alerts-title">
            <h2 id="dash-alerts-title">Payment alerts</h2>
            {m.alerts.open === 0 ? (
              <p className="ok">No open alerts.</p>
            ) : (
              <ul className="plain">
                {Object.entries(m.alerts.by_kind).map(([k, n]) => (
                  <li key={k}>
                    <strong>{n}</strong> {ALERT_LABEL[k as keyof typeof ALERT_LABEL] ?? k}
                  </li>
                ))}
              </ul>
            )}
            <p>
              <a href={href.alerts}>Open alerts</a>
            </p>
          </section>

          <section aria-labelledby="fresh-title">
            <h2 id="fresh-title">Data freshness</h2>
            <dl className="facts">
              <div>
                <dt>Oldest provider confirmation</dt>
                <dd>{when(m.freshness.oldest_subscription_sync)}</dd>
              </div>
              <div>
                <dt>Last provider event applied</dt>
                <dd>{when(m.freshness.last_webhook_processed)}</dd>
              </div>
              <div>
                <dt>Events waiting / failed</dt>
                <dd>
                  {m.freshness.webhooks_pending} / {m.freshness.webhooks_failed}
                </dd>
              </div>
            </dl>
            {m.gaps.length > 0 && (
              <>
                <h3>Known gaps</h3>
                <ul>
                  {m.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function Tile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <li className="tile">
      <span className="tile-value">{value.toLocaleString()}</span>
      <span className="tile-label">{label}</span>
      {hint && <span className="muted small">{hint}</span>}
    </li>
  );
}

// ---------------------------------------------------------------- customers
export function CustomersPage() {
  const { api, explain, can } = useConsole();
  const [q, setQ] = useState('');
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

  return (
    <section className="stack" aria-labelledby="customers-title">
      <PageTitle>
        <span id="customers-title">Customers</span>
      </PageTitle>
      <form className="filters" onSubmit={submit} aria-label="Find customers">
        <label>
          Search
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={120}
            placeholder="Name, org_…, cus_… or an owner’s e-mail"
            spellCheck={false}
          />
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
      <p className="muted small">
        Every page you open is recorded in the platform audit.
        {!can('admin.customers.contact') && ' Owner addresses are masked for your role.'}
      </p>
      <Problem text={problem} />
      {items === null ? (
        !problem && <p aria-busy="true">Loading…</p>
      ) : items.length === 0 ? (
        <p>No customers match.</p>
      ) : (
        <>
          <Scroll>
            <table>
              <thead>
                <tr>
                  <th scope="col">Workspace</th>
                  <th scope="col">Plan</th>
                  <th scope="col">State</th>
                  <th scope="col">Members</th>
                  <th scope="col">Profiles</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Last active</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">
                      <a href={href.customer(c.id)}>{c.name}</a>
                      {c.suspended && <span className="flag"> Suspended</span>}
                      {c.restricted && <span className="flag"> Restricted</span>}
                    </th>
                    <td>
                      {c.plan_name} <span className="muted small mono">@{c.plan_version}</span>
                    </td>
                    <td>
                      <StateBadge state={c.state} />
                    </td>
                    <td>{c.member_count}</td>
                    <td>{c.profile_count}</td>
                    <td className="mono small">{c.owner_email ?? '—'}</td>
                    <td>{when(c.last_active_at)}</td>
                    <td>{day(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
          {next && (
            <div className="actions">
              <button type="button" className="pb-button" disabled={busy} onClick={() => void load(next)}>
                Show more
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- one customer
export function CustomerPage({ orgId }: { orgId: string }) {
  const { api, can, has } = useConsole();
  const { data: d, problem, reload } = useLoad<AdminCustomerDetail>(() => api.customer(orgId), [api, orgId]);
  if (!d) {
    return (
      <section className="stack">
        <p>
          <a href={href.customers}>← Customers</a>
        </p>
        <Loading problem={problem} />
      </section>
    );
  }
  const b = d.billing;
  return (
    <article className="stack" aria-labelledby="customer-title">
      <p>
        <a href={href.customers}>← Customers</a>
      </p>
      <header className="org-head">
        <PageTitle>
          <span id="customer-title">{d.customer.name}</span>
        </PageTitle>
        <StateBadge state={b.state} />
      </header>
      <p className="muted">
        <span className="mono">{d.customer.id}</span> · created {day(d.customer.created_at)} · owner{' '}
        <span className="mono">{d.customer.owner_email ?? '—'}</span>
        {has('support', 'support_lead', 'billing_admin', 'platform_owner', 'business_admin') && (
          <>
            {' '}
            · <a href={href.org(d.customer.id)}>Support view (members with approval, overrides)</a>
          </>
        )}
      </p>
      <Problem text={problem} />

      <section aria-labelledby="c-billing-title">
        <h2 id="c-billing-title">Billing</h2>
        <dl className="facts">
          <div>
            <dt>Plan</dt>
            <dd>
              {b.plan_name}{' '}
              <span className="mono">
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
            <dd>
              {b.price
                ? `${money(b.price.amount_minor * b.price.quantity, b.price.currency)} every ${b.price.interval_count > 1 ? `${b.price.interval_count} ` : ''}${b.price.interval}${b.price.interval_count > 1 ? 's' : ''}`
                : '—'}
            </dd>
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
        {can('admin.operations.act') && b.provider_customer_id && <Resync orgId={d.customer.id} />}
      </section>

      <section aria-labelledby="c-usage-title">
        <h2 id="c-usage-title">Usage</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Limit</th>
              <th scope="col">Used</th>
              <th scope="col">Allowed</th>
            </tr>
          </thead>
          <tbody>
            {(['profiles', 'seats', 'storage_bytes'] as const).map((k) => (
              <tr key={k}>
                <th scope="row">{LIMIT_LABEL[k]}</th>
                <td>{limitValue(k, d.usage[k])}</td>
                <td>{limitValue(k, b.limits[k])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
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
      </section>

      <Restrictions detail={d} onChanged={reload} />
      {can('admin.notes.read') && <Notes detail={d} onChanged={reload} />}

      <section aria-labelledby="c-invoices-title">
        <h2 id="c-invoices-title">Invoices</h2>
        {d.invoices.length === 0 ? (
          <p className="muted">No invoices yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Status</th>
                <th scope="col">Due</th>
                <th scope="col">Paid</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {d.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.number ?? i.id}</td>
                  <td>{i.status}</td>
                  <td>{money(i.amount_due_minor, i.currency)}</td>
                  <td>{money(i.amount_paid_minor, i.currency)}</td>
                  <td>{when(i.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="c-events-title">
        <h2 id="c-events-title">Payment provider events</h2>
        {d.events.length === 0 ? (
          <p className="muted">No events.</p>
        ) : (
          <ul className="plain">
            {d.events.map((e) => (
              <li key={e.provider_event_id}>
                <span className="mono">{e.type}</span> — {e.status}
                {e.error && <span className="muted small"> ({e.error})</span>}{' '}
                <span className="muted small">{when(e.received_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="c-audit-title">
        <h2 id="c-audit-title">Support audit</h2>
        {d.audit.length === 0 ? (
          <p className="muted">Nothing recorded yet.</p>
        ) : (
          <ul className="plain">
            {d.audit.map((a) => (
              <li key={`${a.at}-${a.action}-${a.target ?? ''}`}>
                <span className="mono small">{a.action}</span>{' '}
                <span className="muted small">{when(a.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

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
      <div className="actions">
        <button type="button" className="pb-button" onClick={run}>
          Confirm with the payment provider now
        </button>
      </div>
      {note && (
        <p className="ok" role="status">
          {note}
        </p>
      )}
      <Problem text={problem} />
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
    <section aria-labelledby="c-restr-title">
      <h2 id="c-restr-title">Restrictions</h2>
      {detail.restrictions.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="plain">
          {detail.restrictions.map((r) => (
            <li key={r.id}>
              <strong>{r.kind === 'payment' ? 'Payment restriction' : 'Security suspension'}</strong>{' '}
              {r.scope === 'account' && '(one account) '}—{' '}
              {r.active ? 'active' : r.lifted_at ? 'lifted' : 'expired'}
              {r.expires_at && r.active && `, until ${when(r.expires_at)}`}.{' '}
              <span className="muted">{r.reason}</span>{' '}
              <span className="muted small">{when(r.created_at)}</span>
              {r.active && ((r.kind === 'payment' && canPay) || (r.kind === 'security' && canSec)) && (
                <button
                  type="button"
                  className="pb-button"
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
        <form className="stack" onSubmit={lift} aria-label="Lift the restriction">
          <label htmlFor="lift-reason">Why is it lifted? (at least 20 characters)</label>
          <textarea
            id="lift-reason"
            value={liftReason}
            minLength={20}
            maxLength={500}
            required
            onChange={(e) => setLiftReason(e.target.value)}
          />
          <div className="row">
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
        <form className="form" onSubmit={apply} aria-label="Restrict this workspace">
          <fieldset>
            <legend>Restrict this workspace</legend>
            {canPay && (
              <label className="choice">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === 'payment'}
                  onChange={() => setKind('payment')}
                />{' '}
                Payment restriction — stop creating and opening profiles; data, export and billing stay
                available
              </label>
            )}
            {canSec && (
              <label className="choice">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === 'security'}
                  onChange={() => setKind('security')}
                />{' '}
                Security suspension — stop all access now, close open profiles, revoke API tokens
              </label>
            )}
          </fieldset>
          <label htmlFor="restr-reason">Reason (recorded; not sent to the customer)</label>
          <textarea
            id="restr-reason"
            value={reason}
            minLength={20}
            maxLength={500}
            required
            onChange={(e) => setReason(e.target.value)}
          />
          <label htmlFor="restr-days">Ends after how many days? (empty: until lifted)</label>
          <input
            id="restr-days"
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
          <label className="choice">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> E-mail
            the workspace’s owners
          </label>
          <div className="row">
            <button
              type="submit"
              className="pb-button"
              data-variant="danger"
              disabled={reason.trim().length < 20 || (kind === 'payment' ? !canPay : !canSec)}
            >
              {kind === 'payment' ? 'Restrict workspace' : 'Suspend workspace'}
            </button>
          </div>
          <p className="muted small">
            Nothing is ever deleted. The change is recorded and visible to the owners.
          </p>
        </form>
      )}
      {done && (
        <p className="ok" role="status">
          {done}
        </p>
      )}
      <Problem text={problem} />
    </section>
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
    <section aria-labelledby="c-notes-title">
      <h2 id="c-notes-title">Case notes</h2>
      {detail.notes.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        <ul className="plain notes">
          {detail.notes.map((n) => (
            <li key={n.id}>
              <p>{n.body}</p>
              <p className="muted small">
                {n.author_name} · {when(n.created_at)}
                {n.redacted && ' · redacted'}
              </p>
            </li>
          ))}
        </ul>
      )}
      {can('admin.notes.write') && (
        <form className="stack" onSubmit={add}>
          <label htmlFor="note-body">Add a note (never paste card numbers, passwords or keys)</label>
          <textarea
            id="note-body"
            value={body}
            maxLength={2000}
            required
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="row">
            <button type="submit" className="pb-button" disabled={body.trim().length < 3}>
              Add note
            </button>
          </div>
        </form>
      )}
      {done && (
        <p className="ok" role="status">
          {done}
        </p>
      )}
      <Problem text={problem} />
    </section>
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

  if (!cat) {
    return (
      <section className="stack" aria-labelledby="plans-title">
        <PageTitle>
          <span id="plans-title">Plans</span>
        </PageTitle>
        <Loading problem={problem} />
      </section>
    );
  }
  const current = cat.plans.filter((p) => p.current);
  const older = cat.plans.filter((p) => !p.current);
  return (
    <section className="stack" aria-labelledby="plans-title">
      <PageTitle>
        <span id="plans-title">Plans</span>
      </PageTitle>
      <p className="muted">
        A published plan version never changes. Changes are made in a draft and published as a new version:
        new purchases use it, while workspaces keep the version and price they bought.
        {!cat.provider &&
          ' The payment provider is not configured on this server: only plans without prices can be published.'}
      </p>
      {note && (
        <p className="ok" role="status">
          {note}
        </p>
      )}
      <Problem text={error} />
      <Scroll>
        <table>
          <thead>
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">Sold</th>
              <th scope="col">Prices</th>
              <th scope="col">Profiles / seats / storage</th>
              <th scope="col">Workspaces</th>
              <th scope="col">Published</th>
              {can('admin.catalog.edit') && <th scope="col">Change</th>}
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
        <details>
          <summary>Earlier versions ({older.length})</summary>
          <Scroll>
            <table>
              <tbody>
                {older.map((p) => (
                  <PlanRow key={`${p.id}@${p.version}`} p={p} />
                ))}
              </tbody>
            </table>
          </Scroll>
        </details>
      )}

      {can('admin.catalog.edit') && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void startDraft(newId.trim(), false);
          }}
          aria-label="New plan"
        >
          <label htmlFor="new-plan">New plan id</label>
          <input
            id="new-plan"
            value={newId}
            onChange={(e) => setNewId(e.target.value.toLowerCase())}
            pattern="[a-z][a-z0-9_]{1,31}"
            placeholder="pro"
            required
          />
          <button type="submit" className="pb-button">
            Start a new plan
          </button>
        </form>
      )}

      <section aria-labelledby="drafts-title">
        <h2 id="drafts-title">Drafts</h2>
        {cat.drafts.length === 0 ? (
          <p className="muted">No open drafts.</p>
        ) : (
          <ul className="plain">
            {cat.drafts.map((d) => (
              <li key={d.id}>
                <strong>
                  {d.name}{' '}
                  <span className="mono">
                    ({d.plan_id}, from {d.base_version ? `@${d.base_version}` : 'new'})
                  </span>
                </strong>{' '}
                — {d.state === 'publishing' ? 'publishing…' : 'draft'}
                {d.last_error && <span className="problem-inline"> Last attempt failed: {d.last_error}</span>}{' '}
                {can('admin.catalog.edit') && d.state === 'draft' && (
                  <button
                    type="button"
                    className="pb-button"
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
      </section>
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

      <section aria-labelledby="pubs-title">
        <h2 id="pubs-title">Publication history</h2>
        {cat.publications.length === 0 ? (
          <p className="muted">Nothing published from the console yet.</p>
        ) : (
          <ul className="plain">
            {cat.publications.map((p) => (
              <li key={p.id}>
                <span className="mono">
                  {p.plan_id}@{p.version}
                </span>{' '}
                — {p.state}
                {p.error && <span className="muted"> ({p.error})</span>}{' '}
                <span className="muted small">{when(p.started_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function PlanRow({ p, onDraft }: { p: PublishedPlan; onDraft?: () => void }) {
  const { can } = useConsole();
  return (
    <tr>
      <th scope="row">
        {p.name}{' '}
        <span className="mono small">
          {p.id}@{p.version}
        </span>
      </th>
      <td>{p.purchasable ? 'Yes' : 'No'}</td>
      <td>
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
      <td>{p.subscribers}</td>
      <td>
        {day(p.published_at)} <span className="muted small">{p.source === 'seed' ? 'seed' : 'console'}</span>
      </td>
      {onDraft && can('admin.catalog.edit') && (
        <td>
          <button
            type="button"
            className="pb-button"
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
    <section className="editor" aria-labelledby="editor-title">
      <h2 id="editor-title">
        Draft: {draft.plan_id} {draft.base_version ? `(after version ${draft.base_version})` : '(new plan)'}
      </h2>
      <div className="form">
        <label htmlFor="d-name">Name</label>
        <input id="d-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="d-desc">Description</label>
        <input
          id="d-desc"
          value={description}
          maxLength={200}
          onChange={(e) => setDescription(e.target.value)}
        />
        <fieldset>
          <legend>Limits (empty: no limit)</legend>
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
        </fieldset>
        <fieldset>
          <legend>Features</legend>
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
        </fieldset>
        <fieldset>
          <legend>Prices (before tax; the payment provider charges them)</legend>
          <label className="choice">
            <input type="checkbox" checked={purchasable} onChange={(e) => setPurchasable(e.target.checked)} />{' '}
            Sell this plan through checkout
          </label>
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
          {!provider && <p className="muted small">No payment provider here: leave prices empty.</p>}
        </fieldset>
      </div>
      {confirming ? (
        <div className="confirm" role="alertdialog" aria-labelledby="confirm-title">
          <h3 id="confirm-title">Publish {draft.plan_id} as a new version?</h3>
          <p>
            {purchasable
              ? `It will be sold at ${[monthly && `${monthly} ${currency.toUpperCase()} a month`, yearly && `${yearly} ${currency.toUpperCase()} a year`].filter(Boolean).join(' and ')}.`
              : 'It will not be sold through checkout.'}{' '}
            New prices are created at the payment provider and cannot be changed afterwards. Existing
            workspaces keep what they bought.
          </p>
          <div className="row">
            <button
              type="button"
              className="pb-button"
              data-variant="primary"
              disabled={busy}
              onClick={publish}
            >
              {busy ? 'Publishing…' : 'Publish now'}
            </button>
            <button type="button" className="pb-button" disabled={busy} onClick={() => setConfirming(false)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
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

  return (
    <section className="stack" aria-labelledby="ops-title">
      <PageTitle>
        <span id="ops-title">Operations</span>
      </PageTitle>
      {note && (
        <p className="ok" role="status">
          {note}
        </p>
      )}
      <Problem text={error} />
      {!o ? (
        <Loading problem={problem} />
      ) : (
        <>
          <dl className="facts">
            <div>
              <dt>Server</dt>
              <dd>
                API {o.server.api_version} · {o.server.environment}
                {o.server.database_migration && ` · database ${o.server.database_migration}`}
              </dd>
            </div>
            <div>
              <dt>Worker last ran</dt>
              <dd
                className={
                  !o.server.worker_last_seen ||
                  Date.parse(o.server.worker_last_seen) < Date.now() - 5 * 60_000
                    ? 'over'
                    : undefined
                }
              >
                {when(o.server.worker_last_seen)}
              </dd>
            </div>
            <div>
              <dt>Last profile backup</dt>
              <dd>{when(o.backups.last_profile_backup)}</dd>
            </div>
            <div>
              <dt>Off-site database backup</dt>
              <dd>
                {o.backups.offsite
                  ? `${o.backups.offsite.status}, last ${when(o.backups.offsite.last_success)}`
                  : 'Not reported on this server'}
              </dd>
            </div>
            <div>
              <dt>Waiting for an answer</dt>
              <dd>
                {o.inbox.deletion_requests_pending} account deletion request
                {o.inbox.deletion_requests_pending === 1 ? '' : 's'} · {o.inbox.contact_requests_unhandled}{' '}
                contact message{o.inbox.contact_requests_unhandled === 1 ? '' : 's'} (sent to the support
                address)
              </dd>
            </div>
            <div>
              <dt>Outbox</dt>
              <dd>
                {o.outbox.pending} waiting ({o.outbox.retrying} retrying)
                {o.outbox.oldest_pending && `, oldest ${when(o.outbox.oldest_pending)}`}
              </dd>
            </div>
          </dl>

          <section aria-labelledby="ops-hooks-title">
            <h2 id="ops-hooks-title">Payment provider events</h2>
            <p>
              {o.webhooks.pending} waiting, {o.webhooks.failed} failed
              {o.webhooks.oldest_pending && ` · oldest waiting since ${when(o.webhooks.oldest_pending)}`}
            </p>
            {o.webhooks.recent_failures.length > 0 && (
              <ul className="plain">
                {o.webhooks.recent_failures.map((w) => (
                  <li key={w.provider_event_id}>
                    <span className="mono">{w.type}</span> — {w.attempts} attempts{w.error && `: ${w.error}`}{' '}
                    {w.org_id && <a href={href.customer(w.org_id)}>customer</a>}{' '}
                    <span className="muted small">{when(w.received_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="ops-mail-title">
            <h2 id="ops-mail-title">E-mail</h2>
            <p>
              {o.email.configured ? 'Queue enabled' : 'E-mail is not set up on this server'} ·{' '}
              {o.email.pending} waiting · {o.email.failed} failed · {o.email.sent_24h} sent in 24 hours
            </p>
            {o.email.recent_failures.length > 0 && (
              <Scroll>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Kind</th>
                      <th scope="col">Error</th>
                      <th scope="col">Attempts</th>
                      <th scope="col">Queued</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.email.recent_failures.map((m) => (
                      <tr key={m.id}>
                        <td>{m.kind.replace(/_/g, ' ')}</td>
                        <td className="mono small">{m.error ?? '—'}</td>
                        <td>{m.attempts}</td>
                        <td>{when(m.created_at)}</td>
                        <td>
                          {m.retryable && can('admin.operations.act') ? (
                            <button
                              type="button"
                              className="pb-button"
                              onClick={() => void retry(m.id)}
                              aria-label={`Retry ${m.kind.replace(/_/g, ' ')} e-mail`}
                            >
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
            <p className="muted small">Addresses and contents are never shown here.</p>
          </section>

          <section aria-labelledby="ops-release-title">
            <h2 id="ops-release-title">Desktop releases</h2>
            <p>
              Stable channel:{' '}
              {o.release.status === 'available'
                ? `version ${o.release.version}`
                : o.release.status.replace(/_/g, ' ')}
              {o.release.checked_at && (
                <span className="muted small"> (checked {when(o.release.checked_at)})</span>
              )}
            </p>
            {o.release.requests.length > 0 && (
              <ul className="plain">
                {o.release.requests.map((r) => (
                  <li key={r.id}>
                    {r.action.replace(/_/g, ' ')} — {r.state} <span className="muted">{r.reason}</span>{' '}
                    <span className="muted small">{when(r.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
            {can('admin.releases.request') && (
              <form className="form" onSubmit={request} aria-label="Request a release action">
                <label htmlFor="rel-action">Request</label>
                <select id="rel-action" value={action} onChange={(e) => setAction(e.target.value)}>
                  <option value="pause_channel">Pause downloads and updates</option>
                  <option value="resume_channel">Resume downloads and updates</option>
                  <option value="publish_version">Publish a built version</option>
                </select>
                {action === 'publish_version' && (
                  <>
                    <label htmlFor="rel-version">Version</label>
                    <input
                      id="rel-version"
                      value={version}
                      onChange={(e) => setVersion(e.target.value)}
                      placeholder="1.2.0"
                    />
                  </>
                )}
                <label htmlFor="rel-reason">Why? (at least 20 characters)</label>
                <textarea
                  id="rel-reason"
                  value={reason}
                  minLength={20}
                  maxLength={500}
                  required
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="row">
                  <button type="submit" className="pb-button" disabled={reason.trim().length < 20}>
                    Record request
                  </button>
                </div>
                <p className="muted small">
                  Releases are built and signed by the release pipeline only; this records what you want done.
                </p>
              </form>
            )}
          </section>
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
      <PageTitle>
        <span id="staff-title">Staff</span>
      </PageTitle>
      <p className="muted">
        Staff are added, changed and removed on the server (staff.ts); the last platform owner cannot be
        removed.
      </p>
      {!data ? (
        <Loading problem={problem} />
      ) : (
        <>
          <table>
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
                <tr key={s.user_id}>
                  <th scope="row">
                    {s.display_name}
                    {s.disabled && <span className="muted"> (removed)</span>}
                  </th>
                  <td className="mono small">{s.email ?? '—'}</td>
                  <td>{s.roles.map((r) => ROLE_LABEL[r]).join(', ')}</td>
                  <td>{when(s.last_sign_in)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary>What each role may do (mapping version {data.mapping_version})</summary>
            <ul>
              {Object.entries(data.role_permissions).map(([role, perms]) => (
                <li key={role}>
                  <strong>{ROLE_LABEL[role as keyof typeof ROLE_LABEL]}</strong>:{' '}
                  {(perms as StaffPermission[]).map((p) => p.replace('admin.', '')).join(', ') ||
                    'support tools only'}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
