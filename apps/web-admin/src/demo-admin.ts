/**
 * R5: the in-memory stand-in for /v1/admin (demo builds only). It applies the server's rules closely enough to
 * exercise the screens: permissions from STAFF_ROLE_PERMISSIONS, a second factor for business screens, masked owner
 * addresses without the contact permission, restrictions with reasons, redacted notes, drafts with revisions and
 * publishing as a new immutable version (a provider failure publishes nothing), failed e-mail retry, release requests.
 * Fictional data only.
 */
import {
  type AdminCatalog,
  type AdminCustomer,
  type AdminCustomerDetail,
  type AdminMetrics,
  type AdminOperations,
  type AdminStaff,
  type CatalogPublication,
  type PlanDraft,
  type PublishedPlan,
  type Restriction,
  STAFF_PERMISSION_MAPPING_VERSION,
  STAFF_PERMISSIONS,
  STAFF_ROLE_PERMISSIONS,
  type StaffPermission,
  type SupportNote,
  staffCan,
} from '@pb/contracts/admin';
import { PLAN_CATALOG, STAFF_ROLES } from '@pb/contracts/billing';
import { type ConsoleApi, ConsoleError, type Staff } from './api.ts';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const C32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const rid = (prefix: string) => {
  let s = '';
  for (let i = 0; i < 26; i++) s += C32[Math.floor(Math.random() * 32)];
  return `${prefix}_${s}`;
};

/** The support demo's organizations, as far as the admin screens need them. */
export interface AdminDemoOrg {
  id: string;
  name: string;
  created: number;
  plan: { id: string; version: number; name: string; limits: Record<string, number | null> };
  state: AdminCustomer['state'];
  reason: string;
  customer: string | null;
  periodEnd: number | null;
  emails: string[];
  members: { role: string }[];
  usage: { profiles: number; seats: number; storage_bytes: number };
  invoices: {
    id: string;
    number: string | null;
    status: string;
    currency: string;
    amount_due_minor: number;
    amount_paid_minor: number;
    created_at: string;
  }[];
  events: {
    provider_event_id: string;
    type: string;
    status: string;
    received_at: string;
    error: string | null;
  }[];
}

export interface AdminDemoControls {
  /** The next publication fails at the payment provider. */
  failNextPublish(): void;
}

type AdminMethods = Pick<
  ConsoleApi,
  | 'adminMe'
  | 'metrics'
  | 'customers'
  | 'customer'
  | 'addNote'
  | 'restrict'
  | 'liftRestriction'
  | 'adminResync'
  | 'catalog'
  | 'createDraft'
  | 'updateDraft'
  | 'discardDraft'
  | 'publishDraft'
  | 'operations'
  | 'retryEmail'
  | 'requestRelease'
  | 'staffList'
>;

export function adminDemo(opts: {
  orgs: AdminDemoOrg[];
  me: () => Staff | null;
  mfa: () => boolean;
  record: (action: string, orgId?: string | null, target?: string | null, details?: object) => void;
  delay: <T>(v: T) => Promise<T>;
  staff: Staff[];
}): AdminMethods & { adminControls: AdminDemoControls } {
  const { orgs, record, delay } = opts;
  const now = Date.now();
  let failNext = false;

  const admin = (permission: StaffPermission): Staff => {
    const me = opts.me();
    if (!me) throw new ConsoleError('UNAUTHENTICATED', 'Sign in to the console', 401);
    if (!staffCan(me.roles, permission)) {
      throw new ConsoleError('FORBIDDEN', 'Your staff role does not allow this', 403, { permission });
    }
    if (!opts.mfa())
      throw new ConsoleError('MFA_REQUIRED', 'Sign in again with your one-time code to use this', 403);
    return me;
  };
  const orgOf = (id: string) => {
    const o = orgs.find((x) => x.id === id);
    if (!o) throw new ConsoleError('NOT_FOUND', 'Customer not found', 404);
    return o;
  };

  const restrictions: Restriction[] = [];
  const notes: SupportNote[] = [];
  const activeRestriction = (orgId: string, kind: 'payment' | 'security') =>
    restrictions.some(
      (r) =>
        r.org_id === orgId &&
        r.kind === kind &&
        r.active &&
        (!r.expires_at || Date.parse(r.expires_at) > Date.now()),
    );
  const customerOf = (o: AdminDemoOrg, contact: boolean): AdminCustomer => {
    const email = o.emails[0] ?? null;
    return {
      id: o.id,
      name: o.name,
      created_at: iso(o.created),
      plan_id: o.plan.id,
      plan_version: o.plan.version,
      plan_name: o.plan.name,
      state: activeRestriction(o.id, 'payment') ? 'restricted' : o.state,
      member_count: o.members.length,
      profile_count: o.usage.profiles,
      owner_email: email && !contact ? `${email.slice(0, 1)}***@${email.split('@')[1]}` : email,
      last_active_at: iso(now - (o.state === 'restricted' ? 9 : 0.2) * DAY),
      suspended: activeRestriction(o.id, 'security'),
      restricted: activeRestriction(o.id, 'payment'),
    };
  };

  // Catalog: the seeds, plus prices for the sold plans.
  const PRICE: Record<string, number> = { starter: 1900, team: 4900, agency: 14900 };
  const plans: PublishedPlan[] = PLAN_CATALOG.map((p) => ({
    id: p.id,
    version: p.version,
    name: p.name,
    description: p.description,
    purchasable: p.purchasable,
    trial_days: p.trialDays,
    limits: p.limits,
    features: p.features,
    source: 'seed' as const,
    current: true,
    prices: PRICE[p.id]
      ? [
          {
            interval: 'month' as const,
            currency: 'usd',
            amount_minor: PRICE[p.id] as number,
            provider_price_id: `price_demo_${p.id}`,
          },
        ]
      : [],
    subscribers: orgs.filter((o) => o.plan.id === p.id).length + (p.id === 'trial' ? 12 : 0),
    published_at: iso(now - 200 * DAY),
    published_by: null,
  }));
  const drafts: PlanDraft[] = [];
  const publications: CatalogPublication[] = [];
  let generation = 0;

  const emails = [
    {
      id: rid('eml'),
      kind: 'invitation',
      org_id: orgs[1]?.id ?? null,
      attempts: 8,
      error: 'smtp_rejected',
      created_at: iso(now - 3 * 3600_000),
      retryable: true,
    },
    {
      id: rid('eml'),
      kind: 'payment_failed',
      org_id: orgs[1]?.id ?? null,
      attempts: 8,
      error: 'smtp_unavailable',
      created_at: iso(now - 9 * DAY),
      retryable: false,
    },
  ];
  const releaseRequests: AdminOperations['release']['requests'] = [];

  const draftById = (id: string) => {
    const d = drafts.find((x) => x.id === id);
    if (!d) throw new ConsoleError('NOT_FOUND', 'Draft not found', 404);
    return d;
  };

  return {
    async adminMe() {
      const me = opts.me();
      if (!me) throw new ConsoleError('UNAUTHENTICATED', 'Sign in to the console', 401);
      return delay({
        roles: me.roles,
        permissions: STAFF_PERMISSIONS.filter((p) => staffCan(me.roles, p)),
        mfa: opts.mfa(),
      });
    },
    async metrics() {
      admin('admin.metrics.read');
      const by = { trial: 12, active: 0, past_due: 0, grace: 0, restricted: 0, canceled: 1 };
      for (const o of orgs) by[activeRestriction(o.id, 'payment') ? 'restricted' : o.state] += 1;
      const m: AdminMetrics = {
        generated_at: iso(Date.now()),
        workspaces: {
          total: Object.values(by).reduce((a, b) => a + b, 0),
          active_customers: by.trial + by.active + by.past_due + by.grace,
          by_state: by,
          paying: by.active,
          complimentary: 2,
          new_last_30_days: 9,
        },
        mrr: [
          {
            currency: 'usd',
            amount_minor: 14_900 + 4_083,
            subscriptions: 2,
            canceling_amount_minor: 0,
            at_risk_amount_minor: 4_900,
          },
          {
            currency: 'eur',
            amount_minor: 4_500,
            subscriptions: 1,
            canceling_amount_minor: 4_500,
            at_risk_amount_minor: 0,
          },
        ],
        cash_collected_30d: [
          { currency: 'usd', amount_minor: 68_700 },
          { currency: 'eur', amount_minor: 4_500 },
        ],
        refunds_30d: [{ currency: 'usd', amount_minor: 14_900 }],
        alerts: { open: 2, by_kind: { refund: 1, event_failed: 1 } },
        freshness: {
          oldest_subscription_sync: iso(Date.now() - 3 * 3600_000),
          last_webhook_processed: iso(Date.now() - 4 * 60_000),
          webhooks_pending: 0,
          webhooks_failed: 1,
        },
        gaps: [
          'Discounts, credits and one-time items are not applied to recurring revenue (list prices).',
          '1 provider event(s) failed; see Operations.',
        ],
      };
      record('admin.metrics_viewed');
      return delay(m);
    },
    async customers(q) {
      const me = admin('admin.customers.read');
      const contact = staffCan(me.roles, 'admin.customers.contact');
      const text = (q.q ?? '').trim().toLowerCase();
      let list = orgs
        .filter(
          (o) =>
            !text ||
            o.id.toLowerCase() === text ||
            o.customer?.toLowerCase() === text ||
            (text.includes('@') && o.emails[0] === text) ||
            o.name.toLowerCase().startsWith(text),
        )
        .map((o) => customerOf(o, contact))
        .filter((c) => (!q.state || c.state === q.state) && (!q.plan || c.plan_id === q.plan))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const limit = q.limit ?? 50;
      const start = q.cursor ? Number(atob(q.cursor)) : 0;
      const page = list.slice(start, start + limit);
      list = [];
      record('admin.customers_listed', null, null, { q: q.q ?? null });
      return delay({
        items: page,
        next_cursor:
          start + limit < orgs.length && page.length === limit ? btoa(String(start + limit)) : null,
      });
    },
    async customer(orgId) {
      const me = admin('admin.customers.read');
      const o = orgOf(orgId);
      const c = customerOf(o, staffCan(me.roles, 'admin.customers.contact'));
      const plan = plans.find((p) => p.id === o.plan.id && p.version === o.plan.version);
      const d: AdminCustomerDetail = {
        customer: c,
        billing: {
          state: c.state,
          reason: (c.restricted ? 'staff_restriction' : o.reason) as AdminCustomerDetail['billing']['reason'],
          until: null,
          plan_id: o.plan.id,
          plan_version: o.plan.version,
          plan_name: o.plan.name,
          limits: (plan?.limits ?? o.plan.limits) as AdminCustomerDetail['billing']['limits'],
          features: plan?.features ?? {
            team_sessions: true,
            automation: true,
            api_tokens: true,
            webhooks: true,
          },
          provider_customer_id: o.customer,
          provider_subscription_id: o.customer ? `sub_${o.customer.slice(4)}` : null,
          price: plan?.prices[0]
            ? {
                currency: 'usd',
                amount_minor: plan.prices[0].amount_minor,
                interval: 'month',
                interval_count: 1,
                quantity: 1,
              }
            : null,
          current_period_end: o.periodEnd ? iso(o.periodEnd) : null,
          cancel_at_period_end: false,
          synced_at: iso(Date.now() - 4 * 60_000),
        },
        usage: o.usage,
        members_by_role: o.members.reduce<Record<string, number>>((acc, m) => {
          acc[m.role] = (acc[m.role] ?? 0) + 1;
          return acc;
        }, {}),
        devices: {
          active: o.members.length + 1,
          by_platform: { 'windows-x64': o.members.length, 'macos-arm64': 1 },
        },
        invoices: o.invoices as AdminCustomerDetail['invoices'],
        events: o.events,
        restrictions: restrictions.filter((r) => r.org_id === o.id),
        notes: staffCan(me.roles, 'admin.notes.read') ? notes.filter((n) => n.org_id === o.id) : [],
        audit: [
          { at: iso(Date.now()), action: 'admin.customer_viewed', actor_user_id: me.user_id, target: null },
        ],
      };
      record('admin.customer_viewed', o.id);
      return delay(d);
    },
    async addNote(orgId, body) {
      const me = admin('admin.notes.write');
      orgOf(orgId);
      const text = body
        .replace(/\b(?:\d[ -]?){12,18}\d\b/g, '[redacted]')
        .replace(
          /\b(password|token|secret)(\s*[:=]\s*)\S+/gi,
          (_m, w: string, s: string) => `${w}${s}[redacted]`,
        );
      const n: SupportNote = {
        id: rid('snt'),
        org_id: orgId,
        author_user_id: me.user_id,
        author_name: me.display_name,
        body: text,
        redacted: text !== body,
        created_at: iso(Date.now()),
      };
      notes.unshift(n);
      record('admin.note_added', orgId, n.id);
      return delay(n);
    },
    async restrict(body) {
      const me = admin(
        body.kind === 'security' ? 'admin.restrictions.security' : 'admin.restrictions.payment',
      );
      if (body.reason.trim().length < 20) {
        throw new ConsoleError('VALIDATION_FAILED', 'Request failed validation', 422, {
          issues: [{ path: '/reason', message: 'must NOT have fewer than 20 characters' }],
        });
      }
      const r: Restriction = {
        id: rid('rst'),
        kind: body.kind,
        scope: body.scope,
        org_id: body.org_id ?? null,
        user_id: body.user_id ?? null,
        reason: body.reason,
        created_by: me.user_id,
        created_at: iso(Date.now()),
        expires_at: body.expires_at ?? null,
        lifted_at: null,
        lifted_by: null,
        notified: body.notify !== false,
        active: true,
      };
      restrictions.unshift(r);
      record(`admin.restriction_${body.kind}_applied`, r.org_id, r.id);
      return delay(r);
    },
    async liftRestriction(id, reason) {
      const r = restrictions.find((x) => x.id === id);
      if (!r) throw new ConsoleError('NOT_FOUND', 'Restriction not found', 404);
      const me = admin(r.kind === 'security' ? 'admin.restrictions.security' : 'admin.restrictions.payment');
      if (reason.trim().length < 20)
        throw new ConsoleError('VALIDATION_FAILED', 'Request failed validation', 422);
      Object.assign(r, { active: false, lifted_at: iso(Date.now()), lifted_by: me.user_id });
      record(`admin.restriction_${r.kind}_lifted`, r.org_id, r.id);
      return delay(r);
    },
    async adminResync(orgId) {
      admin('admin.operations.act');
      return delay(Boolean(orgOf(orgId).customer));
    },
    async catalog() {
      admin('admin.catalog.read');
      const c: AdminCatalog = {
        generation,
        provider: true,
        plans: plans.map((p) => ({
          ...p,
          current: plans.every((x) => x.id !== p.id || x.version <= p.version),
        })),
        drafts: drafts.filter((d) => d.state === 'draft' || d.state === 'publishing'),
        publications,
      };
      return delay(c);
    },
    async createDraft(body) {
      const me = admin('admin.catalog.edit');
      const base = plans.filter((p) => p.id === body.plan_id).sort((a, b) => b.version - a.version)[0];
      const from = body.from_published !== false && base;
      const d: PlanDraft = {
        id: rid('pld'),
        plan_id: body.plan_id,
        base_version: base?.version ?? null,
        name: body.name ?? (from ? base.name : body.plan_id),
        description: body.description ?? (from ? base.description : ''),
        purchasable: body.purchasable ?? (from ? base.purchasable : false),
        limits:
          body.limits ??
          (from
            ? base.limits
            : { profiles: 100, seats: 1, storage_bytes: 10 * 1024 ** 3, automation_concurrency: 1 }),
        features:
          body.features ??
          (from
            ? base.features
            : { team_sessions: false, automation: false, api_tokens: false, webhooks: false }),
        prices:
          body.prices ??
          (from
            ? base.prices.map((p) => ({
                interval: p.interval,
                currency: p.currency,
                amount_minor: p.amount_minor,
              }))
            : []),
        state: 'draft',
        revision: 1,
        published_version: null,
        last_error: null,
        created_by: me.user_id,
        created_at: iso(Date.now()),
        updated_at: iso(Date.now()),
      };
      drafts.unshift(d);
      record('admin.plan_draft_created', null, d.id);
      return delay(d);
    },
    async updateDraft(id, body) {
      admin('admin.catalog.edit');
      const d = draftById(id);
      if (d.revision !== body.revision || d.state !== 'draft') {
        throw new ConsoleError('VERSION_CONFLICT', 'The draft changed or is not editable; reload it', 409);
      }
      const { revision: _r, ...rest } = body;
      Object.assign(d, rest, { revision: d.revision + 1, updated_at: iso(Date.now()), last_error: null });
      return delay(d);
    },
    async discardDraft(id, revision) {
      admin('admin.catalog.edit');
      const d = draftById(id);
      if (d.revision !== revision)
        throw new ConsoleError('VERSION_CONFLICT', 'The draft changed; reload it', 409);
      d.state = 'discarded';
      return delay(d);
    },
    async publishDraft(id, revision) {
      const me = admin('admin.catalog.publish');
      const d = draftById(id);
      if (d.revision !== revision || d.state !== 'draft') {
        throw new ConsoleError('VERSION_CONFLICT', 'The draft changed; review it and publish again', 409);
      }
      if (d.purchasable && d.prices.length === 0) {
        throw new ConsoleError(
          'VALIDATION_FAILED',
          'A plan sold through checkout needs at least one price',
          422,
        );
      }
      const version = Math.max(0, ...plans.filter((p) => p.id === d.plan_id).map((p) => p.version)) + 1;
      const pub: CatalogPublication = {
        id: rid('cpo'),
        draft_id: d.id,
        plan_id: d.plan_id,
        version,
        state: 'succeeded',
        provider_product_id: `pb_plan_${d.plan_id}`,
        prices: d.prices.map((p) => ({ ...p, provider_price_id: rid('price').replace('price_', 'price_') })),
        error: null,
        started_by: me.user_id,
        started_at: iso(Date.now()),
        finished_at: iso(Date.now()),
      };
      if (failNext) {
        failNext = false;
        publications.unshift({ ...pub, state: 'failed', prices: [], error: 'provider: HTTP 503 api_error' });
        d.last_error = 'provider: HTTP 503 api_error';
        throw new ConsoleError(
          'PUBLISH_FAILED',
          'Publishing failed; nothing was published. The draft can be published again.',
          502,
        );
      }
      publications.unshift(pub);
      plans.push({
        id: d.plan_id,
        version,
        name: d.name,
        description: d.description,
        purchasable: d.purchasable,
        trial_days: null,
        limits: d.limits,
        features: d.features,
        source: 'admin',
        current: true,
        prices: pub.prices,
        subscribers: 0,
        published_at: pub.started_at,
        published_by: me.user_id,
      });
      Object.assign(d, { state: 'published', published_version: version });
      generation += 1;
      record('admin.catalog_published', null, pub.id);
      return delay(pub);
    },
    async operations() {
      admin('admin.operations.read');
      const o: AdminOperations = {
        generated_at: iso(Date.now()),
        server: {
          api_version: '0.19.0',
          environment: 'demo',
          database_migration: '0016_business_admin.sql',
          worker_last_seen: iso(Date.now() - 40_000),
        },
        webhooks: {
          pending: 0,
          failed: 1,
          oldest_pending: null,
          recent_failures: [
            {
              provider_event_id: 'evt_DemoBr21',
              type: 'customer.subscription.updated',
              org_id: orgs[2]?.id ?? null,
              attempts: 4,
              error: 'provider unavailable (will retry)',
              received_at: iso(Date.now() - DAY),
            },
          ],
        },
        email: {
          configured: true,
          pending: 0,
          failed: emails.length,
          sent_24h: 31,
          recent_failures: emails,
        },
        inbox: { deletion_requests_pending: 1, contact_requests_unhandled: 3 },
        outbox: { pending: 0, retrying: 0, oldest_pending: null },
        health: {
          signups_24h: 3,
          signups_7d: 17,
          checkouts_open: 1,
          checkout_oldest_open: iso(Date.now() - 40 * 60_000),
          leases_active: 12,
          leases_expired_unreleased: 0,
          snapshots_committed_24h: 148,
          snapshots_failed_24h: 0,
          jobs_queued: 0,
          job_oldest_queued: null,
          archiving_failing: false,
        },
        backups: {
          last_profile_backup: iso(Date.now() - 25 * 60_000),
          offsite: { last_success: iso(Date.now() - 50_000), status: 'Log archiving works' },
        },
        release: {
          status: 'not_available',
          version: null,
          checked_at: iso(Date.now() - 5 * 60_000),
          requests: releaseRequests,
        },
      };
      return delay(o);
    },
    async retryEmail(id) {
      admin('admin.operations.act');
      const i = emails.findIndex((e) => e.id === id && e.retryable);
      if (i < 0)
        throw new ConsoleError(
          'VERSION_CONFLICT',
          'This e-mail cannot be retried (sent, pending or expired)',
          409,
        );
      emails.splice(i, 1);
      record('admin.email_retried', null, id);
      return delay(true);
    },
    async requestRelease(body) {
      const me = admin('admin.releases.request');
      const id = rid('rlr');
      releaseRequests.unshift({
        id,
        action: body.action,
        reason: body.reason,
        state: 'requested',
        requested_by: me.user_id,
        created_at: iso(Date.now()),
      });
      record('admin.release_requested', null, id);
      return delay({ id });
    },
    async staffList() {
      admin('admin.staff.read');
      const s: AdminStaff = {
        items: opts.staff.map((x) => ({
          user_id: x.user_id,
          display_name: x.display_name,
          email: `${x.display_name.split(' ')[0]?.toLowerCase()}@staff.example`,
          roles: x.roles,
          disabled: false,
          last_sign_in: iso(Date.now() - 2 * 3600_000),
        })),
        mapping_version: STAFF_PERMISSION_MAPPING_VERSION,
        role_permissions: Object.fromEntries(
          STAFF_ROLES.map((r) => [r, [...STAFF_ROLE_PERMISSIONS[r]]]),
        ) as AdminStaff['role_permissions'],
      };
      return delay(s);
    },
    adminControls: {
      failNextPublish() {
        failNext = true;
      },
    },
  };
}
