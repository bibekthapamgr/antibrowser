/**
 * Billing (milestone 11, ADR-0018): Organization → Billing for owners and billing members, and the subscription
 * banner every member sees. The subscription comes from the organization's server (its database decides what the
 * organization may do); the payment provider's checkout, portal and invoice pages are opened by the shell in the
 * default browser. A payment is never assumed from the browser coming back: this screen waits for the server to
 * confirm it.
 */
import type {
  BillingPlan,
  BillingSummary,
  BillingUsage,
  Invoice,
  PlanLimitKey,
  Subscription,
} from '@pb/contracts/billing';
import type { Role } from '@pb/contracts/resources';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Backend } from './backend/types.ts';
import { errorMessage } from './backend/types.ts';
import { can, get } from './cloud.ts';
import { formatBytes } from './components.tsx';
import { day, type Notify } from './status.tsx';

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
      return `${s.reason === 'trial_ended' ? 'The trial ended.' : s.reason === 'paused' ? 'The subscription is paused.' : 'The subscription needs attention.'} ${RESTRICTED_HELP}`;
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
  const show = (k: PlanLimitKey, n: number | null) =>
    n === null ? 'no limit' : k === 'storage_bytes' ? formatBytes(n) : String(n);

  return (
    <section className="stack billing" aria-labelledby="org-billing-title">
      <h2 id="org-billing-title">Billing</h2>
      <div
        className={`notice${blocked ? ' notice--error' : ''}`}
        role={blocked ? 'alert' : 'status'}
        data-state={sub.state}
      >
        <p>
          <strong>
            {sub.plan.name === STATE_LABEL[sub.state]
              ? sub.plan.name
              : `${sub.plan.name} · ${STATE_LABEL[sub.state]}`}
          </strong>
        </p>
        <p>{stateText(sub, owner)}</p>
        {sub.current_period_end && sub.state === 'active' && !sub.cancel_at_period_end && (
          <p className="muted small">Renews {day(sub.current_period_end)}.</p>
        )}
        {waiting && (
          <p className="small" role="status">
            Waiting for the payment provider to confirm… (the browser coming back is not enough; this page
            checks with your organization's server)
          </p>
        )}
        {owner && manageable && (
          <button type="button" className="pb-button" disabled={offline || busy} onClick={portal}>
            Manage subscription…
          </button>
        )}
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

      <h3 id="billing-limits-title">Plan limits</h3>
      <table className="simple records billing-limits" aria-labelledby="billing-limits-title">
        <thead>
          <tr>
            <th scope="col">Limit</th>
            <th scope="col">Used</th>
            <th scope="col">Allowed</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(LIMIT_LABEL) as PlanLimitKey[]).map((k) => {
            const lim = sub.limits[k];
            const used = value(k);
            const over = sub.over_limits.includes(k);
            return (
              <tr key={k} data-over={over || undefined}>
                <th scope="row">{LIMIT_LABEL[k]}</th>
                <td>
                  {k === 'storage_bytes' ? formatBytes(used) : used}
                  {lim !== null && (
                    <progress
                      aria-label={`${LIMIT_LABEL[k]} used`}
                      value={Math.min(used, lim)}
                      max={Math.max(lim, 1)}
                    />
                  )}
                </td>
                <td>
                  {show(k, lim)}
                  {over && <span className="over-limit">over the limit</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sub.over_limits.length > 0 && (
        <p className="notice" role="note">
          This organization uses more than its plan allows (
          {sub.over_limits.map((k) => LIMIT_LABEL[k].toLowerCase()).join(', ')}
          ). Nothing is removed and everything keeps working; adding more waits until you are under the limit
          or choose a larger plan.
        </p>
      )}
      <p className="muted small">
        Included: {sub.features.team_sessions ? 'shared profiles' : 'no shared profiles'}
        {sub.features.automation ? ', automation' : ''}
        {sub.features.api_tokens ? ', API tokens' : ''}
        {sub.features.webhooks ? ', webhooks' : ''}.
      </p>

      {owner && !manageable && (
        <>
          <h3 id="billing-plans-title">Choose a plan</h3>
          {plans === null ? (
            <p role="status">Loading plans…</p>
          ) : offered.length === 0 ? (
            <p className="muted">No plans are offered on this server yet.</p>
          ) : (
            <ul className="plan-list" aria-labelledby="billing-plans-title">
              {offered.map((p) => (
                <li key={`${p.id}@${p.version}`} className="plan-card">
                  <h4>{p.name}</h4>
                  <p className="muted small">{p.description}</p>
                  <p className="plan-price">
                    {p.price
                      ? `${money(p.price.amount_minor, p.price.currency)} per ${p.price.interval}`
                      : 'Price shown at checkout'}
                  </p>
                  <ul className="small">
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
                    <li>{p.features.team_sessions ? 'Shared profiles' : 'No shared profiles'}</li>
                  </ul>
                  <button
                    type="button"
                    className="pb-button plan-choose"
                    data-variant="primary"
                    disabled={offline || busy || !p.available}
                    onClick={() => choose(p)}
                  >
                    Choose {p.name}
                  </button>
                  {!p.available && <p className="muted small">Not offered on this server yet.</p>}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            Payment happens on the payment provider's page; this app never sees card details. Any tax is shown
            at checkout.
          </p>
        </>
      )}

      <h3 id="billing-usage-title">Usage this period</h3>
      {usage === null ? (
        <p className="muted">No usage recorded yet.</p>
      ) : (
        <>
          <p className="muted small">
            {day(usage.period_start)} – {day(usage.period_end)}
          </p>
          {usage.totals.length === 0 ? (
            <p className="muted">No usage recorded yet in this period.</p>
          ) : (
            <table className="simple records" aria-labelledby="billing-usage-title">
              <tbody>
                {usage.totals.map((t) => (
                  <tr key={t.type}>
                    <th scope="row">{USAGE_LABEL[t.type] ?? t.type}</th>
                    <td>
                      {t.type === 'storage_bytes' ? formatBytes(t.quantity) : t.quantity.toLocaleString()}
                      {t.type === 'snapshot_committed' ? ` (${t.events.toLocaleString()} backups)` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h3 id="billing-invoices-title">Invoices and receipts</h3>
      {invoices === null ? (
        <p role="status">Loading…</p>
      ) : invoices.length === 0 ? (
        <p className="muted">No invoices yet.</p>
      ) : (
        <table className="simple records" aria-labelledby="billing-invoices-title">
          <thead>
            <tr>
              <th scope="col">Invoice</th>
              <th scope="col">Date</th>
              <th scope="col">Amount</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="pb-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <th scope="row">{inv.number ?? inv.id}</th>
                <td>{day(inv.created_at)}</td>
                <td>
                  {money(inv.status === 'paid' ? inv.amount_paid_minor : inv.amount_due_minor, inv.currency)}
                </td>
                <td>{inv.status === 'paid' ? 'Paid' : inv.status === 'open' ? 'Due' : inv.status}</td>
                <td className="row-actions">
                  {inv.has_hosted_page && (
                    <button
                      type="button"
                      className="pb-button"
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
                      disabled={offline}
                      onClick={() => openInvoice(inv, true)}
                    >
                      PDF<span className="pb-sr-only"> of invoice {inv.number ?? ''}</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="muted small">
        {sub.retention_days
          ? `If the subscription ends, data is kept for ${sub.retention_days} days, then deleted on a schedule announced in advance.`
          : 'If the subscription ends, your data is kept until an owner deletes it. A billing problem never deletes profiles or backups.'}
      </p>
    </section>
  );
}
