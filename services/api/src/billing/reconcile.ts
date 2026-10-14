/**
 * Billing reconciliation (milestone 11, ADR-0018), run by the worker.
 *
 * - Webhook events are processed by fetching the CURRENT object from the provider and applying that, never the event
 *   payload (the route does not even store it). Arrival order therefore does not matter, and a replayed or late
 *   "paid" event cannot reactivate a newer canceled state: the fetch returns the canceled subscription.
 * - A subscription replaces an organization's current one only if it is the same subscription or a newer one; events
 *   for an older, ended subscription change nothing.
 * - If the provider cannot be reached, events wait and are retried; organizations keep their last validated state
 *   (plus the bounded renewal grace computed by app.billing_effective).
 * - Resync confirms every provider subscription at least daily (more often around period ends and payment problems),
 *   records time-based transitions, raises deduplicated alerts for staff and samples usage.
 * Nothing here deletes customer data. No payload or personal data is logged.
 */
import { newId } from '@pb/contracts';
import type pg from 'pg';
import { audit } from '../audit.ts';
import { withTx } from '../db.ts';
import { type Stripe, StripeError, type StripeInvoice, type StripeSubscription } from './stripe.ts';

export interface ReconcileDeps {
  /** The worker's pool (pb_worker). */
  pool: pg.Pool;
  stripe: Stripe;
  /** `plan@version` -> price id (the reverse is used to map subscriptions to plans). */
  prices: Record<string, string>;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  /** Days of grace after the provider stops retrying (BILLING_TIMING.graceDays). */
  graceDays: number;
}

const RETRY_SECONDS = [30, 120, 600, 1800, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600];
const LIVE = new Set(['trialing', 'active', 'past_due', 'unpaid']);

// ---------------------------------------------------------------- alerts
export async function raiseAlert(
  c: pg.PoolClient,
  kind: string,
  orgId: string | null,
  ref: string | null,
  detail: string,
): Promise<void> {
  await c.query(
    `insert into billing_alerts (id, kind, org_id, ref, detail) values ($1, $2, $3, $4, $5)
     on conflict (kind, coalesce(org_id, ''), coalesce(ref, '')) where resolved_at is null
     do update set last_seen_at = now(), count = billing_alerts.count + 1, detail = excluded.detail`,
    [newId('billingAlert'), kind, orgId, ref, detail.slice(0, 300)],
  );
}

async function alertAlone(
  deps: ReconcileDeps,
  kind: string,
  orgId: string | null,
  ref: string | null,
  detail: string,
) {
  await withTx(deps.pool, { orgId, userId: null }, (c) => raiseAlert(c, kind, orgId, ref, detail));
}

// ---------------------------------------------------------------- applying a subscription
interface Row {
  plan_id: string;
  plan_version: number;
  state: string;
  reason: string;
  provider_subscription_id: string | null;
  provider_subscription_created: Date | null;
  grace_until: Date | null;
  observed_state: string | null;
  provider_status: string | null;
  provider_fetched_at: Date | null;
}

function planOfPrices(
  prices: Record<string, string>,
  priceIds: string[],
): { id: string; version: number } | null {
  for (const price of priceIds) {
    const key = Object.keys(prices).find((k) => prices[k] === price);
    if (key) {
      const [id, v] = key.split('@');
      if (id && v) return { id, version: Number(v) };
    }
  }
  return null;
}

/** Provider status -> stored state (null: an unfinished checkout, which changes nothing). */
function stateOf(
  sub: StripeSubscription,
  row: Row,
  graceDays: number,
): { state: string; reason: string; graceUntil: Date | null } | null {
  const grace = () =>
    row.state === 'grace' && row.grace_until
      ? row.grace_until
      : new Date(Date.now() + graceDays * 86_400_000);
  switch (sub.status) {
    case 'trialing':
      return { state: 'trial', reason: 'trial', graceUntil: null };
    case 'active':
      return { state: 'active', reason: 'paid', graceUntil: null };
    case 'past_due':
      return { state: 'past_due', reason: 'payment_failed', graceUntil: null };
    case 'unpaid':
      return row.state === 'restricted'
        ? { state: 'restricted', reason: row.reason, graceUntil: null }
        : { state: 'grace', reason: 'payment_retries_exhausted', graceUntil: grace() };
    case 'canceled':
      if (sub.cancellationReason === 'cancellation_requested') {
        return { state: 'canceled', reason: 'canceled_by_customer', graceUntil: null };
      }
      return row.state === 'restricted'
        ? { state: 'restricted', reason: row.reason, graceUntil: null }
        : { state: 'grace', reason: 'payment_retries_exhausted', graceUntil: grace() };
    case 'paused':
      return { state: 'restricted', reason: 'paused', graceUntil: null };
    default:
      return null;
  }
}

export interface ApplyResult {
  outcome: 'applied' | 'unchanged' | 'older_subscription' | 'incomplete' | 'stale';
  stateChanged: boolean;
  planChanged: boolean;
  effective: string | null;
}

/** The database's clock, read just before fetching from the provider (the freshness mark of what is fetched). */
export async function fetchMark(deps: ReconcileDeps): Promise<Date> {
  const { rows } = await deps.pool.query<{ t: Date }>('select clock_timestamp() as t');
  return rows[0]?.t ?? new Date();
}

/**
 * Applies the provider's current subscription to an organization, inside one transaction with its subscription row
 * locked. `cause` is recorded in the history ('webhook:<type>', 'resync', 'checkout'). `fetchedAt` is the database
 * time just before the object was fetched: an object fetched before the one last applied is stale and ignored, so two
 * workers (or an event and a resync) can never put an older answer over a newer one — a late "active" read cannot
 * undo a cancellation that was already applied.
 *
 * Which subscription is the organization's: a live one over an ended one, and of two alike the newer. An ended
 * subscription therefore never replaces a live one, and a live one the customer still pays for is never ignored
 * because a newer one ended.
 */
export async function applySubscription(
  deps: ReconcileDeps,
  orgId: string,
  sub: StripeSubscription,
  cause: string,
  fetchedAt: Date,
): Promise<ApplyResult> {
  return withTx(deps.pool, { orgId, userId: null }, async (c) => {
    const { rows } = await c.query<Row>(
      `select plan_id, plan_version, state, reason, provider_subscription_id, provider_subscription_created,
              grace_until, observed_state, provider_status, provider_fetched_at
         from subscriptions where org_id = $1 for update`,
      [orgId],
    );
    const row = rows[0];
    if (!row) throw new Error('subscription row missing');
    if (row.provider_fetched_at && fetchedAt < row.provider_fetched_at) {
      return { outcome: 'stale', stateChanged: false, planChanged: false, effective: null };
    }
    const created = new Date(sub.created * 1000);
    if (row.provider_subscription_id && row.provider_subscription_id !== sub.id) {
      const storedLive = LIVE.has(row.provider_status ?? '');
      const incomingLive = LIVE.has(sub.status);
      const newer = !row.provider_subscription_created || created > row.provider_subscription_created;
      const replaces = incomingLive !== storedLive ? incomingLive : newer;
      if (!replaces) {
        if (incomingLive) {
          await raiseAlert(
            c,
            'duplicate_subscriptions',
            orgId,
            sub.id,
            'Another subscription of this customer is still live',
          );
        }
        return { outcome: 'older_subscription', stateChanged: false, planChanged: false, effective: null };
      }
      if (incomingLive && storedLive) {
        await raiseAlert(
          c,
          'duplicate_subscriptions',
          orgId,
          sub.id,
          'A second live subscription replaced the first',
        );
      }
    }
    const next = stateOf(sub, row, deps.graceDays);
    if (!next) return { outcome: 'incomplete', stateChanged: false, planChanged: false, effective: null };
    let plan = planOfPrices(deps.prices, sub.priceIds);
    if (!plan) {
      await raiseAlert(
        c,
        'unknown_price',
        orgId,
        sub.priceIds[0] ?? sub.id,
        'Subscription price is not in the catalog',
      );
      plan = { id: row.plan_id, version: row.plan_version };
    }
    const exists = await c.query('select 1 from plans where id = $1 and version = $2', [
      plan.id,
      plan.version,
    ]);
    if (!exists.rowCount) {
      await raiseAlert(
        c,
        'unknown_price',
        orgId,
        `${plan.id}@${plan.version}`,
        'Configured plan is not in the catalog',
      );
      plan = { id: row.plan_id, version: row.plan_version };
    }
    const trialEnds = next.state === 'trial' ? new Date((sub.trialEnd ?? Date.now() / 1000) * 1000) : null;
    await c.query(
      `update subscriptions set plan_id = $2, plan_version = $3, state = $4, reason = $5, provider = 'stripe',
              provider_subscription_id = $6, provider_subscription_created = $7, provider_status = $8,
              trial_ends_at = $9, current_period_end = $10, cancel_at_period_end = $11, grace_until = $12,
              canceled_at = $13, provider_fetched_at = $14, synced_at = now(), resync_after = null, resync_requested_at = null,
              updated_at = now(), version = version + 1
        where org_id = $1`,
      [
        orgId,
        plan.id,
        plan.version,
        next.state,
        next.reason,
        sub.id,
        created,
        sub.status.slice(0, 32),
        trialEnds,
        sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null,
        sub.cancelAtPeriodEnd,
        next.graceUntil,
        sub.canceledAt ? new Date(sub.canceledAt * 1000) : null,
        fetchedAt,
      ],
    );
    const planChanged = plan.id !== row.plan_id || plan.version !== row.plan_version;
    const eff = await c.query<{ state: string; reason: string }>(
      'select state, reason from app.billing_effective($1)',
      [orgId],
    );
    const effective = eff.rows[0]?.state ?? null;
    const stateChanged = effective !== row.observed_state;
    if (stateChanged || planChanged) {
      await c.query(
        `insert into subscription_history (org_id, from_state, to_state, reason, plan_id, plan_version, cause)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          orgId,
          row.observed_state,
          effective,
          eff.rows[0]?.reason ?? next.reason,
          plan.id,
          plan.version,
          cause,
        ],
      );
      await c.query('update subscriptions set observed_state = $2 where org_id = $1', [orgId, effective]);
      await audit(c, {
        orgId,
        actorUserId: null,
        actorDeviceId: null,
        action: planChanged ? 'billing.plan_changed' : 'billing.state_changed',
        targetType: 'organization',
        targetId: orgId,
        outcome: 'success',
        requestId: newId('request'),
        details: { from: row.observed_state, to: effective, plan: `${plan.id}@${plan.version}` },
      });
    }
    return {
      outcome: stateChanged || planChanged ? 'applied' : 'unchanged',
      stateChanged,
      planChanged,
      effective,
    };
  });
}

// ---------------------------------------------------------------- invoices
const STRIPE_URL = /^https:\/\/[a-z0-9.-]+\.stripe\.com\//;

export async function upsertInvoice(deps: ReconcileDeps, orgId: string, inv: StripeInvoice): Promise<void> {
  const status = ['draft', 'open', 'paid', 'void', 'uncollectible'].includes(inv.status)
    ? inv.status
    : 'open';
  await withTx(deps.pool, { orgId, userId: null }, (c) =>
    c.query(
      `insert into billing_invoices (id, org_id, subscription_id, number, status, currency, amount_due, amount_paid,
                                     provider_created_at, period_start, period_end, hosted_url, pdf_url)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (id) do update set status = excluded.status, number = excluded.number,
              amount_due = excluded.amount_due, amount_paid = excluded.amount_paid,
              hosted_url = excluded.hosted_url, pdf_url = excluded.pdf_url, updated_at = now()
        where billing_invoices.org_id = excluded.org_id`,
      [
        inv.id,
        orgId,
        inv.subscription && /^sub_[A-Za-z0-9]{1,64}$/.test(inv.subscription) ? inv.subscription : null,
        inv.number?.slice(0, 64) ?? null,
        status,
        /^[a-z]{3}$/.test(inv.currency) ? inv.currency : 'usd',
        Math.trunc(inv.amountDue),
        Math.trunc(inv.amountPaid),
        new Date(inv.created * 1000),
        inv.periodStart ? new Date(inv.periodStart * 1000) : null,
        inv.periodEnd ? new Date(inv.periodEnd * 1000) : null,
        inv.hostedUrl && STRIPE_URL.test(inv.hostedUrl) ? inv.hostedUrl : null,
        inv.pdfUrl && STRIPE_URL.test(inv.pdfUrl) ? inv.pdfUrl : null,
      ],
    ),
  );
}

// ---------------------------------------------------------------- events
async function orgForCustomer(deps: ReconcileDeps, customer: string | null): Promise<string | null> {
  if (!customer) return null;
  const { rows } = await withTx(deps.pool, { orgId: null, userId: null }, (c) =>
    c.query<{ org: string | null }>('select app.billing_org_for_customer($1) as org', [customer]),
  );
  return rows[0]?.org ?? null;
}

interface EventRow {
  provider_event_id: string;
  type: string;
  object_type: string | null;
  object_id: string | null;
  attempts: number;
}

type Outcome = { status: 'processed' | 'ignored'; orgId: string | null; note?: string };

async function processEvent(deps: ReconcileDeps, ev: EventRow): Promise<Outcome> {
  const cause = `webhook:${ev.type}`.slice(0, 80);
  const id = ev.object_id;
  const unknownCustomer = async (customer: string | null) => {
    await alertAlone(
      deps,
      'unknown_customer',
      null,
      customer ?? ev.provider_event_id,
      `No organization for ${ev.type}`,
    );
    return { status: 'ignored', orgId: null, note: 'unknown_customer' } as Outcome;
  };
  const subscriptionOf = async (subId: string, orgId: string) => {
    const at = await fetchMark(deps);
    const sub = await deps.stripe.getSubscription(subId);
    const owner = await orgForCustomer(deps, sub.customer);
    if (owner !== orgId) return null;
    return applySubscription(deps, orgId, sub, cause, at);
  };

  if (ev.type.startsWith('customer.subscription.') && id?.startsWith('sub_')) {
    const at = await fetchMark(deps);
    const sub = await deps.stripe.getSubscription(id);
    const orgId = await orgForCustomer(deps, sub.customer);
    if (!orgId) return unknownCustomer(sub.customer);
    await applySubscription(deps, orgId, sub, cause, at);
    return { status: 'processed', orgId };
  }
  if (ev.type.startsWith('checkout.session.') && id?.startsWith('cs_')) {
    if (ev.type !== 'checkout.session.completed' && ev.type !== 'checkout.session.async_payment_succeeded') {
      return { status: 'ignored', orgId: null };
    }
    const session = await deps.stripe.getCheckoutSession(id);
    const orgId = await orgForCustomer(deps, session.customer);
    if (!orgId) return unknownCustomer(session.customer);
    // The session must name the same organization (it is created with the organization's own customer).
    if (session.clientReferenceId !== orgId) {
      await alertAlone(
        deps,
        'unknown_customer',
        orgId,
        session.id,
        'Checkout session names another organization',
      );
      return { status: 'ignored', orgId, note: 'reference_mismatch' };
    }
    if (session.subscription) await subscriptionOf(session.subscription, orgId);
    return { status: 'processed', orgId };
  }
  if (ev.type.startsWith('invoice.') && id?.startsWith('in_')) {
    const inv = await deps.stripe.getInvoice(id);
    const orgId = await orgForCustomer(deps, inv.customer);
    if (!orgId) return unknownCustomer(inv.customer);
    await upsertInvoice(deps, orgId, inv);
    if (inv.subscription) {
      const r = await subscriptionOf(inv.subscription, orgId);
      if (
        inv.status === 'paid' &&
        r &&
        r.outcome !== 'older_subscription' &&
        r.effective &&
        !['active', 'trial'].includes(r.effective)
      ) {
        await alertAlone(
          deps,
          'paid_not_active',
          orgId,
          inv.id,
          `Invoice paid but the organization is ${r.effective}`,
        );
      }
    }
    return { status: 'processed', orgId };
  }
  if (ev.type === 'charge.refunded' && id?.startsWith('ch_')) {
    const orgId = await orgForCustomer(deps, await deps.stripe.customerOfCharge(id));
    await alertAlone(deps, 'refund', orgId, id, 'A charge was refunded (reconcile; nothing is deleted)');
    return { status: 'processed', orgId };
  }
  if (ev.type === 'charge.dispute.created' && id?.startsWith('dp_')) {
    const orgId = await orgForCustomer(deps, await deps.stripe.customerOfDispute(id));
    await alertAlone(deps, 'dispute', orgId, id, 'A payment was disputed');
    return { status: 'processed', orgId };
  }
  return { status: 'ignored', orgId: null };
}

/** Claims due events (skip locked), processes each from fresh provider data, and records the outcome. */
export async function processBillingEvents(
  deps: ReconcileDeps,
  limit = 20,
): Promise<{ processed: number; ignored: number; retried: number; failed: number }> {
  const claimed = await withTx(deps.pool, { orgId: null, userId: null }, (c) =>
    c.query<EventRow>(
      `update billing_webhook_events e set next_attempt_at = now() + interval '2 minutes', attempts = e.attempts + 1
        where e.provider_event_id in (
          select provider_event_id from billing_webhook_events
           where status = 'pending' and next_attempt_at <= now()
           order by received_at limit $1 for update skip locked)
       returning e.provider_event_id, e.type, e.object_type, e.object_id, e.attempts`,
      [limit],
    ),
  );
  const out = { processed: 0, ignored: 0, retried: 0, failed: 0 };
  for (const ev of claimed.rows) {
    let status: 'processed' | 'ignored' | 'failed' | 'pending';
    let orgId: string | null = null;
    let error: string | null = null;
    let retryIn = 0;
    try {
      const r = await processEvent(deps, ev);
      status = r.status;
      orgId = r.orgId;
      error = r.note ?? null;
    } catch (err) {
      const e = err instanceof StripeError ? err : null;
      if (e?.missing) {
        status = 'ignored';
        error = 'object_missing';
      } else if (e?.transient && ev.attempts < RETRY_SECONDS.length) {
        status = 'pending';
        error = e.type;
        retryIn = RETRY_SECONDS[ev.attempts - 1] ?? 3600;
      } else {
        status = 'failed';
        error = e ? `${e.status} ${e.type}` : 'processing_error';
        deps.log('error', 'billing event failed', { event: ev.provider_event_id, type: ev.type, error });
        await alertAlone(deps, 'event_failed', null, ev.provider_event_id, `${ev.type}: ${error}`).catch(
          () => undefined,
        );
      }
    }
    await withTx(deps.pool, { orgId: null, userId: null }, (c) =>
      c.query(
        `update billing_webhook_events set status = $2, org_id = coalesce($3, org_id), error = $4,
                processed_at = case when $2 = 'pending' then null else now() end,
                next_attempt_at = now() + make_interval(secs => $5)
          where provider_event_id = $1`,
        [ev.provider_event_id, status, orgId, error?.slice(0, 200) ?? null, retryIn],
      ),
    );
    if (status === 'processed') out.processed++;
    else if (status === 'ignored') out.ignored++;
    else if (status === 'pending') out.retried++;
    else out.failed++;
  }
  return out;
}

// ---------------------------------------------------------------- resync and housekeeping
/** Confirms provider subscriptions due for a resync; a state the webhooks did not bring raises `missed_webhook`. */
export async function resyncSubscriptions(
  deps: ReconcileDeps,
  limit = 50,
): Promise<{ synced: number; missed: number }> {
  const due = await withTx(deps.pool, { orgId: null, userId: null }, (c) =>
    c.query<{ org_id: string; provider_customer_id: string; provider_subscription_id: string | null }>(
      'select * from app.billing_resync_due($1)',
      [limit],
    ),
  );
  let synced = 0;
  let missed = 0;
  for (const r of due.rows) {
    try {
      const at = await fetchMark(deps);
      let sub: StripeSubscription | null = null;
      const all = await deps.stripe.listSubscriptions(r.provider_customer_id);
      const usable = all.filter((s) => s.status !== 'incomplete' && s.status !== 'incomplete_expired');
      // The organization's subscription: a live one over an ended one, and of two alike the newer (a missed
      // checkout.session.completed, or a customer still paying for an older one after a newer one ended).
      const best = (list: StripeSubscription[]) =>
        [...list].sort(
          (a, b) => Number(LIVE.has(b.status)) - Number(LIVE.has(a.status)) || b.created - a.created,
        )[0] ?? null;
      if (r.provider_subscription_id) {
        const current =
          usable.find((s) => s.id === r.provider_subscription_id) ??
          (await deps.stripe.getSubscription(r.provider_subscription_id));
        sub = best([current, ...usable.filter((s) => s.id !== current.id)]);
      } else {
        sub = best(usable);
      }
      if (!sub) {
        await withTx(deps.pool, { orgId: r.org_id, userId: null }, (c) =>
          c.query(
            'update subscriptions set synced_at = now(), resync_after = null, resync_requested_at = null where org_id = $1',
            [r.org_id],
          ),
        );
        continue;
      }
      const res = await applySubscription(deps, r.org_id, sub, 'resync', at);
      synced++;
      if (res.stateChanged || res.planChanged) {
        missed++;
        await alertAlone(
          deps,
          'missed_webhook',
          r.org_id,
          sub.id,
          `Resync changed the organization to ${res.effective}`,
        );
      }
    } catch (err) {
      const e = err instanceof StripeError ? err : null;
      const error = e ? `${e.status} ${e.type}` : 'error';
      deps.log('warn', 'billing resync failed', { org: r.org_id, error });
      // Back off so one failing organization cannot hold the head of every batch; a lasting failure (a deleted
      // customer, ids from another Stripe mode) is an alert for staff.
      const transient = !e || e.transient;
      await withTx(deps.pool, { orgId: r.org_id, userId: null }, async (c) => {
        await c.query(
          `update subscriptions set resync_after = now() + make_interval(secs => $2) where org_id = $1`,
          [r.org_id, transient ? 900 : 6 * 3600],
        );
        if (!transient) {
          await raiseAlert(c, 'resync_failed', r.org_id, r.provider_customer_id, `Resync failed: ${error}`);
        }
      }).catch(() => undefined);
    }
  }
  return { synced, missed };
}

/** Pending events older than 30 minutes: one open alert with the count. */
export async function checkBacklog(deps: ReconcileDeps): Promise<number> {
  return withTx(deps.pool, { orgId: null, userId: null }, async (c) => {
    const { rows } = await c.query<{ n: number }>(
      `select count(*)::int as n from billing_webhook_events
        where status = 'pending' and received_at < now() - interval '30 minutes'`,
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0)
      await raiseAlert(c, 'webhook_backlog', null, null, `${n} provider event(s) waiting over 30 minutes`);
    return n;
  });
}

/** Time-based transitions (trial end, grace end, unconfirmed renewal) recorded in history and activity. */
export async function observeTransitions(pool: pg.Pool): Promise<number> {
  const { rows } = await withTx(pool, { orgId: null, userId: null }, (c) =>
    c.query<{ n: number }>('select app.billing_observe(100000) as n'),
  );
  return rows[0]?.n ?? 0;
}

/** Daily usage samples for yesterday (UTC) and the API roll-up; idempotent. */
export async function sampleUsage(pool: pg.Pool): Promise<number> {
  const { rows } = await withTx(pool, { orgId: null, userId: null }, (c) =>
    c.query<{ n: number }>("select app.billing_sample_usage(((now() at time zone 'UTC')::date - 1)) as n"),
  );
  return rows[0]?.n ?? 0;
}
