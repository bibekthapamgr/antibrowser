/**
 * Creating the provider's catalog objects (milestone 11 setup script; R5 console publishing, ADR-0024): one product
 * per plan id, immutable prices found by lookup key (a changed amount or a new plan version is always a NEW price —
 * a provider price amount is never changed), and a customer portal configuration that lets customers switch between
 * the prices currently offered. Every create call carries an idempotency key, so a retry never makes a second object.
 * Error messages never contain the secret key.
 */
import { planKey } from '@pb/contracts';
import { formEncode, STRIPE_API_VERSION } from './stripe.ts';

type Json = Record<string, unknown>;

export class ProvisionError extends Error {
  /** HTTP status of the provider's answer (0: not reached). */
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
    this.name = 'ProvisionError';
  }
}

export type ProviderCall = (
  method: 'GET' | 'POST',
  path: string,
  params?: Json,
  idempotencyKey?: string,
) => Promise<{ status: number; body: Json }>;

/** A raw caller of the provider's REST API (form-encoded requests, the pinned API version). */
export function providerCaller(key: string, apiBase: string, timeoutMs = 20_000): ProviderCall {
  return async (method, path, params, idempotencyKey) => {
    const encoded = params ? formEncode(params as never) : '';
    const url = `${apiBase.replace(/\/+$/, '')}${path}${method === 'GET' && encoded ? `?${encoded}` : ''}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          'stripe-version': STRIPE_API_VERSION,
          ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        ...(method === 'POST' ? { body: encoded } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      return { status: 0, body: { error: { type: 'network' } } };
    }
    const body = (await res.json().catch(() => ({}))) as Json;
    return { status: res.status, body };
  };
}

export function provisionFailure(what: string, r: { status: number; body: Json }): ProvisionError {
  const e = (r.body.error ?? {}) as { type?: string; code?: string; message?: string };
  return new ProvisionError(
    `${what}: HTTP ${r.status} ${e.type ?? ''} ${e.code ?? ''} ${e.message ?? ''}`.trim().slice(0, 300),
    r.status,
  );
}

export interface PlanRef {
  id: string;
  version: number;
  name: string;
  description: string;
}

export const productId = (plan: Pick<PlanRef, 'id'>) => `pb_plan_${plan.id}`;
export const lookupKey = (
  plan: Pick<PlanRef, 'id' | 'version'>,
  currency: string,
  interval: string,
  minor: number,
) => `pb_${plan.id}_${plan.version}_${currency}_${interval}_${minor}`;

export async function ensureProduct(
  call: ProviderCall,
  plan: PlanRef,
  idemPrefix = 'pb-setup',
): Promise<string> {
  const id = productId(plan);
  const got = await call('GET', `/v1/products/${id}`);
  if (got.status === 200) return id;
  if (got.status !== 404) throw provisionFailure(`product ${id}`, got);
  const made = await call(
    'POST',
    '/v1/products',
    {
      id,
      name: `Project Browser ${plan.name}`,
      description: plan.description || plan.name,
      metadata: { pb_plan: plan.id },
    },
    `${idemPrefix}-product-${id}`,
  );
  if (made.status !== 200) throw provisionFailure(`product ${id}`, made);
  return id;
}

export async function ensurePrice(
  call: ProviderCall,
  plan: PlanRef,
  product: string,
  currency: string,
  interval: 'month' | 'year',
  minor: number,
  idemPrefix = 'pb-setup',
): Promise<string> {
  const key = lookupKey(plan, currency, interval, minor);
  const found = await call('GET', '/v1/prices', { lookup_keys: [key], active: true, limit: 1 });
  if (found.status !== 200) throw provisionFailure(`price ${key}`, found);
  const existing = (found.body.data as Json[] | undefined)?.[0];
  if (existing && typeof existing.id === 'string') return existing.id;
  const made = await call(
    'POST',
    '/v1/prices',
    {
      product,
      currency,
      unit_amount: minor,
      recurring: { interval },
      lookup_key: key,
      metadata: { pb_plan: planKey(plan.id, plan.version) },
    },
    `${idemPrefix}-price-${key}`,
  );
  if (made.status !== 200 || typeof made.body.id !== 'string') throw provisionFailure(`price ${key}`, made);
  return made.body.id;
}

/** Reads a price back and checks it is exactly what was meant (product, amount, currency, interval, active). */
export async function verifyPrice(
  call: ProviderCall,
  priceId: string,
  want: { product: string; currency: string; interval: 'month' | 'year'; minor: number },
): Promise<void> {
  const r = await call('GET', `/v1/prices/${encodeURIComponent(priceId)}`);
  if (r.status !== 200) throw provisionFailure(`price ${priceId}`, r);
  const p = r.body;
  const product = typeof p.product === 'string' ? p.product : ((p.product as Json | undefined)?.id ?? null);
  const recurring = (p.recurring ?? {}) as Json;
  const ok =
    p.active !== false &&
    product === want.product &&
    p.unit_amount === want.minor &&
    String(p.currency ?? '').toLowerCase() === want.currency &&
    recurring.interval === want.interval &&
    (recurring.interval_count ?? 1) === 1;
  if (!ok) throw new ProvisionError(`price ${priceId} does not match what was published`);
}

export async function ensurePortalConfiguration(
  call: ProviderCall,
  offers: { product: string; price: string }[],
  headline = 'Project Browser subscription',
): Promise<string> {
  const signature = offers
    .map((o) => o.price)
    .sort()
    .join(',');
  const list = await call('GET', '/v1/billing_portal/configurations', { active: true, limit: 100 });
  if (list.status !== 200) throw provisionFailure('portal configurations', list);
  const match = ((list.body.data as Json[] | undefined) ?? []).find(
    (c) => (c.metadata as Json | undefined)?.pb_prices === signature,
  );
  if (match && typeof match.id === 'string') return match.id;
  const made = await call(
    'POST',
    '/v1/billing_portal/configurations',
    {
      business_profile: { headline },
      features: {
        customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        // Cancel at the end of the period: access continues until then and nothing is deleted.
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ['price'],
          proration_behavior: 'create_prorations',
          // One entry per product with all of its prices (monthly and, where sold, yearly).
          products: [...new Set(offers.map((o) => o.product))].map((product) => ({
            product,
            prices: offers.filter((o) => o.product === product).map((o) => o.price),
          })),
        },
      },
      metadata: { pb_prices: signature },
    },
    `pb-setup-portal-${signature}`.slice(0, 255),
  );
  if (made.status !== 200 || typeof made.body.id !== 'string')
    throw provisionFailure('portal configuration', made);
  return made.body.id;
}
