import type {
  BillingAlertKind,
  BillingReason,
  BillingState,
  OverrideScope,
  PlanLimitKey,
  StaffRole,
  SupportAccessScope,
} from '@pb/contracts/billing';

export const STATE_LABEL: Record<BillingState, string> = {
  trial: 'Trial',
  active: 'Active',
  past_due: 'Past due',
  grace: 'Grace period',
  restricted: 'Restricted',
  canceled: 'Canceled',
};

export const REASON_LABEL: Record<BillingReason, string> = {
  trial: 'trial',
  trial_ended: 'trial ended',
  paid: 'paid',
  payment_failed: 'payment failed',
  payment_retries_exhausted: 'payment retries exhausted',
  renewal_unconfirmed: 'renewal not confirmed',
  grace_ended: 'grace period ended',
  canceled_by_customer: 'canceled by the customer',
  paused: 'paused at the provider',
  no_subscription: 'no subscription',
  complimentary: 'complimentary',
};

export const ROLE_LABEL: Record<StaffRole, string> = {
  support: 'Support',
  support_lead: 'Support lead',
  billing_admin: 'Billing admin',
};

export const ACCESS_LABEL: Record<SupportAccessScope, string> = {
  members: 'Members',
  activity: 'Activity log',
};

export const LIMIT_LABEL: Record<PlanLimitKey, string> = {
  profiles: 'Profiles',
  seats: 'Seats (members and pending invitations)',
  storage_bytes: 'Backup storage',
  automation_concurrency: 'Automation jobs at a time',
};

export const OVERRIDE_LABEL: Record<OverrideScope, string> = {
  'limit.profiles': 'Profile limit',
  'limit.seats': 'Seat limit',
  'limit.storage_bytes': 'Backup storage limit',
  'limit.automation_concurrency': 'Automation jobs at a time',
  'feature.team_sessions': 'Shared profiles',
  'feature.automation': 'Automation',
  'feature.api_tokens': 'API tokens',
  'feature.webhooks': 'Webhooks',
  'access.unrestricted': 'Unrestricted access',
};

export const ALERT_LABEL: Record<BillingAlertKind, string> = {
  webhook_backlog: 'Provider events waiting',
  event_failed: 'Provider event failing',
  unknown_customer: 'Unknown customer',
  unknown_price: 'Unknown price',
  duplicate_subscriptions: 'Duplicate subscriptions',
  paid_not_active: 'Paid but not active',
  missed_webhook: 'Missed provider event',
  dispute: 'Payment dispute',
  refund: 'Refund',
  signature_failures: 'Signature failures',
  resync_failed: 'Resync failing',
  break_glass_used: 'Break-glass access',
};

export function when(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function day(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Amounts in the currency's minor unit, formatted with the currency's own number of decimals. */
export function money(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(minor / 10 ** digits);
  } catch {
    return `${(minor / 100).toFixed(2)} ${code}`;
  }
}

export function limitValue(key: PlanLimitKey, n: number | null): string {
  if (n === null) return 'No limit';
  return key === 'storage_bytes' ? bytes(n) : String(n);
}

export function overrideValue(scope: OverrideScope, v: number | boolean | null): string {
  if (scope === 'access.unrestricted') return 'Full access';
  if (scope.startsWith('feature.')) return v ? 'On' : 'Off';
  if (v === null) return 'No limit';
  return scope === 'limit.storage_bytes' && typeof v === 'number' ? bytes(v) : String(v);
}

export function minutesLeft(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}
