/**
 * Stripe TEST-mode setup for the plans (milestone 11, ADR-0018): one product per purchasable plan, a monthly (or
 * yearly) price per plan from the amounts YOU give, and a customer portal configuration that lets customers switch
 * between those prices, update payment methods, see invoices and cancel at the end of the period. Prints (or writes)
 * BILLING_STRIPE_PRICES and STRIPE_PORTAL_CONFIGURATION for the server's billing settings.
 *
 * The amounts are the owner's pricing decision; this script has no defaults. Test-mode keys only: a live setup is a
 * separate, reviewed step (milestone 12/14). Safe to re-run: products are found by id, prices by lookup key (a
 * changed amount makes a NEW price; Stripe prices are immutable), the portal configuration by the prices it offers.
 *
 *   node --env-file=/etc/project-browser/billing.env services/api/scripts/stripe-setup.ts \
 *     --price starter=<amount> --price team=<amount> --price agency=<amount> \
 *     [--currency usd] [--interval month|year] [--write /etc/project-browser/billing.env]
 *
 * The key comes from STRIPE_SECRET_KEY in the environment (never from the command line, which other users of the
 * server can see).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { latestPlan, type PlanDefinition, planKey } from '@pb/contracts/billing';
import { formEncode, STRIPE_API_VERSION } from '../src/billing/stripe.ts';

type Json = Record<string, unknown>;

export interface StripeSetupOptions {
  key: string;
  apiBase: string;
  currency: string;
  interval: 'month' | 'year';
  /** plan id → amount in the currency's minor unit. */
  amounts: Record<string, number>;
  log?: (line: string) => void;
}

export interface StripeSetupResult {
  prices: Record<string, string>;
  portalConfiguration: string;
}

export class StripeSetupError extends Error {}

export function stripeCaller(key: string, apiBase: string) {
  return async function call(
    method: 'GET' | 'POST',
    path: string,
    params?: Json,
    idempotencyKey?: string,
  ): Promise<{ status: number; body: Json }> {
    const encoded = params ? formEncode(params as never) : '';
    const url = `${apiBase}${path}${method === 'GET' && encoded ? `?${encoded}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        'stripe-version': STRIPE_API_VERSION,
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(method === 'POST' ? { body: encoded } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    return { status: res.status, body };
  };
}
type Call = ReturnType<typeof stripeCaller>;

const fail = (what: string, r: { status: number; body: Json }) => {
  const e = (r.body.error ?? {}) as { type?: string; code?: string; message?: string };
  // Stripe's error message never contains the key; it is shown to help the owner fix the account settings.
  return new StripeSetupError(
    `${what}: HTTP ${r.status} ${e.type ?? ''} ${e.code ?? ''} ${e.message ?? ''}`.trim(),
  );
};

/** Minor units of an amount like "49" or "49.50" in a currency (JPY has none, USD two). */
export function minorUnits(amount: string, currency: string): number {
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  if (!/^\d{1,7}(\.\d+)?$/.test(amount)) throw new StripeSetupError(`not an amount: ${amount}`);
  const [whole = '0', frac = ''] = amount.split('.');
  if (frac.length > digits) throw new StripeSetupError(`${amount} has more decimals than ${currency} allows`);
  const minor = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0');
  if (!Number.isSafeInteger(minor) || minor <= 0)
    throw new StripeSetupError(`not a positive amount: ${amount}`);
  return minor;
}

export const productId = (plan: PlanDefinition) => `pb_plan_${plan.id}`;
export const lookupKey = (plan: PlanDefinition, currency: string, interval: string, minor: number) =>
  `pb_${plan.id}_${plan.version}_${currency}_${interval}_${minor}`;

export async function ensureProduct(call: Call, plan: PlanDefinition): Promise<string> {
  const id = productId(plan);
  const got = await call('GET', `/v1/products/${id}`);
  if (got.status === 200) return id;
  if (got.status !== 404) throw fail(`product ${id}`, got);
  const made = await call(
    'POST',
    '/v1/products',
    {
      id,
      name: `Project Browser ${plan.name}`,
      description: plan.description,
      metadata: { pb_plan: plan.id },
    },
    `pb-setup-product-${id}`,
  );
  if (made.status !== 200) throw fail(`product ${id}`, made);
  return id;
}

export async function ensurePrice(
  call: Call,
  plan: PlanDefinition,
  product: string,
  currency: string,
  interval: 'month' | 'year',
  minor: number,
): Promise<string> {
  const key = lookupKey(plan, currency, interval, minor);
  const found = await call('GET', '/v1/prices', { lookup_keys: [key], active: true, limit: 1 });
  if (found.status !== 200) throw fail(`price ${key}`, found);
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
    `pb-setup-price-${key}`,
  );
  if (made.status !== 200 || typeof made.body.id !== 'string') throw fail(`price ${key}`, made);
  return made.body.id;
}

export async function ensurePortalConfiguration(
  call: Call,
  offers: { product: string; price: string }[],
): Promise<string> {
  const signature = offers
    .map((o) => o.price)
    .sort()
    .join(',');
  const list = await call('GET', '/v1/billing_portal/configurations', { active: true, limit: 100 });
  if (list.status !== 200) throw fail('portal configurations', list);
  const match = ((list.body.data as Json[] | undefined) ?? []).find(
    (c) => (c.metadata as Json | undefined)?.pb_prices === signature,
  );
  if (match && typeof match.id === 'string') return match.id;
  const made = await call(
    'POST',
    '/v1/billing_portal/configurations',
    {
      business_profile: { headline: 'Project Browser subscription' },
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
          products: offers.map((o) => ({ product: o.product, prices: [o.price] })),
        },
      },
      metadata: { pb_prices: signature },
    },
    `pb-setup-portal-${signature}`.slice(0, 255),
  );
  if (made.status !== 200 || typeof made.body.id !== 'string') throw fail('portal configuration', made);
  return made.body.id;
}

export async function setupStripe(o: StripeSetupOptions): Promise<StripeSetupResult> {
  if (!/^(sk|rk)_test_/.test(o.key)) {
    throw new StripeSetupError('test-mode keys only (sk_test_… or rk_test_…); live setup is a separate step');
  }
  const log = o.log ?? (() => undefined);
  const call = stripeCaller(o.key, o.apiBase.replace(/\/+$/, ''));
  const prices: Record<string, string> = {};
  const offers: { product: string; price: string }[] = [];
  for (const [id, minor] of Object.entries(o.amounts)) {
    const plan = latestPlan(id);
    if (!plan?.purchasable) throw new StripeSetupError(`${id} is not a purchasable plan`);
    const product = await ensureProduct(call, plan);
    const price = await ensurePrice(call, plan, product, o.currency, o.interval, minor);
    prices[planKey(plan.id, plan.version)] = price;
    offers.push({ product, price });
    log(`ok  ${planKey(plan.id, plan.version)} → ${price} (${product})`);
  }
  const portalConfiguration = await ensurePortalConfiguration(call, offers);
  log(`ok  customer portal configuration ${portalConfiguration}`);
  return { prices, portalConfiguration };
}

/** Sets (or adds) KEY=value lines in an environment file and keeps everything else. */
export function writeEnvValues(file: string, values: Record<string, string>): void {
  let text = readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^#?\\s*${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  }
  writeFileSync(file, text);
}

async function main() {
  const args = process.argv.slice(2);
  const amounts: Record<string, string> = {};
  let currency = 'usd';
  let interval: 'month' | 'year' = 'month';
  let write: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1] ?? '';
    if (a === '--price') {
      const [plan, amount] = v.split('=');
      if (!plan || !amount) throw new StripeSetupError('--price plan=amount, e.g. --price team=49');
      amounts[plan] = amount;
      i++;
    } else if (a === '--currency') {
      currency = v.toLowerCase();
      i++;
    } else if (a === '--interval') {
      if (v !== 'month' && v !== 'year') throw new StripeSetupError('--interval month|year');
      interval = v;
      i++;
    } else if (a === '--write') {
      write = v;
      i++;
    } else {
      throw new StripeSetupError(`unknown argument ${a}`);
    }
  }
  if (!/^[a-z]{3}$/.test(currency)) throw new StripeSetupError('--currency is a three-letter code, e.g. usd');
  if (Object.keys(amounts).length === 0) {
    throw new StripeSetupError('give the price of each plan you sell: --price starter=… --price team=…');
  }
  const minor = Object.fromEntries(Object.entries(amounts).map(([p, a]) => [p, minorUnits(a, currency)]));
  const result = await setupStripe({
    key: process.env.STRIPE_SECRET_KEY ?? '',
    apiBase: process.env.STRIPE_API_BASE || 'https://api.stripe.com',
    currency,
    interval,
    amounts: minor,
    log: (l) => console.log(l),
  });
  const values = {
    BILLING_STRIPE_PRICES: `'${JSON.stringify(result.prices)}'`,
    STRIPE_PORTAL_CONFIGURATION: result.portalConfiguration,
  };
  if (write) {
    writeEnvValues(write, values);
    console.log(`ok  written to ${write}`);
  } else {
    console.log('\nAdd to the billing settings:');
    for (const [k, v] of Object.entries(values)) console.log(`${k}=${v}`);
  }
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`STOPPED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
