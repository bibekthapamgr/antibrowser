/**
 * R5 (ADR-0024): business-owner administration, for platform staff in the console (/v1/admin).
 *
 * - Namespace is not authority: every route names the staff permission it needs (STAFF_ROLE_PERMISSIONS), checks it
 *   here AND in the database (each cross-workspace reader calls app.staff_require), and needs a console session
 *   opened with a second factor. Workspace owners, customer tokens and portal cookies never reach these routes.
 * - Global customer browsing is for the business roles only and every list or view is written to the platform audit.
 *   Member names and addresses still need the milestone 11 time-bound approval (/v1/support). Customer session data,
 *   credentials, cookies and screenshots are not reachable through any route.
 * - Restrictions are recorded with reason, scope and expiry; payment restrictions narrow billing like an unpaid
 *   workspace; security suspensions stop all access, end sessions and fence open profiles. Nothing is deleted.
 * - Plans are edited as drafts and published as new immutable versions (src/admin/publish.ts).
 */
import {
  AdminCatalog,
  AdminCustomerDetail,
  AdminCustomers,
  AdminCustomersQuery,
  AdminMe,
  AdminMetrics,
  AdminOperations,
  AdminStaff,
  ApiError,
  BILLING_STATES,
  type BillingState,
  CatalogPublication,
  isId,
  newId,
  PlanDraft,
  PlanDraftCreate,
  PlanDraftPublish,
  PlanDraftUpdate,
  ReleaseActionRequest,
  Restriction,
  RestrictionCreate,
  RestrictionLift,
  STAFF_PERMISSION_MAPPING_VERSION,
  STAFF_PERMISSIONS,
  STAFF_ROLE_PERMISSIONS,
  STAFF_ROLES,
  type StaffPermission,
  SupportNote,
  SupportNoteCreate,
  staffCan,
} from '@pb/contracts';
import type pg from 'pg';
import Type from 'typebox';
import {
  draftSeed,
  PUBLICATION_COLUMNS,
  platformAudit,
  publishDraft,
  validateDraft,
} from '../admin/publish.ts';
import { redactNote } from '../admin/redact.ts';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit } from '../audit.ts';
import type { Principal } from '../auth.ts';
import { invalidateCatalog, newestPlan, readCatalog } from '../billing/catalog.ts';
import { effectiveOf, usageOf } from '../billing/state.ts';
import { ts, withTx } from '../db.ts';
import { enqueueEmail } from '../email.ts';
import { endLease } from '../sessions.ts';
import { errors, OrgParams } from './common.ts';

type StaffPrincipal = Principal & { staff: NonNullable<Principal['staff']> };

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new ApiError('INTERNAL', 'Not saved');
  return row;
}

/** The staff member, if their roles include the permission and the session used a second factor. */
function adminOf(req: { principal: Principal | null }, permission: StaffPermission): StaffPrincipal {
  const p = principalOf(req);
  if (p.kind !== 'staff' || !p.staff) throw new ApiError('UNAUTHENTICATED', 'Sign in to the console');
  if (!staffCan(p.staff.roles, permission)) {
    throw new ApiError('FORBIDDEN', 'Your staff role does not allow this', { permission });
  }
  if (!p.staff.mfa) throw new ApiError('MFA_REQUIRED', 'Sign in again with your one-time code to use this');
  return p as StaffPrincipal;
}

const staffCtx = (p: StaffPrincipal, orgId: string | null = null) => ({ orgId, userId: p.userId });
const who = (p: StaffPrincipal, requestId: string) => ({ userId: p.userId, requestId });

const IdParam = (prefix: 'pld' | 'rst' | 'eml') =>
  Type.Object(
    { id: Type.String({ pattern: `^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$` }) },
    { additionalProperties: false },
  );

const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt = '', id = ''] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!isId('organization', id) || Number.isNaN(Date.parse(createdAt))) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid cursor', { field: 'cursor' });
  }
  return { createdAt, id };
}

const RESTRICTION_COLUMNS = `r.id, r.kind, r.scope, r.org_id, r.user_id, r.reason, r.created_by,
  ${ts('r.created_at')} as created_at, ${ts('r.expires_at')} as expires_at, ${ts('r.lifted_at')} as lifted_at,
  r.lifted_by, r.notified, (r.lifted_at is null and (r.expires_at is null or r.expires_at > now())) as active`;

const NOTE_COLUMNS = `n.id, n.org_id, n.author_user_id,
  coalesce(app.staff_display_name(n.author_user_id), 'Staff') as author_name, n.body, n.redacted,
  ${ts('n.created_at')} as created_at`;

const DRAFT_COLUMNS = `d.id, d.plan_id, d.base_version, d.name, d.description, d.purchasable, d.limits, d.features,
  d.prices, d.state, d.revision, d.published_version, d.last_error, d.created_by, ${ts('d.created_at')} as created_at,
  ${ts('d.updated_at')} as updated_at`;

interface CustomerRow {
  id: string;
  name: string;
  created_at: string;
  plan_id: string;
  plan_version: number;
  plan_name: string;
  state: BillingState;
  member_count: string;
  profile_count: string;
  owner_email: string | null;
  last_active_at: string | null;
  suspended: boolean;
  restricted: boolean;
}

async function customersPage(
  c: pg.PoolClient,
  q: {
    q?: string | undefined;
    state?: string | undefined;
    plan?: string | undefined;
    after?: { createdAt: string; id: string } | null;
    limit: number;
    contact: boolean;
  },
): Promise<CustomerRow[]> {
  const { rows } = await c.query<CustomerRow>(
    `select id, name, ${ts('created_at')} as created_at, plan_id, plan_version, plan_name, state,
            member_count::text, profile_count::text, owner_email, ${ts('last_active_at')} as last_active_at,
            suspended, restricted
       from app.admin_customers($1, $2, $3, $4, $5, $6, $7)`,
    [
      q.q ?? null,
      q.state ?? null,
      q.plan ?? null,
      q.after?.createdAt ?? null,
      q.after?.id ?? null,
      q.limit,
      q.contact,
    ],
  );
  return rows;
}

const customerOf = (r: CustomerRow) => ({
  id: r.id,
  name: r.name,
  created_at: r.created_at,
  plan_id: r.plan_id,
  plan_version: r.plan_version,
  plan_name: r.plan_name,
  state: (BILLING_STATES as readonly string[]).includes(r.state) ? r.state : ('restricted' as const),
  member_count: Number(r.member_count),
  profile_count: Number(r.profile_count),
  owner_email: r.owner_email,
  last_active_at: r.last_active_at,
  suspended: r.suspended,
  restricted: r.restricted,
});

export function adminRoutes(app: App, deps: Deps): void {
  const tags = ['admin'];

  // ---------------------------------------------------------------- who am I
  app.get(
    '/admin/me',
    {
      config: { staff: true },
      schema: {
        tags,
        description: 'The signed-in staff member’s roles and permissions, and whether this session used MFA.',
        response: { 200: AdminMe, ...errors },
      },
    },
    async (req) => {
      const p = principalOf(req);
      if (p.kind !== 'staff' || !p.staff) throw new ApiError('UNAUTHENTICATED', 'Sign in to the console');
      const roles = p.staff.roles;
      return {
        roles,
        permissions: STAFF_PERMISSIONS.filter((perm) => staffCan(roles, perm)),
        mfa: p.staff.mfa,
      };
    },
  );

  // ---------------------------------------------------------------- dashboard
  app.get(
    '/admin/metrics',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Dashboard numbers (admin.metrics.read): workspaces by billing state, monthly recurring revenue per ' +
          'currency (never converted), cash collected and refunds in the last 30 days, open alerts, data freshness ' +
          'and known reconciliation gaps.',
        response: { 200: AdminMetrics, ...errors },
      },
    },
    async (req) => {
      const p = adminOf(req, 'admin.metrics.read');
      return withTx(deps.pool, staffCtx(p), async (c) => {
        const counts = await c.query<{
          state: BillingState;
          total: string;
          paying: string;
          complimentary: string;
          new_30d: string;
        }>(
          'select state, total::text, paying::text, complimentary::text, new_30d::text from app.admin_state_counts()',
        );
        const byState = Object.fromEntries(BILLING_STATES.map((s) => [s, 0])) as Record<BillingState, number>;
        let total = 0;
        let paying = 0;
        let complimentary = 0;
        let fresh = 0;
        for (const r of counts.rows) {
          if ((BILLING_STATES as readonly string[]).includes(r.state)) byState[r.state] += Number(r.total);
          total += Number(r.total);
          paying += Number(r.paying);
          complimentary += Number(r.complimentary);
          fresh += Number(r.new_30d);
        }
        const mrrRows = await c.query<{
          currency: string;
          bucket: 'active' | 'at_risk';
          canceling: boolean;
          amount: string;
          subscriptions: string;
        }>('select currency, bucket, canceling, amount::text, subscriptions::text from app.admin_mrr()');
        const mrr = new Map<
          string,
          {
            currency: string;
            amount_minor: number;
            subscriptions: number;
            canceling_amount_minor: number;
            at_risk_amount_minor: number;
          }
        >();
        for (const r of mrrRows.rows) {
          const m = mrr.get(r.currency) ?? {
            currency: r.currency,
            amount_minor: 0,
            subscriptions: 0,
            canceling_amount_minor: 0,
            at_risk_amount_minor: 0,
          };
          const amount = Number(r.amount);
          if (r.bucket === 'active') {
            m.amount_minor += amount;
            m.subscriptions += Number(r.subscriptions);
            if (r.canceling) m.canceling_amount_minor += amount;
          } else {
            m.at_risk_amount_minor += amount;
          }
          mrr.set(r.currency, m);
        }
        const cash = await c.query<{ kind: 'paid' | 'refunded'; currency: string; amount: string }>(
          'select kind, currency, amount::text from app.admin_cash(30)',
        );
        const gaps = await c.query<{
          live_without_price: string;
          tax_inclusive: string;
          oldest_sync: string | null;
        }>(
          `select live_without_price::text, tax_inclusive::text, ${ts('oldest_sync')} as oldest_sync
             from app.admin_billing_gaps()`,
        );
        const alerts = await c.query<{ kind: string; n: string }>(
          'select kind, count(*)::text as n from billing_alerts where resolved_at is null group by kind',
        );
        const hooks = await c.query<{ pending: string; failed: string; last: string | null }>(
          `select count(*) filter (where status = 'pending')::text as pending,
                  count(*) filter (where status = 'failed')::text as failed,
                  ${ts("max(processed_at) filter (where status in ('processed', 'ignored'))")} as last
             from billing_webhook_events`,
        );
        const g = gaps.rows[0];
        const h = hooks.rows[0];
        const gapText: string[] = [];
        if (g && Number(g.live_without_price) > 0) {
          gapText.push(
            `${g.live_without_price} live subscription(s) have no price details yet (counted after their next provider sync).`,
          );
        }
        if (g && Number(g.tax_inclusive) > 0) {
          gapText.push(
            `${g.tax_inclusive} subscription(s) use tax-inclusive prices: their amounts include tax.`,
          );
        }
        gapText.push(
          'Discounts, credits and one-time items are not applied to recurring revenue (list prices).',
        );
        if (h && Number(h.pending) > 0)
          gapText.push(`${h.pending} provider event(s) are waiting to be applied.`);
        if (h && Number(h.failed) > 0) gapText.push(`${h.failed} provider event(s) failed; see Operations.`);
        const byKind = Object.fromEntries(alerts.rows.map((r) => [r.kind, Number(r.n)]));
        await platformAudit(c, who(p, req.id), 'admin.metrics_viewed', null);
        return {
          generated_at: new Date().toISOString(),
          workspaces: {
            total,
            active_customers: byState.trial + byState.active + byState.past_due + byState.grace,
            by_state: byState,
            paying,
            complimentary,
            new_last_30_days: fresh,
          },
          mrr: [...mrr.values()]
            .map((m) => ({
              ...m,
              amount_minor: Math.round(m.amount_minor),
              canceling_amount_minor: Math.round(m.canceling_amount_minor),
              at_risk_amount_minor: Math.round(m.at_risk_amount_minor),
            }))
            .sort((a, b) => a.currency.localeCompare(b.currency)),
          cash_collected_30d: cash.rows
            .filter((r) => r.kind === 'paid')
            .map((r) => ({ currency: r.currency, amount_minor: Number(r.amount) })),
          refunds_30d: cash.rows
            .filter((r) => r.kind === 'refunded')
            .map((r) => ({ currency: r.currency, amount_minor: Number(r.amount) })),
          alerts: { open: Object.values(byKind).reduce((a, b) => a + b, 0), by_kind: byKind },
          freshness: {
            oldest_subscription_sync: g?.oldest_sync ?? null,
            last_webhook_processed: h?.last ?? null,
            webhooks_pending: Number(h?.pending ?? 0),
            webhooks_failed: Number(h?.failed ?? 0),
          },
          gaps: gapText,
        };
      });
    },
  );

  // ---------------------------------------------------------------- customers
  app.get(
    '/admin/customers',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Customer workspaces, newest first, 1-100 per page (admin.customers.read). `q`: an organization id, a ' +
          'provider customer id, an owner’s exact e-mail address or the start of a name. Owner addresses are masked ' +
          'without admin.customers.contact. Every page is recorded in the platform audit.',
        querystring: AdminCustomersQuery,
        response: { 200: AdminCustomers, ...errors },
      },
    },
    async (req) => {
      const p = adminOf(req, 'admin.customers.read');
      const contact = staffCan(p.staff.roles, 'admin.customers.contact');
      const limit = req.query.limit ?? 50;
      const after = req.query.cursor ? decodeCursor(req.query.cursor) : null;
      return withTx(deps.pool, staffCtx(p), async (c) => {
        const rows = await customersPage(c, {
          q: req.query.q,
          state: req.query.state,
          plan: req.query.plan,
          after,
          limit: limit + 1,
          contact,
        });
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const q = req.query.q?.includes('@') ? maskEmail(req.query.q) : (req.query.q ?? null);
        await platformAudit(c, who(p, req.id), 'admin.customers_listed', null, {
          q,
          state: req.query.state ?? null,
          plan: req.query.plan ?? null,
          count: page.length,
          contact,
        });
        return {
          items: page.map(customerOf),
          next_cursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
        };
      });
    },
  );

  app.get(
    '/admin/customers/:orgId',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'A customer’s business detail (admin.customers.read): live billing state and price, usage, members by ' +
          'role, signed-in computers by platform, invoices, provider events, restrictions, case notes (with ' +
          'admin.notes.read) and platform audit entries. Recorded in the platform audit and the workspace’s own ' +
          'activity log.',
        params: OrgParams,
        response: { 200: AdminCustomerDetail, ...errors },
      },
    },
    async (req) => {
      const p = adminOf(req, 'admin.customers.read');
      const orgId = req.params.orgId;
      const contact = staffCan(p.staff.roles, 'admin.customers.contact');
      return withTx(deps.pool, staffCtx(p, orgId), async (c) => {
        const listed = await customersPage(c, { q: orgId, limit: 1, contact });
        const row = listed[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Customer not found');
        const eff = await effectiveOf(c, orgId);
        const usage = await usageOf(c, orgId);
        const sub = await c.query<{
          provider_customer_id: string | null;
          provider_subscription_id: string | null;
          price_currency: string | null;
          price_amount_minor: string | null;
          price_interval: string | null;
          price_interval_count: number | null;
          price_quantity: number | null;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          synced_at: string | null;
        }>(
          `select provider_customer_id, provider_subscription_id, price_currency, price_amount_minor::text,
                  price_interval, price_interval_count, price_quantity, ${ts('current_period_end')} as current_period_end,
                  cancel_at_period_end, ${ts('synced_at')} as synced_at
             from subscriptions where org_id = $1`,
          [orgId],
        );
        const s = sub.rows[0];
        const people = await c.query<{ kind: string; key: string; n: string }>(
          'select kind, key, n::text from app.admin_customer_people($1)',
          [orgId],
        );
        const invoices = await c.query<{
          id: string;
          number: string | null;
          status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
          currency: string;
          amount_due: string;
          amount_paid: string;
          created_at: string;
        }>(
          `select id, number, status, currency, amount_due::text, amount_paid::text,
                  ${ts('provider_created_at')} as created_at
             from billing_invoices where org_id = $1 order by provider_created_at desc limit 24`,
          [orgId],
        );
        const events = await c.query<{
          provider_event_id: string;
          type: string;
          status: string;
          received_at: string;
          error: string | null;
        }>(
          `select provider_event_id, type, status, ${ts('received_at')} as received_at, error
             from billing_webhook_events where org_id = $1 order by received_at desc limit 30`,
          [orgId],
        );
        const restrictions = await c.query<Restriction>(
          `select ${RESTRICTION_COLUMNS} from account_restrictions r
            where r.org_id = $1 order by r.created_at desc limit 50`,
          [orgId],
        );
        const notes = staffCan(p.staff.roles, 'admin.notes.read')
          ? (
              await c.query<SupportNote>(
                `select ${NOTE_COLUMNS} from support_notes n
                  where n.org_id = $1 order by n.created_at desc limit 100`,
                [orgId],
              )
            ).rows
          : [];
        const auditRows = await c.query<{
          at: string;
          action: string;
          actor_user_id: string | null;
          target: string | null;
        }>(
          `select ${ts('at')} as at, action, actor_user_id, target from platform_audit
            where org_id = $1 order by at desc limit 50`,
          [orgId],
        );
        await platformAudit(c, who(p, req.id), 'admin.customer_viewed', null, {}, orgId);
        await audit(c, {
          orgId,
          actorUserId: p.userId,
          actorDeviceId: null,
          action: 'support.viewed_overview',
          targetType: 'organization',
          targetId: orgId,
          outcome: 'success',
          requestId: req.id,
          details: { by: 'support', console: 'admin' },
        });
        const roles: Record<string, number> = {};
        const platforms: Record<string, number> = {};
        for (const r of people.rows) {
          if (r.kind === 'role') roles[r.key] = Number(r.n);
          else platforms[r.key] = Number(r.n);
        }
        return {
          customer: customerOf(row),
          billing: {
            state: eff.state,
            reason: eff.reason,
            until: eff.until,
            plan_id: eff.planId,
            plan_version: eff.planVersion,
            plan_name: eff.planName,
            limits: eff.limits,
            features: eff.features,
            provider_customer_id: s?.provider_customer_id ?? null,
            provider_subscription_id: s?.provider_subscription_id ?? null,
            price:
              s?.price_currency && s.price_amount_minor && s.price_interval
                ? {
                    currency: s.price_currency,
                    amount_minor: Number(s.price_amount_minor),
                    interval: s.price_interval,
                    interval_count: s.price_interval_count ?? 1,
                    quantity: Math.max(1, s.price_quantity ?? 1),
                  }
                : null,
            current_period_end: s?.current_period_end ?? null,
            cancel_at_period_end: s?.cancel_at_period_end ?? false,
            synced_at: s?.synced_at ?? null,
          },
          usage: { profiles: usage.profiles, seats: usage.seats, storage_bytes: usage.storage_bytes },
          members_by_role: roles,
          devices: {
            active: Object.values(platforms).reduce((a, b) => a + b, 0),
            by_platform: platforms,
          },
          invoices: invoices.rows.map((i) => ({
            id: i.id,
            number: i.number,
            status: i.status,
            currency: i.currency,
            amount_due_minor: Number(i.amount_due),
            amount_paid_minor: Number(i.amount_paid),
            created_at: i.created_at,
          })),
          events: events.rows,
          restrictions: restrictions.rows,
          notes,
          audit: auditRows.rows,
        };
      });
    },
  );

  app.post(
    '/admin/customers/:orgId/notes',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Adds a support-case note (admin.notes.write). Card numbers, passwords, keys and tokens are replaced with ' +
          '[redacted] before it is stored; `redacted` says whether that happened.',
        params: OrgParams,
        body: SupportNoteCreate,
        response: { 201: SupportNote, ...errors },
      },
    },
    async (req, reply) => {
      const p = adminOf(req, 'admin.notes.write');
      const { text, redacted } = redactNote(req.body.body);
      if (text.trim().length === 0)
        throw new ApiError('VALIDATION_FAILED', 'The note is empty', { field: 'body' });
      const note = await withTx(deps.pool, staffCtx(p, req.params.orgId), async (c) => {
        const exists = await c.query('select 1 from organizations where id = $1', [req.params.orgId]);
        if (!exists.rowCount) throw new ApiError('NOT_FOUND', 'Customer not found');
        const id = newId('supportNote');
        await c.query(
          'insert into support_notes (id, org_id, author_user_id, body, redacted) values ($1, $2, $3, $4, $5)',
          [id, req.params.orgId, p.userId, text, redacted],
        );
        await platformAudit(c, who(p, req.id), 'admin.note_added', id, { redacted }, req.params.orgId);
        const { rows } = await c.query<SupportNote>(
          `select ${NOTE_COLUMNS} from support_notes n where n.id = $1`,
          [id],
        );
        return one(rows);
      });
      return reply.status(201).send(note);
    },
  );

  app.post(
    '/admin/customers/:orgId/resync',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Asks the worker to confirm this customer’s subscription with the provider now (admin.operations.act).',
        params: OrgParams,
        response: { 202: Type.Object({ queued: Type.Boolean() }), ...errors },
      },
    },
    async (req, reply) => {
      const p = adminOf(req, 'admin.operations.act');
      const queued = await withTx(deps.pool, staffCtx(p, req.params.orgId), async (c) => {
        const r = await c.query<{ ok: boolean | null }>('select app.billing_request_resync($1) as ok', [
          req.params.orgId,
        ]);
        await platformAudit(c, who(p, req.id), 'admin.resync_requested', null, {}, req.params.orgId);
        return r.rows[0]?.ok === true;
      });
      return reply.status(202).send({ queued });
    },
  );

  // ---------------------------------------------------------------- restrictions
  app.post(
    '/admin/restrictions',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Restricts a workspace or suspends an account (payment: admin.restrictions.payment; security: ' +
          'admin.restrictions.security), with a reason (20-500 characters), an optional expiry (≤ 366 days) and an ' +
          'e-mail to the owners (or the account). A security suspension ends open profiles (fenced), API tokens and, ' +
          'for an account, every session. Nothing is deleted.',
        body: RestrictionCreate,
        response: { 201: Restriction, ...errors },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const p = adminOf(
        req,
        b.kind === 'security' ? 'admin.restrictions.security' : 'admin.restrictions.payment',
      );
      if (b.scope === 'workspace' && !b.org_id) {
        throw new ApiError('VALIDATION_FAILED', 'A workspace restriction names the workspace', {
          field: 'org_id',
        });
      }
      if (b.scope === 'account' && (b.kind !== 'security' || !b.user_id)) {
        throw new ApiError('VALIDATION_FAILED', 'An account can only be suspended for security, by user id', {
          field: 'user_id',
        });
      }
      if (b.expires_at) {
        const at = Date.parse(b.expires_at);
        if (!(at > Date.now() + 60_000) || at > Date.now() + 365 * 86_400_000) {
          throw new ApiError('VALIDATION_FAILED', 'The expiry must be between a minute and 365 days ahead', {
            field: 'expires_at',
          });
        }
      }
      if (b.user_id && b.user_id === p.userId) {
        throw new ApiError('FORBIDDEN', 'You cannot suspend your own account');
      }
      const id = newId('restriction');
      const orgId = b.org_id ?? null;
      const restriction = await withTx(deps.pool, staffCtx(p, orgId), async (c) => {
        if (orgId) {
          const exists = await c.query('select 1 from organizations where id = $1', [orgId]);
          if (!exists.rowCount) throw new ApiError('NOT_FOUND', 'Customer not found');
        }
        if (b.scope === 'account' && b.user_id) {
          if (orgId) {
            const m = await c.query<{ ok: boolean }>('select app.admin_member_of($1, $2) as ok', [
              orgId,
              b.user_id,
            ]);
            if (!m.rows[0]?.ok)
              throw new ApiError('NOT_FOUND', 'That account is not a member of this workspace');
          }
          const staffTarget = await c.query(
            'select 1 from platform_staff where user_id = $1 and disabled_at is null',
            [b.user_id],
          );
          if (staffTarget.rowCount) {
            throw new ApiError(
              'FORBIDDEN',
              'Staff accounts are removed on the server (staff.ts), not suspended here',
            );
          }
        }
        await c.query(
          `insert into account_restrictions (id, kind, scope, org_id, user_id, reason, created_by, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            b.kind,
            b.scope,
            orgId,
            b.scope === 'account' ? b.user_id : null,
            b.reason,
            p.userId,
            b.expires_at ?? null,
          ],
        );
        let ended = 0;
        if (b.kind === 'security' && b.scope === 'workspace' && orgId) {
          await c.query(
            'update organizations set suspended_at = coalesce(suspended_at, now()) where id = $1',
            [orgId],
          );
          const open = await c.query<{ profile_id: string }>(
            "select profile_id from profile_leases where org_id = $1 and state = 'active'",
            [orgId],
          );
          const access = { orgId, userId: p.userId, deviceId: null, requestId: req.id };
          for (const l of open.rows) {
            if (await endLease(c, access, l.profile_id, 'revoked', 'workspace_suspended')) ended++;
          }
          await c.query('update api_tokens set revoked_at = now() where org_id = $1 and revoked_at is null', [
            orgId,
          ]);
        }
        if (b.kind === 'security' && b.scope === 'account' && b.user_id) {
          const r = await c.query<{ n: number }>(
            'select app.admin_set_account_suspended($1, true, $2) as n',
            [b.user_id, p.userId],
          );
          ended = r.rows[0]?.n ?? 0;
        }
        const notified =
          b.notify === false ? false : await notifyRestriction(c, deps, id, b, orgId, 'applied');
        if (notified) await c.query('update account_restrictions set notified = true where id = $1', [id]);
        await platformAudit(
          c,
          who(p, req.id),
          `admin.restriction_${b.kind}_applied`,
          id,
          {
            scope: b.scope,
            user: b.user_id ?? null,
            expires_at: b.expires_at ?? null,
            ended_profiles: ended,
            notified,
          },
          orgId,
        );
        if (orgId) {
          await audit(c, {
            orgId,
            actorUserId: p.userId,
            actorDeviceId: null,
            action: b.kind === 'security' ? 'support.suspended' : 'support.restricted',
            targetType: 'organization',
            targetId: orgId,
            outcome: 'success',
            requestId: req.id,
            details: { by: 'support', restriction: id, scope: b.scope },
          });
        }
        const { rows } = await c.query<Restriction>(
          `select ${RESTRICTION_COLUMNS} from account_restrictions r where r.id = $1`,
          [id],
        );
        return one(rows);
      });
      return reply.status(201).send(restriction);
    },
  );

  app.post(
    '/admin/restrictions/:id/lift',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Lifts a restriction (same permission as applying it), with a reason; the owners (or the account) are told.',
        params: IdParam('rst'),
        body: RestrictionLift,
        response: { 200: Restriction, ...errors },
      },
    },
    async (req) => {
      const base = principalOf(req);
      if (base.kind !== 'staff') throw new ApiError('UNAUTHENTICATED', 'Sign in to the console');
      const found = await withTx(deps.pool, { orgId: null, userId: base.userId }, (c) =>
        c.query<{ kind: 'payment' | 'security'; org_id: string | null }>(
          'select kind, org_id from account_restrictions where id = $1',
          [req.params.id],
        ),
      );
      const r0 = found.rows[0];
      if (!r0) throw new ApiError('NOT_FOUND', 'Restriction not found');
      const p = adminOf(
        req,
        r0.kind === 'security' ? 'admin.restrictions.security' : 'admin.restrictions.payment',
      );
      return withTx(deps.pool, staffCtx(p, r0.org_id), async (c) => {
        const { rows } = await c.query<{
          kind: 'payment' | 'security';
          scope: 'workspace' | 'account';
          org_id: string | null;
          user_id: string | null;
        }>(
          `update account_restrictions set lifted_at = now(), lifted_by = $2, lift_reason = $3
            where id = $1 and lifted_at is null returning kind, scope, org_id, user_id`,
          [req.params.id, p.userId, req.body.reason],
        );
        const r = rows[0];
        if (!r) throw new ApiError('VERSION_CONFLICT', 'This restriction was already lifted');
        if (r.kind === 'security' && r.scope === 'workspace' && r.org_id) {
          const other = await c.query(
            `select 1 from account_restrictions where org_id = $1 and kind = 'security' and scope = 'workspace'
                and lifted_at is null and (expires_at is null or expires_at > now())`,
            [r.org_id],
          );
          if (!other.rowCount)
            await c.query('update organizations set suspended_at = null where id = $1', [r.org_id]);
        }
        if (r.kind === 'security' && r.scope === 'account' && r.user_id) {
          await c.query('select app.admin_set_account_suspended($1, false, $2)', [r.user_id, p.userId]);
        }
        await notifyRestriction(
          c,
          deps,
          req.params.id,
          { kind: r.kind, scope: r.scope, user_id: r.user_id ?? undefined },
          r.org_id,
          'lifted',
        );
        await platformAudit(
          c,
          who(p, req.id),
          `admin.restriction_${r.kind}_lifted`,
          req.params.id,
          {},
          r.org_id,
        );
        const out = await c.query<Restriction>(
          `select ${RESTRICTION_COLUMNS} from account_restrictions r where r.id = $1`,
          [req.params.id],
        );
        return one(out.rows);
      });
    },
  );

  // ---------------------------------------------------------------- catalog
  const catalogView = async (c: pg.PoolClient) => {
    const cat = await readCatalog(c);
    const subs = await c.query<{ plan_id: string; plan_version: number; n: string }>(
      'select plan_id, plan_version, n::text from app.admin_plan_subscribers()',
    );
    const drafts = await c.query<PlanDraft>(
      `select ${DRAFT_COLUMNS} from plan_drafts d where d.state in ('draft', 'publishing')
        order by d.updated_at desc limit 50`,
    );
    const pubs = await c.query<CatalogPublication>(
      `select ${PUBLICATION_COLUMNS} from catalog_publications p order by p.started_at desc limit 30`,
    );
    return {
      generation: cat.generation,
      provider: Boolean(deps.billing.provider),
      plans: cat.plans
        .map((pl) => ({
          id: pl.id,
          version: pl.version,
          name: pl.name,
          description: pl.description,
          purchasable: pl.purchasable,
          trial_days: pl.trialDays,
          limits: pl.limits,
          features: pl.features,
          source: pl.source,
          current: newestPlan(cat, pl.id)?.version === pl.version,
          prices: cat.prices
            .filter((x) => x.planId === pl.id && x.planVersion === pl.version)
            .map((x) => ({
              interval: x.interval,
              currency: x.currency,
              amount_minor: x.amountMinor,
              provider_price_id: x.providerPriceId,
            })),
          subscribers: Number(
            subs.rows.find((s) => s.plan_id === pl.id && s.plan_version === pl.version)?.n ?? 0,
          ),
          published_at: pl.publishedAt,
          published_by: pl.publishedBy,
        }))
        .sort((a, b) => a.id.localeCompare(b.id) || b.version - a.version),
      drafts: drafts.rows,
      publications: pubs.rows,
    };
  };

  app.get(
    '/admin/catalog',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Published plan versions (with their immutable provider prices and subscriber counts), open drafts and ' +
          'recent publications (admin.catalog.read).',
        response: { 200: AdminCatalog, ...errors },
      },
    },
    async (req) => {
      const p = adminOf(req, 'admin.catalog.read');
      return withTx(deps.pool, staffCtx(p), (c) => catalogView(c));
    },
  );

  app.post(
    '/admin/plan-drafts',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Starts a draft for a new version of a plan (admin.catalog.edit), prefilled from its newest published ' +
          'version with `from_published`, or a new plan id with all fields given. Nothing changes for customers ' +
          'until the draft is published.',
        body: PlanDraftCreate,
        response: { 201: PlanDraft, ...errors },
      },
    },
    async (req, reply) => {
      const p = adminOf(req, 'admin.catalog.edit');
      const b = req.body;
      const seed = await draftSeed(deps, b.plan_id);
      const fromBase = b.from_published !== false && seed;
      const name = b.name ?? (fromBase ? seed.base.name : undefined);
      const limits = b.limits ?? (fromBase ? seed.base.limits : undefined);
      const features = b.features ?? (fromBase ? seed.base.features : undefined);
      if (!name || !limits || !features) {
        throw new ApiError('VALIDATION_FAILED', 'A new plan needs a name, limits and features', {
          field: 'name',
        });
      }
      const draft = {
        name,
        description: b.description ?? (fromBase ? seed.base.description : ''),
        purchasable: b.purchasable ?? (fromBase ? seed.base.purchasable : false),
        limits,
        features,
        prices: b.prices ?? (fromBase ? seed.prices : []),
      };
      const row = await withTx(deps.pool, staffCtx(p), async (c) => {
        const id = newId('planDraft');
        await c.query(
          `insert into plan_drafts (id, plan_id, base_version, name, description, purchasable, limits, features,
                                    prices, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            b.plan_id,
            seed ? seed.base.version : null,
            draft.name,
            draft.description,
            draft.purchasable,
            draft.limits,
            draft.features,
            JSON.stringify(draft.prices),
            p.userId,
          ],
        );
        await platformAudit(c, who(p, req.id), 'admin.plan_draft_created', id, { plan: b.plan_id });
        const { rows } = await c.query<PlanDraft>(
          `select ${DRAFT_COLUMNS} from plan_drafts d where d.id = $1`,
          [id],
        );
        return one(rows);
      });
      return reply.status(201).send(row);
    },
  );

  app.put(
    '/admin/plan-drafts/:id',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Edits a draft (admin.catalog.edit); send the revision you edited (VERSION_CONFLICT otherwise).',
        params: IdParam('pld'),
        body: PlanDraftUpdate,
        response: { 200: PlanDraft, ...errors },
      },
    },
    async (req) => {
      const p = adminOf(req, 'admin.catalog.edit');
      const b = req.body;
      return withTx(deps.pool, staffCtx(p), async (c) => {
        const { rows } = await c.query<PlanDraft>(
          `update plan_drafts set name = $3, description = $4, purchasable = $5, limits = $6, features = $7,
                  prices = $8, revision = revision + 1, last_error = null, updated_at = now()
            where id = $1 and revision = $2 and state = 'draft'
            returning id`,
          [
            req.params.id,
            b.revision,
            b.name,
            b.description,
            b.purchasable,
            b.limits,
            b.features,
            JSON.stringify(b.prices),
          ],
        );
        if (!rows[0]) {
          const cur = await c.query<{ revision: number; state: string }>(
            'select revision, state from plan_drafts where id = $1',
            [req.params.id],
          );
          if (!cur.rows[0]) throw new ApiError('NOT_FOUND', 'Draft not found');
          throw new ApiError('VERSION_CONFLICT', 'The draft changed or is not editable; reload it', {
            current_revision: cur.rows[0].revision,
            state: cur.rows[0].state,
          });
        }
        await platformAudit(c, who(p, req.id), 'admin.plan_draft_edited', req.params.id);
        const out = await c.query<PlanDraft>(`select ${DRAFT_COLUMNS} from plan_drafts d where d.id = $1`, [
          req.params.id,
        ]);
        return one(out.rows);
      });
    },
  );

  app.post(
    '/admin/plan-drafts/:id/discard',
    {
      config: { staff: true },
      schema: {
        tags,
        description: 'Discards a draft that was not published (admin.catalog.edit).',
        params: IdParam('pld'),
        body: PlanDraftPublish,
        response: { 200: PlanDraft, ...errors },
      },
    },
    async (req) => {
      const p = adminOf(req, 'admin.catalog.edit');
      return withTx(deps.pool, staffCtx(p), async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `update plan_drafts set state = 'discarded', updated_at = now()
            where id = $1 and revision = $2 and state = 'draft' returning id`,
          [req.params.id, req.body.revision],
        );
        if (!rows[0]) throw new ApiError('VERSION_CONFLICT', 'The draft changed or is not open; reload it');
        await platformAudit(c, who(p, req.id), 'admin.plan_draft_discarded', req.params.id);
        const out = await c.query<PlanDraft>(`select ${DRAFT_COLUMNS} from plan_drafts d where d.id = $1`, [
          req.params.id,
        ]);
        return one(out.rows);
      });
    },
  );

  app.post(
    '/admin/plan-drafts/:id/publish',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Publishes a draft as a new immutable plan version (admin.catalog.publish): validate → create or reuse ' +
          'the provider product and prices → verify them → store the version and prices → refresh pricing. Only one ' +
          'publication per plan runs at a time; repeating the request for the same revision returns the same ' +
          'publication. A provider failure publishes nothing (PUBLISH_FAILED) and the draft stays editable. ' +
          'Workspaces keep the version and price they bought; new purchases use the new version.',
        params: IdParam('pld'),
        body: PlanDraftPublish,
        response: { 200: CatalogPublication, 201: CatalogPublication, ...errors },
      },
    },
    async (req, reply) => {
      const p = adminOf(req, 'admin.catalog.publish');
      const out = await publishDraft(deps, who(p, req.id), req.params.id, req.body.revision);
      return reply.status(out.created ? 201 : 200).send(out.publication);
    },
  );

  // ---------------------------------------------------------------- operations
  app.get(
    '/admin/operations',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Operations (admin.operations.read): provider events waiting or failed, the e-mail queue (no addresses or ' +
          'contents), the outbox, backup recency, the worker’s last run, the release channel and release requests. ' +
          'No secret values.',
        response: { 200: AdminOperations, ...errors },
      },
    },
    async (req) => {
      const p = adminOf(req, 'admin.operations.read');
      const downloads = await deps.downloads().catch(() => null);
      return withTx(deps.pool, staffCtx(p), async (c) => {
        const hooks = await c.query<{ pending: string; failed: string; oldest: string | null }>(
          `select count(*) filter (where status = 'pending')::text as pending,
                  count(*) filter (where status = 'failed')::text as failed,
                  ${ts("min(received_at) filter (where status = 'pending')")} as oldest
             from billing_webhook_events`,
        );
        const failures = await c.query<{
          provider_event_id: string;
          type: string;
          org_id: string | null;
          attempts: number;
          error: string | null;
          received_at: string;
        }>(
          `select provider_event_id, type, org_id, attempts, error, ${ts('received_at')} as received_at
             from billing_webhook_events where status = 'failed' order by received_at desc limit 20`,
        );
        const mail = await c.query<{
          id: string;
          kind: string;
          org_id: string | null;
          state: string;
          attempts: number;
          last_error: string | null;
          created_at: string;
          retryable: boolean;
          sent_recently: boolean;
        }>(
          `select id, kind, org_id, state, attempts, last_error, ${ts('created_at')} as created_at, retryable,
                  sent_recently from app.admin_email_status()`,
        );
        const ops = await c.query<{
          last_profile_backup: string | null;
          outbox_pending: string;
          outbox_retrying: string;
          outbox_oldest: string | null;
          deletion_requests: string;
          contact_requests: string;
        }>(
          `select ${ts('last_profile_backup')} as last_profile_backup, outbox_pending::text, outbox_retrying::text,
                  ${ts('outbox_oldest')} as outbox_oldest, deletion_requests::text, contact_requests::text
             from app.admin_ops_summary()`,
        );
        const beat = await c.query<{ at: string }>(
          `select ${ts('at')} as at from worker_heartbeats where name = 'worker'`,
        );
        // Outside the transaction: a refused read here must not abort the others.
        const archiver = await deps.pool
          .query<{ last: string | null; failed: string; archived: string; last_failed: string | null }>(
            `select ${ts('last_archived_time')} as last, failed_count::text as failed, archived_count::text as archived,
                    ${ts('last_failed_time')} as last_failed from pg_stat_archiver`,
          )
          .catch(() => ({
            rows: [] as {
              last: string | null;
              failed: string;
              archived: string;
              last_failed: string | null;
            }[],
          }));
        const migration = await deps.pool
          .query<{ name: string }>('select name from public.schema_migrations order by name desc limit 1')
          .catch(() => ({ rows: [] as { name: string }[] }));
        const releaseReqs = await c.query<{
          id: string;
          action: string;
          reason: string;
          state: string;
          requested_by: string;
          created_at: string;
        }>(
          `select id, action, reason, state, requested_by, ${ts('created_at')} as created_at
             from release_action_requests order by created_at desc limit 20`,
        );
        const o = ops.rows[0];
        const a = archiver.rows[0];
        const h = hooks.rows[0];
        const failedMail = mail.rows.filter((m) => m.state === 'failed');
        return {
          generated_at: new Date().toISOString(),
          server: {
            api_version: '0.17.0',
            environment: deps.config.appEnv,
            database_migration: migration.rows[0]?.name ?? null,
            worker_last_seen: beat.rows[0]?.at ?? null,
          },
          webhooks: {
            pending: Number(h?.pending ?? 0),
            failed: Number(h?.failed ?? 0),
            oldest_pending: h?.oldest ?? null,
            recent_failures: failures.rows,
          },
          email: {
            configured: deps.config.email.taskKey !== null,
            pending: mail.rows.filter((m) => m.state === 'pending').length,
            failed: failedMail.length,
            sent_24h: mail.rows.filter((m) => m.sent_recently).length,
            recent_failures: failedMail
              .sort((x, y) => y.created_at.localeCompare(x.created_at))
              .slice(0, 30)
              .map((m) => ({
                id: m.id,
                kind: m.kind,
                org_id: m.org_id,
                attempts: m.attempts,
                error: m.last_error,
                created_at: m.created_at,
                retryable: m.retryable,
              })),
          },
          inbox: {
            deletion_requests_pending: Number(o?.deletion_requests ?? 0),
            contact_requests_unhandled: Number(o?.contact_requests ?? 0),
          },
          outbox: {
            pending: Number(o?.outbox_pending ?? 0),
            retrying: Number(o?.outbox_retrying ?? 0),
            oldest_pending: o?.outbox_oldest ?? null,
          },
          backups: {
            last_profile_backup: o?.last_profile_backup ?? null,
            offsite:
              a && (Number(a.archived) > 0 || Number(a.failed) > 0)
                ? {
                    last_success: a.last,
                    status:
                      a.last_failed && (!a.last || a.last_failed > a.last)
                        ? 'Log archiving is failing'
                        : 'Log archiving works',
                  }
                : null,
          },
          release: {
            status: downloads?.status ?? 'unknown',
            version: downloads?.version ?? null,
            checked_at: downloads?.checked_at ?? null,
            requests: releaseReqs.rows,
          },
        };
      });
    },
  );

  app.post(
    '/admin/email/:id/retry',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Sends a failed e-mail again (admin.operations.act); possible while its sealed contents are kept (7 days).',
        params: IdParam('eml'),
        response: { 202: Type.Object({ queued: Type.Boolean() }), ...errors },
      },
    },
    async (req, reply) => {
      const p = adminOf(req, 'admin.operations.act');
      const queued = await withTx(deps.pool, staffCtx(p), async (c) => {
        const r = await c.query<{ ok: boolean }>('select app.admin_email_retry($1) as ok', [req.params.id]);
        const ok = r.rows[0]?.ok === true;
        await platformAudit(c, who(p, req.id), 'admin.email_retried', req.params.id, { queued: ok });
        return ok;
      });
      if (!queued)
        throw new ApiError('VERSION_CONFLICT', 'This e-mail cannot be retried (sent, pending or expired)');
      return reply.status(202).send({ queued });
    },
  );

  app.post(
    '/admin/release-requests',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Records a request for a release action (admin.releases.request). The signed release pipeline carries it ' +
          'out; nothing here uploads, signs or changes a release.',
        body: ReleaseActionRequest,
        response: {
          201: Type.Object(
            { id: Type.String(), state: Type.Literal('requested') },
            { additionalProperties: false },
          ),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const p = adminOf(req, 'admin.releases.request');
      if (req.body.action === 'publish_version' && !req.body.version) {
        throw new ApiError('VALIDATION_FAILED', 'Name the version to publish', { field: 'version' });
      }
      const id = newId('releaseRequest');
      await withTx(deps.pool, staffCtx(p), async (c) => {
        await c.query(
          `insert into release_action_requests (id, action, version, reason, requested_by)
           values ($1, $2, $3, $4, $5)`,
          [id, req.body.action, req.body.version ?? null, req.body.reason, p.userId],
        );
        await platformAudit(c, who(p, req.id), 'admin.release_requested', id, {
          action: req.body.action,
          version: req.body.version ?? null,
        });
      });
      return reply.status(201).send({ id, state: 'requested' as const });
    },
  );

  // ---------------------------------------------------------------- staff
  app.get(
    '/admin/staff',
    {
      config: { staff: true },
      schema: {
        tags,
        description:
          'Staff and their roles, with the versioned role → permission mapping (admin.staff.read). Staff are added, ' +
          'changed and removed only on the server (staff.ts); the last platform owner cannot be removed.',
        response: { 200: AdminStaff, ...errors },
      },
    },
    async (req) => {
      const p = adminOf(req, 'admin.staff.read');
      return withTx(deps.pool, staffCtx(p), async (c) => {
        const { rows } = await c.query<{
          user_id: string;
          display_name: string;
          email: string | null;
          roles: (typeof STAFF_ROLES)[number][];
          disabled: boolean;
          last_sign_in: string | null;
        }>(
          `select user_id, coalesce(display_name, 'Staff') as display_name, email, roles, disabled,
                  ${ts('last_sign_in')} as last_sign_in from app.admin_staff_list()`,
        );
        await platformAudit(c, who(p, req.id), 'admin.staff_viewed', null);
        return {
          items: rows,
          mapping_version: STAFF_PERMISSION_MAPPING_VERSION,
          role_permissions: Object.fromEntries(
            STAFF_ROLES.map((r) => [r, [...STAFF_ROLE_PERMISSIONS[r]]]),
          ) as Record<(typeof STAFF_ROLES)[number], StaffPermission[]>,
        };
      });
    },
  );

  // Publishing invalidates this server's caches; other servers notice within the catalog TTL.
  app.addHook('onClose', async () => invalidateCatalog(deps));
}

/** Queues the restriction e-mail for the workspace's owners (or the suspended account). Returns whether any went out. */
async function notifyRestriction(
  c: pg.PoolClient,
  deps: Deps,
  restrictionId: string,
  r: {
    kind: 'payment' | 'security';
    scope: 'workspace' | 'account';
    user_id?: string | undefined;
    expires_at?: string | undefined;
  },
  orgId: string | null,
  phase: 'applied' | 'lifted',
): Promise<boolean> {
  const key = deps.config.email.taskKey;
  if (!key) return false;
  const { rows } = await c.query<{ email: string; org_name: string }>(
    'select email, org_name from app.admin_notice_recipients($1, $2)',
    [orgId, r.scope === 'account' ? (r.user_id ?? null) : null],
  );
  let any = false;
  for (const to of rows) {
    const queued = await enqueueEmail(c, key, {
      kind: 'restriction_notice',
      orgId,
      to: to.email,
      dedupeKey: `restriction_notice:${restrictionId}:${phase}:${to.email}`.slice(0, 200),
      vars: {
        workspace_name: to.org_name,
        restriction: r.kind,
        scope: r.scope,
        phase,
        until: r.expires_at ?? '',
      },
    });
    any = any || queued;
  }
  return any;
}

export const _test = { validateDraft };
