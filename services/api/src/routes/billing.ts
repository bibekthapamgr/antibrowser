/**
 * Billing (milestone 11, ADR-0018): an organization's subscription, plans, usage and invoices; hosted checkout and
 * portal sessions; and the payment provider's webhook.
 *
 * - Reads come from the database only (the provider is never asked to decide access; an outage changes nothing).
 * - Checkout and portal pages are the provider's: the application never sees card data. The return page is only
 *   informational — a redirect is never proof of payment; the subscription changes when the provider's own data says
 *   so (webhook, then the worker fetches the current object).
 * - The webhook is verified against the exact raw body, deduplicated on the event id and recorded without its payload.
 */
import {
  ApiError,
  BillingPlans,
  BillingUsage,
  CheckoutRequest,
  HostedSession,
  InvoiceLinks,
  Invoices,
  latestPlan,
  newId,
  PLAN_CATALOG,
  planKey,
  Subscription,
  USAGE_TYPES,
  type UsageType,
} from '@pb/contracts';
import Type from 'typebox';
import type { App, Deps } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { effectiveOf, subscriptionView, usageOf } from '../billing/state.ts';
import {
  billingFailure,
  parseEventEnvelope,
  type StripePrice,
  verifyStripeSignature,
} from '../billing/stripe.ts';
import { ts, withTx } from '../db.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { requireInteractive, requirePermission, resolveTenant } from '../tenancy.ts';
import { errors, OrgParams } from './common.ts';

/** Provider events the worker acts on; others are recorded (for deduplication and support) and ignored. */
const HANDLED = [
  /^customer\.subscription\.[a-z_]+$/,
  /^checkout\.session\.(completed|async_payment_succeeded)$/,
  /^invoice\.(paid|payment_failed|payment_succeeded|finalized|updated|voided|marked_uncollectible)$/,
  /^charge\.refunded$/,
  /^charge\.dispute\.created$/,
];
const LIVE_STATUSES = ['trialing', 'active', 'past_due', 'unpaid', 'paused'];
const PRICE_TTL_MS = 3_600_000;
const PRICE_FAILURE_TTL_MS = 300_000;

const InvoiceParams = Type.Object(
  { orgId: OrgParams.properties.orgId, invoiceId: Type.String({ pattern: '^in_[A-Za-z0-9]{1,64}$' }) },
  { additionalProperties: false },
);

function stripeOf(deps: Deps) {
  const stripe = deps.billing.stripe;
  if (!stripe) throw new ApiError('BILLING_UNAVAILABLE', 'Billing is not configured on this server');
  return stripe;
}

async function displayPrice(deps: Deps, priceId: string): Promise<StripePrice | null> {
  const cached = deps.billing.priceCache.get(priceId);
  const now = Date.now();
  if (cached && now - cached.at < (cached.price ? PRICE_TTL_MS : PRICE_FAILURE_TTL_MS)) return cached.price;
  let price: StripePrice | null = null;
  try {
    price = deps.billing.stripe ? await deps.billing.stripe.getPrice(priceId) : null;
  } catch {
    price = null;
  }
  deps.billing.priceCache.set(priceId, { at: now, price });
  return price;
}

export function billingRoutes(app: App, deps: Deps): void {
  app.get(
    '/orgs/:orgId/billing/subscription',
    {
      schema: {
        tags: ['billing'],
        description:
          'The plan, effective state (trial, active, past_due, grace, restricted, canceled) with its reason and end, ' +
          'limits and features (with staff overrides), current usage and exceeded limits. From the database only.',
        params: OrgParams,
        response: { 200: Subscription, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'billing.read');
      return withTx(deps.pool, access, (c) => subscriptionView(c, access.orgId, deps.billing.retentionDays));
    },
  );

  app.get(
    '/orgs/:orgId/billing/plans',
    {
      schema: {
        tags: ['billing'],
        description:
          'Plans this server can sell (newest version of each purchasable plan) and the organization’s current plan. ' +
          'Prices are read from the payment provider for display; checkout always shows the binding amount.',
        params: OrgParams,
        response: { 200: BillingPlans, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'billing.read');
      const current = await withTx(deps.pool, access, (c) => effectiveOf(c, access.orgId));
      const ids = [...new Set(PLAN_CATALOG.filter((p) => p.purchasable).map((p) => p.id))];
      const offered = ids.map((id) => latestPlan(id)).filter((p) => p !== undefined);
      const mine = PLAN_CATALOG.find((p) => p.id === current.planId && p.version === current.planVersion);
      const list =
        mine && !offered.some((p) => p.id === mine.id && p.version === mine.version)
          ? [mine, ...offered]
          : offered;
      const items = await Promise.all(
        list.map(async (p) => {
          const priceId = deps.billing.prices[planKey(p.id, p.version)];
          const price = priceId ? await displayPrice(deps, priceId) : null;
          return {
            id: p.id,
            version: p.version,
            name: p.name,
            description: p.description,
            limits: p.limits,
            features: p.features,
            available: Boolean(p.purchasable && priceId && deps.billing.stripe),
            price:
              price && price.unitAmount !== null && price.interval
                ? { amount_minor: price.unitAmount, currency: price.currency, interval: price.interval }
                : null,
          };
        }),
      );
      return { items };
    },
  );

  app.post(
    '/orgs/:orgId/billing/checkout-session',
    {
      schema: {
        tags: ['billing'],
        description:
          'Starts the payment provider’s hosted checkout for a plan (owners). Refused while a subscription is live ' +
          '(ALREADY_SUBSCRIBED: change plans in the portal). Open the returned address in a browser; the ' +
          'subscription changes only when the provider confirms payment, never because of the redirect back.',
        params: OrgParams,
        body: CheckoutRequest,
        response: { 201: HostedSession, ...errors },
      },
    },
    async (req, reply) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'billing.manage');
      const stripe = stripeOf(deps);
      await hit(deps.pool, LIMITS.billingSessionPerOrg, access.orgId);
      const plan = latestPlan(req.body.plan_id);
      const price = plan ? deps.billing.prices[planKey(plan.id, plan.version)] : undefined;
      if (!plan?.purchasable || !price) {
        throw new ApiError('PLAN_NOT_AVAILABLE', 'This plan is not offered on this server', {
          plan_id: req.body.plan_id,
        });
      }
      const row = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{
          provider_customer_id: string | null;
          provider_subscription_id: string | null;
          provider_status: string | null;
          name: string;
          email: string | null;
        }>(
          `select s.provider_customer_id, s.provider_subscription_id, s.provider_status, o.name,
                  (select u.email from users u where u.id = $2 and u.email_verified) as email
             from subscriptions s join organizations o on o.id = s.org_id where s.org_id = $1`,
          [access.orgId, access.userId],
        );
        return rows[0];
      });
      if (!row) throw new ApiError('NOT_FOUND', 'Organization not found');
      if (row.provider_subscription_id && LIVE_STATUSES.includes(row.provider_status ?? '')) {
        throw new ApiError(
          'ALREADY_SUBSCRIBED',
          'A subscription is already live; use the billing portal to change it',
        );
      }
      let customer = row.provider_customer_id;
      try {
        if (customer) {
          // Never two paid subscriptions: an earlier checkout still open is expired first, and a subscription the
          // provider already has (the worker may not have applied it yet) sends the owner to the portal.
          await stripe.expireOpenCheckoutSessions(customer);
          const live = (await stripe.listSubscriptions(customer)).some((s) =>
            LIVE_STATUSES.includes(s.status),
          );
          if (live) {
            throw new ApiError(
              'ALREADY_SUBSCRIBED',
              'A subscription is already live; use the billing portal to change it',
            );
          }
        }
        if (!customer) {
          // The same idempotency key for every attempt: concurrent requests get the same customer back.
          const created = await stripe.createCustomer(
            { orgId: access.orgId, name: row.name, email: row.email },
            `pb-customer-${access.orgId}`,
          );
          customer = await withTx(deps.pool, access, async (c) => {
            await c.query(
              `update subscriptions set provider_customer_id = $2, provider = 'stripe', updated_at = now(),
                      version = version + 1
                where org_id = $1 and provider_customer_id is null`,
              [access.orgId, created],
            );
            const r = await c.query<{ id: string }>(
              'select provider_customer_id as id from subscriptions where org_id = $1',
              [access.orgId],
            );
            return r.rows[0]?.id ?? created;
          });
        }
        const session = await stripe.createCheckoutSession(
          {
            customer,
            price,
            orgId: access.orgId,
            successUrl: `${deps.billing.returnUrl}?result=success`,
            cancelUrl: `${deps.billing.returnUrl}?result=canceled`,
            automaticTax: deps.billing.automaticTax,
          },
          `pb-checkout-${newId('request')}`,
        );
        if (!session.url)
          throw new ApiError('BILLING_UNAVAILABLE', 'The payment provider returned no checkout page');
        await withTx(deps.pool, access, (c) =>
          audit(
            c,
            changeEntry(access, 'billing.checkout_started', 'organization', access.orgId, {
              plan: planKey(plan.id, plan.version),
            }),
          ),
        );
        return reply.status(201).send({
          url: session.url,
          expires_at: session.expiresAt ? new Date(session.expiresAt * 1000).toISOString() : null,
        });
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw billingFailure(err);
      }
    },
  );

  app.post(
    '/orgs/:orgId/billing/portal-session',
    {
      schema: {
        tags: ['billing'],
        description:
          'Opens the payment provider’s customer portal (owners): change plan, payment method, cancel, invoices. ' +
          'Changes made there reach this application through the provider’s webhooks.',
        params: OrgParams,
        response: { 201: HostedSession, ...errors },
      },
    },
    async (req, reply) => {
      requireInteractive(req.principal);
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'billing.manage');
      const stripe = stripeOf(deps);
      await hit(deps.pool, LIMITS.billingSessionPerOrg, access.orgId);
      const customer = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{ id: string | null }>(
          'select provider_customer_id as id from subscriptions where org_id = $1',
          [access.orgId],
        );
        return rows[0]?.id ?? null;
      });
      if (!customer) {
        throw new ApiError('PLAN_NOT_AVAILABLE', 'There is no billing account yet; choose a plan first', {
          reason: 'no_customer',
        });
      }
      try {
        const url = await stripe.createPortalSession({
          customer,
          returnUrl: `${deps.billing.returnUrl}?result=portal`,
          configuration: deps.billing.portalConfiguration,
        });
        await withTx(deps.pool, access, (c) =>
          audit(c, changeEntry(access, 'billing.portal_opened', 'organization', access.orgId)),
        );
        return reply.status(201).send({ url, expires_at: null });
      } catch (err) {
        throw billingFailure(err);
      }
    },
  );

  app.get(
    '/orgs/:orgId/billing/usage',
    {
      schema: {
        tags: ['billing'],
        description:
          'Usage in the current period from the usage ledger (idempotent events: committed backups, finished jobs, ' +
          'API-token requests; daily samples of storage, active profiles and seats) and the last 30 days by day.',
        params: OrgParams,
        response: { 200: BillingUsage, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'billing.read');
      return withTx(deps.pool, access, async (c) => {
        const e = await effectiveOf(c, access.orgId);
        const current = await usageOf(c, access.orgId);
        const period = await c.query<{ period_start: string; period_end: string }>(
          `select ${ts("coalesce(current_period_end - interval '1 month', date_trunc('month', now()))")} as period_start,
                  ${ts("coalesce(current_period_end, date_trunc('month', now()) + interval '1 month')")} as period_end
             from subscriptions where org_id = $1`,
          [access.orgId],
        );
        const p = period.rows[0];
        if (!p) throw new ApiError('NOT_FOUND', 'Organization not found');
        const SAMPLES = ['storage_bytes', 'active_profiles', 'seats'];
        const totals = await c.query<{ type: UsageType; quantity: number; events: number }>(
          `select type,
                  case when type = any($4::text[])
                       then (array_agg(quantity order by occurred_at desc))[1] else sum(quantity) end::float8 as quantity,
                  count(*)::int as events
             from usage_events where org_id = $1 and occurred_at >= $2 and occurred_at < $3
            group by type`,
          [access.orgId, p.period_start, p.period_end, SAMPLES],
        );
        const today = await c.query<{ n: number }>(
          "select coalesce(sum(requests), 0)::float8 as n from api_usage_daily where org_id = $1 and day = (now() at time zone 'UTC')::date",
          [access.orgId],
        );
        const byType = new Map(totals.rows.map((t) => [t.type, t]));
        const api = byType.get('api_requests');
        const liveApi = today.rows[0]?.n ?? 0;
        if (liveApi > 0) {
          byType.set('api_requests', {
            type: 'api_requests',
            quantity: (api?.quantity ?? 0) + liveApi,
            events: (api?.events ?? 0) + 1,
          });
        }
        const daily = await c.query<{ day: string; type: UsageType; quantity: number }>(
          `select to_char((occurred_at at time zone 'UTC')::date, 'YYYY-MM-DD') as day, type,
                  case when type = any($2::text[]) then max(quantity) else sum(quantity) end::float8 as quantity
             from usage_events where org_id = $1 and occurred_at >= now() - interval '30 days'
            group by 1, 2 order by 1, 2`,
          [access.orgId, SAMPLES],
        );
        return {
          period_start: p.period_start,
          period_end: p.period_end,
          current,
          limits: e.limits,
          totals: USAGE_TYPES.filter((t) => byType.has(t)).map(
            (t) => byType.get(t) as NonNullable<ReturnType<typeof byType.get>>,
          ),
          daily: daily.rows,
        };
      });
    },
  );

  app.get(
    '/orgs/:orgId/billing/invoices',
    {
      schema: {
        tags: ['billing'],
        description: 'Invoices and receipts mirrored from the payment provider (newest first, at most 24).',
        params: OrgParams,
        response: { 200: Invoices, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'billing.read');
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query(
          `select id, number, status, currency, amount_due::int as amount_due_minor,
                  amount_paid::int as amount_paid_minor, ${ts('provider_created_at')} as created_at,
                  ${ts('period_start')} as period_start, ${ts('period_end')} as period_end,
                  hosted_url is not null as has_hosted_page, pdf_url is not null as has_pdf
             from billing_invoices where org_id = $1 order by provider_created_at desc limit 24`,
          [access.orgId],
        );
        return { items: rows };
      });
    },
  );

  app.get(
    '/orgs/:orgId/billing/invoices/:invoiceId/links',
    {
      schema: {
        tags: ['billing'],
        description:
          'The provider-hosted invoice page and PDF of one invoice. The desktop opens them in the default browser ' +
          '(after checking the host); the manager window never receives them.',
        params: InvoiceParams,
        response: { 200: InvoiceLinks, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'billing.read');
      const row = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{ hosted_url: string | null; pdf_url: string | null }>(
          'select hosted_url, pdf_url from billing_invoices where org_id = $1 and id = $2',
          [access.orgId, req.params.invoiceId],
        );
        return rows[0];
      });
      if (!row) throw new ApiError('NOT_FOUND', 'Invoice not found');
      return { hosted_url: row.hosted_url, pdf_url: row.pdf_url };
    },
  );

  app.get(
    '/billing/return',
    {
      config: { public: true },
      schema: {
        tags: ['billing'],
        security: [],
        description:
          'Where checkout and the portal send the browser back. Informational only: a redirect never changes a ' +
          'subscription (the provider’s confirmation does).',
        querystring: Type.Object(
          {
            result: Type.Optional(
              Type.Union([Type.Literal('success'), Type.Literal('canceled'), Type.Literal('portal')]),
            ),
          },
          { additionalProperties: true },
        ),
      },
    },
    async (req, reply) => {
      const result = (req.query as { result?: string }).result;
      const line =
        result === 'success'
          ? 'Thank you. Your subscription updates in Project Browser as soon as the payment provider confirms the payment (usually within a minute).'
          : result === 'canceled'
            ? 'Checkout was canceled. Nothing was charged.'
            : 'You can close this page and return to Project Browser.';
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        )
        .header('referrer-policy', 'no-referrer')
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Browser billing</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 16px;color:#1d2433;background:#fff}@media (prefers-color-scheme:dark){body{color:#e6e9ef;background:#14171d}}</style></head><body><h1>Project Browser</h1><p>${line}</p><p>You can close this page.</p></body></html>`,
        );
    },
  );

  // ---------------------------------------------------------------- the provider's webhook (raw body)
  app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) =>
      done(null, body),
    );
    raw.post(
      '/webhooks/billing',
      {
        config: { public: true },
        schema: {
          tags: ['billing'],
          security: [],
          description:
            'Payment provider webhook (provider-authenticated: `Stripe-Signature` over the exact raw body, 5-minute ' +
            'tolerance). Each event id is recorded once (a duplicate answers 200 and changes nothing); no payload is ' +
            'stored. The worker then fetches the current object from the provider and applies it.',
          response: {
            200: Type.Object(
              { received: Type.Boolean(), duplicate: Type.Boolean() },
              { additionalProperties: false },
            ),
            ...errors,
          },
        },
      },
      async (req) => {
        await hit(deps.pool, LIMITS.billingWebhookPerIp, req.ip);
        if (deps.billing.webhookSecrets.length === 0) {
          throw new ApiError('BILLING_UNAVAILABLE', 'Billing is not configured on this server');
        }
        const body = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
        const header = req.headers['stripe-signature'];
        const check = verifyStripeSignature(
          body,
          typeof header === 'string' ? header : undefined,
          deps.billing.webhookSecrets,
        );
        if (!check.ok) {
          await withTx(deps.pool, { orgId: null, userId: null }, async (c) => {
            await c.query(
              `insert into platform_audit (id, action, details, request_id) values ($1, 'billing.webhook_refused', $2, $3)`,
              [newId('audit'), JSON.stringify({ reason: check.reason }), req.id],
            );
            await c.query(
              `insert into billing_alerts (id, kind, org_id, ref, detail) values ($1, 'signature_failures', null, null, $2)
               on conflict (kind, coalesce(org_id, ''), coalesce(ref, '')) where resolved_at is null
               do update set last_seen_at = now(), count = billing_alerts.count + 1, detail = excluded.detail`,
              [newId('billingAlert'), `Webhook signature refused (${check.reason})`],
            );
          }).catch(() => undefined);
          throw new ApiError('VALIDATION_FAILED', 'Webhook signature could not be verified', {
            reason: check.reason,
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          throw new ApiError('VALIDATION_FAILED', 'Malformed event');
        }
        const ev = parseEventEnvelope(parsed);
        if (!ev) throw new ApiError('VALIDATION_FAILED', 'Malformed event');
        if (ev.livemode !== deps.billing.livemode) {
          throw new ApiError('VALIDATION_FAILED', 'Event mode does not match this server', {
            reason: 'livemode',
          });
        }
        const handled = HANDLED.some((r) => r.test(ev.type));
        const inserted = await withTx(deps.pool, { orgId: null, userId: null }, (c) =>
          c.query(
            `insert into billing_webhook_events (provider_event_id, type, object_type, object_id, livemode,
                                                 provider_created_at, status, processed_at)
             values ($1, $2, $3, $4, $5, to_timestamp($6), $7, case when $7 = 'ignored' then now() end)
             on conflict (provider_event_id) do nothing`,
            [
              ev.id,
              ev.type,
              ev.objectType,
              ev.objectId,
              ev.livemode,
              ev.created,
              handled ? 'pending' : 'ignored',
            ],
          ),
        );
        return { received: true, duplicate: inserted.rowCount === 0 };
      },
    );
  });
}
