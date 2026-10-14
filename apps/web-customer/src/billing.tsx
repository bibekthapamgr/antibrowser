/**
 * R4 billing in the portal. Plans and prices come from the server (verified at the payment provider); the price,
 * currency and role are never decided here. Checkout and payment-method changes are the provider's hosted pages.
 * After paying, the return page shows "pending verification" until the provider confirms (webhook, then the
 * server's own check) — a redirect alone never changes a plan.
 */
import type { BillingPlan, Invoice, Subscription } from '@pb/contracts/billing';
import type { Organization } from '@pb/contracts/resources';
import { useEffect, useId, useState } from 'react';
import type { PortalApi } from './api.ts';
import {
  bytes,
  Card,
  can,
  day,
  ErrorBox,
  errorText,
  Loading,
  limitText,
  money,
  TAX_TEXT,
  useLoad,
  usePageHeading,
} from './common.tsx';
import { planIntent, setPlanIntent } from './onboarding.tsx';

export const STATE_TEXT: Record<Subscription['state'], string> = {
  trial: 'Free trial',
  active: 'Active',
  past_due: 'Payment failed — retrying',
  grace: 'Grace period',
  restricted: 'Restricted',
  canceled: 'Canceled',
};

/** What the state means for the person, in one sentence. */
export function stateLine(s: Subscription): string {
  switch (s.state) {
    case 'trial':
      return `Your free trial ends on ${day(s.trial_ends_at ?? s.until)}. Choose a plan to keep creating and opening profiles after that.`;
    case 'active':
      return s.cancel_at_period_end
        ? `Canceled: it stays active until ${day(s.current_period_end)}, then stops renewing. Nothing is deleted.`
        : s.current_period_end
          ? `Renews on ${day(s.current_period_end)}.`
          : // A workspace on a plan without a paid subscription (beta, or kept working by support): no renewal date.
            'No payment is due for this plan right now.';
    case 'past_due':
      return 'A payment failed. Everything keeps working while the provider retries; please check the payment method.';
    case 'grace':
      return `Payment is overdue. Everything keeps working until ${day(s.grace_until ?? s.until)}; please update the payment method.`;
    case 'restricted':
      return 'New profiles and opening profiles are paused until a plan is active. Your data is kept and can be exported.';
    case 'canceled':
      return 'The subscription ended. Your data is kept; choose a plan to continue.';
  }
}

export function BillingPage(props: { api: PortalApi; org: Organization }) {
  const { api, org } = props;
  const h = usePageHeading('Billing');
  const manage = can(org.role, 'billing.manage');
  const read = can(org.role, 'billing.read');
  const sub = useLoad(
    () =>
      read ? api.request<Subscription>('GET', `/orgs/${org.id}/billing/subscription`) : Promise.resolve(null),
    [api, org.id, read],
  );
  const plans = useLoad(
    () =>
      read
        ? api.request<{ items: BillingPlan[] }>('GET', `/orgs/${org.id}/billing/plans`)
        : Promise.resolve(null),
    [api, org.id, read],
  );
  const invoices = useLoad(
    () =>
      read
        ? api.request<{ items: Invoice[] }>('GET', `/orgs/${org.id}/billing/invoices`)
        : Promise.resolve({ items: [] }),
    [api, org.id, read],
  );
  const [interval, setPeriod] = useState<'month' | 'year'>('month');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const intervalName = useId();
  const intent = planIntent();

  if (!read)
    return (
      <>
        <h1 ref={h} tabIndex={-1}>
          Billing
        </h1>
        <Card>
          <p>
            {org.name} is on the <strong>{org.billing?.plan_name ?? 'current'}</strong> plan. Its subscription
            is managed by the workspace’s owners and billing managers; your seat is part of it, so you need no
            plan of your own.
          </p>
        </Card>
      </>
    );

  const startCheckout = async (planId: string) => {
    setBusy(planId);
    setActionError(null);
    try {
      const r = await api.request<{ url: string }>('POST', `/orgs/${org.id}/billing/checkout-session`, {
        plan_id: planId,
        interval,
        return_to: 'portal',
      });
      setPlanIntent(null);
      api.navigate(r.url);
    } catch (e) {
      setActionError(e);
      setBusy(null);
    }
  };
  const openProviderPortal = async () => {
    setBusy('portal');
    setActionError(null);
    try {
      const r = await api.request<{ url: string }>(
        'POST',
        `/orgs/${org.id}/billing/portal-session?return_to=portal`,
      );
      api.navigate(r.url);
    } catch (e) {
      setActionError(e);
      setBusy(null);
    }
  };
  const openInvoice = async (inv: Invoice, which: 'hosted_url' | 'pdf_url') => {
    try {
      const r = await api.request<{ hosted_url: string | null; pdf_url: string | null }>(
        'GET',
        `/orgs/${org.id}/billing/invoices/${inv.id}/links`,
      );
      const url = r[which];
      if (url) api.navigate(url);
    } catch (e) {
      setActionError(e);
    }
  };

  const s = sub.data;
  const items = plans.data?.items.filter((p) => p.available || p.id === s?.plan.id) ?? [];
  const intervals = new Set(items.flatMap((p) => (p.prices ?? []).map((x) => x.interval)));
  const subscribed = !!s?.has_provider_subscription && ['active', 'past_due', 'grace'].includes(s.state);
  return (
    <>
      <h1 ref={h} tabIndex={-1}>
        Billing
      </h1>
      {sub.error !== null && <ErrorBox error={sub.error} retry={sub.reload} />}
      {!s && sub.loading && <Loading />}
      {s && (
        <Card title="Current plan" id="plan-title">
          <p>
            <strong>{s.plan.name}</strong> ·{' '}
            <span className={`state state--${s.state}`}>{STATE_TEXT[s.state]}</span>
          </p>
          <p>{stateLine(s)}</p>
          <dl className="facts">
            <dt>Profiles</dt>
            <dd>
              {s.usage.profiles} of {limitText(s.limits.profiles, '')}
            </dd>
            <dt>Seats (members and pending invitations, owner included)</dt>
            <dd>
              {s.usage.seats} of {limitText(s.limits.seats, '')}
            </dd>
            <dt>Backup storage</dt>
            <dd>
              {bytes(s.usage.storage_bytes)} of {bytes(s.limits.storage_bytes)}
            </dd>
          </dl>
          {s.over_limits.length > 0 && (
            <p className="notice">
              This workspace uses more than its plan allows ({s.over_limits.join(', ')}). Nothing is removed;
              new {s.over_limits.includes('seats') ? 'members' : 'profiles'} cannot be added until it is
              within the plan or the plan changes.
            </p>
          )}
          {manage && s.has_provider_subscription && (
            <div className="actions">
              <button type="button" disabled={busy !== null} onClick={openProviderPortal}>
                Manage payment and plan
              </button>
            </div>
          )}
          {manage && s.has_provider_subscription && (
            <p className="muted small">
              Upgrade, downgrade, cancel, payment methods and billing details are handled on the payment
              provider’s page. It shows the exact amount and any proration before you confirm.
            </p>
          )}
          {!manage && <p className="muted small">Only owners change the plan or the payment method.</p>}
        </Card>
      )}
      {actionError !== null && <ErrorBox error={actionError} />}
      {!subscribed && (
        <Card title="Choose a plan" id="plans-title">
          {plans.error !== null && <ErrorBox error={plans.error} retry={plans.reload} />}
          {plans.loading && !plans.data && <Loading what="Loading plans…" />}
          {plans.data && items.length === 0 && (
            <p className="notice">
              Plans cannot be bought on this server right now. Your trial and data are not affected.
            </p>
          )}
          {intervals.size > 1 && (
            <fieldset className="segmented">
              <legend>Billing period</legend>
              {(['month', 'year'] as const).map((i) => (
                <label key={i}>
                  <input
                    type="radio"
                    name={intervalName}
                    checked={interval === i}
                    onChange={() => setPeriod(i)}
                  />
                  {i === 'month' ? 'Monthly' : 'Yearly'}
                </label>
              ))}
            </fieldset>
          )}
          <ul className="plans">
            {items.map((p) => {
              const price = (p.prices ?? []).find((x) => x.interval === interval);
              return (
                <li key={p.id} className={`plan${intent === p.id ? ' plan--chosen' : ''}`}>
                  <h3>{p.name}</h3>
                  <p className="muted">{p.description}</p>
                  <p className="price">
                    {price ? (
                      <>
                        <strong>{money(price.amount_minor, price.currency)}</strong> per{' '}
                        {price.interval === 'month' ? 'month' : 'year'}
                        <span className="muted small"> · {TAX_TEXT[price.tax]}</span>
                      </>
                    ) : (
                      <span className="muted">
                        {interval === 'year' ? 'Not offered yearly.' : 'Price not available right now.'}
                      </span>
                    )}
                  </p>
                  <ul className="limits">
                    <li>{limitText(p.limits.profiles, 'profiles')}</li>
                    <li>
                      {limitText(p.limits.seats, p.limits.seats === 1 ? 'seat' : 'seats')} (owner included)
                    </li>
                    <li>{bytes(p.limits.storage_bytes)} encrypted backups</li>
                    {p.features.team_sessions && <li>Shared profiles with handoff</li>}
                  </ul>
                  {intent === p.id && <p className="small">You chose this plan when you signed up.</p>}
                  {manage ? (
                    <button
                      type="button"
                      className={intent === p.id ? 'primary' : undefined}
                      disabled={!price || busy !== null}
                      onClick={() => startCheckout(p.id)}
                    >
                      {busy === p.id ? 'Opening checkout…' : `Choose ${p.name}`}
                    </button>
                  ) : (
                    <p className="muted small">An owner can choose this plan.</p>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="muted small">
            Checkout is the payment provider’s page; we never see card details. The amount, tax and currency
            shown there are binding. Your plan changes once the provider confirms the payment.
          </p>
        </Card>
      )}
      <Card title="Invoices" id="invoices-title">
        {invoices.error !== null && <ErrorBox error={invoices.error} retry={invoices.reload} />}
        {invoices.loading && !invoices.data && <Loading />}
        {invoices.data && invoices.data.items.length === 0 && <p className="muted">No invoices yet.</p>}
        {invoices.data && invoices.data.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Invoices</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Number</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Links</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.data.items.map((i) => (
                  <tr key={i.id}>
                    <td>{day(i.created_at)}</td>
                    <td>{i.number ?? '—'}</td>
                    <td>{money(i.amount_due_minor, i.currency)}</td>
                    <td>{i.status === 'paid' ? 'Paid' : i.status === 'open' ? 'Open' : i.status}</td>
                    <td>
                      {i.has_hosted_page && (
                        <button type="button" className="link" onClick={() => openInvoice(i, 'hosted_url')}>
                          View<span className="sr-only"> invoice {i.number ?? ''}</span>
                        </button>
                      )}{' '}
                      {i.has_pdf && (
                        <button type="button" className="link" onClick={() => openInvoice(i, 'pdf_url')}>
                          PDF<span className="sr-only"> of invoice {i.number ?? ''}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * Where the payment provider sends the browser back. A redirect is never proof of payment: this page waits for the
 * server to say the plan is active (the provider's confirmation), up to a few minutes, and says what is happening.
 */
export function BillingReturn(props: {
  api: PortalApi;
  org: Organization;
  result: string;
  onDone: () => void;
}) {
  const { api, org, result } = props;
  const h = usePageHeading(result === 'success' ? 'Confirming your payment' : 'Checkout canceled');
  const [sub, setSub] = useState<Subscription | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (result !== 'success') return;
    let live = true;
    let n = 0;
    const tick = async () => {
      try {
        const s = await api.request<Subscription>('GET', `/orgs/${org.id}/billing/subscription`);
        if (!live) return;
        setSub(s);
        setError(null);
        if (s.state === 'active' && s.has_provider_subscription) return;
      } catch (e) {
        if (live) setError(e);
      }
      n++;
      setWaited(n);
      // Every 3 s for two minutes, then every 15 s: a slow confirmation still arrives.
      if (live) setTimeout(tick, n < 40 ? 3000 : 15_000);
    };
    void tick();
    return () => {
      live = false;
    };
  }, [api, org.id, result]);
  if (result !== 'success')
    return (
      <Card>
        <h1 ref={h} tabIndex={-1}>
          {result === 'canceled' ? 'Checkout canceled' : 'Back from billing'}
        </h1>
        <p>{result === 'canceled' ? 'Nothing was charged. You can choose a plan again at any time.' : ''}</p>
        <div className="actions">
          <button type="button" className="primary" onClick={props.onDone}>
            Back to billing
          </button>
        </div>
      </Card>
    );
  const active = sub?.state === 'active' && sub.has_provider_subscription;
  return (
    <Card>
      <h1 ref={h} tabIndex={-1}>
        {active ? 'Your plan is active' : 'Confirming your payment'}
      </h1>
      <div role="status" aria-live="polite">
        {active ? (
          <p>
            <strong>{sub?.plan.name}</strong> is active for {org.name}. The desktop app shows the same plan
            the next time it checks (within a minute).
          </p>
        ) : (
          <>
            <p>
              <strong>Pending verification.</strong> The payment provider has to confirm the payment before
              the plan changes. This usually takes a few seconds.
            </p>
            {waited >= 40 && (
              <p className="notice">
                This is taking longer than usual. You can close this page: the plan changes by itself once the
                confirmation arrives, and the owners get an e-mail. You are never charged twice by coming back
                here.
              </p>
            )}
          </>
        )}
      </div>
      {error !== null && <p className="error">{errorText(error)}</p>}
      <div className="actions">
        <button type="button" className={active ? 'primary' : undefined} onClick={props.onDone}>
          {active ? 'Go to billing' : 'Back to billing'}
        </button>
      </div>
    </Card>
  );
}
