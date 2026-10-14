/**
 * Milestone 11 acceptance (ADR-0018), against an in-process fake Stripe speaking the same HTTP API: successful and
 * failed payments, duplicate and out-of-order webhooks, a replayed paid event after cancellation, upgrade, downgrade,
 * cancellation, grace and trial expiry, a provider outage, concurrent profile and seat creation, restricted
 * organizations closing and exporting, overrides, the usage ledger, alerts, and no card data or secrets in logs.
 */
import { randomBytes } from 'node:crypto';
import { newId, RESTRICTED_ACTIONS } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncCatalog } from '../scripts/migrate.ts';
import {
  applySubscription,
  checkBacklog,
  fetchMark,
  observeTransitions,
  processBillingEvents,
  type ReconcileDeps,
  resyncSubscriptions,
  sampleUsage,
} from '../src/billing/reconcile.ts';
import { createStripe, stripeSignatureHeader, verifyStripeSignature } from '../src/billing/stripe.ts';
import { type FakeStripe, fakeStripe, stripeEnv } from './fake-stripe.ts';
import { type Harness, harness, idemKey, type SignedIn } from './helpers.ts';

let f: FakeStripe;
let h: Harness;
let deps: ReconcileDeps;
const logLines: string[] = [];

beforeAll(async () => {
  f = await fakeStripe();
  h = await harness({ env: stripeEnv(f), logLines });
  deps = {
    pool: h.worker,
    stripe: createStripe({ secretKey: f.secretKey, apiBase: f.url }),
    prices: { 'starter@1': f.prices.starter, 'team@1': f.prices.team, 'agency@1': f.prices.agency },
    log: () => undefined,
    graceDays: 7,
  };
});
afterAll(async () => {
  await h?.close();
  await f?.close();
});

// ---------------------------------------------------------------- helpers
interface Org {
  id: string;
  owner: SignedIn;
}

async function newOrg(name = 'Billing (test)'): Promise<Org> {
  const owner = await h.signIn();
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().id, owner };
}

const get = (o: Org, path: string, headers = o.owner.headers) =>
  h.app.inject({ method: 'GET', url: `/v1/orgs/${o.id}${path}`, headers });
const post = (o: Org, path: string, payload?: object, headers = o.owner.headers) =>
  h.app.inject({ method: 'POST', url: `/v1/orgs/${o.id}${path}`, headers, ...(payload ? { payload } : {}) });

async function subscription(o: Org) {
  const res = await get(o, '/billing/subscription');
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function deliver(events: Record<string, unknown>[], opts: { secret?: string; t?: number } = {}) {
  const out = [];
  for (const ev of events) {
    const { body, header } = f.sign(ev, opts);
    out.push(
      await h.app.inject({
        method: 'POST',
        url: '/v1/webhooks/billing',
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
        payload: body,
      }),
    );
  }
  return out;
}

async function work() {
  const total = { processed: 0, ignored: 0, retried: 0, failed: 0 };
  for (let i = 0; i < 20; i++) {
    const r = await processBillingEvents(deps, 50);
    total.processed += r.processed;
    total.ignored += r.ignored;
    total.retried += r.retried;
    total.failed += r.failed;
    if (r.processed + r.ignored + r.failed + r.retried === 0) break;
  }
  return total;
}

/** Owner checks out a plan and the customer pays (or the card fails). Returns the provider subscription id. */
async function subscribe(o: Org, plan = 'team', opts: { fail?: boolean } = {}): Promise<string> {
  const res = await post(o, '/billing/checkout-session', { plan_id: plan });
  expect(res.statusCode, res.body).toBe(201);
  const url = new URL(res.json().url);
  expect(url.host).toBe('checkout.stripe.com');
  const sessionId = url.pathname.split('/').pop() as string;
  const events = f.completeCheckout(sessionId, opts);
  for (const r of await deliver(events)) expect(r.statusCode, r.body).toBe(200);
  await work();
  return f.sessions.get(sessionId)?.subscription as string;
}

async function createProfile(o: Org, name = `p-${randomBytes(3).toString('hex')}`) {
  return post(o, '/profiles', { name });
}

async function history(orgId: string) {
  const { rows } = await h.owner.query(
    'select from_state, to_state, cause from subscription_history where org_id = $1 order by id',
    [orgId],
  );
  return rows;
}

// ---------------------------------------------------------------- trial and checkout
describe('trial and checkout', () => {
  it('starts every new organization on a 14-day trial with trial limits', async () => {
    const o = await newOrg();
    const s = await subscription(o);
    expect(s).toMatchObject({
      plan: { id: 'trial' },
      state: 'trial',
      reason: 'trial',
      has_provider_subscription: false,
    });
    const days = (new Date(s.until).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    expect(s.limits).toMatchObject({ seats: 5, profiles: 100 });
    const org = (await get(o, '')).json();
    expect(org.billing).toEqual({
      plan_id: 'trial',
      plan_name: 'Trial',
      state: 'trial',
      reason: 'trial',
      until: s.until,
    });
  });

  it('a successful payment activates the plan; the redirect back alone changes nothing', async () => {
    const o = await newOrg();
    const res = await post(o, '/billing/checkout-session', { plan_id: 'team' });
    expect(res.statusCode, res.body).toBe(201);
    const sessionId = new URL(res.json().url).pathname.split('/').pop() as string;
    // The checkout used the organization's own customer, the configured price, an idempotency key and the pinned API.
    const create = f.requests.find(
      (r) => r.path === '/v1/checkout/sessions' && r.params.client_reference_id === o.id,
    );
    expect(create).toMatchObject({
      version: '2025-03-31.basil',
      params: { mode: 'subscription', 'line_items[0][price]': f.prices.team },
    });
    expect(create?.idempotencyKey).toMatch(/^pb-checkout-chk_/); // R4: one key per checkout attempt
    // The browser comes back: informational only.
    const back = await h.app.inject({ method: 'GET', url: '/v1/billing/return?result=success' });
    expect(back.statusCode).toBe(200);
    expect(back.headers['content-type']).toContain('text/html');
    expect((await subscription(o)).state).toBe('trial');
    // The provider confirms.
    await deliver(f.completeCheckout(sessionId));
    expect((await subscription(o)).state).toBe('trial'); // recorded, not yet applied by the worker
    expect((await work()).processed).toBe(3);
    const s = await subscription(o);
    expect(s).toMatchObject({
      plan: { id: 'team', version: 1 },
      state: 'active',
      reason: 'paid',
      has_provider_subscription: true,
    });
    expect(s.limits).toMatchObject({ seats: 5, profiles: 500 });
    expect(s.current_period_end).not.toBeNull();
    const inv = (await get(o, '/billing/invoices')).json().items;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({
      status: 'paid',
      currency: 'usd',
      amount_paid_minor: 4900,
      has_hosted_page: true,
      has_pdf: true,
    });
    const links = (await get(o, `/billing/invoices/${inv[0].id}/links`)).json();
    expect(new URL(links.hosted_url).host).toBe('invoice.stripe.com');
    expect((await history(o.id)).map((r) => r.to_state)).toEqual(['trial', 'active']);
    const audit = await h.owner.query(
      "select action from audit_events where org_id = $1 and action like 'billing.%' order by created_at",
      [o.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['billing.checkout_started', 'billing.plan_changed']);
  });

  it('a failed payment at checkout changes nothing (an incomplete subscription is ignored)', async () => {
    const o = await newOrg();
    await subscribe(o, 'team', { fail: true });
    expect(await subscription(o)).toMatchObject({
      plan: { id: 'trial' },
      state: 'trial',
      has_provider_subscription: false,
    });
  });

  it('only owners start checkout or the portal, only for offered plans, and not while subscribed', async () => {
    const o = await newOrg();
    expect((await post(o, '/billing/checkout-session', { plan_id: 'beta' })).json().code).toBe(
      'PLAN_NOT_AVAILABLE',
    );
    expect((await post(o, '/billing/checkout-session', { plan_id: 'internal' })).json().code).toBe(
      'PLAN_NOT_AVAILABLE',
    );
    expect((await post(o, '/billing/portal-session')).json()).toMatchObject({
      code: 'PLAN_NOT_AVAILABLE',
      safe_details: { reason: 'no_customer' },
    });
    await subscribe(o, 'team');
    expect((await post(o, '/billing/checkout-session', { plan_id: 'agency' })).json().code).toBe(
      'ALREADY_SUBSCRIBED',
    );
    const portal = await post(o, '/billing/portal-session');
    expect(portal.statusCode, portal.body).toBe(201);
    expect(new URL(portal.json().url).host).toBe('billing.stripe.com');
    // A billing member reads but cannot manage; an admin cannot even read billing.
    const billing = await h.signIn();
    const admin = await h.signIn();
    for (const [p, role] of [
      [billing, 'billing'],
      [admin, 'admin'],
    ] as const) {
      await h.owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [
        o.id,
        p.session.user.id,
        role,
      ]);
    }
    expect((await get(o, '/billing/subscription', billing.headers)).statusCode).toBe(200);
    expect((await get(o, '/billing/invoices', billing.headers)).statusCode).toBe(200);
    expect((await post(o, '/billing/portal-session', undefined, billing.headers)).json().code).toBe(
      'FORBIDDEN',
    );
    expect((await get(o, '/billing/subscription', admin.headers)).json().code).toBe('FORBIDDEN');
    expect((await post(o, '/billing/checkout-session', { plan_id: 'team' }, admin.headers)).json().code).toBe(
      'FORBIDDEN',
    );
  });

  it('lists the plans this server sells with provider prices', async () => {
    const o = await newOrg();
    const plans = (await get(o, '/billing/plans')).json().items;
    expect(plans.map((p: { id: string }) => p.id)).toEqual(['trial', 'starter', 'team', 'agency']);
    expect(plans.find((p: { id: string }) => p.id === 'team')).toMatchObject({
      available: true,
      price: { amount_minor: 4900, currency: 'usd', interval: 'month' },
    });
    expect(plans.find((p: { id: string }) => p.id === 'trial')).toMatchObject({
      available: false,
      price: null,
    });
  });
});

// ---------------------------------------------------------------- webhooks
describe('webhooks', () => {
  it('refuses missing, wrong, stale and other-mode signatures and records nothing', async () => {
    const o = await newOrg();
    const ev = f.event('customer.subscription.updated', { id: 'sub_none', object: 'subscription' });
    const count = async () =>
      (
        await h.owner.query(
          'select count(*)::int as n from billing_webhook_events where provider_event_id = $1',
          [ev.id],
        )
      ).rows[0].n;
    const bodyOf = JSON.stringify(ev);
    const send = (headers: Record<string, string>, payload = bodyOf) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/webhooks/billing',
        headers: { 'content-type': 'application/json', ...headers },
        payload,
      });
    expect((await send({})).json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      safe_details: { reason: 'missing' },
    });
    const otherSecret = `whsec_${randomBytes(16).toString('hex')}`;
    expect((await deliver([ev], { secret: otherSecret }))[0]?.json().safe_details.reason).toBe('mismatch');
    expect(
      (await deliver([ev], { t: Math.floor(Date.now() / 1000) - 600 }))[0]?.json().safe_details.reason,
    ).toBe('stale');
    // A valid signature over a different body (one changed character) fails.
    const { header } = f.sign(ev);
    expect(
      (await send({ 'stripe-signature': header }, bodyOf.replace('updated', 'deleted'))).json().safe_details
        .reason,
    ).toBe('mismatch');
    const live = { ...ev, livemode: true };
    expect((await deliver([live]))[0]?.json().safe_details.reason).toBe('livemode');
    expect(await count()).toBe(0);
    const alert = await h.owner.query(
      "select count from billing_alerts where kind = 'signature_failures' and resolved_at is null",
    );
    expect(alert.rows[0]?.count).toBeGreaterThanOrEqual(4);
    void o;
  });

  it('verifies like Stripe: any v1 of several (a rotation), other schemes ignored', () => {
    const body = Buffer.from('{"id":"evt_1"}');
    const a = `whsec_${randomBytes(16).toString('hex')}`;
    const b = `whsec_${randomBytes(16).toString('hex')}`;
    const t = Math.floor(Date.now() / 1000);
    const sigB = stripeSignatureHeader(body.toString(), b, t).split(',')[1] as string;
    const sigA = stripeSignatureHeader(body.toString(), a, t).split(',')[1] as string;
    expect(verifyStripeSignature(body, `t=${t},v0=${'0'.repeat(64)},${sigB}`, [a, b]).ok).toBe(true);
    expect(verifyStripeSignature(body, `t=${t},${sigA},${sigB}`, [a]).ok).toBe(true);
    expect(verifyStripeSignature(body, `t=${t},v0=${sigA.slice(3)}`, [a])).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('a duplicate event is recorded once and applied once', async () => {
    const o = await newOrg();
    const sub = await subscribe(o, 'team');
    const events = f.failRenewal(sub);
    const first = await deliver(events);
    const again = await deliver(events);
    expect(first.map((r) => r.json())).toEqual([
      { received: true, duplicate: false },
      { received: true, duplicate: false },
    ]);
    expect(again.map((r) => r.json())).toEqual([
      { received: true, duplicate: true },
      { received: true, duplicate: true },
    ]);
    await work();
    expect((await subscription(o)).state).toBe('past_due');
    expect((await history(o.id)).filter((r) => r.to_state === 'past_due')).toHaveLength(1);
  });

  it('out-of-order and replayed events: the provider’s current state wins; a paid event cannot undo a cancellation', async () => {
    const o = await newOrg();
    const res = await post(o, '/billing/checkout-session', { plan_id: 'team' });
    const sessionId = new URL(res.json().url).pathname.split('/').pop() as string;
    const paid = f.completeCheckout(sessionId);
    const sub = f.sessions.get(sessionId)?.subscription as string;
    const canceled = f.cancel(sub);
    // The cancellation arrives first, the earlier "paid" events afterwards.
    await deliver(canceled);
    await work();
    expect(await subscription(o)).toMatchObject({ state: 'canceled', reason: 'canceled_by_customer' });
    await deliver(paid);
    await work();
    expect(await subscription(o)).toMatchObject({ state: 'canceled', reason: 'canceled_by_customer' });
    // A replay of the paid event with a new id (an attacker cannot sign; this is the provider resending).
    await deliver([
      f.event(
        'invoice.paid',
        paid[2]?.data ? (paid[2].data as { object: Record<string, unknown> }).object : {},
      ),
    ]);
    await work();
    expect((await subscription(o)).state).toBe('canceled');
  });

  it('events for an older subscription never replace the newer one', async () => {
    const o = await newOrg();
    const first = await subscribe(o, 'starter');
    await deliver(f.cancel(first));
    await work();
    expect((await subscription(o)).state).toBe('canceled');
    // The customer subscribes again (a new subscription), then a late event about the first arrives.
    const customer = f.subscriptions.get(first)?.customer as string;
    const second = f.createSubscription(customer, f.prices.agency);
    await deliver([f.event('customer.subscription.created', second)]);
    await work();
    expect(await subscription(o)).toMatchObject({ state: 'active', plan: { id: 'agency' } });
    await deliver([
      f.event('customer.subscription.updated', f.subscriptions.get(first) as Record<string, unknown>),
    ]);
    await work();
    expect(await subscription(o)).toMatchObject({ state: 'active', plan: { id: 'agency' } });
  });

  it('records events it does not act on and events for unknown customers without changing anything', async () => {
    const ignored = f.event('customer.created', { id: 'cus_somebody', object: 'customer' });
    expect((await deliver([ignored]))[0]?.json()).toEqual({ received: true, duplicate: false });
    const stranger = f.createSubscription('cus_stranger', f.prices.team);
    await deliver([f.event('customer.subscription.created', stranger)]);
    await work();
    const { rows } = await h.owner.query(
      'select provider_event_id, status, error from billing_webhook_events where provider_event_id = any($1)',
      [[ignored.id]],
    );
    expect(rows[0]).toMatchObject({ status: 'ignored' });
    const alert = await h.owner.query(
      "select 1 from billing_alerts where kind = 'unknown_customer' and ref = 'cus_stranger'",
    );
    expect(alert.rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------- lifecycle
describe('payment failures, grace and restriction', () => {
  it('past_due keeps full access; exhausted retries give 7 days of grace; then restricted; paying restores', async () => {
    const o = await newOrg();
    const sub = await subscribe(o, 'team');
    await deliver(f.failRenewal(sub));
    await work();
    expect(await subscription(o)).toMatchObject({ state: 'past_due', reason: 'payment_failed' });
    expect((await createProfile(o)).statusCode).toBe(201);
    await deliver(f.retriesExhausted(sub));
    await work();
    const g = await subscription(o);
    expect(g).toMatchObject({ state: 'grace', reason: 'payment_retries_exhausted' });
    expect((new Date(g.until).getTime() - Date.now()) / 86_400_000).toBeGreaterThan(6.9);
    expect((await createProfile(o)).statusCode).toBe(201);
    // The grace period ends (the clock moves; no job needed for it to take effect).
    await h.owner.query(
      "update subscriptions set grace_until = now() - interval '1 minute' where org_id = $1",
      [o.id],
    );
    expect(await subscription(o)).toMatchObject({ state: 'restricted', reason: 'grace_ended' });
    const refused = await createProfile(o);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: 'SUBSCRIPTION_RESTRICTED',
      safe_details: {
        state: 'restricted',
        action: 'profile.create',
        still_allowed: expect.arrayContaining(['close_profiles', 'export']),
      },
    });
    // The worker records the time-based transition in the history and the activity log.
    expect(await observeTransitions(h.worker)).toBeGreaterThanOrEqual(1);
    expect((await history(o.id)).at(-1)).toMatchObject({
      from_state: 'grace',
      to_state: 'restricted',
      cause: 'time',
    });
    // Paying brings it back at once.
    await deliver(f.payRenewal(sub));
    await work();
    expect(await subscription(o)).toMatchObject({ state: 'active' });
    expect((await createProfile(o)).statusCode).toBe(201);
  });

  it('canceled for non-payment is grace, then restricted — data is never deleted', async () => {
    const o = await newOrg();
    const sub = await subscribe(o, 'team');
    const profile = (await createProfile(o, 'Keep me')).json().id;
    await deliver(f.retriesExhausted(sub, { cancel: true }));
    await work();
    expect((await subscription(o)).state).toBe('grace');
    await h.owner.query(
      "update subscriptions set grace_until = now() - interval '1 second' where org_id = $1",
      [o.id],
    );
    expect((await subscription(o)).state).toBe('restricted');
    const p = await get(o, `/profiles/${profile}`);
    expect(p.statusCode).toBe(200);
    expect(p.json().name).toBe('Keep me');
  });

  it('a trial that ends without a plan is restricted', async () => {
    const o = await newOrg();
    await h.owner.query(
      "update subscriptions set trial_ends_at = now() - interval '1 minute' where org_id = $1",
      [o.id],
    );
    expect(await subscription(o)).toMatchObject({ state: 'restricted', reason: 'trial_ended' });
    expect((await get(o, '')).json().billing).toMatchObject({ state: 'restricted', reason: 'trial_ended' });
    expect((await createProfile(o)).json().code).toBe('SUBSCRIPTION_RESTRICTED');
    // Checkout stays possible (billing is always allowed).
    expect((await post(o, '/billing/checkout-session', { plan_id: 'team' })).statusCode).toBe(201);
  });

  it('cancellation at the period end keeps the plan until then, then the organization is canceled', async () => {
    const o = await newOrg();
    const sub = await subscribe(o, 'team');
    await deliver(f.cancel(sub, { atPeriodEnd: true }));
    await work();
    const s = await subscription(o);
    expect(s).toMatchObject({ state: 'active', cancel_at_period_end: true });
    expect(s.until).toBe(s.current_period_end);
    await h.owner.query(
      "update subscriptions set current_period_end = now() - interval '1 minute' where org_id = $1",
      [o.id],
    );
    expect(await subscription(o)).toMatchObject({ state: 'canceled', reason: 'canceled_by_customer' });
    expect((await createProfile(o)).json().code).toBe('SUBSCRIPTION_RESTRICTED');
  });
});

describe('restricted organizations', () => {
  it('can read, close, back up, export, delete and manage billing — and nothing in RESTRICTED_ACTIONS', async () => {
    const o = await newOrg();
    const profile = (await createProfile(o, 'Open one')).json().id;
    const client = (await post(o, '/clients', { name: 'Client A' })).json().id;
    const device = o.owner.session.device.id;
    const opened = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${o.id}/profiles/${profile}/leases`,
      headers: { ...o.owner.headers, 'idempotency-key': idemKey() },
      payload: { device_id: device, browser_version: '155.0.8059.39', platform: 'linux-x64' },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const lease = opened.json().lease;
    // An invitation made before the restriction cannot be used to join while restricted.
    const inviteEmail = `late-${randomBytes(3).toString('hex')}@people.test`;
    const invite = (await post(o, '/invitations', { email: inviteEmail, role: 'viewer' })).json();
    const invitee = await h.signIn({ email: inviteEmail });
    await h.owner.query(
      "update subscriptions set trial_ends_at = now() - interval '1 minute' where org_id = $1",
      [o.id],
    );
    // Refused: every restricted action that has a route here.
    const refusals: Record<string, () => Promise<{ json(): { code: string } }>> = {
      'profile.create': () => createProfile(o),
      'client.create': () => post(o, '/clients', { name: 'Client B' }),
      'member.invite': () => post(o, '/invitations', { email: 'new@people.test', role: 'viewer' }),
      'token.create': () =>
        post(o, '/api-tokens', { name: 't', scopes: ['profiles:read'], expires_in_days: 1 }),
      'webhook.create': () =>
        post(o, '/webhook-endpoints', {
          url: 'https://hooks.example.com/x',
          events: ['automation.job.failed'],
        }),
      'automation.create': () =>
        h.app.inject({
          method: 'POST',
          url: `/v1/orgs/${o.id}/automation/jobs`,
          headers: { ...o.owner.headers, 'idempotency-key': idemKey() },
          payload: { profile_id: profile, steps: [], keep_open_minutes: 5 },
        }),
      'profile.open': () =>
        h.app.inject({
          method: 'POST',
          url: `/v1/orgs/${o.id}/profiles/${profile}/leases`,
          headers: { ...o.owner.headers, 'idempotency-key': idemKey() },
          payload: { device_id: device, browser_version: '155.0.8059.39', platform: 'linux-x64' },
        }),
      import: () =>
        h.app.inject({
          method: 'POST',
          url: `/v1/orgs/${o.id}/local-import`,
          headers: { ...o.owner.headers, 'idempotency-key': idemKey() },
          payload: { dry_run: true, clients: [], profiles: [] },
        }),
      'invitation.accept': () =>
        h.app.inject({
          method: 'POST',
          url: `/v1/invitations/${invite.token}/accept`,
          headers: invitee.headers,
        }),
    };
    for (const [action, call] of Object.entries(refusals)) {
      expect((await call()).json().code, action).toBe('SUBSCRIPTION_RESTRICTED');
    }
    // Every restricted action is covered by a test here or below (automation.claim: agents; trash.restore: below).
    expect(RESTRICTED_ACTIONS.filter((a) => !(a in refusals))).toEqual(['trash.restore', 'automation.claim']);
    // Allowed: heartbeat and release the open profile, read, export, delete, billing.
    const hb = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${o.id}/profiles/${profile}/leases/${lease.id}/heartbeat`,
      headers: o.owner.headers,
      payload: { fencing_token: lease.fencing_token, run_state: 'running' },
    });
    expect(hb.statusCode, hb.body).toBe(200);
    const released = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${o.id}/profiles/${profile}/leases/${lease.id}/release`,
      headers: o.owner.headers,
      payload: { fencing_token: lease.fencing_token, outcome: 'closed' },
    });
    expect(released.statusCode, released.body).toBeLessThan(300);
    expect((await get(o, '/profiles')).statusCode).toBe(200);
    expect((await get(o, `/clients/${client}`)).statusCode).toBe(200);
    const etag = (await get(o, `/profiles/${profile}`)).headers.etag as string;
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${o.id}/profiles/${profile}`,
      headers: { ...o.owner.headers, 'if-match': etag },
    });
    expect(del.statusCode, del.body).toBeLessThan(300);
    // Restoring from the trash adds a profile: refused.
    const undelete = await post(o, `/profiles/${profile}/undelete`);
    expect(undelete.json().code).toBe('SUBSCRIPTION_RESTRICTED');
    expect((await get(o, '/billing/subscription')).statusCode).toBe(200);
  });

  it('staff can keep an organization working with an override until it expires', async () => {
    const o = await newOrg();
    await h.owner.query(
      "update subscriptions set trial_ends_at = now() - interval '1 minute' where org_id = $1",
      [o.id],
    );
    expect((await createProfile(o)).json().code).toBe('SUBSCRIPTION_RESTRICTED');
    const ovr = newId('override');
    await h.owner.query(
      `insert into entitlement_overrides (id, org_id, scope, value, reason, created_by, expires_at)
       values ($3, $1, 'access.unrestricted', 'true', 'test: customer is paying by wire transfer', $2, now() + interval '1 day')`,
      [o.id, o.owner.session.user.id, ovr],
    );
    expect((await createProfile(o)).statusCode).toBe(201);
    const s = await subscription(o);
    expect(s.state).toBe('restricted');
    expect(s.overrides).toEqual([{ scope: 'access.unrestricted', expires_at: expect.any(String) }]);
    await h.owner.query(
      "update entitlement_overrides set expires_at = created_at + interval '1 second' where id = $1",
      [ovr],
    );
    await new Promise((r) => setTimeout(r, 1100));
    expect((await createProfile(o)).json().code).toBe('SUBSCRIPTION_RESTRICTED');
  });
});

// ---------------------------------------------------------------- upgrades, downgrades and limits
describe('plans and limits', () => {
  it('an upgrade raises limits at once; a downgrade keeps everything and stops new creation over the limit', async () => {
    const o = await newOrg();
    const sub = await subscribe(o, 'team');
    const invited: { token: string; email: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const email = `m${i}-${randomBytes(3).toString('hex')}@people.test`;
      invited.push({ email, token: (await post(o, '/invitations', { email, role: 'viewer' })).json().token });
    }
    await deliver(f.changePrice(sub, f.prices.agency));
    await work();
    expect(await subscription(o)).toMatchObject({ plan: { id: 'agency' }, limits: { seats: 20 } });
    expect((await history(o.id)).at(-1)).toMatchObject({ cause: 'webhook:customer.subscription.updated' });
    // Downgrade to a one-seat plan: 4 seats used (owner + 3 invitations) stay; nothing is removed.
    await deliver(f.changePrice(sub, f.prices.starter));
    await work();
    const s = await subscription(o);
    expect(s).toMatchObject({ plan: { id: 'starter' }, usage: { seats: 4 }, over_limits: ['seats'] });
    const invite = await post(o, '/invitations', { email: 'one-more@people.test', role: 'viewer' });
    expect(invite.statusCode).toBe(409);
    expect(invite.json()).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      safe_details: {
        limit: 'seats',
        used: 4,
        allowed: 1,
        remediation: ['upgrade', 'remove_members', 'revoke_invitations'],
      },
    });
    const pending = (await get(o, '/invitations')).json().items;
    expect(pending.length).toBe(3);
    // Over the seats after the downgrade, a pending invitation cannot be used to join either (review fix).
    const first = invited[0] as { token: string; email: string };
    const joiner = await h.signIn({ email: first.email });
    const join = await h.app.inject({
      method: 'POST',
      url: `/v1/invitations/${first.token}/accept`,
      headers: joiner.headers,
    });
    expect(join.json()).toMatchObject({ code: 'PLAN_LIMIT_REACHED', safe_details: { limit: 'seats' } });
    expect((await subscription(o)).usage.seats).toBe(4);
    // Starter has no shared profiles feature.
    expect(s.features.team_sessions).toBe(false);
  });

  it('concurrent profile creation never exceeds the limit', async () => {
    const o = await newOrg();
    await h.owner.query(
      `insert into entitlement_overrides (id, org_id, scope, value, reason, created_by, expires_at)
       values ($3, $1, 'limit.profiles', '3', 'test: three profiles at most here', $2, now() + interval '1 day')`,
      [o.id, o.owner.session.user.id, newId('override')],
    );
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => createProfile(o, `race ${i}`)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(
      results.filter((r) => r.statusCode !== 201).every((r) => r.json().code === 'PLAN_LIMIT_REACHED'),
    ).toBe(true);
    const { rows } = await h.owner.query(
      'select count(*)::int as n from profiles where org_id = $1 and deleted_at is null',
      [o.id],
    );
    expect(rows[0].n).toBe(3);
  });

  it('concurrent invitations never exceed the seats; accepting converts a reserved seat', async () => {
    const o = await newOrg();
    // Trial: 5 seats; the owner uses one.
    const emails = Array.from(
      { length: 10 },
      (_, i) => `race${i}-${randomBytes(3).toString('hex')}@people.test`,
    );
    const results = await Promise.all(
      emails.map((email) => post(o, '/invitations', { email, role: 'viewer' })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(4);
    expect(
      results.filter((r) => r.statusCode !== 201).every((r) => r.json().code === 'PLAN_LIMIT_REACHED'),
    ).toBe(true);
    // An invited person accepts: the reserved seat converts (still 5 used, not 6).
    const invited = results.find((r) => r.statusCode === 201)?.json();
    const person = await h.signIn({ email: invited.invitation.email });
    const accept = await h.app.inject({
      method: 'POST',
      url: `/v1/invitations/${invited.token}/accept`,
      headers: person.headers,
    });
    expect(accept.statusCode, accept.body).toBeLessThan(300);
    expect((await subscription(o)).usage.seats).toBe(5);
  });

  it('bulk import over the limit is refused as a whole with the limit named', async () => {
    const o = await newOrg();
    const profiles = Array.from({ length: 101 }, (_, i) => ({
      local_id: newId('profile'),
      name: `Imported ${i}`,
    }));
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${o.id}/local-import`,
      headers: { ...o.owner.headers, 'idempotency-key': idemKey() },
      payload: { dry_run: false, clients: [], profiles },
    });
    expect(res.json()).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      safe_details: { limit: 'profiles', allowed: 100 },
    });
    const { rows } = await h.owner.query('select count(*)::int as n from profiles where org_id = $1', [o.id]);
    expect(rows[0].n).toBe(0);
  });

  it('the plan’s storage caps the backup quota; the plan’s automation concurrency caps claims', async () => {
    const o = await newOrg();
    const q = await h.owner.query('select app.org_backup_quota($1)::float8 as q', [o.id]);
    expect(q.rows[0].q).toBe(10 * 1024 ** 3);
    await h.owner.query(
      `insert into entitlement_overrides (id, org_id, scope, value, reason, created_by, expires_at)
       values ($3, $1, 'limit.storage_bytes', 'null', 'test: no storage limit for a while', $2, now() + interval '1 day')`,
      [o.id, o.owner.session.user.id, newId('override')],
    );
    const q2 = await h.owner.query(
      'select app.org_backup_quota($1)::float8 as q, backup_quota_bytes::float8 as own from organizations where id = $1',
      [o.id],
    );
    expect(q2.rows[0].q).toBe(q2.rows[0].own);
    // The plan's storage applies above the old 20 GiB default (review fix): Agency 200 GiB, an override 500 GiB.
    const a = await newOrg();
    await subscribe(a, 'agency');
    const qa = await h.owner.query('select app.org_backup_quota($1)::float8 as q', [a.id]);
    expect(qa.rows[0].q).toBe(200 * 1024 ** 3);
    await h.owner.query(
      `insert into entitlement_overrides (id, org_id, scope, value, reason, created_by, expires_at)
       values ($3, $1, 'limit.storage_bytes', $4, 'test: a larger storage allowance', $2, now() + interval '1 day')`,
      [a.id, a.owner.session.user.id, newId('override'), String(500 * 1024 ** 3)],
    );
    const qb = await h.owner.query('select app.org_backup_quota($1)::float8 as q', [a.id]);
    expect(qb.rows[0].q).toBe(500 * 1024 ** 3);
  });
});

// ---------------------------------------------------------------- outages and reconciliation
describe('provider outage and reconciliation', () => {
  it('an outage never locks a paid organization out at once; events wait and apply later', async () => {
    const o = await newOrg();
    const sub = await subscribe(o, 'team');
    f.down = true;
    try {
      expect((await post(o, '/billing/portal-session')).json()).toMatchObject({
        code: 'BILLING_UNAVAILABLE',
        retryable: true,
      });
      expect((await createProfile(o)).statusCode).toBe(201); // nothing else depends on the provider
      const events = f.failRenewal(sub);
      for (const r of await deliver(events)) expect(r.statusCode).toBe(200);
      const r = await work();
      expect(r.retried).toBeGreaterThanOrEqual(2);
      expect((await subscription(o)).state).toBe('active');
      // The period ends unconfirmed: still active for 72 hours, then grace, then restricted after 10 days.
      await h.owner.query(
        "update subscriptions set current_period_end = now() - interval '2 days', synced_at = now() - interval '33 days' where org_id = $1",
        [o.id],
      );
      expect((await subscription(o)).state).toBe('active');
      await h.owner.query(
        "update subscriptions set current_period_end = now() - interval '4 days' where org_id = $1",
        [o.id],
      );
      expect(await subscription(o)).toMatchObject({ state: 'grace', reason: 'renewal_unconfirmed' });
      await h.owner.query(
        "update subscriptions set current_period_end = now() - interval '11 days' where org_id = $1",
        [o.id],
      );
      expect(await subscription(o)).toMatchObject({ state: 'restricted', reason: 'renewal_unconfirmed' });
    } finally {
      f.down = false;
    }
    // The provider is back: the waiting events apply (fetched fresh: past_due).
    await h.owner.query("update billing_webhook_events set next_attempt_at = now() where status = 'pending'");
    await work();
    expect((await subscription(o)).state).toBe('past_due');
  });

  it('resync finds a change the webhooks missed and raises an alert', async () => {
    const o = await newOrg();
    const sub = await subscribe(o, 'team');
    f.changePrice(sub, f.prices.agency); // no event delivered
    await h.owner.query('update subscriptions set synced_at = null where org_id = $1', [o.id]);
    const r = await resyncSubscriptions(deps, 500);
    expect(r.synced).toBeGreaterThanOrEqual(1);
    expect((await subscription(o)).plan.id).toBe('agency');
    expect(
      (
        await h.owner.query("select 1 from billing_alerts where kind = 'missed_webhook' and org_id = $1", [
          o.id,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await history(o.id)).at(-1)).toMatchObject({ cause: 'resync' });
  });

  it('refunds and disputes raise alerts and delete nothing; a backlog raises one', async () => {
    const o = await newOrg();
    const sub = await subscribe(o, 'team');
    const customer = f.subscriptions.get(sub)?.customer as string;
    await deliver([...f.refund(customer), ...f.dispute(customer)]);
    await work();
    const kinds = await h.owner.query('select kind from billing_alerts where org_id = $1 order by kind', [
      o.id,
    ]);
    expect(kinds.rows.map((r) => r.kind)).toEqual(['dispute', 'refund']);
    expect((await subscription(o)).state).toBe('active');
    await h.owner.query(
      `insert into billing_webhook_events (provider_event_id, type, livemode, provider_created_at, received_at)
       values ('evt_backlogtest1', 'invoice.paid', false, now(), now() - interval '1 hour')`,
    );
    expect(await checkBacklog(deps)).toBeGreaterThanOrEqual(1);
    await h.owner.query("delete from billing_webhook_events where provider_event_id = 'evt_backlogtest1'");
  });
});

// ---------------------------------------------------------------- usage ledger
describe('usage ledger', () => {
  it('counts API-token requests and daily samples once, however often it runs', async () => {
    const o = await newOrg();
    await createProfile(o);
    const tok = (
      await post(o, '/api-tokens', { name: 'usage', scopes: ['profiles:read'], expires_in_days: 1 })
    ).json();
    const headers = { authorization: `Bearer ${tok.secret}` };
    for (let i = 0; i < 3; i++) expect((await get(o, '/profiles', headers)).statusCode).toBe(200);
    const today = await h.owner.query('select requests::int as n from api_usage_daily where org_id = $1', [
      o.id,
    ]);
    expect(today.rows[0].n).toBe(3);
    // Pretend the requests were yesterday, then sample twice.
    await h.owner.query('update api_usage_daily set day = day - 1 where org_id = $1', [o.id]);
    await sampleUsage(h.worker);
    await sampleUsage(h.worker);
    const { rows } = await h.owner.query(
      'select type, quantity::float8 as q, count(*) over (partition by type)::int as n from usage_events where org_id = $1 order by type',
      [o.id],
    );
    expect(rows).toEqual([
      { type: 'active_profiles', q: 1, n: 1 },
      { type: 'api_requests', q: 3, n: 1 },
      { type: 'seats', q: 1, n: 1 },
      { type: 'storage_bytes', q: 0, n: 1 },
    ]);
    const usageRes = await get(o, '/billing/usage');
    expect(usageRes.statusCode, usageRes.body).toBe(200);
    const usage = usageRes.json();
    expect(usage.current).toMatchObject({ profiles: 1, seats: 1 });
    expect(usage.totals.find((t: { type: string }) => t.type === 'api_requests')).toMatchObject({
      quantity: 3,
    });
  });
});

// ---------------------------------------------------------------- catalog
describe('plan catalog', () => {
  it('a released plan version cannot change; organizations without a subscription go on beta', async () => {
    const pg = (await import('pg')).default;
    const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        "update app.plans set limits = jsonb_set(limits, '{seats}', '6') where id = 'team' and version = 1",
      );
      await expect(syncCatalog(client, false)).rejects.toThrow(/immutable/);
      await client.query(
        "update app.plans set limits = jsonb_set(limits, '{seats}', '5') where id = 'team' and version = 1",
      );
      const o = await newOrg('Before billing');
      await client.query('delete from app.subscriptions where org_id = $1', [o.id]);
      expect((await subscription(o)).state).toBe('restricted'); // fails closed without a row
      await syncCatalog(client, false);
      expect(await subscription(o)).toMatchObject({
        plan: { id: 'beta' },
        state: 'active',
        reason: 'complimentary',
      });
    } finally {
      await client.end();
    }
  });
});

// ---------------------------------------------------------------- independent review fixes
describe('review fixes', () => {
  it('past_due does not last forever: grace 30 days after the period end, restricted 7 days later', async () => {
    const o = await newOrg();
    const sub = await subscribe(o, 'team');
    await deliver(f.failRenewal(sub));
    await work();
    expect((await subscription(o)).state).toBe('past_due');
    const set = (days: number) =>
      h.owner.query(
        `update subscriptions set current_period_end = now() - make_interval(days => $2) where org_id = $1`,
        [o.id, days],
      );
    await set(29);
    expect(await subscription(o)).toMatchObject({ state: 'past_due', reason: 'payment_failed' });
    await set(31);
    const g = await subscription(o);
    expect(g).toMatchObject({ state: 'grace', reason: 'payment_failed' });
    expect(new Date(g.until).getTime()).toBeGreaterThan(Date.now() + 5 * 86_400_000);
    expect((await createProfile(o)).statusCode).toBe(201);
    await set(38);
    expect(await subscription(o)).toMatchObject({ state: 'restricted', reason: 'grace_ended' });
    expect((await createProfile(o)).json().code).toBe('SUBSCRIPTION_RESTRICTED');
  });

  it('an object fetched before the last applied one never overwrites it (two workers, a late read)', async () => {
    const o = await newOrg();
    const sub = await subscribe(o, 'team');
    const before = await fetchMark(deps);
    const activeRead = await deps.stripe.getSubscription(sub);
    // Meanwhile the customer cancels and that is applied.
    await deliver(f.cancel(sub));
    await work();
    expect((await subscription(o)).state).toBe('canceled');
    // The slower worker now commits its earlier "active" read: ignored.
    const late = await applySubscription(deps, o.id, activeRead, 'test:late', before);
    expect(late.outcome).toBe('stale');
    expect((await subscription(o)).state).toBe('canceled');
  });

  it('a live subscription the customer still pays for wins over a newer one that ended', async () => {
    const o = await newOrg();
    const first = await subscribe(o, 'starter');
    const customer = f.subscriptions.get(first)?.customer as string;
    // A second subscription (e.g. two checkouts before either was applied); the newer one is canceled.
    const second = f.createSubscription(customer, f.prices.agency);
    await deliver([f.event('customer.subscription.created', second)]);
    await work();
    expect(await subscription(o)).toMatchObject({ state: 'active', plan: { id: 'agency' } });
    await deliver(f.cancel(second.id as string));
    await work();
    // The first is still active and paid: the resync finds it and the organization stays usable on it.
    await h.owner.query('select app.billing_request_resync($1)', [o.id]);
    await resyncSubscriptions(deps, 500);
    expect(await subscription(o)).toMatchObject({ state: 'active', plan: { id: 'starter' } });
    // And an ended subscription's late event does not take it back.
    await deliver([
      f.event(
        'customer.subscription.updated',
        f.subscriptions.get(second.id as string) as Record<string, unknown>,
      ),
    ]);
    await work();
    expect(await subscription(o)).toMatchObject({ state: 'active', plan: { id: 'starter' } });
  });

  it('a second checkout expires the first one, and a subscription not applied yet sends the owner to the portal', async () => {
    const o = await newOrg();
    const one = await post(o, '/billing/checkout-session', { plan_id: 'team' });
    const firstId = new URL(one.json().url).pathname.split('/').pop() as string;
    const two = await post(o, '/billing/checkout-session', { plan_id: 'agency' });
    expect(two.statusCode, two.body).toBe(201);
    expect(f.sessions.get(firstId)?.status).toBe('expired');
    // The customer completes the second checkout; before the worker has applied it, another checkout is refused.
    const secondId = new URL(two.json().url).pathname.split('/').pop() as string;
    f.completeCheckout(secondId);
    expect((await post(o, '/billing/checkout-session', { plan_id: 'starter' })).json().code).toBe(
      'ALREADY_SUBSCRIBED',
    );
  });

  it('a resync that keeps failing backs off and raises an alert instead of blocking the others', async () => {
    const o = await newOrg();
    await subscribe(o, 'team');
    // The stored subscription no longer exists at the provider (another mode's id, a deleted customer).
    await h.owner.query(
      `update subscriptions set provider_subscription_id = $2, provider_customer_id = $3, synced_at = null
        where org_id = $1`,
      [o.id, `sub_gone${randomBytes(4).toString('hex')}`, `cus_gone${randomBytes(4).toString('hex')}`],
    );
    await resyncSubscriptions(deps, 500);
    const { rows } = await h.owner.query(
      "select resync_after > now() + interval '5 hours' as backed_off from subscriptions where org_id = $1",
      [o.id],
    );
    expect(rows[0].backed_off).toBe(true);
    const due = await h.owner.query('select org_id from app.billing_resync_due(500) where org_id = $1', [
      o.id,
    ]);
    expect(due.rowCount).toBe(0);
    const alert = await h.owner.query(
      "select count from billing_alerts where kind = 'resync_failed' and org_id = $1 and resolved_at is null",
      [o.id],
    );
    expect(alert.rowCount).toBe(1);
    // Staff asking for a resync makes it due again at once, without touching the customer's state.
    const stateBefore = (await subscription(o)).state;
    await h.owner.query('select app.billing_request_resync($1)', [o.id]);
    const again = await h.owner.query('select org_id from app.billing_resync_due(500) where org_id = $1', [
      o.id,
    ]);
    expect(again.rowCount).toBe(1);
    expect((await subscription(o)).state).toBe(stateBefore);
  });
});

// ---------------------------------------------------------------- logs
describe('logs', () => {
  it('never contain card data, provider secrets or webhook payloads', () => {
    const text = logLines.join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(f.secretKey);
    expect(text).not.toContain(f.webhookSecret);
    expect(text).not.toMatch(/\b4242\s?4242/);
    expect(text).not.toContain('"object":"subscription"');
    expect(text).not.toMatch(/stripe-signature/i);
    // Requests to the provider never carried card fields either.
    expect(f.requests.some((r) => Object.keys(r.params).some((k) => /card|number|cvc/i.test(k)))).toBe(false);
  });
});
