/**
 * The plans this server sells, with prices verified at the payment provider (R4, ADR-0023), read from the DATABASE
 * (R5, ADR-0024): `plans` (seeded versions and versions published from the console) and `plan_prices` (the immutable
 * provider price of each version and interval) are the runtime authority. The milestone 11 setting
 * BILLING_STRIPE_PRICES remains a bootstrap fallback for versions that have no published price yet.
 *
 * - Only the newest version of each purchasable plan is offered for new purchases; workspaces keep the version (and
 *   price) they bought until they change plan.
 * - A price counts only when it is configured for that version and interval, readable at the provider, active, and
 *   bills at that interval; anything else is not offered (no checkout) — never shown as free.
 * - The catalog snapshot is cached briefly (CATALOG_TTL_MS) and dropped at once by a publication on this server; other
 *   API instances notice the new `generation` within the TTL.
 */
import { createHash } from 'node:crypto';
import {
  type PlanFeatures,
  type PlanLimits,
  PRICE_INTERVALS,
  type PriceInterval,
  type PublicPlans,
  type PublicPrice,
  priceKeys,
} from '@pb/contracts';
import type pg from 'pg';
import type { Deps } from '../app.ts';
import type { StripePrice } from './stripe.ts';

const PRICE_TTL_MS = 3_600_000;
const PRICE_FAILURE_TTL_MS = 300_000;
export const CATALOG_TTL_MS = 15_000;
const PUBLIC_TTL_MS = 60_000;

export interface StoredPlan {
  id: string;
  version: number;
  name: string;
  description: string;
  purchasable: boolean;
  trialDays: number | null;
  limits: PlanLimits;
  features: PlanFeatures;
  source: 'seed' | 'admin';
  publishedAt: string;
  publishedBy: string | null;
}

export interface StoredPrice {
  planId: string;
  planVersion: number;
  interval: PriceInterval;
  currency: string;
  amountMinor: number;
  providerPriceId: string;
  providerProductId: string;
}

export interface CatalogSnapshot {
  generation: number;
  plans: StoredPlan[];
  prices: StoredPrice[];
  portalConfiguration: string | null;
  at: number;
}

export interface CatalogCache {
  snapshot: CatalogSnapshot | null;
  publicPlans: { at: number; value: PublicPlans } | null;
}

export const newCatalogCache = (): CatalogCache => ({ snapshot: null, publicPlans: null });

/** Drops every cached view of the catalog on this server (after a publication). */
export function invalidateCatalog(deps: Pick<Deps, 'billing'>): void {
  deps.billing.catalog.snapshot = null;
  deps.billing.catalog.publicPlans = null;
  deps.billing.priceCache.clear();
}

/** Reads the catalog from any pool that may read plans, plan_prices and catalog_state (API or worker). */
export async function readCatalog(db: pg.Pool | pg.PoolClient): Promise<CatalogSnapshot> {
  const plans = await db.query<{
    id: string;
    version: number;
    name: string;
    description: string;
    purchasable: boolean;
    trial_days: number | null;
    limits: PlanLimits;
    features: PlanFeatures;
    source: 'seed' | 'admin';
    published_at: string;
    published_by: string | null;
  }>(
    `select id, version, name, description, purchasable, trial_days, limits, features, source,
            to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as published_at, published_by
       from app.plans order by id, version`,
  );
  const prices = await db.query<{
    plan_id: string;
    plan_version: number;
    interval: PriceInterval;
    currency: string;
    amount_minor: string;
    provider_price_id: string;
    provider_product_id: string;
  }>(
    `select plan_id, plan_version, interval, currency, amount_minor::text as amount_minor, provider_price_id,
            provider_product_id from app.plan_prices`,
  );
  const state = await db.query<{ generation: string; portal_configuration: string | null }>(
    'select generation::text as generation, portal_configuration from app.catalog_state',
  );
  return {
    generation: Number(state.rows[0]?.generation ?? 0),
    portalConfiguration: state.rows[0]?.portal_configuration ?? null,
    plans: plans.rows.map((r) => ({
      id: r.id,
      version: r.version,
      name: r.name,
      description: r.description,
      purchasable: r.purchasable,
      trialDays: r.trial_days,
      limits: r.limits,
      features: r.features,
      source: r.source,
      publishedAt: r.published_at,
      publishedBy: r.published_by,
    })),
    prices: prices.rows.map((r) => ({
      planId: r.plan_id,
      planVersion: r.plan_version,
      interval: r.interval,
      currency: r.currency,
      amountMinor: Number(r.amount_minor),
      providerPriceId: r.provider_price_id,
      providerProductId: r.provider_product_id,
    })),
    at: Date.now(),
  };
}

/** The catalog as this server sees it (cached for CATALOG_TTL_MS). */
export async function catalogOf(deps: Pick<Deps, 'pool' | 'billing'>): Promise<CatalogSnapshot> {
  const c = deps.billing.catalog.snapshot;
  if (c && Date.now() - c.at < CATALOG_TTL_MS) return c;
  const fresh = await readCatalog(deps.pool);
  deps.billing.catalog.snapshot = fresh;
  return fresh;
}

export function planAt(cat: CatalogSnapshot, id: string, version: number): StoredPlan | undefined {
  return cat.plans.find((p) => p.id === id && p.version === version);
}

/** The newest stored version of a plan (what new purchases and new trials use). */
export function newestPlan(cat: CatalogSnapshot, id: string): StoredPlan | undefined {
  let best: StoredPlan | undefined;
  for (const p of cat.plans) if (p.id === id && (!best || p.version > best.version)) best = p;
  return best;
}

const size = (n: number | null) => (n === null ? Number.POSITIVE_INFINITY : n);

/** The newest version of each plan, when that version is purchasable; smallest plan first (seats, then profiles). */
export function offeredPlans(cat: CatalogSnapshot): StoredPlan[] {
  const ids = [...new Set(cat.plans.map((p) => p.id))];
  return ids
    .map((id) => newestPlan(cat, id))
    .filter((p): p is StoredPlan => p?.purchasable === true)
    .sort(
      (a, b) =>
        size(a.limits.seats) - size(b.limits.seats) ||
        size(a.limits.profiles) - size(b.limits.profiles) ||
        a.id.localeCompare(b.id),
    );
}

export const trialDaysOf = (cat: CatalogSnapshot): number => newestPlan(cat, 'trial')?.trialDays ?? 0;

/** A provider price, cached (an hour when read, five minutes after a failure). */
export async function providerPrice(
  deps: Pick<Deps, 'billing'>,
  priceId: string,
): Promise<{ price: StripePrice | null; at: number }> {
  const cached = deps.billing.priceCache.get(priceId);
  const now = Date.now();
  if (cached && now - cached.at < (cached.price ? PRICE_TTL_MS : PRICE_FAILURE_TTL_MS)) return cached;
  let price: StripePrice | null = null;
  try {
    price = deps.billing.stripe ? await deps.billing.stripe.getPrice(priceId) : null;
  } catch {
    price = null;
  }
  const entry = { at: now, price };
  deps.billing.priceCache.set(priceId, entry);
  return entry;
}

/**
 * The price id of a plan version at an interval: the published price (plan_prices) first, else the bootstrap setting
 * (`plan@version/interval`, and for month also the milestone 11 key `plan@version`).
 */
export function configuredPrice(
  deps: Pick<Deps, 'billing'>,
  cat: CatalogSnapshot,
  plan: Pick<StoredPlan, 'id' | 'version'>,
  interval: PriceInterval,
): string | null {
  const stored = cat.prices.find(
    (p) => p.planId === plan.id && p.planVersion === plan.version && p.interval === interval,
  );
  if (stored) return stored.providerPriceId;
  for (const key of priceKeys(plan.id, plan.version, interval)) {
    const id = deps.billing.prices[key];
    if (id) return id;
  }
  return null;
}

/** A verified, sellable price of a plan at an interval, or null (then checkout refuses the plan). */
export async function sellablePrice(
  deps: Pick<Deps, 'billing'>,
  cat: CatalogSnapshot,
  plan: StoredPlan,
  interval: PriceInterval,
): Promise<{ priceId: string; price: StripePrice; at: number } | null> {
  if (!plan.purchasable || !deps.billing.stripe) return null;
  const priceId = configuredPrice(deps, cat, plan, interval);
  if (!priceId) return null;
  const { price, at } = await providerPrice(deps, priceId);
  if (!price?.active || price.unitAmount === null || price.interval !== interval) return null;
  return { priceId, price, at };
}

/** Every verified price of a plan (the public page, the portal and the desktop show the same). */
export async function verifiedPrices(
  deps: Pick<Deps, 'billing'>,
  cat: CatalogSnapshot,
  plan: StoredPlan,
): Promise<PublicPrice[]> {
  const prices: PublicPrice[] = [];
  for (const interval of PRICE_INTERVALS) {
    const s = await sellablePrice(deps, cat, plan, interval);
    if (!s || s.price.unitAmount === null) continue;
    prices.push({
      interval,
      amount_minor: s.price.unitAmount,
      currency: s.price.currency,
      tax: deps.billing.automaticTax ? 'automatic' : s.price.taxBehavior,
      verified_at: new Date(s.at).toISOString(),
    });
  }
  return prices;
}

/** The public catalog (GET /v1/public/plans), cached for a minute and dropped by a publication. */
export async function publicCatalog(deps: Pick<Deps, 'pool' | 'billing'>): Promise<PublicPlans> {
  const cached = deps.billing.catalog.publicPlans;
  if (cached && Date.now() - cached.at < PUBLIC_TTL_MS) return cached.value;
  const cat = await catalogOf(deps);
  const items = await Promise.all(
    offeredPlans(cat).map(async (plan) => {
      const prices = await verifiedPrices(deps, cat, plan);
      return {
        id: plan.id,
        version: plan.version,
        name: plan.name,
        description: plan.description,
        limits: plan.limits,
        features: plan.features,
        prices,
        available: prices.length > 0,
      };
    }),
  );
  const fingerprint = JSON.stringify([
    cat.generation,
    items.map((p) => [
      p.id,
      p.version,
      p.limits,
      p.features,
      p.prices.map((x) => [x.interval, x.amount_minor, x.currency, x.tax]),
    ]),
  ]);
  const value: PublicPlans = {
    catalog_version: createHash('sha256').update(fingerprint).digest('hex').slice(0, 16),
    generated_at: new Date().toISOString(),
    trial_days: trialDaysOf(cat),
    checkout: Boolean(deps.billing.stripe),
    items,
  };
  deps.billing.catalog.publicPlans = { at: Date.now(), value };
  return value;
}
