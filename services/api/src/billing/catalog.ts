/**
 * R4 (ADR-0023): the plans this server sells, with prices verified at the payment provider. One definition for the
 * public pricing page, the portal and checkout:
 *   - only the newest version of each purchasable catalog plan;
 *   - a price counts only when it is configured for that plan and interval, readable at the provider, active, and
 *     bills at that interval; anything else is not offered (no checkout) — never shown as free;
 *   - the version string changes whenever the catalog or a verified price changes, so cached pages revalidate.
 */
import { createHash } from 'node:crypto';
import {
  latestPlan,
  PLAN_CATALOG,
  type PlanDefinition,
  PRICE_INTERVALS,
  type PriceInterval,
  type PublicPlans,
  type PublicPrice,
  priceKeys,
} from '@pb/contracts';
import type { Deps } from '../app.ts';
import type { StripePrice } from './stripe.ts';

const PRICE_TTL_MS = 3_600_000;
const PRICE_FAILURE_TTL_MS = 300_000;

/** A provider price, cached (an hour when read, five minutes after a failure). */
export async function providerPrice(
  deps: Deps,
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

/** The configured price id of a plan at an interval (month also accepts the milestone 11 key `plan@version`). */
export function configuredPrice(deps: Deps, plan: PlanDefinition, interval: PriceInterval): string | null {
  for (const key of priceKeys(plan.id, plan.version, interval)) {
    const id = deps.billing.prices[key];
    if (id) return id;
  }
  return null;
}

/** A verified, sellable price of a plan at an interval, or null (then checkout refuses the plan). */
export async function sellablePrice(
  deps: Deps,
  plan: PlanDefinition,
  interval: PriceInterval,
): Promise<{ priceId: string; price: StripePrice; at: number } | null> {
  if (!plan.purchasable || !deps.billing.stripe) return null;
  const priceId = configuredPrice(deps, plan, interval);
  if (!priceId) return null;
  const { price, at } = await providerPrice(deps, priceId);
  if (!price?.active || price.unitAmount === null || price.interval !== interval) return null;
  return { priceId, price, at };
}

export function offeredPlans(): PlanDefinition[] {
  const ids = [...new Set(PLAN_CATALOG.filter((p) => p.purchasable).map((p) => p.id))];
  return ids.map((id) => latestPlan(id)).filter((p): p is PlanDefinition => p?.purchasable === true);
}

const TRIAL_DAYS = PLAN_CATALOG.find((p) => p.id === 'trial')?.trialDays ?? 0;

/** The public catalog (GET /v1/public/plans). */
export async function publicCatalog(deps: Deps): Promise<PublicPlans> {
  const items = await Promise.all(
    offeredPlans().map(async (plan) => {
      const prices: PublicPrice[] = [];
      for (const interval of PRICE_INTERVALS) {
        const s = await sellablePrice(deps, plan, interval);
        if (!s || s.price.unitAmount === null) continue;
        prices.push({
          interval,
          amount_minor: s.price.unitAmount,
          currency: s.price.currency,
          tax: deps.billing.automaticTax ? 'automatic' : s.price.taxBehavior,
          verified_at: new Date(s.at).toISOString(),
        });
      }
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
  const fingerprint = JSON.stringify(
    items.map((p) => [
      p.id,
      p.version,
      p.limits,
      p.features,
      p.prices.map((x) => [x.interval, x.amount_minor, x.currency, x.tax]),
    ]),
  );
  return {
    catalog_version: createHash('sha256').update(fingerprint).digest('hex').slice(0, 16),
    generated_at: new Date().toISOString(),
    trial_days: TRIAL_DAYS,
    checkout: Boolean(deps.billing.stripe),
    items,
  };
}
