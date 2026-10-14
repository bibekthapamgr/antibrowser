/**
 * In-memory stand-in for the milestone 11 billing API (UI development and UI tests only): the subscription, plans,
 * usage and invoices, following services/api closely enough for the screens (the shared plan catalog, permissions
 * from the shared matrix, the same states and reasons). Choosing a plan "opens checkout" and the demo provider
 * confirms a moment later, the way the real server learns of a payment from the provider. `simulate` puts the
 * organization in another state for screenshots and tests.
 */
import {
  type BillingPlan,
  type BillingReason,
  type BillingState,
  type BillingSummary,
  type BillingUsage,
  type Invoice,
  latestPlan,
  PLAN_CATALOG,
  type PlanDefinition,
  type Subscription,
} from '@pb/contracts/billing';
import type { Permission, Role } from '@pb/contracts/resources';
import { ROLE_PERMISSIONS } from '@pb/contracts/resources';
import type { BillingRepository, CloudRequest } from './types.ts';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Demo prices for the screens (not the product's prices, which live in the payment provider). */
const DEMO_PRICE: Record<string, number> = { starter: 1900, team: 4900, agency: 14900 };

export interface DemoBillingOrg {
  id: string;
  members: Map<string, { role: Role }>;
  profiles: { deleted: boolean }[];
  invitations: { accepted_at: string | null; revoked: boolean; expires_at: string }[];
  snapshots: { ciphertext_size: number }[];
}

interface State {
  plan: PlanDefinition;
  state: BillingState;
  reason: BillingReason;
  trialEnds: number | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: number | null;
  provider: boolean;
  invoices: Invoice[];
}

type Res = { status: number; body: unknown };

export function demoBilling(deps: {
  meId: string;
  orgs: () => DemoBillingOrg[];
  err: (status: number, code: string, message: string, details?: Record<string, unknown>) => Res;
}) {
  const states = new Map<string, State>();
  const role = (org: DemoBillingOrg) => org.members.get(deps.meId)?.role ?? null;
  const allows = (org: DemoBillingOrg, p: Permission) => {
    const r = role(org);
    return !!r && ROLE_PERMISSIONS[r].includes(p);
  };

  const stateOf = (org: DemoBillingOrg): State => {
    let s = states.get(org.id);
    if (!s) {
      s = {
        plan: latestPlan('trial') as PlanDefinition,
        state: 'trial',
        reason: 'trial',
        trialEnds: Date.now() + 10 * DAY,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        graceUntil: null,
        provider: false,
        invoices: [],
      };
      states.set(org.id, s);
    }
    return s;
  };

  const until = (s: State): string | null => {
    if (s.state === 'trial') return s.trialEnds ? iso(s.trialEnds) : null;
    if (s.state === 'grace') return s.graceUntil ? iso(s.graceUntil) : null;
    if (s.state === 'active' && s.cancelAtPeriodEnd && s.periodEnd) return iso(s.periodEnd);
    return null;
  };

  const usage = (org: DemoBillingOrg) => ({
    profiles: org.profiles.filter((p) => !p.deleted).length,
    seats:
      org.members.size +
      org.invitations.filter((i) => !i.accepted_at && !i.revoked && Date.parse(i.expires_at) > Date.now())
        .length,
    storage_bytes: org.snapshots.reduce((n, s) => n + s.ciphertext_size, 0),
    automation_running: 0,
  });

  const summary = (org: DemoBillingOrg): BillingSummary => {
    const s = stateOf(org);
    return { plan_id: s.plan.id, plan_name: s.plan.name, state: s.state, reason: s.reason, until: until(s) };
  };

  const subscription = (org: DemoBillingOrg): Subscription => {
    const s = stateOf(org);
    const u = usage(org);
    const over = (['profiles', 'seats', 'storage_bytes'] as const).filter((k) => {
      const lim = s.plan.limits[k];
      return lim !== null && u[k] > lim;
    });
    return {
      org_id: org.id,
      plan: { id: s.plan.id, version: s.plan.version, name: s.plan.name },
      state: s.state,
      reason: s.reason,
      until: until(s),
      trial_ends_at: s.trialEnds ? iso(s.trialEnds) : null,
      current_period_end: s.periodEnd ? iso(s.periodEnd) : null,
      cancel_at_period_end: s.cancelAtPeriodEnd,
      grace_until: s.graceUntil ? iso(s.graceUntil) : null,
      has_provider_subscription: s.provider,
      limits: s.plan.limits,
      features: s.plan.features,
      usage: u,
      over_limits: over,
      overrides: [],
      retention_days: null,
      synced_at: s.provider ? iso(Date.now() - 3_600_000) : null,
    };
  };

  const plans = (org: DemoBillingOrg): BillingPlan[] => {
    const s = stateOf(org);
    const offered = [...new Set(PLAN_CATALOG.filter((p) => p.purchasable).map((p) => p.id))]
      .map((id) => latestPlan(id))
      .filter((p): p is PlanDefinition => p !== undefined);
    const list = offered.some((p) => p.id === s.plan.id) ? offered : [s.plan, ...offered];
    return list.map((p) => ({
      id: p.id,
      version: p.version,
      name: p.name,
      description: p.description,
      limits: p.limits,
      features: p.features,
      available: p.purchasable,
      price: DEMO_PRICE[p.id]
        ? { amount_minor: DEMO_PRICE[p.id] as number, currency: 'usd', interval: 'month' }
        : null,
    }));
  };

  const usageView = (org: DemoBillingOrg): BillingUsage => {
    const s = stateOf(org);
    const end = s.periodEnd ?? Date.now() + 20 * DAY;
    const start = end - 30 * DAY;
    const u = usage(org);
    return {
      period_start: iso(start),
      period_end: iso(end),
      current: u,
      limits: s.plan.limits,
      totals: [
        { type: 'snapshot_committed', quantity: u.storage_bytes, events: org.snapshots.length },
        { type: 'automation_job', quantity: 6, events: 6 },
        { type: 'api_requests', quantity: 412, events: 9 },
      ],
      daily: [],
    };
  };

  const invoice = (s: State, plan: PlanDefinition, paid: boolean, at: number): Invoice => ({
    id: `in_demo${Math.random().toString(36).slice(2, 12)}`,
    number: `DEMO-${String(s.invoices.length + 1).padStart(4, '0')}`,
    status: paid ? 'paid' : 'open',
    currency: 'usd',
    amount_due_minor: DEMO_PRICE[plan.id] ?? 0,
    amount_paid_minor: paid ? (DEMO_PRICE[plan.id] ?? 0) : 0,
    created_at: iso(at),
    period_start: iso(at),
    period_end: iso(at + 30 * DAY),
    has_hosted_page: true,
    has_pdf: true,
  });

  function route(org: DemoBillingOrg, req: CloudRequest, parts: string[]): Res | null {
    if (parts[2] !== 'billing') return null;
    if (req.method !== 'GET') return deps.err(404, 'NOT_FOUND', 'Route not found');
    if (!allows(org, 'billing.read')) {
      return deps.err(403, 'FORBIDDEN', 'Your role does not allow this action', {
        permission: 'billing.read',
      });
    }
    switch (parts[3]) {
      case 'subscription':
        return { status: 200, body: subscription(org) };
      case 'plans':
        return { status: 200, body: { items: plans(org) } };
      case 'usage':
        return { status: 200, body: usageView(org) };
      case 'invoices':
        return { status: 200, body: { items: stateOf(org).invoices } };
      default:
        return deps.err(404, 'NOT_FOUND', 'Route not found');
    }
  }

  const byId = (orgId: string) => deps.orgs().find((o) => o.id === orgId);
  const refuse = (code: string, message: string) => Promise.reject({ code, message });

  /** What this computer's shell would do: here, "the provider" confirms a checkout a moment later. */
  const computer: BillingRepository & { opened: string[] } = {
    opened: [],
    async openCheckout(orgId, planId) {
      const org = byId(orgId);
      if (!org || !allows(org, 'billing.manage')) {
        return refuse('BILLING_FORBIDDEN', 'Only the organization’s owners can change its subscription.');
      }
      const s = stateOf(org);
      if (s.provider && s.state !== 'canceled') {
        return refuse(
          'ALREADY_SUBSCRIBED',
          'This organization already has a subscription. Change the plan in the billing portal.',
        );
      }
      const plan = latestPlan(planId);
      if (!plan?.purchasable)
        return refuse('PLAN_NOT_AVAILABLE', 'This plan cannot be bought on this server yet.');
      computer.opened.push(`checkout:${planId}`);
      setTimeout(() => {
        const at = Date.now();
        Object.assign(s, {
          plan,
          state: 'active',
          reason: 'paid',
          trialEnds: null,
          periodEnd: at + 30 * DAY,
          cancelAtPeriodEnd: false,
          graceUntil: null,
          provider: true,
        } satisfies Partial<State>);
        s.invoices.unshift(invoice(s, plan, true, at));
      }, 1200);
      return null;
    },
    async openPortal(orgId) {
      const org = byId(orgId);
      if (!org || !allows(org, 'billing.manage')) {
        return refuse('BILLING_FORBIDDEN', 'Only the organization’s owners can change its subscription.');
      }
      computer.opened.push('portal');
      return null;
    },
    async openInvoice(orgId, invoiceId, pdf) {
      const org = byId(orgId);
      if (!org || !allows(org, 'billing.read')) return refuse('BILLING_FORBIDDEN', 'Not allowed.');
      computer.opened.push(`invoice:${invoiceId}:${pdf ? 'pdf' : 'page'}`);
      return null;
    },
  };

  /** Screens and tests: put the first organization (or one by id) in a state, with a paid history where it fits. */
  function simulate(state: BillingState, orgId?: string) {
    const org = orgId ? byId(orgId) : deps.orgs().find((o) => role(o) === 'owner');
    if (!org) return;
    const s = stateOf(org);
    const team = latestPlan('team') as PlanDefinition;
    const at = Date.now();
    if (state !== 'trial' && s.invoices.length === 0) {
      s.invoices.push(invoice(s, team, true, at - 32 * DAY), invoice(s, team, true, at - 62 * DAY));
    }
    const base = {
      plan: state === 'trial' ? s.plan : team,
      provider: state !== 'trial',
      cancelAtPeriodEnd: false,
    };
    const next: Record<BillingState, Partial<State>> = {
      trial: { state: 'trial', reason: 'trial', trialEnds: at + 2 * DAY, periodEnd: null, graceUntil: null },
      active: {
        state: 'active',
        reason: 'paid',
        trialEnds: null,
        periodEnd: at + 12 * DAY,
        graceUntil: null,
      },
      past_due: {
        state: 'past_due',
        reason: 'payment_failed',
        trialEnds: null,
        periodEnd: at - DAY,
        graceUntil: null,
      },
      grace: {
        state: 'grace',
        reason: 'payment_retries_exhausted',
        trialEnds: null,
        periodEnd: at - 5 * DAY,
        graceUntil: at + 4 * DAY,
      },
      restricted: {
        state: 'restricted',
        reason: 'grace_ended',
        trialEnds: null,
        periodEnd: at - 15 * DAY,
        graceUntil: null,
      },
      canceled: {
        state: 'canceled',
        reason: 'canceled_by_customer',
        trialEnds: null,
        periodEnd: at - 3 * DAY,
        graceUntil: null,
      },
    };
    Object.assign(s, base, next[state]);
    if (state === 'past_due') s.invoices.unshift(invoice(s, team, false, at - DAY));
  }

  return { route, summary, computer, simulate };
}
