/**
 * Entitlements as the API uses them (milestone 11, ADR-0018). The database computes the effective state, limits and
 * features (`app.billing_effective`); this module reads them inside the request's transaction and turns them into
 * answers. Nothing is cached: a revoked override or an ended grace period applies to the very next request.
 */
import {
  ApiError,
  type BillingReason,
  type BillingState,
  type BillingSummary,
  BLOCKING_STATES,
  PLAN_LIMIT_KEYS,
  type PlanFeature,
  type PlanFeatures,
  type PlanLimitKey,
  type PlanLimits,
  type RestrictedAction,
  type Subscription,
} from '@pb/contracts';
import type pg from 'pg';
import { ts } from '../db.ts';

/** What resolveTenant attaches to every organization request (one query with the membership). */
export interface BillingAccess {
  state: BillingState;
  reason: BillingReason;
  until: string | null;
  blocked: boolean;
  planId: string;
  planName: string;
}

/** SQL fragment for resolveTenant: effective billing columns for organization `$1`. */
export const BILLING_ACCESS_COLUMNS = `e.state as billing_state, e.reason as billing_reason,
  ${ts('e.until')} as billing_until, e.blocked as billing_blocked, e.plan_id as billing_plan_id,
  e.plan_name as billing_plan_name`;

export function billingAccessOf(row: {
  billing_state: string;
  billing_reason: string;
  billing_until: string | null;
  billing_blocked: boolean;
  billing_plan_id: string;
  billing_plan_name: string;
}): BillingAccess {
  return {
    state: row.billing_state as BillingState,
    reason: row.billing_reason as BillingReason,
    until: row.billing_until,
    blocked: row.billing_blocked,
    planId: row.billing_plan_id,
    planName: row.billing_plan_name,
  };
}

export function billingSummary(b: BillingAccess): BillingSummary {
  return { plan_id: b.planId, plan_name: b.planName, state: b.state, reason: b.reason, until: b.until };
}

/** What a restricted or canceled organization may still do, for messages. */
const STILL_ALLOWED = ['read', 'close_profiles', 'back_up', 'export', 'delete', 'billing'] as const;

/**
 * Refuses RESTRICTED_ACTIONS while the organization is restricted or canceled (unless staff granted
 * `access.unrestricted`). Everything else — reading, closing, backing up, exporting, deleting, billing — stays.
 */
export function requireBillingAllows(access: { billing?: BillingAccess }, action: RestrictedAction): void {
  const b = access.billing;
  if (!b?.blocked) return;
  throw restrictedError(b.state, b.reason, action);
}

/** SUBSCRIPTION_RESTRICTED for a state, reason and refused action (also raised by the database as BILLING_RESTRICTED). */
export function restrictedError(state: string, reason: string, action: string): ApiError {
  return new ApiError(
    'SUBSCRIPTION_RESTRICTED',
    state === 'canceled'
      ? 'This organization’s subscription has ended. You can still close profiles, back up and export; an owner can subscribe again.'
      : 'This organization’s subscription needs attention. You can still close profiles, back up and export; an owner can fix it in Billing.',
    { state, reason, action, still_allowed: [...STILL_ALLOWED] },
  );
}

/** The database's BILLING_RESTRICTED (P0001, JSON detail) as SUBSCRIPTION_RESTRICTED. */
export function restrictedFromDatabase(detail: string | undefined): ApiError {
  let d: { state?: string; reason?: string; action?: string } = {};
  try {
    d = JSON.parse(detail ?? '{}') as typeof d;
  } catch {
    d = {};
  }
  return restrictedError(d.state ?? 'restricted', d.reason ?? 'no_subscription', d.action ?? 'unknown');
}

export interface Effective {
  state: BillingState;
  reason: BillingReason;
  until: string | null;
  blocked: boolean;
  unrestricted: boolean;
  planId: string;
  planVersion: number;
  planName: string;
  limits: PlanLimits;
  features: PlanFeatures;
}

export async function effectiveOf(c: pg.PoolClient, orgId: string): Promise<Effective> {
  const { rows } = await c.query<{
    state: BillingState;
    reason: BillingReason;
    until: string | null;
    blocked: boolean;
    unrestricted: boolean;
    plan_id: string;
    plan_version: number;
    plan_name: string;
    limits: Record<string, unknown>;
    features: Record<string, unknown>;
  }>(
    `select e.state, e.reason, ${ts('e.until')} as until, e.blocked, e.unrestricted, e.plan_id, e.plan_version,
            e.plan_name, e.limits, e.features
       from app.billing_effective($1) e`,
    [orgId],
  );
  const r = rows[0];
  if (!r) throw new ApiError('INTERNAL', 'Billing state unavailable');
  const limits = Object.fromEntries(
    PLAN_LIMIT_KEYS.map((k) => {
      const v = r.limits[k];
      return [k, typeof v === 'number' ? v : null];
    }),
  ) as PlanLimits;
  const features = {
    team_sessions: r.features.team_sessions === true,
    automation: r.features.automation === true,
    api_tokens: r.features.api_tokens === true,
    webhooks: r.features.webhooks === true,
  };
  return {
    state: r.state,
    reason: r.reason,
    until: r.until,
    blocked: r.blocked,
    unrestricted: r.unrestricted,
    planId: r.plan_id,
    planVersion: r.plan_version,
    planName: r.plan_name,
    limits,
    features,
  };
}

const FEATURE_MESSAGES: Record<PlanFeature, string> = {
  team_sessions: 'Your organization’s plan does not include shared profiles',
  automation: 'Your organization’s plan does not include automation',
  api_tokens: 'Your organization’s plan does not include API tokens',
  webhooks: 'Your organization’s plan does not include webhooks',
};

/** A plan feature (with overrides) must be on. */
export async function requireFeature(c: pg.PoolClient, orgId: string, feature: PlanFeature): Promise<void> {
  const e = await effectiveOf(c, orgId);
  if (!e.features[feature]) {
    throw new ApiError('ENTITLEMENT_REQUIRED', FEATURE_MESSAGES[feature], {
      entitlement: feature,
      plan: e.planId,
      remediation: ['upgrade'],
    });
  }
}

export interface Usage {
  profiles: number;
  seats: number;
  storage_bytes: number;
  automation_running: number;
}

export async function usageOf(c: pg.PoolClient, orgId: string): Promise<Usage> {
  const { rows } = await c.query<Usage>(
    `select (select count(*) from profiles where org_id = $1 and deleted_at is null)::int as profiles,
            app.billing_seats_used($1)::int as seats,
            app.billing_storage_used($1)::float8 as storage_bytes,
            (select count(*) from automation_jobs where org_id = $1 and state in ('CLAIMED', 'RUNNING'))::int
              as automation_running`,
    [orgId],
  );
  const u = rows[0];
  if (!u) throw new ApiError('INTERNAL', 'Usage unavailable');
  return u;
}

const USAGE_OF_LIMIT: Record<PlanLimitKey, keyof Usage> = {
  profiles: 'profiles',
  seats: 'seats',
  storage_bytes: 'storage_bytes',
  automation_concurrency: 'automation_running',
};

/** Limits currently exceeded (after a downgrade): creation stops, nothing is removed. */
export function overLimits(limits: PlanLimits, usage: Usage): PlanLimitKey[] {
  return PLAN_LIMIT_KEYS.filter((k) => {
    const lim = limits[k];
    return lim !== null && usage[USAGE_OF_LIMIT[k]] > lim;
  });
}

export async function subscriptionView(
  c: pg.PoolClient,
  orgId: string,
  retentionDays: number | null,
): Promise<Subscription> {
  const e = await effectiveOf(c, orgId);
  const usage = await usageOf(c, orgId);
  const { rows } = await c.query<{
    trial_ends_at: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    grace_until: string | null;
    has_provider_subscription: boolean;
    synced_at: string | null;
  }>(
    `select ${ts('trial_ends_at')} as trial_ends_at, ${ts('current_period_end')} as current_period_end,
            cancel_at_period_end, ${ts('grace_until')} as grace_until,
            provider_subscription_id is not null as has_provider_subscription, ${ts('synced_at')} as synced_at
       from subscriptions where org_id = $1`,
    [orgId],
  );
  const s = rows[0];
  const overrides = await c.query<{ scope: Subscription['overrides'][number]['scope']; expires_at: string }>(
    `select distinct on (scope) scope, ${ts('expires_at')} as expires_at from entitlement_overrides
      where org_id = $1 and revoked_at is null and expires_at > now() order by scope, created_at desc`,
    [orgId],
  );
  return {
    org_id: orgId,
    plan: { id: e.planId, version: e.planVersion, name: e.planName },
    state: e.state,
    reason: e.reason,
    until: e.until,
    trial_ends_at: s?.trial_ends_at ?? null,
    current_period_end: s?.current_period_end ?? null,
    cancel_at_period_end: s?.cancel_at_period_end ?? false,
    grace_until: s?.grace_until ?? null,
    has_provider_subscription: s?.has_provider_subscription ?? false,
    limits: e.limits,
    features: e.features,
    usage,
    over_limits: overLimits(e.limits, usage),
    overrides: overrides.rows,
    retention_days: retentionDays,
    synced_at: s?.synced_at ?? null,
  };
}

/** PLAN_LIMIT raised by the limit triggers -> PLAN_LIMIT_REACHED with what to do. */
export function planLimitError(detail: string | undefined): ApiError {
  let d: { limit?: string; used?: number; allowed?: number } = {};
  try {
    d = JSON.parse(detail ?? '{}') as typeof d;
  } catch {
    d = {};
  }
  const limit = (PLAN_LIMIT_KEYS as readonly string[]).includes(d.limit ?? '')
    ? (d.limit as PlanLimitKey)
    : null;
  const what =
    limit === 'profiles'
      ? 'profiles'
      : limit === 'seats'
        ? 'seats (members and pending invitations)'
        : limit === 'storage_bytes'
          ? 'backup storage'
          : 'automation capacity';
  const remediation =
    limit === 'seats'
      ? ['upgrade', 'remove_members', 'revoke_invitations']
      : limit === 'profiles'
        ? ['upgrade', 'delete_profiles']
        : ['upgrade'];
  return new ApiError(
    'PLAN_LIMIT_REACHED',
    `Your organization’s plan allows ${d.allowed ?? 'no more'} ${what}; it uses ${d.used ?? 'all of them'}.`,
    { limit, used: d.used ?? null, allowed: d.allowed ?? null, remediation },
  );
}

export const isBlocking = (state: BillingState): boolean => BLOCKING_STATES.includes(state);
