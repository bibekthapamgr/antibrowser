/**
 * Stripe (milestone 11, ADR-0018): a small REST client and webhook signature verification. No SDK: the handful of
 * endpoints used are called with `fetch`, form-encoded, with the API version pinned and an Idempotency-Key on every
 * create. Responses are reduced to the fields this application uses and checked at run time; nothing from a response
 * body is ever logged (customer objects carry personal data; the application never sees card data).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@pb/contracts';

/** Pinned on purpose: an upgrade is a deliberate change, verified with stripe-mock and the sandbox test. */
export const STRIPE_API_VERSION = '2025-03-31.basil';
const TIMEOUT_MS = 10_000;

export interface StripeConfig {
  secretKey: string;
  apiBase: string;
}

// ---------------------------------------------------------------- the objects, reduced
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  created: number;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  endedAt: number | null;
  trialEnd: number | null;
  cancellationReason: string | null;
  /** The latest period end over the items (API 2025-03-31: periods live on subscription items). */
  currentPeriodEnd: number | null;
  priceIds: string[];
}

export interface StripeCheckoutSession {
  id: string;
  customer: string | null;
  subscription: string | null;
  clientReferenceId: string | null;
  orgIdMetadata: string | null;
  mode: string;
  status: string | null;
  url: string | null;
  expiresAt: number | null;
}

export interface StripeInvoice {
  id: string;
  customer: string | null;
  subscription: string | null;
  number: string | null;
  status: string;
  currency: string;
  amountDue: number;
  amountPaid: number;
  created: number;
  periodStart: number | null;
  periodEnd: number | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

export interface StripePrice {
  id: string;
  unitAmount: number | null;
  currency: string;
  interval: 'month' | 'year' | null;
}

export interface StripeEventEnvelope {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  objectType: string | null;
  objectId: string | null;
}

export class StripeError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  constructor(status: number, type: string, code: string | null) {
    super(`Stripe request failed (${status} ${type}${code ? ` ${code}` : ''})`);
    this.status = status;
    this.type = type;
    this.code = code;
    this.name = 'StripeError';
  }
  /** The object does not exist (deleted customer, wrong id). */
  get missing(): boolean {
    return this.status === 404 || this.code === 'resource_missing';
  }
  /** Worth retrying later (network, rate limit, provider error). */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface Stripe {
  createCustomer(
    p: { orgId: string; name: string; email: string | null },
    idempotencyKey: string,
  ): Promise<string>;
  createCheckoutSession(
    p: {
      customer: string;
      price: string;
      orgId: string;
      successUrl: string;
      cancelUrl: string;
      automaticTax: boolean;
    },
    idempotencyKey: string,
  ): Promise<StripeCheckoutSession>;
  createPortalSession(p: {
    customer: string;
    returnUrl: string;
    configuration?: string | null;
  }): Promise<string>;
  getSubscription(id: string): Promise<StripeSubscription>;
  listSubscriptions(customer: string): Promise<StripeSubscription[]>;
  getCheckoutSession(id: string): Promise<StripeCheckoutSession>;
  getInvoice(id: string): Promise<StripeInvoice>;
  listInvoices(customer: string, limit: number): Promise<StripeInvoice[]>;
  getPrice(id: string): Promise<StripePrice>;
  /** The customer a charge or dispute belongs to (refund and dispute alerts). */
  customerOfCharge(chargeId: string): Promise<string | null>;
  customerOfDispute(disputeId: string): Promise<string | null>;
}

// ---------------------------------------------------------------- form encoding
type FormValue = string | number | boolean | null | undefined | FormObject | FormValue[];
interface FormObject {
  [key: string]: FormValue;
}

/** Stripe's bracket notation: `line_items[0][price]=…`, `metadata[org_id]=…`. Null and undefined are left out. */
export function formEncode(obj: FormObject): string {
  const out: string[] = [];
  const walk = (prefix: string, v: FormValue) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) walk(`${prefix}[${i}]`, item);
    } else if (typeof v === 'object') {
      for (const [k, inner] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, inner);
    } else {
      out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
    }
  };
  walk('', obj);
  return out.join('&');
}

// ---------------------------------------------------------------- reading responses defensively
type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const idOf = (v: unknown): string | null =>
  str(v) ?? (v && typeof v === 'object' ? str((v as Json).id) : null);
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(obj(v).data) ? (obj(v).data as unknown[]) : []);

function need(v: string | null, what: string): string {
  if (!v) throw new StripeError(502, 'invalid_response', what);
  return v;
}

export function parseSubscription(raw: unknown): StripeSubscription {
  const s = obj(raw);
  const items = list(s.items).map(obj);
  const ends = items.map((i) => num(i.current_period_end)).filter((n): n is number => n !== null);
  const legacyEnd = num(s.current_period_end);
  return {
    id: need(str(s.id), 'subscription.id'),
    customer: need(idOf(s.customer), 'subscription.customer'),
    status: need(str(s.status), 'subscription.status'),
    created: num(s.created) ?? 0,
    cancelAtPeriodEnd: s.cancel_at_period_end === true,
    canceledAt: num(s.canceled_at),
    endedAt: num(s.ended_at),
    trialEnd: num(s.trial_end),
    cancellationReason: str(obj(s.cancellation_details).reason),
    currentPeriodEnd: ends.length ? Math.max(...ends) : legacyEnd,
    priceIds: items.map((i) => idOf(i.price)).filter((p): p is string => p !== null),
  };
}

export function parseCheckoutSession(raw: unknown): StripeCheckoutSession {
  const s = obj(raw);
  return {
    id: need(str(s.id), 'checkout.id'),
    customer: idOf(s.customer),
    subscription: idOf(s.subscription),
    clientReferenceId: str(s.client_reference_id),
    orgIdMetadata: str(obj(s.metadata).org_id),
    mode: str(s.mode) ?? '',
    status: str(s.status),
    url: str(s.url),
    expiresAt: num(s.expires_at),
  };
}

export function parseInvoice(raw: unknown): StripeInvoice {
  const s = obj(raw);
  // API 2025-03-31 moved the subscription under `parent.subscription_details`; older versions had `subscription`.
  const subscription =
    idOf(obj(obj(s.parent).subscription_details).subscription) ?? idOf(s.subscription) ?? null;
  return {
    id: need(str(s.id), 'invoice.id'),
    customer: idOf(s.customer),
    subscription,
    number: str(s.number),
    status: str(s.status) ?? 'draft',
    currency: (str(s.currency) ?? 'usd').toLowerCase(),
    amountDue: num(s.amount_due) ?? 0,
    amountPaid: num(s.amount_paid) ?? 0,
    created: num(s.created) ?? 0,
    periodStart: num(s.period_start),
    periodEnd: num(s.period_end),
    hostedUrl: str(s.hosted_invoice_url),
    pdfUrl: str(s.invoice_pdf),
  };
}

export function parsePrice(raw: unknown): StripePrice {
  const s = obj(raw);
  const interval = str(obj(s.recurring).interval);
  return {
    id: need(str(s.id), 'price.id'),
    unitAmount: num(s.unit_amount),
    currency: (str(s.currency) ?? 'usd').toLowerCase(),
    interval: interval === 'month' || interval === 'year' ? interval : null,
  };
}

/** The parts of an event the route keeps: identity, type, time, mode and the object it is about. Never the payload. */
export function parseEventEnvelope(raw: unknown): StripeEventEnvelope | null {
  const e = obj(raw);
  const id = str(e.id);
  const type = str(e.type);
  const created = num(e.created);
  if (
    !id ||
    !/^evt_[A-Za-z0-9]{1,64}$/.test(id) ||
    !type ||
    !/^[a-z_]+(\.[a-z_]+)+$/.test(type) ||
    !created
  ) {
    return null;
  }
  const o = obj(obj(e.data).object);
  const objectId = str(o.id);
  return {
    id,
    type,
    created,
    livemode: e.livemode === true,
    objectType: str(o.object),
    objectId: objectId && /^[a-z]{2,8}_[A-Za-z0-9_]{1,80}$/.test(objectId) ? objectId : null,
  };
}

// ---------------------------------------------------------------- signatures
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>…]` over the exact raw body: HMAC-SHA256 with the endpoint
 * secret (the whole `whsec_…` string is the key) of `<t>.<body>`. Any v1 may match (several during a secret
 * rotation); other schemes are ignored; constant-time comparison; the timestamp must be within the tolerance.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  secrets: readonly string[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' } {
  if (!header) return { ok: false, reason: 'missing' };
  if (header.length > 2048) return { ok: false, reason: 'malformed' };
  let t: number | null = null;
  const v1: Buffer[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't' && /^[0-9]{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) v1.push(Buffer.from(v, 'hex'));
  }
  if (t === null || v1.length === 0) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - t) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
  const signed = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), rawBody]);
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(signed).digest();
    if (v1.some((sig) => sig.length === expected.length && timingSafeEqual(sig, expected)))
      return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}

/** Test and tooling helper: the header Stripe would send for this body. */
export function stripeSignatureHeader(rawBody: string, secret: string, t: number): string {
  const sig = createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}

// ---------------------------------------------------------------- the client
export function createStripe(cfg: StripeConfig, fetchImpl: typeof fetch = fetch): Stripe {
  async function call(method: 'GET' | 'POST', path: string, form?: FormObject, idempotencyKey?: string) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${cfg.secretKey}`,
      'stripe-version': STRIPE_API_VERSION,
      'user-agent': 'ProjectBrowser/1 (+billing)',
    };
    let body: string | undefined;
    let url = `${cfg.apiBase}${path}`;
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = form ? formEncode(form) : '';
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    } else if (form) {
      const q = formEncode(form);
      if (q) url += `?${q}`;
    }
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      throw new StripeError(0, 'network', null);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = obj(obj(json).error);
      throw new StripeError(res.status, str(err.type) ?? 'api_error', str(err.code));
    }
    return json;
  }

  return {
    async createCustomer(p, idem) {
      const r = await call(
        'POST',
        '/v1/customers',
        { name: p.name, email: p.email, metadata: { org_id: p.orgId } },
        idem,
      );
      return need(str(obj(r).id), 'customer.id');
    },
    async createCheckoutSession(p, idem) {
      const r = await call(
        'POST',
        '/v1/checkout/sessions',
        {
          mode: 'subscription',
          customer: p.customer,
          client_reference_id: p.orgId,
          line_items: [{ price: p.price, quantity: 1 }],
          success_url: p.successUrl,
          cancel_url: p.cancelUrl,
          metadata: { org_id: p.orgId },
          subscription_data: { metadata: { org_id: p.orgId } },
          automatic_tax: p.automaticTax ? { enabled: true } : undefined,
          customer_update: p.automaticTax ? { address: 'auto' } : undefined,
        },
        idem,
      );
      return parseCheckoutSession(r);
    },
    async createPortalSession(p) {
      const r = await call('POST', '/v1/billing_portal/sessions', {
        customer: p.customer,
        return_url: p.returnUrl,
        configuration: p.configuration ?? null,
      });
      return need(str(obj(r).url), 'portal.url');
    },
    async getSubscription(id) {
      return parseSubscription(await call('GET', `/v1/subscriptions/${encodeURIComponent(id)}`));
    },
    async listSubscriptions(customer) {
      const r = await call('GET', '/v1/subscriptions', { customer, status: 'all', limit: 20 });
      return list(r).map(parseSubscription);
    },
    async getCheckoutSession(id) {
      return parseCheckoutSession(await call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`));
    },
    async getInvoice(id) {
      return parseInvoice(await call('GET', `/v1/invoices/${encodeURIComponent(id)}`));
    },
    async listInvoices(customer, limit) {
      const r = await call('GET', '/v1/invoices', { customer, limit });
      return list(r).map(parseInvoice);
    },
    async getPrice(id) {
      return parsePrice(await call('GET', `/v1/prices/${encodeURIComponent(id)}`));
    },
    async customerOfCharge(chargeId) {
      return idOf(obj(await call('GET', `/v1/charges/${encodeURIComponent(chargeId)}`)).customer);
    },
    async customerOfDispute(disputeId) {
      const d = obj(await call('GET', `/v1/disputes/${encodeURIComponent(disputeId)}`));
      const charge = idOf(d.charge);
      if (!charge) return null;
      return idOf(obj(await call('GET', `/v1/charges/${encodeURIComponent(charge)}`)).customer);
    },
  };
}

/** Maps provider failures to the API's errors (an outage is retryable and changes nothing else). */
export function billingFailure(err: unknown): ApiError {
  if (err instanceof StripeError && !err.transient) {
    return new ApiError('BILLING_UNAVAILABLE', 'The payment provider refused the request', {
      provider_status: err.status,
      provider_error: err.type,
    });
  }
  return new ApiError('BILLING_UNAVAILABLE', 'The payment provider could not be reached; try again shortly');
}
