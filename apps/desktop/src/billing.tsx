/**
 * Billing (milestone 11, ADR-0018): Organization → Billing for owners and billing members, and the subscription
 * banner every member sees. The subscription comes from the organization's server (its database decides what the
 * organization may do); the payment provider's checkout, portal and invoice pages are opened by the shell in the
 * default browser. A payment is never assumed from the browser coming back: this screen waits for the server to
 * confirm it.
 */
import {
  BILLING_TIMING,
  type BillingPlan,
  type BillingSummary,
  type BillingUsage,
  catalogPlan,
  type Invoice,
  type PlanLimitKey,
  type Subscription,
} from '@pb/contracts/billing';
import type { Role } from '@pb/contracts/resources';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Backend } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { can, get } from './cloud.ts';
import { formatBytes } from './components.tsx';
import { day, type Notify } from './status.tsx';
import { Meter, Pill, type Tone } from './ui.tsx';

const LIMIT_LABEL: Record<PlanLimitKey, string> = {
  profiles: 'Profiles',
  seats: 'Seats (members and pending invitations)',
  storage_bytes: 'Backup storage',
  automation_concurrency: 'Automation jobs at a time',
};

const USAGE_LABEL: Record<string, string> = {
  snapshot_committed: 'Backups saved',
  automation_job: 'Automation jobs run',
  api_requests: 'API requests',
  storage_bytes: 'Backup storage (latest daily sample)',
  active_profiles: 'Profiles (latest daily sample)',
  seats: 'Seats (latest daily sample)',
};

const STATE_LABEL: Record<Subscription['state'], string> = {
  trial: 'Trial',
  active: 'Active',
  past_due: 'Payment failed',
  grace: 'Grace period',
  restricted: 'Restricted',
  canceled: 'Ended',
};

function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(
      minor / 100,
    );
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** A plan price for a card: whole amounts without cents ("$49"), others as usual ("$49.50"). */
function priceParts(minor: number, currency: string): string {
  if (minor % 100 !== 0) return money(minor, currency);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return money(minor, currency);
  }
}

const RESTRICTED_HELP =
  'You can still see everything, close profiles, back up, export and delete. Creating or opening profiles, inviting people and new automation wait until billing is fixed. Nothing is deleted.';

/** What the state means and what to do, in words. */
function stateText(s: Pick<Subscription, 'state' | 'reason' | 'until' | 'plan'>, owner: boolean): string {
  const who = owner ? 'Choose a plan' : 'An owner can choose a plan';
  switch (s.state) {
    case 'trial': {
      const n = daysLeft(s.until);
      return `Trial: ${n === null ? '' : n === 1 ? '1 day left' : `${n} days left`} (ends ${day(s.until)}). ${who} to keep working after that.`;
    }
    case 'active':
      return s.until
        ? `${s.plan.name} until ${day(s.until)}: the subscription was canceled and ends then.`
        : s.reason === 'complimentary'
          ? `${s.plan.name}: provided without charge.`
          : `${s.plan.name}: active.`;
    case 'past_due':
      return `A payment failed. Full access continues while the payment provider tries again; ${owner ? 'update the payment method in the billing portal' : 'an owner can update the payment method'}.`;
    case 'grace':
      return s.reason === 'renewal_unconfirmed'
        ? `The renewal could not be confirmed with the payment provider yet. Full access continues until ${day(s.until)}.`
        : `The payment could not be collected. Full access continues until ${day(s.until)}; after that the organization is restricted.`;
    case 'restricted':
      return `${s.reason === 'trial_ended' ? 'The trial ended.' : s.reason === 'paused' ? 'The subscription is paused.' : s.reason === 'staff_restriction' ? 'Project Browser support restricted this workspace; contact support.' : 'The subscription needs attention.'} ${RESTRICTED_HELP}`;
    case 'canceled':
      return `The subscription ended. ${RESTRICTED_HELP}`;
  }
}

/** The banner every member sees on the organization when billing needs attention (or a trial ends soon). */
export function BillingBanner(props: {
  billing: BillingSummary | undefined;
  role: Role | null;
  onOpenBilling: () => void;
}) {
  const b = props.billing;
  if (!b) return null;
  const left = daysLeft(b.until);
  const urgent = b.state === 'restricted' || b.state === 'canceled';
  const show =
    urgent || b.state === 'past_due' || b.state === 'grace' || (b.state === 'trial' && (left ?? 99) <= 3);
  if (!show) return null;
  const canSee = can(props.role, 'billing.read');
  return (
    <div
      className={`notice billing-banner${urgent ? ' notice--error' : ''}`}
      role={urgent ? 'alert' : 'status'}
    >
      <p>
        <strong>{STATE_LABEL[b.state]}.</strong>{' '}
        {stateText(
          { ...b, plan: { id: b.plan_id, version: 1, name: b.plan_name } },
          can(props.role, 'billing.manage'),
        )}
        {!canSee && ' Ask an owner of this organization.'}
      </p>
      {canSee && (
        <button type="button" className="pb-button" onClick={props.onOpenBilling}>
          Open billing
        </button>
      )}
    </div>
  );
}

export function OrgBillingSection(props: {
  backend: Backend;
  orgId: string;
  role: Role;
  notify: Notify;
  offline: boolean;
  onChanged?: () => void;
}) {
  const { backend, orgId, role, notify, offline } = props;
  const owner = can(role, 'billing.manage');
  const [sub, setSub] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<BillingPlan[] | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [waiting, setWaiting] = useState<{ since: number; before: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;

  const load = useCallback(async () => {
    try {
      const s = await get<Subscription>(backend, `/v1/orgs/${orgId}/billing/subscription`);
      setSub(s.data);
      return s.data;
    } catch (e) {
      notify(errorMessage(e, 'Could not load the subscription.'), 'error');
      return null;
    }
  }, [backend, orgId, notify]);

  useEffect(() => {
    void load();
    get<{ items: BillingPlan[] }>(backend, `/v1/orgs/${orgId}/billing/plans`)
      .then((r) => setPlans(r.data.items))
      .catch(() => setPlans([]));
    get<BillingUsage>(backend, `/v1/orgs/${orgId}/billing/usage`)
      .then((r) => setUsage(r.data))
      .catch(() => setUsage(null));
    get<{ items: Invoice[] }>(backend, `/v1/orgs/${orgId}/billing/invoices`)
      .then((r) => setInvoices(r.data.items))
      .catch(() => setInvoices([]));
  }, [backend, orgId, load]);

  // After checkout or the portal: wait for the server to confirm a change (the provider tells it, not the browser).
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      const s = await load();
      const now = s ? `${s.state}:${s.plan.id}@${s.plan.version}:${s.cancel_at_period_end}` : waiting.before;
      if (now !== waiting.before) {
        setWaiting(null);
        notify(
          `Subscription updated: ${s?.plan.name ?? ''} — ${s ? STATE_LABEL[s.state].toLowerCase() : ''}.`,
        );
        onChanged.current?.();
        get<{ items: Invoice[] }>(backend, `/v1/orgs/${orgId}/billing/invoices`)
          .then((r) => setInvoices(r.data.items))
          .catch(() => undefined);
      } else if (Date.now() - waiting.since > 15 * 60_000) {
        setWaiting(null);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, load, notify, backend, orgId]);

  const snapshot = (s: Subscription) => `${s.state}:${s.plan.id}@${s.plan.version}:${s.cancel_at_period_end}`;

  const choose = async (plan: BillingPlan) => {
    if (!sub) return;
    setBusy(true);
    try {
      await backend.billing.openCheckout(orgId, plan.id);
      setWaiting({ since: Date.now(), before: snapshot(sub) });
      notify(
        `Checkout for ${plan.name} opened in your browser. This page updates when the payment is confirmed.`,
      );
    } catch (e) {
      notify(errorMessage(e, 'Could not open checkout.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const portal = async () => {
    if (!sub) return;
    setBusy(true);
    try {
      await backend.billing.openPortal(orgId);
      setWaiting({ since: Date.now(), before: snapshot(sub) });
      notify(
        'The billing portal opened in your browser. Changes appear here once the payment provider confirms them.',
      );
    } catch (e) {
      notify(errorMessage(e, 'Could not open the billing portal.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const openInvoice = async (inv: Invoice, pdf: boolean) => {
    try {
      await backend.billing.openInvoice(orgId, inv.id, pdf);
    } catch (e) {
      notify(errorMessage(e, 'Could not open the invoice.'), 'error');
    }
  };

  if (!sub) {
    return (
      <p role="status" className="loading">
        Loading billing…
      </p>
    );
  }
  const blocked = sub.state === 'restricted' || sub.state === 'canceled';
  const manageable = sub.has_provider_subscription && sub.state !== 'canceled';
  const offered = (plans ?? []).filter((p) => p.id !== 'trial' && p.id !== 'beta' && p.id !== 'internal');
  const value = (k: PlanLimitKey): number =>
    k === 'automation_concurrency' ? sub.usage.automation_running : sub.usage[k];
  const fmt = (k: PlanLimitKey) => (n: number) =>
    k === 'storage_bytes' ? formatBytes(n) : n.toLocaleString();
  // The plan most teams want: the least expensive one that shares profiles (only a hint; every plan can be chosen).
  const recommended = offered
    .filter((p) => p.available && p.features.team_sessions && p.price)
    .sort((a, b) => (a.price?.amount_minor ?? 0) - (b.price?.amount_minor ?? 0))[0]?.id;
  const tone: Tone =
    sub.state === 'active' ? 'ok' : sub.state === 'trial' ? 'accent' : blocked ? 'error' : 'warn';
  // Days left of a state that ends by itself (trial, grace, a canceled subscription's last period).
  const left = sub.until ? daysLeft(sub.until) : null;
  const span =
    sub.state === 'trial'
      ? (catalogPlan(sub.plan.id, sub.plan.version)?.trialDays ?? BILLING_TIMING.trialDays)
      : null;
  const renews = sub.current_period_end && sub.state === 'active' && !sub.cancel_at_period_end;

  return (
    <section className="stack billing" aria-labelledby="org-billing-title">
      <h2 id="org-billing-title" className="billing__title">
        Billing
      </h2>
      <div
        className={`plan-hero plan-hero--${tone}${blocked ? ' notice--error' : ''}`}
        role={blocked ? 'alert' : 'status'}
        data-state={sub.state}
      >
        <div className="plan-hero__main">
          <div className="plan-hero__head">
            <p className="plan-hero__name">{sub.plan.name}</p>
            <Pill tone={tone}>
              {/* A trial plan is called "Trial" already: its pill says it is running instead. */}
              {sub.plan.name === STATE_LABEL[sub.state] ? 'Active' : STATE_LABEL[sub.state]}
            </Pill>
            {sub.cancel_at_period_end && sub.state === 'active' && (
              <Pill tone="warn">Ends at period end</Pill>
            )}
          </div>
          <p className="plan-hero__text">{stateText(sub, owner)}</p>
          {waiting && (
            <p className="plan-hero__waiting small" role="status">
              <span className="spinner" aria-hidden="true" />
              Waiting for the payment provider to confirm… (the browser coming back is not enough; this page
              checks with your organization's server)
            </p>
          )}
          {owner && manageable && (
            <div className="row">
              <button type="button" className="pb-button" disabled={offline || busy} onClick={portal}>
                Manage subscription…
              </button>
            </div>
          )}
        </div>
        {left !== null ? (
          <div className="plan-hero__side">
            <p className="plan-hero__figure">
              {left}
              <span className="plan-hero__unit"> {left === 1 ? 'day left' : 'days left'}</span>
            </p>
            {span !== null && (
              <progress
                className="plan-hero__bar"
                aria-label={`${STATE_LABEL[sub.state]} time used`}
                value={Math.max(0, Math.min(span, span - left))}
                max={span}
              />
            )}
            <p className="muted small">
              {sub.state === 'active' ? 'Ends' : sub.state === 'trial' ? 'Trial ends' : 'Until'}{' '}
              {day(sub.until)}
            </p>
          </div>
        ) : renews ? (
          <div className="plan-hero__side">
            <p className="muted small">Renews</p>
            <p className="plan-hero__date">{day(sub.current_period_end)}</p>
          </div>
        ) : null}
      </div>

      {sub.overrides.length > 0 && (
        <p className="muted small">
          Adjusted by support:{' '}
          {sub.overrides
            .map(
              (o) =>
                `${o.scope === 'access.unrestricted' ? 'full access kept' : o.scope.replace(/^(limit|feature)\./, '').replaceAll('_', ' ')} until ${day(o.expires_at)}`,
            )
            .join('; ')}
          .
        </p>
      )}

      <section className="panel" aria-labelledby="billing-limits-title">
        <header className="panel__head">
          <h3 id="billing-limits-title">Plan limits</h3>
          <ul className="feature-chips" aria-label="Included in this plan">
            {(
              [
                ['team_sessions', 'Shared profiles'],
                ['automation', 'Automation'],
                ['api_tokens', 'API tokens'],
                ['webhooks', 'Webhooks'],
              ] as const
            ).map(([k, label]) => (
              <li key={k} className={sub.features[k] ? 'feature-chip' : 'feature-chip feature-chip--off'}>
                {label}
                <span className="pb-sr-only">{sub.features[k] ? ': included' : ': not included'}</span>
              </li>
            ))}
          </ul>
        </header>
        <div className="meters billing-limits">
          {(Object.keys(LIMIT_LABEL) as PlanLimitKey[]).map((k) => (
            <Meter
              key={k}
              label={LIMIT_LABEL[k]}
              used={value(k)}
              limit={sub.limits[k]}
              format={fmt(k)}
              over={sub.over_limits.includes(k)}
            />
          ))}
        </div>
        {sub.over_limits.length > 0 && (
          <p className="notice" role="note">
            This organization uses more than its plan allows (
            {sub.over_limits.map((k) => LIMIT_LABEL[k].toLowerCase()).join(', ')}
            ). Nothing is removed and everything keeps working; adding more waits until you are under the
            limit or choose a larger plan.
          </p>
        )}
      </section>

      {owner && !manageable && (
        <section className="stack" aria-labelledby="billing-plans-title">
          <div className="section-head">
            <h3 id="billing-plans-title">Choose a plan</h3>
            <p className="muted small">
              Payment happens on the payment provider's page; this app never sees card details. Any tax is
              shown at checkout.
            </p>
          </div>
          {plans === null ? (
            <p role="status">Loading plans…</p>
          ) : offered.length === 0 ? (
            <p className="empty-note">No plans are offered on this server yet.</p>
          ) : (
            <ul className="plan-list" aria-labelledby="billing-plans-title">
              {offered.map((p) => {
                const price = p.price ? priceParts(p.price.amount_minor, p.price.currency) : null;
                const year = p.prices?.find((x) => x.interval === 'year');
                const current = p.id === sub.plan.id;
                return (
                  <li
                    key={`${p.id}@${p.version}`}
                    className={`plan-card${p.id === recommended ? ' plan-card--featured' : ''}`}
                  >
                    <div className="plan-card__head">
                      <h4>{p.name}</h4>
                      {current ? (
                        <Pill tone="neutral">Current plan</Pill>
                      ) : (
                        p.id === recommended && <Pill tone="accent">Recommended</Pill>
                      )}
                    </div>
                    <p className="muted small plan-card__desc">{p.description}</p>
                    <p className="plan-price">
                      {price ? (
                        <>
                          <span className="plan-price__amount">{price}</span>
                          <span className="plan-price__interval"> per {p.price?.interval}</span>
                        </>
                      ) : (
                        <span className="plan-price__interval">Price shown at checkout</span>
                      )}
                    </p>
                    {year && p.price?.interval !== 'year' && (
                      <p className="muted small">or {money(year.amount_minor, year.currency)} per year</p>
                    )}
                    <ul className="plan-features">
                      <li>
                        {p.limits.profiles === null ? 'Unlimited profiles' : `${p.limits.profiles} profiles`}
                      </li>
                      <li>
                        {p.limits.seats === null
                          ? 'Unlimited seats'
                          : p.limits.seats === 1
                            ? '1 seat'
                            : `${p.limits.seats} seats`}
                      </li>
                      <li>
                        {p.limits.storage_bytes === null ? 'Unlimited' : formatBytes(p.limits.storage_bytes)}{' '}
                        backup storage
                      </li>
                      <li className={p.features.team_sessions ? undefined : 'plan-features__off'}>
                        {p.features.team_sessions ? 'Shared profiles' : 'No shared profiles'}
                      </li>
                    </ul>
                    <button
                      type="button"
                      className="pb-button plan-choose"
                      data-variant={p.id === recommended ? 'primary' : undefined}
                      disabled={offline || busy || !p.available}
                      onClick={() => choose(p)}
                    >
                      Choose {p.name}
                    </button>
                    {!p.available && <p className="muted small">Not offered on this server yet.</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="billing-usage-title">
        <header className="panel__head">
          <h3 id="billing-usage-title">Usage this period</h3>
          {usage && (
            <p className="muted small">
              {day(usage.period_start)} – {day(usage.period_end)}
            </p>
          )}
        </header>
        {usage === null ? (
          <p className="empty-note">No usage recorded yet.</p>
        ) : usage.totals.length === 0 ? (
          <p className="empty-note">No usage recorded yet in this period.</p>
        ) : (
          <dl className="kv">
            {usage.totals.map((t) => (
              <div key={t.type} className="kv__row">
                <dt>{USAGE_LABEL[t.type] ?? t.type}</dt>
                <dd>
                  {t.type === 'storage_bytes' ? formatBytes(t.quantity) : t.quantity.toLocaleString()}
                  {t.type === 'snapshot_committed' ? ` (${t.events.toLocaleString()} backups)` : ''}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="stack" aria-labelledby="billing-invoices-title">
        <h3 id="billing-invoices-title">Invoices and receipts</h3>
        {invoices === null ? (
          <p role="status">Loading…</p>
        ) : invoices.length === 0 ? (
          <div className="empty-panel">
            <p>No invoices yet.</p>
            <p className="muted small">Invoices and receipts appear here after the first payment.</p>
          </div>
        ) : (
          <table className="simple records invoices" aria-labelledby="billing-invoices-title">
            <thead>
              <tr>
                <th scope="col">Invoice</th>
                <th scope="col">Date</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="pb-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <th scope="row" className="mono-id">
                    {inv.number ?? inv.id}
                  </th>
                  <td>{day(inv.created_at)}</td>
                  <td className="num">
                    {money(
                      inv.status === 'paid' ? inv.amount_paid_minor : inv.amount_due_minor,
                      inv.currency,
                    )}
                  </td>
                  <td>
                    <Pill tone={inv.status === 'paid' ? 'ok' : inv.status === 'open' ? 'warn' : 'neutral'}>
                      {inv.status === 'paid' ? 'Paid' : inv.status === 'open' ? 'Due' : inv.status}
                    </Pill>
                  </td>
                  <td>
                    <div className="cell-actions">
                      {inv.has_hosted_page && (
                        <button
                          type="button"
                          className="pb-button"
                          data-size="sm"
                          disabled={offline}
                          onClick={() => openInvoice(inv, false)}
                        >
                          View<span className="pb-sr-only"> invoice {inv.number ?? ''}</span>
                        </button>
                      )}
                      {inv.has_pdf && (
                        <button
                          type="button"
                          className="pb-button"
                          data-size="sm"
                          disabled={offline}
                          onClick={() => openInvoice(inv, true)}
                        >
                          PDF<span className="pb-sr-only"> of invoice {inv.number ?? ''}</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="muted small">
        {sub.retention_days
          ? `If the subscription ends, data is kept for ${sub.retention_days} days, then deleted on a schedule announced in advance.`
          : 'If the subscription ends, your data is kept until an owner deletes it. A billing problem never deletes profiles or backups.'}
      </p>
    </section>
  );
}
