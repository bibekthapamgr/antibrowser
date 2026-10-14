/**
 * Billing, plan limits and support access (milestone 11, ADR-0018). Browser-safe: no Node imports.
 *
 * - The plan catalog is versioned and lives here; `plan@version` is immutable once released (the migration script
 *   refuses a changed version). Limit numbers are PROVISIONAL placeholders for the owner to set from the cost
 *   worksheet and pilot feedback. No price amount exists in the code: prices live in the payment provider only.
 * - The database decides what an organization may do (`app.billing_effective`); nothing caches a grant. A billing
 *   state only narrows what roles and grants already allow, and an unavailable provider never changes permissions.
 * - Restricted and canceled organizations keep their data and can still read, close, back up, export, delete and
 *   manage billing; they cannot create or open (RESTRICTED_ACTIONS).
 */
import Type, { type Static, type TSchema } from 'typebox';
import { ID_PATTERN } from './ids.ts';

const Id = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const Timestamp = Type.String({ format: 'date-time', description: 'UTC, RFC 3339' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

// ================================================================ Catalog
export const PLAN_LIMIT_KEYS = ['profiles', 'seats', 'storage_bytes', 'automation_concurrency'] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
/** `null`: no limit. */
export type PlanLimits = Record<PlanLimitKey, number | null>;

export const PLAN_FEATURES = ['team_sessions', 'automation', 'api_tokens', 'webhooks'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];
export type PlanFeatures = Record<PlanFeature, boolean>;

export interface PlanDefinition {
  /** Lowercase identifier, stable across versions. */
  id: string;
  version: number;
  name: string;
  description: string;
  /** Offered through checkout (when a provider price is configured for `id@version`). */
  purchasable: boolean;
  /** Days of a trial (only the trial plan). */
  trialDays: number | null;
  limits: PlanLimits;
  features: PlanFeatures;
}

const GiB = 1024 ** 3;
const ALL: PlanFeatures = { team_sessions: true, automation: true, api_tokens: true, webhooks: true };

/**
 * The catalog. PROVISIONAL limits (ADR-0018): to be set by the owner before charging anyone. Changing a released
 * version is refused by the migration script; add a new version instead (organizations keep the version they bought).
 */
export const PLAN_CATALOG: readonly PlanDefinition[] = [
  {
    id: 'trial',
    version: 1,
    name: 'Trial',
    description: 'Every new organization: 14 days with team features.',
    purchasable: false,
    trialDays: 14,
    limits: { profiles: 100, seats: 5, storage_bytes: 10 * GiB, automation_concurrency: 2 },
    features: ALL,
  },
  {
    id: 'starter',
    version: 1,
    name: 'Starter',
    description: 'One person.',
    purchasable: true,
    trialDays: null,
    limits: { profiles: 100, seats: 1, storage_bytes: 10 * GiB, automation_concurrency: 1 },
    features: { ...ALL, team_sessions: false },
  },
  {
    id: 'team',
    version: 1,
    name: 'Team',
    description: 'A small team sharing profiles.',
    purchasable: true,
    trialDays: null,
    limits: { profiles: 500, seats: 5, storage_bytes: 50 * GiB, automation_concurrency: 5 },
    features: ALL,
  },
  {
    id: 'agency',
    version: 1,
    name: 'Agency',
    description: 'Larger teams and many clients.',
    purchasable: true,
    trialDays: null,
    limits: { profiles: 2000, seats: 20, storage_bytes: 200 * GiB, automation_concurrency: 20 },
    features: ALL,
  },
  {
    id: 'beta',
    version: 1,
    name: 'Beta',
    description: 'Organizations created during the team beta (before billing existed).',
    purchasable: false,
    trialDays: null,
    limits: { profiles: 500, seats: 10, storage_bytes: 20 * GiB, automation_concurrency: 5 },
    features: ALL,
  },
  {
    id: 'internal',
    version: 1,
    name: 'Internal',
    description: 'Staff and test organizations. Not for customers.',
    purchasable: false,
    trialDays: null,
    limits: { profiles: null, seats: null, storage_bytes: null, automation_concurrency: null },
    features: ALL,
  },
];

export const PLAN_ID_PATTERN = '^[a-z][a-z0-9_]{1,31}$';
export const planKey = (id: string, version: number): string => `${id}@${version}`;

export function catalogPlan(id: string, version: number): PlanDefinition | undefined {
  return PLAN_CATALOG.find((p) => p.id === id && p.version === version);
}

/** The newest version of a plan. */
export function latestPlan(id: string): PlanDefinition | undefined {
  return PLAN_CATALOG.filter((p) => p.id === id).sort((a, b) => b.version - a.version)[0];
}

// ================================================================ Lifecycle
export const BILLING_STATES = ['trial', 'active', 'past_due', 'grace', 'restricted', 'canceled'] as const;
export type BillingState = (typeof BILLING_STATES)[number];

/** Why an organization is in its state (shown with the action required). */
export const BILLING_REASONS = [
  'trial',
  'trial_ended',
  'paid',
  'payment_failed',
  'payment_retries_exhausted',
  'renewal_unconfirmed',
  'grace_ended',
  'canceled_by_customer',
  'paused',
  'no_subscription',
  /** Beta and internal organizations: no charge. */
  'complimentary',
] as const;
export type BillingReason = (typeof BILLING_REASONS)[number];

/** States in which RESTRICTED_ACTIONS are refused. */
export const BLOCKING_STATES: readonly BillingState[] = ['restricted', 'canceled'];

export const BILLING_TIMING = {
  trialDays: 14,
  /** After the provider stops retrying a failed payment. */
  graceDays: 7,
  /** After the period end without a confirmed renewal: treated as grace (never restricted at once). */
  renewalConfirmHours: 72,
  /** After the period end without a confirmed renewal: restricted. */
  renewalMaxDays: 10,
  /** Longest sensitive support access. */
  supportAccessMaxMinutes: 240,
  /** Longest entitlement override. */
  overrideMaxDays: 90,
  /** Staff console session. */
  staffSessionMinutes: 30,
} as const;

/**
 * What a restricted or canceled organization cannot do. Everything else stays available: reading, closing profiles,
 * releasing sessions, backing up and committing backups, downloading and restoring backups, configuration export,
 * deleting, removing members and revoking invitations, and billing.
 */
export const RESTRICTED_ACTIONS = [
  'profile.create',
  'profile.open',
  'trash.restore',
  'client.create',
  'member.invite',
  'token.create',
  'webhook.create',
  'automation.create',
  'automation.claim',
  'import',
] as const;
export type RestrictedAction = (typeof RESTRICTED_ACTIONS)[number];

export function billingAllows(state: BillingState, _action: RestrictedAction): boolean {
  return !BLOCKING_STATES.includes(state);
}

// ================================================================ Overrides (staff, billing_admin only)
export const OVERRIDE_SCOPES = [
  'limit.profiles',
  'limit.seats',
  'limit.storage_bytes',
  'limit.automation_concurrency',
  'feature.team_sessions',
  'feature.automation',
  'feature.api_tokens',
  'feature.webhooks',
  /** Keeps full access (no restriction) until the override expires, whatever the payment state. */
  'access.unrestricted',
] as const;
export type OverrideScope = (typeof OVERRIDE_SCOPES)[number];

/** The value an override scope takes: a limit (null = no limit), a feature switch, or true for access. */
export function overrideValueValid(scope: OverrideScope, value: unknown): boolean {
  if (scope.startsWith('limit.')) {
    return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  }
  if (scope === 'access.unrestricted') return value === true;
  return typeof value === 'boolean';
}

// ================================================================ Staff
export const STAFF_ROLES = ['support', 'support_lead', 'billing_admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const SUPPORT_ACCESS_SCOPES = ['members', 'activity'] as const;
export type SupportAccessScope = (typeof SUPPORT_ACCESS_SCOPES)[number];

// ================================================================ Schemas: organization billing
const PlanId = Type.String({ pattern: PLAN_ID_PATTERN });
const Limits = Type.Object(
  {
    profiles: Nullable(Type.Integer({ minimum: 0 })),
    seats: Nullable(Type.Integer({ minimum: 0 })),
    storage_bytes: Nullable(Type.Number({ minimum: 0 })),
    automation_concurrency: Nullable(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
const Features = Type.Object(
  {
    team_sessions: Type.Boolean(),
    automation: Type.Boolean(),
    api_tokens: Type.Boolean(),
    webhooks: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Shown to every member with the organization (no amounts, no provider references). */
export const BillingSummary = Type.Object(
  {
    plan_id: PlanId,
    plan_name: Type.String(),
    state: Type.Enum(BILLING_STATES),
    reason: Type.Enum(BILLING_REASONS),
    /** When the current state ends by itself (trial end, grace end, period end of a canceled subscription). */
    until: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type BillingSummary = Static<typeof BillingSummary>;

const Price = Type.Object(
  {
    amount_minor: Type.Integer({
      description: 'In the currency’s smallest unit, as configured in the provider.',
    }),
    currency: Type.String({ pattern: '^[a-z]{3}$' }),
    interval: Type.Union([Type.Literal('month'), Type.Literal('year')]),
  },
  { additionalProperties: false },
);

export const BillingPlan = Type.Object(
  {
    id: PlanId,
    version: Type.Integer({ minimum: 1 }),
    name: Type.String(),
    description: Type.String(),
    limits: Limits,
    features: Features,
    /** Whether checkout can sell it on this server (a provider price is configured). */
    available: Type.Boolean(),
    /** From the provider; null when it could not be read (the checkout page always shows it). */
    price: Nullable(Price),
  },
  { additionalProperties: false },
);
export type BillingPlan = Static<typeof BillingPlan>;
export const BillingPlans = Type.Object({ items: Type.Array(BillingPlan) }, { additionalProperties: false });

const Usage = Type.Object(
  {
    profiles: Type.Integer({ minimum: 0 }),
    seats: Type.Integer({ minimum: 0, description: 'Members plus pending invitations.' }),
    storage_bytes: Type.Number({ minimum: 0 }),
    automation_running: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const Subscription = Type.Object(
  {
    org_id: Id('org'),
    plan: Type.Object(
      { id: PlanId, version: Type.Integer({ minimum: 1 }), name: Type.String() },
      { additionalProperties: false },
    ),
    state: Type.Enum(BILLING_STATES),
    reason: Type.Enum(BILLING_REASONS),
    until: Nullable(Timestamp),
    trial_ends_at: Nullable(Timestamp),
    current_period_end: Nullable(Timestamp),
    cancel_at_period_end: Type.Boolean(),
    grace_until: Nullable(Timestamp),
    /** Whether a provider subscription exists (manage it in the portal). */
    has_provider_subscription: Type.Boolean(),
    limits: Limits,
    features: Features,
    usage: Usage,
    /** Limits currently exceeded (after a downgrade): creation stops, nothing is removed. */
    over_limits: Type.Array(Type.Enum(PLAN_LIMIT_KEYS)),
    /** Overrides in force (staff-granted), without who or why. */
    overrides: Type.Array(
      Type.Object(
        { scope: Type.Enum(OVERRIDE_SCOPES), expires_at: Timestamp },
        { additionalProperties: false },
      ),
    ),
    /** What happens to data after cancellation (the owner's policy; null: kept until an owner deletes it). */
    retention_days: Nullable(Type.Integer({ minimum: 1 })),
    synced_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type Subscription = Static<typeof Subscription>;

export const CheckoutRequest = Type.Object({ plan_id: PlanId }, { additionalProperties: false });
export const HostedSession = Type.Object(
  {
    url: Type.String({
      format: 'uri',
      description: 'Hosted page of the payment provider; open it in a browser.',
    }),
    expires_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type HostedSession = Static<typeof HostedSession>;

export const USAGE_TYPES = [
  'snapshot_committed',
  'automation_job',
  'api_requests',
  'storage_bytes',
  'active_profiles',
  'seats',
] as const;
export type UsageType = (typeof USAGE_TYPES)[number];

export const BillingUsage = Type.Object(
  {
    period_start: Timestamp,
    period_end: Timestamp,
    current: Usage,
    limits: Limits,
    totals: Type.Array(
      Type.Object(
        { type: Type.Enum(USAGE_TYPES), quantity: Type.Number(), events: Type.Integer({ minimum: 0 }) },
        { additionalProperties: false },
      ),
    ),
    daily: Type.Array(
      Type.Object(
        { day: Type.String({ format: 'date' }), type: Type.Enum(USAGE_TYPES), quantity: Type.Number() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type BillingUsage = Static<typeof BillingUsage>;

export const INVOICE_STATES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;
export const Invoice = Type.Object(
  {
    id: Type.String({ pattern: '^in_[A-Za-z0-9]{1,64}$' }),
    number: Nullable(Type.String()),
    status: Type.Enum(INVOICE_STATES),
    currency: Type.String({ pattern: '^[a-z]{3}$' }),
    amount_due_minor: Type.Integer(),
    amount_paid_minor: Type.Integer(),
    created_at: Timestamp,
    period_start: Nullable(Timestamp),
    period_end: Nullable(Timestamp),
    /** The receipt / invoice pages are opened by the desktop shell, never inside the manager. */
    has_hosted_page: Type.Boolean(),
    has_pdf: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type Invoice = Static<typeof Invoice>;
export const Invoices = Type.Object({ items: Type.Array(Invoice) }, { additionalProperties: false });
export const InvoiceLinks = Type.Object(
  { hosted_url: Nullable(Type.String({ format: 'uri' })), pdf_url: Nullable(Type.String({ format: 'uri' })) },
  { additionalProperties: false },
);

// ================================================================ Schemas: support console
export const StaffSessionRequest = Type.Object(
  {
    id_token: Type.String({
      minLength: 20,
      maxLength: 8192,
      pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
    }),
    nonce: Type.String({ minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }),
  },
  { additionalProperties: false },
);
export const StaffSession = Type.Object(
  {
    access_token: Type.String(),
    token_type: Type.Literal('Bearer'),
    expires_in: Type.Integer(),
    staff: Type.Object(
      {
        user_id: Id('usr'),
        display_name: Type.String(),
        roles: Type.Array(Type.Enum(STAFF_ROLES)),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type StaffSession = Static<typeof StaffSession>;

export const ConsoleConfig = Type.Object(
  {
    issuer: Type.String(),
    client_id: Type.String(),
    authorization_endpoint: Type.String(),
    token_endpoint: Type.String(),
    scopes: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type ConsoleConfig = Static<typeof ConsoleConfig>;

export const SupportSearchQuery = Type.Object(
  {
    q: Type.String({
      minLength: 3,
      maxLength: 254,
      description: 'An organization id, a provider customer id, or a member’s exact e-mail address.',
    }),
  },
  { additionalProperties: false },
);
export const SupportOrgHit = Type.Object(
  { id: Id('org'), name: Type.String(), created_at: Timestamp, state: Type.Enum(BILLING_STATES) },
  { additionalProperties: false },
);
export type SupportOrgHit = Static<typeof SupportOrgHit>;
export const SupportSearchResult = Type.Object(
  {
    items: Type.Array(SupportOrgHit),
    matched_by: Type.Union([Type.Literal('org_id'), Type.Literal('customer_id'), Type.Literal('email')]),
  },
  { additionalProperties: false },
);
export type SupportSearchResult = Static<typeof SupportSearchResult>;

export const BILLING_ALERT_KINDS = [
  'webhook_backlog',
  'event_failed',
  'unknown_customer',
  'unknown_price',
  'duplicate_subscriptions',
  'paid_not_active',
  'missed_webhook',
  'dispute',
  'refund',
  'signature_failures',
] as const;
export type BillingAlertKind = (typeof BILLING_ALERT_KINDS)[number];

export const BillingAlert = Type.Object(
  {
    id: Id('alr'),
    kind: Type.Enum(BILLING_ALERT_KINDS),
    org_id: Nullable(Id('org')),
    ref: Nullable(Type.String()),
    detail: Type.String(),
    first_seen_at: Timestamp,
    last_seen_at: Timestamp,
    count: Type.Integer({ minimum: 1 }),
    resolved_at: Nullable(Timestamp),
    resolved_by: Nullable(Id('usr')),
  },
  { additionalProperties: false },
);
export type BillingAlert = Static<typeof BillingAlert>;

export const BillingEventSummary = Type.Object(
  {
    provider_event_id: Type.String(),
    type: Type.String(),
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('processed'),
      Type.Literal('ignored'),
      Type.Literal('failed'),
    ]),
    received_at: Timestamp,
    processed_at: Nullable(Timestamp),
    attempts: Type.Integer({ minimum: 0 }),
    error: Nullable(Type.String()),
  },
  { additionalProperties: false },
);
export type BillingEventSummary = Static<typeof BillingEventSummary>;

export const SupportOrgOverview = Type.Object(
  {
    id: Id('org'),
    name: Type.String(),
    created_at: Timestamp,
    subscription: Subscription,
    provider_customer_id: Nullable(Type.String()),
    provider_subscription_id: Nullable(Type.String()),
    member_count: Type.Integer({ minimum: 0 }),
    history: Type.Array(
      Type.Object(
        {
          at: Timestamp,
          from_state: Nullable(Type.Enum(BILLING_STATES)),
          to_state: Type.Enum(BILLING_STATES),
          plan_id: PlanId,
          plan_version: Type.Integer(),
          cause: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    invoices: Type.Array(Invoice),
    events: Type.Array(BillingEventSummary),
    alerts: Type.Array(BillingAlert),
    active_access: Type.Array(Type.Enum(SUPPORT_ACCESS_SCOPES)),
  },
  { additionalProperties: false },
);
export type SupportOrgOverview = Static<typeof SupportOrgOverview>;

export const ACCESS_REQUEST_STATES = ['pending', 'approved', 'denied', 'revoked', 'expired'] as const;
export const AccessRequest = Type.Object(
  {
    id: Id('sar'),
    org_id: Id('org'),
    scope: Type.Enum(SUPPORT_ACCESS_SCOPES),
    reason: Type.String(),
    duration_minutes: Type.Integer({ minimum: 5 }),
    state: Type.Enum(ACCESS_REQUEST_STATES),
    requested_by: Id('usr'),
    requested_by_name: Type.String(),
    decided_by: Nullable(Id('usr')),
    created_at: Timestamp,
    decided_at: Nullable(Timestamp),
    expires_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type AccessRequest = Static<typeof AccessRequest>;
export const AccessRequestCreate = Type.Object(
  {
    scope: Type.Enum(SUPPORT_ACCESS_SCOPES),
    reason: Type.String({ minLength: 20, maxLength: 500 }),
    duration_minutes: Type.Integer({ minimum: 5, maximum: BILLING_TIMING.supportAccessMaxMinutes }),
  },
  { additionalProperties: false },
);
export type AccessRequestCreate = Static<typeof AccessRequestCreate>;
export const AccessDecision = Type.Object(
  { decision: Type.Union([Type.Literal('approve'), Type.Literal('deny')]) },
  { additionalProperties: false },
);

export const SupportMember = Type.Object(
  {
    user_id: Id('usr'),
    display_name: Type.String(),
    email: Nullable(Type.String()),
    role: Type.String(),
    joined_at: Timestamp,
  },
  { additionalProperties: false },
);
export type SupportMember = Static<typeof SupportMember>;
export const SupportActivityEntry = Type.Object(
  {
    at: Timestamp,
    action: Type.String(),
    outcome: Type.String(),
    actor_user_id: Nullable(Id('usr')),
    target_type: Nullable(Type.String()),
  },
  { additionalProperties: false },
);
export type SupportActivityEntry = Static<typeof SupportActivityEntry>;

export const Override = Type.Object(
  {
    id: Id('ovr'),
    org_id: Id('org'),
    scope: Type.Enum(OVERRIDE_SCOPES),
    value: Type.Union([Type.Null(), Type.Boolean(), Type.Number()]),
    reason: Type.String(),
    created_by: Id('usr'),
    created_at: Timestamp,
    expires_at: Timestamp,
    revoked_at: Nullable(Timestamp),
  },
  { additionalProperties: false },
);
export type Override = Static<typeof Override>;
export const OverrideCreate = Type.Object(
  {
    scope: Type.Enum(OVERRIDE_SCOPES),
    value: Type.Union([Type.Null(), Type.Boolean(), Type.Integer({ minimum: 0 })]),
    reason: Type.String({ minLength: 20, maxLength: 500 }),
    expires_at: Timestamp,
  },
  { additionalProperties: false },
);
export type OverrideCreate = Static<typeof OverrideCreate>;

export const PlatformAuditEntry = Type.Object(
  {
    id: Id('aud'),
    at: Timestamp,
    actor_user_id: Nullable(Id('usr')),
    action: Type.String(),
    org_id: Nullable(Id('org')),
    target: Nullable(Type.String()),
    details: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type PlatformAuditEntry = Static<typeof PlatformAuditEntry>;

// ================================================================ Support console page
/** Where the API serves the support console (same origin as the API, so its requests need no CORS). */
export const CONSOLE_PATH = '/console/';

/**
 * Content-Security-Policy of the support console. Scripts and styles only from the console itself; the only other
 * origin it may contact is the identity provider (the PKCE code exchange at its token endpoint). No frames, no forms
 * posting elsewhere, no plugins, no base-URI changes.
 */
export function consoleCsp(issuerOrigin: string | null): string {
  const connect = ["'self'", ...(issuerOrigin ? [issuerOrigin] : [])].join(' ');
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}
