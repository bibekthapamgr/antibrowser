/**
 * Milestone 11: billing against Stripe's real test mode (a sandbox). Runs only when STRIPE_TEST_SECRET_KEY is set (a
 * repository secret added by the owner; never a live key). It creates throwaway test objects — a product with a
 * test-only price, a customer on a test clock — subscribes, makes a renewal fail by advancing the clock with a card that
 * declines, cancels, and feeds Stripe's own events (fetched from /v1/events, so their real shapes) through the API's
 * webhook route and the worker's processing, which fetches the current objects from Stripe itself. Webhooks cannot
 * reach a CI runner, so the events are signed locally with a test secret; signature checking is covered in
 * billing.test.ts. The customer lives on a test clock, which is deleted at the end with everything on it; the product
 * and its test-only price are reused by every run (fixed id and lookup key), so runs do not pile up objects.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processBillingEvents, type ReconcileDeps } from '../src/billing/reconcile.ts';
import {
  createStripe,
  formEncode,
  STRIPE_API_VERSION,
  stripeSignatureHeader,
} from '../src/billing/stripe.ts';
import { type Harness, harness, type SignedIn } from './helpers.ts';

const key = process.env.STRIPE_TEST_SECRET_KEY ?? '';
const enabled = /^(sk|rk)_test_/.test(key);
const API = 'https://api.stripe.com';

async function call(method: string, path: string, params?: Record<string, unknown>, allow404 = false) {
  const body = params && method !== 'GET' ? formEncode(params as never) : undefined;
  const q = params && method === 'GET' ? `?${formEncode(params as never)}` : '';
  const res = await fetch(`${API}${path}${q}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'stripe-version': STRIPE_API_VERSION,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body } : {}),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (allow404 && res.status === 404) return null;
  if (!res.ok)
    throw new Error(
      `${method} ${path}: ${res.status} ${JSON.stringify((json.error as { type?: string })?.type)}`,
    );
  return json;
}
async function stripe(method: string, path: string, params?: Record<string, unknown>) {
  return (await call(method, path, params)) as Record<string, unknown>;
}
/** The object, or null when Stripe answers 404. */
const stripeOrNull = (method: string, path: string) => call(method, path, undefined, true);

describe.runIf(enabled)('billing against Stripe test mode (sandbox)', () => {
  let h: Harness;
  let deps: ReconcileDeps;
  let owner: SignedIn;
  let orgId = '';
  let clock = '';
  let product = '';
  let price = '';
  let customer = '';
  let sub = '';
  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  const start = Math.floor(Date.now() / 1000) - 5;
  const delivered = new Set<string>();

  beforeAll(async () => {
    product = 'pb_ci_sandbox';
    if (!(await stripeOrNull('GET', `/v1/products/${product}`))) {
      await stripe('POST', '/v1/products', { id: product, name: 'Project Browser CI sandbox (tests only)' });
    }
    // A test-only amount (not a pricing decision): the sandbox needs some price to charge.
    const lookup = 'pb_ci_sandbox_usd_month_1000';
    const found = await stripe('GET', '/v1/prices', { lookup_keys: [lookup], active: true, limit: 1 });
    price =
      (found.data as { id: string }[])[0]?.id ??
      ((
        await stripe('POST', '/v1/prices', {
          product,
          unit_amount: 1000,
          currency: 'usd',
          recurring: { interval: 'month' },
          lookup_key: lookup,
        })
      ).id as string);
    h = await harness({
      env: {
        STRIPE_SECRET_KEY: key,
        STRIPE_WEBHOOK_SECRETS: secret,
        BILLING_STRIPE_PRICES: JSON.stringify({ 'team@1': price }),
      },
    });
    deps = {
      pool: h.worker,
      stripe: createStripe({ secretKey: key, apiBase: API }),
      prices: { 'team@1': price },
      log: () => undefined,
      graceDays: 7,
    };
    owner = await h.signIn();
    orgId = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: owner.headers,
        payload: { name: 'Sandbox' },
      })
    ).json().id;
    clock = (
      await stripe('POST', '/v1/test_helpers/test_clocks', {
        frozen_time: Math.floor(Date.now() / 1000),
        name: 'pb-ci',
      })
    ).id as string;
    customer = (
      await stripe('POST', '/v1/customers', {
        name: 'CI customer',
        test_clock: clock,
        metadata: { org_id: orgId },
      })
    ).id as string;
    await h.owner.query(
      "update subscriptions set provider_customer_id = $2, provider = 'stripe' where org_id = $1",
      [orgId, customer],
    );
  }, 120_000);

  afterAll(async () => {
    if (clock) await stripe('DELETE', `/v1/test_helpers/test_clocks/${clock}`).catch(() => undefined);
    await h?.close();
  });

  /** Stripe's events about this customer, oldest first, delivered once each through the webhook route. */
  async function deliverEvents() {
    const page = await stripe('GET', '/v1/events', { created: { gte: start }, limit: 100 });
    const events = ((page.data as Record<string, unknown>[]) ?? []).reverse().filter((e) => {
      const o = (e.data as { object: Record<string, unknown> }).object;
      return !delivered.has(e.id as string) && (o.customer === customer || o.id === customer);
    });
    for (const e of events) {
      const body = JSON.stringify(e);
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/webhooks/billing',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripeSignatureHeader(body, secret, Math.floor(Date.now() / 1000)),
        },
        payload: body,
      });
      expect(res.statusCode, res.body).toBe(200);
      delivered.add(e.id as string);
    }
    for (let i = 0; i < 10; i++) {
      const r = await processBillingEvents(deps, 100);
      if (r.processed + r.ignored + r.failed + r.retried === 0) break;
      expect(r.failed).toBe(0);
    }
  }

  const state = async () =>
    (
      await h.app.inject({
        method: 'GET',
        url: `/v1/orgs/${orgId}/billing/subscription`,
        headers: owner.headers,
      })
    ).json();

  async function advance(seconds: number) {
    const c = await stripe('GET', `/v1/test_helpers/test_clocks/${clock}`);
    await stripe('POST', `/v1/test_helpers/test_clocks/${clock}/advance`, {
      frozen_time: (c.frozen_time as number) + seconds,
    });
    for (let i = 0; i < 60; i++) {
      if ((await stripe('GET', `/v1/test_helpers/test_clocks/${clock}`)).status === 'ready') return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('test clock did not finish advancing');
  }

  it('a paid subscription activates the plan', async () => {
    const pm = (await stripe('POST', '/v1/payment_methods/pm_card_visa/attach', { customer })).id as string;
    await stripe('POST', `/v1/customers/${customer}`, { invoice_settings: { default_payment_method: pm } });
    sub = (
      await stripe('POST', '/v1/subscriptions', { customer, items: [{ price }], metadata: { org_id: orgId } })
    ).id as string;
    await deliverEvents();
    expect(await state()).toMatchObject({
      plan: { id: 'team' },
      state: 'active',
      has_provider_subscription: true,
    });
    const invoices = (
      await h.app.inject({ method: 'GET', url: `/v1/orgs/${orgId}/billing/invoices`, headers: owner.headers })
    ).json().items;
    expect(invoices[0]).toMatchObject({ status: 'paid', currency: 'usd', amount_paid_minor: 1000 });
  }, 180_000);

  it('a declined renewal is past due', async () => {
    const pm = (await stripe('POST', '/v1/payment_methods/pm_card_chargeCustomerFail/attach', { customer }))
      .id as string;
    await stripe('POST', `/v1/customers/${customer}`, { invoice_settings: { default_payment_method: pm } });
    await stripe('POST', `/v1/subscriptions/${sub}`, { default_payment_method: pm });
    await advance(32 * 86_400);
    await deliverEvents();
    expect(await state()).toMatchObject({ state: 'past_due', reason: 'payment_failed' });
  }, 240_000);

  it('a cancellation is canceled; a replayed earlier event changes nothing', async () => {
    await stripe('DELETE', `/v1/subscriptions/${sub}`);
    await deliverEvents();
    expect(await state()).toMatchObject({ state: 'canceled', reason: 'canceled_by_customer' });
    // Replay every event again under new delivery: duplicates are recognised by id; the state stays.
    delivered.clear();
    await deliverEvents();
    expect((await state()).state).toBe('canceled');
  }, 180_000);
});
