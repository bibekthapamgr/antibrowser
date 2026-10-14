/**
 * An in-process fake of the Stripe endpoints this application uses (milestone 11), speaking the same HTTP API
 * (form-encoded requests, JSON objects shaped like API version 2025-03-31) so the real client code runs against it.
 * Tests drive the provider's side (a checkout completed, a payment failed, a plan changed, an outage) and get the
 * events Stripe would send; `deliver` signs them like Stripe and posts them to the API's webhook route.
 *
 * Secrets are made at run time (never literals in the repository).
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { stripeSignatureHeader } from '../src/billing/stripe.ts';

type Obj = Record<string, unknown>;

export interface FakeStripe {
  url: string;
  secretKey: string;
  webhookSecret: string;
  prices: { starter: string; team: string; agency: string };
  /** Every request received: method, path, decoded form or query, selected headers. */
  requests: {
    method: string;
    path: string;
    params: Record<string, string>;
    idempotencyKey: string | null;
    version: string | null;
  }[];
  /** 503 for every request while true (a provider outage). */
  down: boolean;
  customers: Map<string, Obj>;
  subscriptions: Map<string, Obj>;
  sessions: Map<string, Obj>;
  invoices: Map<string, Obj>;
  // ------------------------------------------------ the provider's side
  /** The customer pays at checkout (or the card fails): returns the events Stripe would send. */
  completeCheckout(sessionId: string, opts?: { fail?: boolean }): Obj[];
  /** A renewal payment fails: past_due with a failed invoice. */
  failRenewal(subId: string): Obj[];
  /** A renewal payment succeeds: active, next period. */
  payRenewal(subId: string): Obj[];
  /** Stripe stops retrying: unpaid (or canceled for non-payment with `cancel: true`). */
  retriesExhausted(subId: string, opts?: { cancel?: boolean }): Obj[];
  /** A plan change in the portal. */
  changePrice(subId: string, price: string): Obj[];
  /** The customer cancels at the period end (or now). */
  cancel(subId: string, opts?: { atPeriodEnd?: boolean }): Obj[];
  /** A subscription created directly (another checkout of the same customer). */
  createSubscription(customer: string, price: string, status?: string): Obj;
  refund(customer: string): Obj[];
  dispute(customer: string): Obj[];
  /** An event as Stripe would send it. */
  event(type: string, object: Obj, opts?: { created?: number; id?: string }): Obj;
  /** Signs an event like Stripe (or with a given secret/time) and returns body and header. */
  sign(event: Obj, opts?: { secret?: string; t?: number }): { body: string; header: string };
  close(): Promise<void>;
}

const rnd = (n = 14) => randomBytes(n).toString('hex').slice(0, n);
const now = () => Math.floor(Date.now() / 1000);
const MONTH = 30 * 86_400;

function decodeForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split('&')) {
    if (!part) continue;
    const [k, v = ''] = part.split('=');
    out[decodeURIComponent(k ?? '')] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function fakeStripe(): Promise<FakeStripe> {
  const secretKey = `sk_${'test'}_${rnd(24)}`;
  const webhookSecret = `whsec_${rnd(32)}`;
  const prices = {
    starter: `price_starter${rnd(6)}`,
    team: `price_team${rnd(6)}`,
    agency: `price_agency${rnd(6)}`,
  };
  const priceObjects = new Map<string, Obj>([
    [
      prices.starter,
      {
        id: prices.starter,
        object: 'price',
        unit_amount: 1900,
        currency: 'usd',
        recurring: { interval: 'month' },
      },
    ],
    [
      prices.team,
      {
        id: prices.team,
        object: 'price',
        unit_amount: 4900,
        currency: 'usd',
        recurring: { interval: 'month' },
      },
    ],
    [
      prices.agency,
      {
        id: prices.agency,
        object: 'price',
        unit_amount: 14900,
        currency: 'usd',
        recurring: { interval: 'month' },
      },
    ],
  ]);
  const customers = new Map<string, Obj>();
  const subscriptions = new Map<string, Obj>();
  const sessions = new Map<string, Obj>();
  const invoices = new Map<string, Obj>();
  const charges = new Map<string, Obj>();
  const disputes = new Map<string, Obj>();
  const idem = new Map<string, Obj>();
  const requests: FakeStripe['requests'] = [];

  const subscription = (customer: string, price: string, status: string, periodEnd = now() + MONTH): Obj => ({
    id: `sub_${rnd()}`,
    object: 'subscription',
    customer,
    status,
    created: now(),
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    trial_end: null,
    cancellation_details: { reason: null },
    items: {
      object: 'list',
      data: [
        {
          id: `si_${rnd()}`,
          price: priceObjects.get(price) ?? { id: price },
          current_period_end: periodEnd,
          current_period_start: periodEnd - MONTH,
        },
      ],
    },
    metadata: {},
  });
  const invoice = (sub: Obj, status: string, amount: number): Obj => {
    const inv = {
      id: `in_${rnd()}`,
      object: 'invoice',
      customer: sub.customer,
      number: `PB-${rnd(6).toUpperCase()}`,
      status,
      currency: 'usd',
      amount_due: amount,
      amount_paid: status === 'paid' ? amount : 0,
      created: now(),
      period_start: now(),
      period_end: now() + MONTH,
      hosted_invoice_url: `https://invoice.stripe.com/i/acct_test/${rnd(20)}`,
      invoice_pdf: `https://pay.stripe.com/invoice/acct_test/${rnd(20)}/pdf`,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
    };
    invoices.set(inv.id, inv);
    return inv;
  };
  const priceOf = (sub: Obj) =>
    ((((sub.items as Obj).data as Obj[])[0]?.price as Obj | undefined)?.id as string | undefined) ?? '';
  const amountOf = (price: string) => (priceObjects.get(price)?.unit_amount as number) ?? 0;

  const fake: FakeStripe = {
    url: '',
    secretKey,
    webhookSecret,
    prices,
    requests,
    down: false,
    customers,
    subscriptions,
    sessions,
    invoices,
    event(type, object, opts = {}) {
      return {
        id: opts.id ?? `evt_${rnd(20)}`,
        object: 'event',
        type,
        created: opts.created ?? now(),
        livemode: false,
        api_version: '2025-03-31.basil',
        data: { object: structuredClone(object) },
      };
    },
    sign(event, opts = {}) {
      const body = JSON.stringify(event);
      return { body, header: stripeSignatureHeader(body, opts.secret ?? webhookSecret, opts.t ?? now()) };
    },
    completeCheckout(sessionId, opts = {}) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error('no such session');
      const price = ((s.line_items as Obj[])[0] as Obj).price as string;
      const sub = subscription(s.customer as string, price, opts.fail ? 'incomplete' : 'active');
      sub.metadata = { org_id: (s.metadata as Obj).org_id };
      subscriptions.set(sub.id as string, sub);
      const inv = invoice(sub, opts.fail ? 'open' : 'paid', amountOf(price));
      Object.assign(s, {
        status: opts.fail ? 'open' : 'complete',
        subscription: sub.id,
        payment_status: opts.fail ? 'unpaid' : 'paid',
      });
      const events = [fake.event('customer.subscription.created', sub)];
      if (opts.fail) events.push(fake.event('invoice.payment_failed', inv));
      else events.push(fake.event('checkout.session.completed', s), fake.event('invoice.paid', inv));
      return events;
    },
    failRenewal(subId) {
      const sub = subscriptions.get(subId) as Obj;
      sub.status = 'past_due';
      const inv = invoice(sub, 'open', amountOf(priceOf(sub)));
      return [fake.event('invoice.payment_failed', inv), fake.event('customer.subscription.updated', sub)];
    },
    payRenewal(subId) {
      const sub = subscriptions.get(subId) as Obj;
      sub.status = 'active';
      const item = ((sub.items as Obj).data as Obj[])[0] as Obj;
      item.current_period_end = now() + MONTH;
      const inv = invoice(sub, 'paid', amountOf(priceOf(sub)));
      return [fake.event('invoice.paid', inv), fake.event('customer.subscription.updated', sub)];
    },
    retriesExhausted(subId, opts = {}) {
      const sub = subscriptions.get(subId) as Obj;
      if (opts.cancel) {
        Object.assign(sub, {
          status: 'canceled',
          canceled_at: now(),
          ended_at: now(),
          cancellation_details: { reason: 'payment_failed' },
        });
        return [fake.event('customer.subscription.deleted', sub)];
      }
      sub.status = 'unpaid';
      return [fake.event('customer.subscription.updated', sub)];
    },
    changePrice(subId, price) {
      const sub = subscriptions.get(subId) as Obj;
      const item = ((sub.items as Obj).data as Obj[])[0] as Obj;
      item.price = priceObjects.get(price) ?? { id: price };
      return [fake.event('customer.subscription.updated', sub)];
    },
    cancel(subId, opts = {}) {
      const sub = subscriptions.get(subId) as Obj;
      if (opts.atPeriodEnd) {
        sub.cancel_at_period_end = true;
        sub.cancellation_details = { reason: 'cancellation_requested' };
        return [fake.event('customer.subscription.updated', sub)];
      }
      Object.assign(sub, {
        status: 'canceled',
        canceled_at: now(),
        ended_at: now(),
        cancellation_details: { reason: 'cancellation_requested' },
      });
      return [fake.event('customer.subscription.deleted', sub)];
    },
    createSubscription(customer, price, status = 'active') {
      const sub = subscription(customer, price, status);
      sub.created = now() + 1;
      subscriptions.set(sub.id as string, sub);
      return sub;
    },
    refund(customer) {
      const ch = { id: `ch_${rnd()}`, object: 'charge', customer, refunded: true };
      charges.set(ch.id, ch);
      return [fake.event('charge.refunded', ch)];
    },
    dispute(customer) {
      const ch = { id: `ch_${rnd()}`, object: 'charge', customer };
      charges.set(ch.id, ch);
      const dp = { id: `dp_${rnd()}`, object: 'dispute', charge: ch.id };
      disputes.set(dp.id, dp);
      return [fake.event('charge.dispute.created', dp)];
    },
    close: async () => undefined,
  };

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const missing = () => send(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
    const raw = await bodyOf(req);
    const u = new URL(req.url ?? '/', 'http://fake');
    const params = req.method === 'POST' ? decodeForm(raw) : Object.fromEntries(u.searchParams);
    const key = (req.headers['idempotency-key'] as string | undefined) ?? null;
    requests.push({
      method: req.method ?? '',
      path: u.pathname,
      params,
      idempotencyKey: key,
      version: (req.headers['stripe-version'] as string) ?? null,
    });
    if (req.headers.authorization !== `Bearer ${secretKey}`) {
      return send(401, { error: { type: 'invalid_request_error', code: 'api_key_invalid' } });
    }
    if (fake.down) return send(503, { error: { type: 'api_error' } });
    const replay = key ? idem.get(`${u.pathname}:${key}`) : undefined;
    if (replay) return send(200, replay);
    const remember = (o: Obj) => {
      if (key) idem.set(`${u.pathname}:${key}`, o);
      return send(200, o);
    };
    const path = u.pathname;
    if (req.method === 'POST' && path === '/v1/customers') {
      const c = {
        id: `cus_${rnd()}`,
        object: 'customer',
        name: params.name,
        email: params.email ?? null,
        metadata: { org_id: params['metadata[org_id]'] },
      };
      customers.set(c.id, c);
      return remember(c);
    }
    if (req.method === 'POST' && path === '/v1/checkout/sessions') {
      if (!customers.has(params.customer ?? '')) return missing();
      const id = `cs_test_${rnd(24)}`;
      const s = {
        id,
        object: 'checkout.session',
        mode: params.mode,
        customer: params.customer,
        client_reference_id: params.client_reference_id,
        metadata: { org_id: params['metadata[org_id]'] },
        line_items: [
          { price: params['line_items[0][price]'], quantity: Number(params['line_items[0][quantity]']) },
        ],
        success_url: params.success_url,
        cancel_url: params.cancel_url,
        status: 'open',
        subscription: null,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        expires_at: now() + 86_400,
      };
      sessions.set(id, s);
      return remember(s);
    }
    const expire = req.method === 'POST' ? /^\/v1\/checkout\/sessions\/(cs_\w+)\/expire$/.exec(path) : null;
    if (expire) {
      const s = sessions.get(expire[1] ?? '');
      if (!s) return missing();
      if (s.status !== 'open') {
        return send(400, { error: { type: 'invalid_request_error', code: 'checkout_session_not_open' } });
      }
      s.status = 'expired';
      return send(200, s);
    }
    if (req.method === 'GET' && path === '/v1/checkout/sessions') {
      return send(200, {
        object: 'list',
        data: [...sessions.values()].filter(
          (o) => o.customer === params.customer && (!params.status || o.status === params.status),
        ),
        has_more: false,
      });
    }
    if (req.method === 'POST' && path === '/v1/billing_portal/sessions') {
      if (!customers.has(params.customer ?? '')) return missing();
      return send(200, {
        id: `bps_${rnd()}`,
        object: 'billing_portal.session',
        url: `https://billing.stripe.com/p/session/test_${rnd(20)}`,
      });
    }
    const listOf = (store: Map<string, Obj>) =>
      send(200, {
        object: 'list',
        data: [...store.values()].filter((o) => o.customer === params.customer),
        has_more: false,
      });
    if (req.method === 'GET' && path === '/v1/subscriptions') return listOf(subscriptions);
    if (req.method === 'GET' && path === '/v1/invoices') return listOf(invoices);
    const readable: [RegExp, Map<string, Obj>][] = [
      [/^\/v1\/subscriptions\/(sub_\w+)$/, subscriptions],
      [/^\/v1\/checkout\/sessions\/(cs_\w+)$/, sessions],
      [/^\/v1\/invoices\/(in_\w+)$/, invoices],
      [/^\/v1\/prices\/(price_\w+)$/, priceObjects],
      [/^\/v1\/charges\/(ch_\w+)$/, charges],
      [/^\/v1\/disputes\/(dp_\w+)$/, disputes],
    ];
    for (const [pattern, store] of readable) {
      const match = req.method === 'GET' ? pattern.exec(path) : null;
      if (match) {
        const found = store.get(match[1] ?? '');
        return found ? send(200, found) : missing();
      }
    }
    return send(404, { error: { type: 'invalid_request_error', code: 'unknown_route' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

/** The configuration a harness needs to talk to this fake. */
export function stripeEnv(f: FakeStripe): Record<string, string> {
  return {
    STRIPE_SECRET_KEY: f.secretKey,
    STRIPE_WEBHOOK_SECRETS: f.webhookSecret,
    STRIPE_API_BASE: f.url,
    BILLING_STRIPE_PRICES: JSON.stringify({
      'starter@1': f.prices.starter,
      'team@1': f.prices.team,
      'agency@1': f.prices.agency,
    }),
    BILLING_RETURN_URL: 'http://127.0.0.1:8080/v1/billing/return',
  };
}
