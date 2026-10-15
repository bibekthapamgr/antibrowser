/**
 * R5 (ADR-0024): publishing a plan draft as a new, immutable plan version.
 *
 *   1. claim (one short transaction): the draft is at the expected revision and still a draft; no publication of the
 *      same plan is running (a unique index makes concurrent requests collide); the new version number is fixed and
 *      a `running` publication is recorded. The same request repeated for the same revision returns the existing
 *      publication instead of starting another.
 *   2. provider (no transaction held): the product and one immutable price per interval are created or reused (lookup
 *      keys include the version and amount; idempotency keys include the publication), read back and verified, and
 *      the customer portal configuration is updated to offer the current prices.
 *   3. commit (one short transaction): the plan version, its prices and the new portal configuration are stored, the
 *      catalog generation increases, the draft is marked published; then this server's caches are dropped.
 * A failure in 2 or 3 marks the publication failed and returns the draft to editing: nothing reaches pricing.
 * A publication left `running` by a crash is taken over after STALE_MINUTES.
 */
import { ApiError, type CatalogPublication, type DraftPrice, newId, type PriceInterval } from '@pb/contracts';
import type pg from 'pg';
import type { Deps } from '../app.ts';
import { catalogOf, invalidateCatalog, newestPlan, offeredPlans, readCatalog } from '../billing/catalog.ts';
import {
  ensurePortalConfiguration,
  ensurePrice,
  ensureProduct,
  ProvisionError,
  verifyPrice,
} from '../billing/provision.ts';
import { ts, withTx } from '../db.ts';

const STALE_MINUTES = 10;

interface DraftRow {
  id: string;
  plan_id: string;
  name: string;
  description: string;
  purchasable: boolean;
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
  prices: DraftPrice[];
  state: string;
  revision: number;
}

export const PUBLICATION_COLUMNS = `p.id, p.draft_id, p.plan_id, p.version, p.state, p.provider_product_id, p.prices,
  p.error, p.started_by, ${ts('p.started_at')} as started_at, ${ts('p.finished_at')} as finished_at`;

export type PublishOutcome = { publication: CatalogPublication; created: boolean };

async function publicationById(c: pg.PoolClient, id: string): Promise<CatalogPublication> {
  const { rows } = await c.query<CatalogPublication>(
    `select ${PUBLICATION_COLUMNS} from catalog_publications p where p.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Publication not found');
  return row;
}

/** Validates what a draft says before anything is created at the provider. */
export function validateDraft(d: Pick<DraftRow, 'purchasable' | 'prices'>): void {
  const intervals = new Set(d.prices.map((p) => p.interval));
  if (intervals.size !== d.prices.length) {
    throw new ApiError('VALIDATION_FAILED', 'At most one price per billing period', { field: 'prices' });
  }
  if (new Set(d.prices.map((p) => p.currency)).size > 1) {
    throw new ApiError('VALIDATION_FAILED', 'All prices of a plan version use one currency', {
      field: 'prices',
    });
  }
  if (d.purchasable && d.prices.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'A plan sold through checkout needs at least one price', {
      field: 'prices',
    });
  }
  if (!d.purchasable && d.prices.length > 0) {
    throw new ApiError('VALIDATION_FAILED', 'A plan that is not sold has no prices', { field: 'prices' });
  }
}

export async function publishDraft(
  deps: Deps,
  staff: { userId: string; requestId: string },
  draftId: string,
  revision: number,
): Promise<PublishOutcome> {
  // ---------------------------------------------------------------- 1. claim
  const claim = await withTx(deps.pool, { orgId: null, userId: staff.userId }, async (c) => {
    const { rows } = await c.query<DraftRow>(
      `select id, plan_id, name, description, purchasable, limits, features, prices, state, revision
         from plan_drafts where id = $1 for update`,
      [draftId],
    );
    const draft = rows[0];
    if (!draft) throw new ApiError('NOT_FOUND', 'Draft not found');
    const same = await c.query<{ id: string; state: string }>(
      `select id, state from catalog_publications
        where draft_id = $1 and draft_revision = $2 and state <> 'failed'`,
      [draftId, revision],
    );
    if (same.rows[0]) return { existing: same.rows[0].id as string };
    if (draft.revision !== revision) {
      throw new ApiError('VERSION_CONFLICT', 'The draft changed; review it and publish again', {
        current_revision: draft.revision,
      });
    }
    if (draft.state !== 'draft') {
      throw new ApiError('VERSION_CONFLICT', 'This draft is not open for publishing', { state: draft.state });
    }
    validateDraft(draft);
    if (draft.prices.length > 0 && !deps.billing.provider) {
      throw new ApiError('BILLING_UNAVAILABLE', 'Publishing prices needs the payment provider configured');
    }
    // A publication of this plan left running by a crash is taken over.
    await c.query(
      `update catalog_publications set state = 'failed', error = 'abandoned', finished_at = now()
        where plan_id = $1 and state = 'running' and started_at < now() - make_interval(mins => $2)`,
      [draft.plan_id, STALE_MINUTES],
    );
    const running = await c.query<{ id: string }>(
      "select id from catalog_publications where plan_id = $1 and state = 'running'",
      [draft.plan_id],
    );
    if (running.rows[0]) {
      throw new ApiError('PUBLISH_IN_PROGRESS', 'This plan is being published; wait a moment', {
        publication_id: running.rows[0].id,
      });
    }
    const v = await c.query<{ next: number }>(
      'select coalesce(max(version), 0) + 1 as next from plans where id = $1',
      [draft.plan_id],
    );
    const version = v.rows[0]?.next ?? 1;
    const id = newId('catalogPublish');
    await c.query(
      `insert into catalog_publications (id, draft_id, draft_revision, plan_id, version, started_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, draftId, revision, draft.plan_id, version, staff.userId],
    );
    await c.query(
      "update plan_drafts set state = 'publishing', last_error = null, updated_at = now() where id = $1",
      [draftId],
    );
    await platformAudit(c, staff, 'admin.catalog_publish_started', id, {
      plan: `${draft.plan_id}@${version}`,
      draft: draftId,
    });
    return { id, version, draft };
  }).catch((err: unknown) => {
    // Two requests at once: the unique indexes refuse the second claim.
    if ((err as { code?: string }).code === '23505') {
      throw new ApiError('PUBLISH_IN_PROGRESS', 'This plan is being published; wait a moment');
    }
    throw err;
  });
  if ('existing' in claim) {
    const existing = claim.existing as string;
    const publication = await withTx(deps.pool, { orgId: null, userId: staff.userId }, (c) =>
      publicationById(c, existing),
    );
    return { publication, created: false };
  }
  const { id, version, draft } = claim;
  const plan = { id: draft.plan_id, version, name: draft.name, description: draft.description };

  try {
    // ---------------------------------------------------------------- 2. provider
    let productId: string | null = null;
    const made: {
      interval: PriceInterval;
      currency: string;
      amount_minor: number;
      provider_price_id: string;
    }[] = [];
    let portalConfiguration: string | null = null;
    if (draft.prices.length > 0) {
      const call = deps.billing.provider;
      if (!call) throw new ProvisionError('provider not configured');
      const idem = `pb-publish-${id}`;
      productId = await ensureProduct(call, plan, idem);
      for (const p of draft.prices) {
        const priceId = await ensurePrice(
          call,
          plan,
          productId,
          p.currency,
          p.interval,
          p.amount_minor,
          idem,
        );
        await verifyPrice(call, priceId, {
          product: productId,
          currency: p.currency,
          interval: p.interval,
          minor: p.amount_minor,
        });
        made.push({
          interval: p.interval,
          currency: p.currency,
          amount_minor: p.amount_minor,
          provider_price_id: priceId,
        });
      }
    }
    // The portal offers every current purchasable version's prices (this one included when it is sold).
    if (deps.billing.provider && (draft.purchasable || draft.prices.length > 0)) {
      const cat = await readCatalog(deps.pool);
      const offers: { product: string; price: string }[] = [];
      for (const p of offeredPlans(cat)) {
        if (p.id === draft.plan_id) continue;
        for (const price of cat.prices.filter((x) => x.planId === p.id && x.planVersion === p.version)) {
          offers.push({ product: price.providerProductId, price: price.providerPriceId });
        }
      }
      if (draft.purchasable && productId) {
        for (const m of made) offers.push({ product: productId, price: m.provider_price_id });
      }
      if (offers.length > 0)
        portalConfiguration = await ensurePortalConfiguration(deps.billing.provider, offers);
    }

    // ---------------------------------------------------------------- 3. commit
    await withTx(deps.pool, { orgId: null, userId: staff.userId }, async (c) => {
      await c.query(
        `insert into plans (id, version, name, description, purchasable, trial_days, limits, features, source,
                            published_at, published_by)
         values ($1, $2, $3, $4, $5,
                 (select trial_days from plans where id = $1 order by version desc limit 1),
                 $6, $7, 'admin', now(), $8)`,
        [
          plan.id,
          version,
          draft.name,
          draft.description,
          draft.purchasable,
          draft.limits,
          draft.features,
          staff.userId,
        ],
      );
      for (const m of made) {
        await c.query(
          `insert into plan_prices (plan_id, plan_version, interval, currency, amount_minor, provider_price_id,
                                    provider_product_id)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [plan.id, version, m.interval, m.currency, m.amount_minor, m.provider_price_id, productId],
        );
      }
      await c.query(
        `update catalog_state set generation = generation + 1, updated_at = now(),
                portal_configuration = coalesce($1, portal_configuration)`,
        [portalConfiguration],
      );
      await c.query(
        `update catalog_publications set state = 'succeeded', provider_product_id = $2, prices = $3,
                finished_at = now() where id = $1`,
        [id, productId, JSON.stringify(made)],
      );
      await c.query(
        `update plan_drafts set state = 'published', published_version = $2, updated_at = now() where id = $1`,
        [draftId, version],
      );
      await platformAudit(c, staff, 'admin.catalog_published', id, {
        plan: `${plan.id}@${version}`,
        prices: made.map((m) => `${m.interval}:${m.currency}:${m.amount_minor}`),
      });
    });
    invalidateCatalog(deps);
  } catch (err) {
    const message =
      err instanceof ProvisionError
        ? `provider: ${err.message}`
        : err instanceof ApiError
          ? err.message
          : 'internal error';
    await withTx(deps.pool, { orgId: null, userId: staff.userId }, async (c) => {
      await c.query(
        `update catalog_publications set state = 'failed', error = $2, finished_at = now()
          where id = $1 and state = 'running'`,
        [id, message.slice(0, 200)],
      );
      await c.query(
        `update plan_drafts set state = 'draft', last_error = $2, updated_at = now()
          where id = $1 and state = 'publishing'`,
        [draftId, message.slice(0, 200)],
      );
      await c.query(
        `insert into billing_alerts (id, kind, ref, detail) values ($1, 'publish_failed', $2, $3)
         on conflict (kind, coalesce(org_id, ''), coalesce(ref, '')) where resolved_at is null
         do update set count = billing_alerts.count + 1, last_seen_at = now(), detail = excluded.detail`,
        [newId('billingAlert'), `${plan.id}@${version}`, `Publication failed: ${message}`.slice(0, 300)],
      );
      await platformAudit(c, staff, 'admin.catalog_publish_failed', id, { plan: `${plan.id}@${version}` });
    });
    throw new ApiError(
      'PUBLISH_FAILED',
      'Publishing failed; nothing was published. The draft can be published again.',
      {
        publication_id: id,
        reason: message.slice(0, 200),
      },
    );
  }
  const publication = await withTx(deps.pool, { orgId: null, userId: staff.userId }, (c) =>
    publicationById(c, id),
  );
  return { publication, created: true };
}

export async function platformAudit(
  c: pg.PoolClient,
  staff: { userId: string; requestId: string },
  action: string,
  target: string | null,
  details: object = {},
  orgId: string | null = null,
): Promise<void> {
  await c.query(
    `insert into platform_audit (id, actor_user_id, action, org_id, target, details, request_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [newId('audit'), staff.userId, action, orgId, target, JSON.stringify(details), staff.requestId],
  );
}

/** A draft for a new version of a plan, prefilled from its newest stored version. */
export async function draftSeed(deps: Deps, planId: string) {
  const cat = await catalogOf(deps);
  const base = newestPlan(cat, planId);
  if (!base) return null;
  return {
    base,
    prices: cat.prices
      .filter((p) => p.planId === base.id && p.planVersion === base.version)
      .map((p) => ({ interval: p.interval, currency: p.currency, amount_minor: p.amountMinor })),
  };
}
