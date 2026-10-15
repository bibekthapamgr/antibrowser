/**
 * R5 (ADR-0024): business-owner administration — what platform staff may do, and the shapes of /v1/admin.
 * Browser-safe: no Node imports.
 *
 * - Authority is a staff permission, never the route's namespace: every /v1/admin route names the permission it needs,
 *   and the staff session must have been opened with a second factor (MFA). Workspace owners are not staff.
 * - The role → permission mapping is versioned (STAFF_PERMISSION_MAPPING_VERSION). The database keeps the same table
 *   (`staff_role_permissions`) for its own checks; a test keeps the two identical.
 * - Support-only roles keep the milestone 11 rules: exact search, time-bound approved access to members and activity,
 *   no browsing of all customers.
 */
import Type, { type Static, type TSchema } from 'typebox';
import {
  BILLING_REASONS,
  BILLING_STATES,
  Features,
  INVOICE_STATES,
  Limits,
  PLAN_ID_PATTERN,
  PRICE_INTERVALS,
  STAFF_ROLES,
  type StaffRole,
} from './billing.ts';
import { ID_PATTERN } from './ids.ts';

const Id = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const Timestamp = Type.String({ format: 'date-time', description: 'UTC, RFC 3339' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Currency = Type.String({ pattern: '^[a-z]{3}$' });
const Reason = Type.String({ minLength: 20, maxLength: 500 });

// ================================================================ permissions
export const STAFF_PERMISSIONS = [
  /** Dashboard numbers: counts, recurring revenue, cash, alerts, data freshness. */
  'admin.metrics.read',
  /** The paginated customer list and a customer's business detail (no member list: that stays approval-based). */
  'admin.customers.read',
  /** Contact columns (the owner's e-mail address) in the list and detail; without it they are masked. */
  'admin.customers.contact',
  /** Payment restrictions (stop creating and opening; data kept, export allowed). */
  'admin.restrictions.payment',
  /** Security suspensions of a workspace or an account (all access stops, sessions end). */
  'admin.restrictions.security',
  /** Entitlement exceptions (reason + expiry ≤ 90 days), the milestone 11 overrides. */
  'admin.entitlements.exception',
  /** Plan catalog: published versions and drafts. */
  'admin.catalog.read',
  'admin.catalog.edit',
  /** Publishing a draft (creates provider products/prices and a new immutable plan version). */
  'admin.catalog.publish',
  /** Operations: failed events, e-mail, worker and backup recency, release status (no secret values). */
  'admin.operations.read',
  /** Retry failed e-mail, request a subscription resync. */
  'admin.operations.act',
  /** Support-case notes on a customer (redacted before storage). */
  'admin.notes.read',
  'admin.notes.write',
  /** The staff list (roles; staff are still added on the server only). */
  'admin.staff.read',
  /** Ask for a release action (pause/resume a channel); the signed release pipeline carries it out. */
  'admin.releases.request',
] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

/** Bumped whenever STAFF_ROLE_PERMISSIONS changes (the migration that changes the database table says so). */
export const STAFF_PERMISSION_MAPPING_VERSION = 1;

const ALL_ADMIN = STAFF_PERMISSIONS;
export const STAFF_ROLE_PERMISSIONS: Record<StaffRole, readonly StaffPermission[]> = {
  support: ['admin.notes.read', 'admin.notes.write'],
  support_lead: ['admin.notes.read', 'admin.notes.write', 'admin.operations.read', 'admin.operations.act'],
  billing_admin: [
    'admin.notes.read',
    'admin.notes.write',
    'admin.entitlements.exception',
    'admin.operations.read',
    'admin.operations.act',
  ],
  platform_owner: ALL_ADMIN,
  business_admin: ALL_ADMIN.filter(
    (p) => p !== 'admin.restrictions.security' && p !== 'admin.staff.read' && p !== 'admin.releases.request',
  ),
  business_analyst: [
    'admin.metrics.read',
    'admin.customers.read',
    'admin.catalog.read',
    'admin.operations.read',
    'admin.notes.read',
  ],
};

export function staffCan(roles: readonly StaffRole[], permission: StaffPermission): boolean {
  return roles.some((r) => STAFF_ROLE_PERMISSIONS[r]?.includes(permission));
}

/** Roles that only a platform owner bootstrap or another platform owner's server command may give. */
export const BUSINESS_ROLES: readonly StaffRole[] = ['platform_owner', 'business_admin', 'business_analyst'];

// ================================================================ metrics
const Money = Type.Object(
  { currency: Currency, amount_minor: Type.Integer() },
  { additionalProperties: false },
);
export const AdminMetrics = Type.Object(
  {
    generated_at: Timestamp,
    /** Customer workspaces (internal and fixture workspaces excluded), by billing state as last observed. */
    workspaces: Type.Object(
      {
        total: Type.Integer({ minimum: 0 }),
        /** Trial, active, past due or grace: people can work. */
        active_customers: Type.Integer({ minimum: 0 }),
        by_state: Type.Record(Type.Enum(BILLING_STATES), Type.Integer({ minimum: 0 })),
        /** Paid through the provider (a provider subscription, state active). */
        paying: Type.Integer({ minimum: 0 }),
        /** Beta or other no-charge plans. */
        complimentary: Type.Integer({ minimum: 0 }),
        new_last_30_days: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    /**
     * Monthly recurring revenue per currency: active provider subscriptions at their list price × quantity,
     * normalized to a month (yearly ÷ 12, every N months ÷ N). Excludes tax where the price excludes it, one-time
     * items, discounts and credits (see `gaps`). Never converted between currencies.
     */
    mrr: Type.Array(
      Type.Object(
        {
          currency: Currency,
          amount_minor: Type.Integer(),
          subscriptions: Type.Integer({ minimum: 0 }),
          /** Of which set to cancel at the period end. */
          canceling_amount_minor: Type.Integer(),
          /** Past due or in grace: not counted above. */
          at_risk_amount_minor: Type.Integer(),
        },
        { additionalProperties: false },
      ),
    ),
    /** Paid invoices (amount paid) and refunds in the last 30 days, per currency. */
    cash_collected_30d: Type.Array(Money),
    refunds_30d: Type.Array(Money),
    alerts: Type.Object(
      {
        open: Type.Integer({ minimum: 0 }),
        by_kind: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    freshness: Type.Object(
      {
        /** Oldest provider confirmation among live provider subscriptions (null: none). */
        oldest_subscription_sync: Nullable(Timestamp),
        last_webhook_processed: Nullable(Timestamp),
        webhooks_pending: Type.Integer({ minimum: 0 }),
        webhooks_failed: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    /** Reconciliation gaps that make the numbers above incomplete, in words (empty: none known). */
    gaps: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type AdminMetrics = Static<typeof AdminMetrics>;

// ================================================================ customers
export const AdminCustomersQuery = Type.Object(
  {
    /** An organization id, a provider customer id, an owner's exact e-mail address, or the start of a name. */
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    state: Type.Optional(Type.Enum(BILLING_STATES)),
    plan: Type.Optional(Type.String({ pattern: PLAN_ID_PATTERN })),
    /** Opaque cursor from the previous page. */
    cursor: Type.Optional(Type.String({ maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export type AdminCustomersQuery = Static<typeof AdminCustomersQuery>;

export const AdminCustomer = Type.Object(
  {
    id: Id('org'),
    name: Type.String(),
    created_at: Timestamp,
    plan_id: Type.String(),
    plan_version: Type.Integer(),
    plan_name: Type.String(),
    /** As last observed by the worker (at most a few minutes old); the detail shows the live state. */
    state: Type.Enum(BILLING_STATES),
    member_count: Type.Integer({ minimum: 0 }),
    profile_count: Type.Integer({ minimum: 0 }),
    /** The first owner's e-mail address; masked (`b***@example.com`) without `admin.customers.contact`. */
    owner_email: Nullable(Type.String()),
    /** Last desktop sign-in or session refresh of any member (approximate). */
    last_active_at: Nullable(Timestamp),
    suspended: Type.Boolean(),
    restricted: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AdminCustomer = Static<typeof AdminCustomer>;
export const AdminCustomers = Type.Object(
  { items: Type.Array(AdminCustomer), next_cursor: Nullable(Type.String()) },
  { additionalProperties: false },
);
export type AdminCustomers = Static<typeof AdminCustomers>;

// ================================================================ restrictions
export const RESTRICTION_KINDS = ['payment', 'security'] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];
export const RESTRICTION_SCOPES = ['workspace', 'account'] as const;
export type RestrictionScope = (typeof RESTRICTION_SCOPES)[number];

export const Restriction = Type.Object(
  {
    id: Id('rst'),
    /**
     * `payment`: the workspace is restricted like an unpaid one — it cannot create or open profiles, invite or
     * automate; everything else (reading, closing, backups, export, deleting, billing) keeps working.
     * `security`: all access stops — open profiles are closed in the app, API tokens are revoked, an account is
     * signed out everywhere. Nothing is deleted in either case.
     */
    kind: Type.Enum(RESTRICTION_KINDS),
    scope: Type.Enum(RESTRICTION_SCOPES),
    org_id: Nullable(Id('org')),
    user_id: Nullable(Id('usr')),
    reason: Type.String(),
    created_by: Id('usr'),
    created_at: Timestamp,
    /** Null: until lifted. */
    expires_at: Nullable(Timestamp),
    lifted_at: Nullable(Timestamp),
    lifted_by: Nullable(Id('usr')),
    /** Whether the workspace's owners (or the account) were told by e-mail. */
    notified: Type.Boolean(),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type Restriction = Static<typeof Restriction>;
export const RestrictionCreate = Type.Object(
  {
    kind: Type.Enum(RESTRICTION_KINDS),
    scope: Type.Enum(RESTRICTION_SCOPES),
    /** Required for `workspace`; for `account`, the workspace the account was found in (for the record). */
    org_id: Type.Optional(Id('org')),
    /** Required for `account` (security only). */
    user_id: Type.Optional(Id('usr')),
    reason: Reason,
    /** Up to 365 days ahead; omitted: until lifted. */
    expires_at: Type.Optional(Timestamp),
    /** E-mail the workspace's owners (or the account). Default true. */
    notify: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type RestrictionCreate = Static<typeof RestrictionCreate>;
export const RestrictionLift = Type.Object({ reason: Reason }, { additionalProperties: false });

// ================================================================ notes
export const SupportNote = Type.Object(
  {
    id: Id('snt'),
    org_id: Id('org'),
    author_user_id: Id('usr'),
    author_name: Type.String(),
    /** Stored after redaction: card-like numbers, secrets and tokens are replaced with [redacted]. */
    body: Type.String(),
    redacted: Type.Boolean(),
    created_at: Timestamp,
  },
  { additionalProperties: false },
);
export type SupportNote = Static<typeof SupportNote>;
export const SupportNoteCreate = Type.Object(
  { body: Type.String({ minLength: 3, maxLength: 2000 }) },
  { additionalProperties: false },
);

// ================================================================ customer detail
export const AdminCustomerDetail = Type.Object(
  {
    customer: AdminCustomer,
    /** Live billing state and plan (app.billing_effective). */
    billing: Type.Object(
      {
        state: Type.Enum(BILLING_STATES),
        reason: Type.Enum(BILLING_REASONS),
        until: Nullable(Timestamp),
        plan_id: Type.String(),
        plan_version: Type.Integer(),
        plan_name: Type.String(),
        limits: Limits,
        features: Features,
        provider_customer_id: Nullable(Type.String()),
        provider_subscription_id: Nullable(Type.String()),
        price: Nullable(
          Type.Object(
            {
              currency: Currency,
              amount_minor: Type.Integer(),
              interval: Type.String(),
              interval_count: Type.Integer({ minimum: 1 }),
              quantity: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
        ),
        current_period_end: Nullable(Timestamp),
        cancel_at_period_end: Type.Boolean(),
        synced_at: Nullable(Timestamp),
      },
      { additionalProperties: false },
    ),
    usage: Type.Object(
      {
        profiles: Type.Integer({ minimum: 0 }),
        seats: Type.Integer({ minimum: 0 }),
        storage_bytes: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    /** Members by role (names and addresses need approved access, as in milestone 11). */
    members_by_role: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    /** Signed-in computers of the members, by platform (no names). */
    devices: Type.Object(
      {
        active: Type.Integer({ minimum: 0 }),
        by_platform: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    invoices: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          number: Nullable(Type.String()),
          status: Type.Enum(INVOICE_STATES),
          currency: Currency,
          amount_due_minor: Type.Integer(),
          amount_paid_minor: Type.Integer(),
          created_at: Timestamp,
        },
        { additionalProperties: false },
      ),
    ),
    events: Type.Array(
      Type.Object(
        {
          provider_event_id: Type.String(),
          type: Type.String(),
          status: Type.String(),
          received_at: Timestamp,
          error: Nullable(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    restrictions: Type.Array(Restriction),
    notes: Type.Array(SupportNote),
    /** Platform audit entries about this customer (who looked, what changed). */
    audit: Type.Array(
      Type.Object(
        {
          at: Timestamp,
          action: Type.String(),
          actor_user_id: Nullable(Id('usr')),
          target: Nullable(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type AdminCustomerDetail = Static<typeof AdminCustomerDetail>;

// ================================================================ catalog
export const DraftPrice = Type.Object(
  {
    interval: Type.Enum(PRICE_INTERVALS),
    currency: Currency,
    amount_minor: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
  },
  { additionalProperties: false },
);
export type DraftPrice = Static<typeof DraftPrice>;

const DraftBody = {
  name: Type.String({ minLength: 1, maxLength: 60 }),
  description: Type.String({ maxLength: 200 }),
  /** Sold through checkout (needs at least one price). */
  purchasable: Type.Boolean(),
  limits: Limits,
  features: Features,
  /** At most one per interval; one currency per plan version. */
  prices: Type.Array(DraftPrice, { maxItems: 2 }),
};

export const PLAN_DRAFT_STATES = ['draft', 'publishing', 'published', 'discarded'] as const;
export const PlanDraft = Type.Object(
  {
    id: Id('pld'),
    plan_id: Type.String({ pattern: PLAN_ID_PATTERN }),
    /** The published version this draft starts from (null: a new plan). */
    base_version: Nullable(Type.Integer({ minimum: 1 })),
    ...DraftBody,
    state: Type.Enum(PLAN_DRAFT_STATES),
    /** Increases with every edit (optimistic concurrency: send it back with changes). */
    revision: Type.Integer({ minimum: 1 }),
    published_version: Nullable(Type.Integer({ minimum: 1 })),
    last_error: Nullable(Type.String()),
    created_by: Id('usr'),
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type PlanDraft = Static<typeof PlanDraft>;
export const PlanDraftCreate = Type.Object(
  {
    plan_id: Type.String({ pattern: PLAN_ID_PATTERN }),
    /** Start from the newest published version of `plan_id` (when it exists) instead of the values below. */
    from_published: Type.Optional(Type.Boolean()),
    name: Type.Optional(DraftBody.name),
    description: Type.Optional(DraftBody.description),
    purchasable: Type.Optional(DraftBody.purchasable),
    limits: Type.Optional(Limits),
    features: Type.Optional(Features),
    prices: Type.Optional(DraftBody.prices),
  },
  { additionalProperties: false },
);
export type PlanDraftCreate = Static<typeof PlanDraftCreate>;
export const PlanDraftUpdate = Type.Object(
  { revision: Type.Integer({ minimum: 1 }), ...DraftBody },
  { additionalProperties: false },
);
export type PlanDraftUpdate = Static<typeof PlanDraftUpdate>;
export const PlanDraftPublish = Type.Object(
  { revision: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export const PUBLISH_STATES = ['running', 'succeeded', 'failed'] as const;
export const CatalogPublication = Type.Object(
  {
    id: Id('cpo'),
    draft_id: Id('pld'),
    plan_id: Type.String(),
    /** The plan version this publication creates. */
    version: Type.Integer({ minimum: 1 }),
    state: Type.Enum(PUBLISH_STATES),
    /** Provider product and prices (immutable; reused when the same amount was published before). */
    provider_product_id: Nullable(Type.String()),
    prices: Type.Array(
      Type.Object(
        {
          interval: Type.Enum(PRICE_INTERVALS),
          currency: Currency,
          amount_minor: Type.Integer(),
          provider_price_id: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    error: Nullable(Type.String()),
    started_by: Id('usr'),
    started_at: Timestamp,
    finished_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type CatalogPublication = Static<typeof CatalogPublication>;

export const PublishedPlan = Type.Object(
  {
    id: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    name: Type.String(),
    description: Type.String(),
    purchasable: Type.Boolean(),
    trial_days: Nullable(Type.Integer()),
    limits: Limits,
    features: Features,
    /** `seed`: from the code's bootstrap catalog; `admin`: published from a draft. */
    source: Type.Enum(['seed', 'admin']),
    /** The newest version of this plan (new purchases use it). */
    current: Type.Boolean(),
    prices: Type.Array(
      Type.Object(
        {
          interval: Type.Enum(PRICE_INTERVALS),
          currency: Currency,
          amount_minor: Type.Integer(),
          provider_price_id: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    /** Workspaces on this exact version (they keep it and its price until they change plan). */
    subscribers: Type.Integer({ minimum: 0 }),
    published_at: Timestamp,
    published_by: Nullable(Id('usr')),
  },
  { additionalProperties: false },
);
export type PublishedPlan = Static<typeof PublishedPlan>;
export const AdminCatalog = Type.Object(
  {
    /** Increases with every publication (caches of the pricing page revalidate). */
    generation: Type.Integer({ minimum: 0 }),
    plans: Type.Array(PublishedPlan),
    drafts: Type.Array(PlanDraft),
    publications: Type.Array(CatalogPublication),
    /** Whether a payment provider is configured (publishing prices needs it). */
    provider: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AdminCatalog = Static<typeof AdminCatalog>;

// ================================================================ operations
export const AdminOperations = Type.Object(
  {
    generated_at: Timestamp,
    server: Type.Object(
      {
        api_version: Type.String(),
        environment: Type.String(),
        database_migration: Nullable(Type.String()),
        worker_last_seen: Nullable(Timestamp),
      },
      { additionalProperties: false },
    ),
    webhooks: Type.Object(
      {
        pending: Type.Integer({ minimum: 0 }),
        failed: Type.Integer({ minimum: 0 }),
        oldest_pending: Nullable(Timestamp),
        recent_failures: Type.Array(
          Type.Object(
            {
              provider_event_id: Type.String(),
              type: Type.String(),
              org_id: Nullable(Id('org')),
              attempts: Type.Integer(),
              error: Nullable(Type.String()),
              received_at: Timestamp,
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    email: Type.Object(
      {
        configured: Type.Boolean(),
        pending: Type.Integer({ minimum: 0 }),
        failed: Type.Integer({ minimum: 0 }),
        sent_24h: Type.Integer({ minimum: 0 }),
        /** Failed e-mail (no addresses or contents), newest first. */
        recent_failures: Type.Array(
          Type.Object(
            {
              id: Id('eml'),
              kind: Type.String(),
              org_id: Nullable(Id('org')),
              attempts: Type.Integer(),
              error: Nullable(Type.String()),
              created_at: Timestamp,
              /** Whether it can still be retried (its encrypted contents are kept until it is sent or expires). */
              retryable: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    /** People waiting for an answer: account deletion requests (handled under the owner's policy) and contact forms. */
    inbox: Type.Object(
      {
        deletion_requests_pending: Type.Integer({ minimum: 0 }),
        contact_requests_unhandled: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    outbox: Type.Object(
      {
        pending: Type.Integer({ minimum: 0 }),
        retrying: Type.Integer({ minimum: 0 }),
        oldest_pending: Nullable(Timestamp),
      },
      { additionalProperties: false },
    ),
    backups: Type.Object(
      {
        /** Newest committed profile backup on this server. */
        last_profile_backup: Nullable(Timestamp),
        /** Off-site database backup status, when the server's backup timer reports it. */
        offsite: Nullable(
          Type.Object(
            { last_success: Nullable(Timestamp), status: Type.String() },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    release: Type.Object(
      {
        status: Type.String(),
        version: Nullable(Type.String()),
        checked_at: Nullable(Timestamp),
        requests: Type.Array(
          Type.Object(
            {
              id: Id('rlr'),
              action: Type.String(),
              reason: Type.String(),
              state: Type.String(),
              requested_by: Id('usr'),
              created_at: Timestamp,
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type AdminOperations = Static<typeof AdminOperations>;

export const RELEASE_ACTIONS = ['pause_channel', 'resume_channel', 'publish_version'] as const;
export const ReleaseActionRequest = Type.Object(
  {
    action: Type.Enum(RELEASE_ACTIONS),
    /** For `publish_version`: the version the signed pipeline built. */
    version: Type.Optional(Type.String({ pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' })),
    reason: Reason,
  },
  { additionalProperties: false },
);

export const AdminStaffMember = Type.Object(
  {
    user_id: Id('usr'),
    display_name: Type.String(),
    email: Nullable(Type.String()),
    roles: Type.Array(Type.Enum(STAFF_ROLES)),
    disabled: Type.Boolean(),
    last_sign_in: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type AdminStaffMember = Static<typeof AdminStaffMember>;
export const AdminStaff = Type.Object(
  {
    items: Type.Array(AdminStaffMember),
    mapping_version: Type.Integer(),
    role_permissions: Type.Record(Type.Enum(STAFF_ROLES), Type.Array(Type.Enum(STAFF_PERMISSIONS))),
  },
  { additionalProperties: false },
);
export type AdminStaff = Static<typeof AdminStaff>;

/** What the console shows the signed-in staff member about their own access. */
export const AdminMe = Type.Object(
  {
    roles: Type.Array(Type.Enum(STAFF_ROLES)),
    permissions: Type.Array(Type.Enum(STAFF_PERMISSIONS)),
    /** Whether this console session was opened with a second factor (admin routes need it). */
    mfa: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AdminMe = Static<typeof AdminMe>;
