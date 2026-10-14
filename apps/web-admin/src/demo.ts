/**
 * In-memory stand-in for /v1/support (demo builds only: UI tests, screenshots, design review). It follows the server's
 * rules closely enough to exercise the screens: role checks, a different support lead approving sensitive access,
 * access that ends by itself, overrides with a reason and an expiry, the platform audit. Fictional organizations and
 * people only. `?as=support|lead|admin|all` picks who signs in; `switchTo` lets a test act as another staff member.
 */
import {
  type AccessRequest,
  BILLING_TIMING,
  type BillingAlert,
  type Invoice,
  latestPlan,
  type Override,
  overrideValueValid,
  type PlanDefinition,
  type PlatformAuditEntry,
  type StaffRole,
  type Subscription,
  type SupportActivityEntry,
  type SupportMember,
  type SupportOrgOverview,
} from '@pb/contracts/billing';
import { type ConsoleApi, ConsoleError, type Session, type Staff } from './api.ts';

const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const C32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const id = (prefix: string) => {
  let s = '';
  for (let i = 0; i < 26; i++) s += C32[Math.floor(Math.random() * 32)];
  return `${prefix}_${s}`;
};

export const PERSONAS: Record<string, Staff> = {
  support: { user_id: 'usr_01J9ZSAMR1VERA000000000000', display_name: 'Sam Rivera', roles: ['support'] },
  lead: { user_id: 'usr_01J9Z1EECHEN0000000000000', display_name: 'Lee Chen', roles: ['support_lead'] },
  admin: { user_id: 'usr_01J9ZADAM0REAV0000000000', display_name: 'Ada Moreau', roles: ['billing_admin'] },
  all: {
    user_id: 'usr_01J9ZJ0RDANPARK0000000000',
    display_name: 'Jordan Park',
    roles: ['support_lead', 'billing_admin'],
  },
};

interface DemoOrg {
  id: string;
  name: string;
  created: number;
  plan: PlanDefinition;
  state: Subscription['state'];
  reason: Subscription['reason'];
  customer: string | null;
  sub: string | null;
  periodEnd: number | null;
  graceUntil: number | null;
  emails: string[];
  members: SupportMember[];
  usage: Subscription['usage'];
  invoices: Invoice[];
  events: SupportOrgOverview['events'];
  history: SupportOrgOverview['history'];
  activity: SupportActivityEntry[];
  resyncQueued: boolean;
}

export interface DemoControls {
  /** The next sign-in is this staff member (the in-memory data stays). */
  switchTo(persona: keyof typeof PERSONAS): void;
  /** Ends every approved access window now (tests of expiry). */
  expireAccess(): void;
}

export function demoApi(persona: string): ConsoleApi & { controls: DemoControls } {
  const now = Date.now();
  let me: Staff | null = null;
  let current: Staff = PERSONAS[persona] ?? (PERSONAS.all as Staff);

  const invoice = (n: number, amount: number, paid: boolean, at: number): Invoice => ({
    id: `in_1Demo${n}${'x'.repeat(8)}`,
    number: `NW-${String(n).padStart(4, '0')}`,
    status: paid ? 'paid' : 'open',
    currency: 'usd',
    amount_due_minor: amount,
    amount_paid_minor: paid ? amount : 0,
    created_at: iso(at),
    period_start: iso(at),
    period_end: iso(at + 30 * DAY),
    has_hosted_page: true,
    has_pdf: true,
  });
  const member = (name: string, email: string, role: string, days: number): SupportMember => ({
    user_id: id('usr'),
    display_name: name,
    email,
    role,
    joined_at: iso(now - days * DAY),
  });
  const team = latestPlan('team') as PlanDefinition;
  const agency = latestPlan('agency') as PlanDefinition;

  const orgs: DemoOrg[] = [
    {
      id: 'org_01J9ZN0RTHW1ND000000000000',
      name: 'Northwind Agency',
      created: now - 120 * DAY,
      plan: agency,
      state: 'active',
      reason: 'paid',
      customer: 'cus_DemoNorthwind01',
      sub: 'sub_DemoNorthwind01',
      periodEnd: now + 12 * DAY,
      graceUntil: null,
      emails: ['owner@northwind.example', 'ops@northwind.example'],
      members: [
        member('Riley Owner', 'owner@northwind.example', 'owner', 120),
        member('Morgan Ops', 'ops@northwind.example', 'admin', 90),
        member('Casey Lin', 'casey@northwind.example', 'operator', 40),
        member('Drew Patel', 'drew@northwind.example', 'viewer', 12),
      ],
      usage: { profiles: 412, seats: 5, storage_bytes: 37.4 * 1024 ** 3, automation_running: 3 },
      invoices: [
        invoice(3, 14_900, true, now - 18 * DAY),
        invoice(2, 14_900, true, now - 48 * DAY),
        invoice(1, 14_900, true, now - 78 * DAY),
      ],
      events: [
        {
          provider_event_id: 'evt_DemoNw03',
          type: 'invoice.paid',
          status: 'processed',
          received_at: iso(now - 18 * DAY),
          processed_at: iso(now - 18 * DAY + 4000),
          attempts: 1,
          error: null,
        },
        {
          provider_event_id: 'evt_DemoNw04',
          type: 'charge.refunded',
          status: 'processed',
          received_at: iso(now - 2 * DAY),
          processed_at: iso(now - 2 * DAY + 3000),
          attempts: 1,
          error: null,
        },
      ],
      history: [
        {
          at: iso(now - 78 * DAY),
          from_state: 'trial',
          to_state: 'active',
          plan_id: 'agency',
          plan_version: 1,
          cause: 'provider: subscription active',
        },
      ],
      activity: [],
      resyncQueued: false,
    },
    {
      id: 'org_01J9ZHARB0R000000000000000',
      name: 'Harbor Studio',
      created: now - 70 * DAY,
      plan: team,
      state: 'past_due',
      reason: 'payment_failed',
      customer: 'cus_DemoHarbor01',
      sub: 'sub_DemoHarbor01',
      periodEnd: now - 2 * DAY,
      graceUntil: null,
      emails: ['ops@harbor.example'],
      members: [
        member('Jamie Harbor', 'ops@harbor.example', 'owner', 70),
        member('Alex Kim', 'alex@harbor.example', 'operator', 30),
      ],
      usage: { profiles: 88, seats: 2, storage_bytes: 6.1 * 1024 ** 3, automation_running: 0 },
      invoices: [invoice(12, 4900, false, now - 2 * DAY), invoice(11, 4900, true, now - 32 * DAY)],
      events: [
        {
          provider_event_id: 'evt_DemoHb07',
          type: 'invoice.payment_failed',
          status: 'processed',
          received_at: iso(now - 2 * DAY),
          processed_at: iso(now - 2 * DAY + 2000),
          attempts: 1,
          error: null,
        },
      ],
      history: [
        {
          at: iso(now - 2 * DAY),
          from_state: 'active',
          to_state: 'past_due',
          plan_id: 'team',
          plan_version: 1,
          cause: 'provider: payment failed',
        },
      ],
      activity: [],
      resyncQueued: false,
    },
    {
      id: 'org_01J9ZBR1GHT000000000000000',
      name: 'Brightline Labs',
      created: now - 200 * DAY,
      plan: team,
      state: 'restricted',
      reason: 'grace_ended',
      customer: 'cus_DemoBright01',
      sub: 'sub_DemoBright01',
      periodEnd: now - 15 * DAY,
      graceUntil: null,
      emails: ['admin@brightline.example'],
      members: [member('Sky Bright', 'admin@brightline.example', 'owner', 200)],
      usage: { profiles: 640, seats: 6, storage_bytes: 52 * 1024 ** 3, automation_running: 0 },
      invoices: [invoice(30, 4900, false, now - 15 * DAY)],
      events: [
        {
          provider_event_id: 'evt_DemoBr21',
          type: 'customer.subscription.updated',
          status: 'failed',
          received_at: iso(now - 1 * DAY),
          processed_at: null,
          attempts: 4,
          error: 'provider unavailable (will retry)',
        },
      ],
      history: [
        {
          at: iso(now - 1 * DAY),
          from_state: 'grace',
          to_state: 'restricted',
          plan_id: 'team',
          plan_version: 1,
          cause: 'grace ended',
        },
        {
          at: iso(now - 8 * DAY),
          from_state: 'past_due',
          to_state: 'grace',
          plan_id: 'team',
          plan_version: 1,
          cause: 'provider: payment retries exhausted',
        },
      ],
      activity: [],
      resyncQueued: false,
    },
  ];
  for (const o of orgs) {
    o.activity = [
      {
        at: iso(now - 3 * 3600_000),
        action: 'profile.opened',
        outcome: 'success',
        actor_user_id: o.members[0]?.user_id ?? null,
        target_type: 'profile',
      },
      {
        at: iso(now - 5 * 3600_000),
        action: 'member.role_changed',
        outcome: 'success',
        actor_user_id: o.members[0]?.user_id ?? null,
        target_type: 'membership',
      },
      {
        at: iso(now - 26 * 3600_000),
        action: 'access.denied',
        outcome: 'denied',
        actor_user_id: o.members.at(-1)?.user_id ?? null,
        target_type: 'route',
      },
    ];
  }

  const alerts: BillingAlert[] = [
    {
      id: id('alr'),
      kind: 'refund',
      org_id: orgs[0]?.id ?? null,
      ref: 'ch_DemoRefund01',
      detail: 'A charge was refunded (USD 149.00). Check whether the plan should change.',
      first_seen_at: iso(now - 2 * DAY),
      last_seen_at: iso(now - 2 * DAY),
      count: 1,
      resolved_at: null,
      resolved_by: null,
    },
    {
      id: id('alr'),
      kind: 'event_failed',
      org_id: orgs[2]?.id ?? null,
      ref: 'evt_DemoBr21',
      detail: 'A provider event failed 4 times; the worker keeps retrying.',
      first_seen_at: iso(now - DAY),
      last_seen_at: iso(now - 20 * MIN),
      count: 4,
      resolved_at: null,
      resolved_by: null,
    },
    {
      id: id('alr'),
      kind: 'webhook_backlog',
      org_id: null,
      ref: null,
      detail: 'More than 50 provider events waited over 10 minutes.',
      first_seen_at: iso(now - 9 * DAY),
      last_seen_at: iso(now - 9 * DAY),
      count: 1,
      resolved_at: iso(now - 9 * DAY + 3600_000),
      resolved_by: PERSONAS.admin?.user_id ?? null,
    },
  ];

  const requests: AccessRequest[] = [
    {
      id: id('sar'),
      org_id: orgs[1]?.id as string,
      scope: 'members',
      reason: 'The owner reports a member they cannot remove; checking the member list and roles with them.',
      duration_minutes: 30,
      state: 'pending',
      requested_by: PERSONAS.support?.user_id as string,
      requested_by_name: 'Sam Rivera',
      decided_by: null,
      created_at: iso(now - 12 * MIN),
      decided_at: null,
      expires_at: null,
    },
  ];
  const overrides: Override[] = [
    {
      id: id('ovr'),
      org_id: orgs[0]?.id as string,
      scope: 'limit.seats',
      value: 25,
      reason: 'Pilot agreement: five extra seats until the agency plan is resized.',
      created_by: PERSONAS.admin?.user_id as string,
      created_at: iso(now - 20 * DAY),
      expires_at: iso(now + 40 * DAY),
      revoked_at: null,
    },
  ];
  const audit: PlatformAuditEntry[] = [];
  const record = (
    action: string,
    orgId: string | null = null,
    target: string | null = null,
    details = {},
  ) => {
    audit.unshift({
      id: id('aud'),
      at: iso(Date.now()),
      actor_user_id: me?.user_id ?? null,
      action,
      org_id: orgId,
      target,
      details,
    });
  };
  record('staff.signed_in');

  const delay = <T>(v: T): Promise<T> => new Promise((ok) => setTimeout(() => ok(structuredClone(v)), 60));
  const who = (...roles: StaffRole[]): Staff => {
    if (!me) throw new ConsoleError('UNAUTHENTICATED', 'Sign in to the support console', 401);
    if (roles.length && !roles.some((r) => me?.roles.includes(r))) {
      throw new ConsoleError('FORBIDDEN', 'Your support role does not allow this', 403, { required: roles });
    }
    return me;
  };
  const orgOf = (orgId: string) => {
    const o = orgs.find((x) => x.id === orgId);
    if (!o) throw new ConsoleError('NOT_FOUND', 'Organization not found', 404);
    return o;
  };
  const stateOf = (r: AccessRequest): AccessRequest =>
    r.state === 'approved' && r.expires_at && Date.parse(r.expires_at) <= Date.now()
      ? { ...r, state: 'expired' }
      : r;
  const active = (orgId: string, userId: string) => [
    ...new Set(
      requests
        .map(stateOf)
        .filter((r) => r.org_id === orgId && r.requested_by === userId && r.state === 'approved')
        .map((r) => r.scope),
    ),
  ];

  const subscription = (o: DemoOrg): Subscription => {
    const inForce = overrides.filter(
      (x) => x.org_id === o.id && !x.revoked_at && Date.parse(x.expires_at) > Date.now(),
    );
    const limits = { ...o.plan.limits };
    for (const x of inForce) {
      if (x.scope.startsWith('limit.')) {
        (limits as Record<string, number | null>)[x.scope.slice(6)] = x.value as number | null;
      }
    }
    const over = (['profiles', 'seats', 'storage_bytes'] as const).filter((k) => {
      const lim = limits[k];
      return lim !== null && o.usage[k] > lim;
    });
    return {
      org_id: o.id,
      plan: { id: o.plan.id, version: o.plan.version, name: o.plan.name },
      state: o.state,
      reason: o.reason,
      until: o.graceUntil ? iso(o.graceUntil) : null,
      trial_ends_at: null,
      current_period_end: o.periodEnd ? iso(o.periodEnd) : null,
      cancel_at_period_end: false,
      grace_until: o.graceUntil ? iso(o.graceUntil) : null,
      has_provider_subscription: Boolean(o.sub),
      limits,
      features: o.plan.features,
      usage: o.usage,
      over_limits: over,
      overrides: inForce.map((x) => ({ scope: x.scope, expires_at: x.expires_at })),
      retention_days: null,
      synced_at: iso(Date.now() - 4 * MIN),
    };
  };

  const api: ConsoleApi & { controls: DemoControls } = {
    demo: true,
    async signIn(): Promise<Session> {
      me = current;
      record('staff.signed_in');
      return delay({ staff: me, expiresAt: Date.now() + BILLING_TIMING.staffSessionMinutes * MIN });
    },
    async resume() {
      return null;
    },
    async signOut() {
      record('staff.signed_out');
      me = null;
    },
    async search(raw) {
      who('support', 'support_lead', 'billing_admin');
      const q = raw.trim();
      let matched: 'org_id' | 'customer_id' | 'email';
      let hits: DemoOrg[];
      if (/^org_[0-9A-HJKMNP-TV-Z]{26}$/.test(q)) {
        matched = 'org_id';
        hits = orgs.filter((o) => o.id === q);
      } else if (/^cus_[A-Za-z0-9]{1,64}$/.test(q)) {
        matched = 'customer_id';
        hits = orgs.filter((o) => o.customer === q);
      } else if (/^[^\s@]+@[^\s@]+$/.test(q)) {
        matched = 'email';
        hits = orgs.filter((o) => o.emails.includes(q.toLowerCase()));
      } else {
        throw new ConsoleError(
          'VALIDATION_FAILED',
          'Search by organization id, customer id or an exact e-mail address',
          422,
        );
      }
      record('support.searched', null, null, { matched_by: matched, results: hits.length });
      return delay({
        matched_by: matched,
        items: hits.map((o) => ({ id: o.id, name: o.name, created_at: iso(o.created), state: o.state })),
      });
    },
    async org(orgId) {
      const s = who('support', 'support_lead', 'billing_admin');
      const o = orgOf(orgId);
      record('support.viewed_overview', o.id);
      return delay({
        id: o.id,
        name: o.name,
        created_at: iso(o.created),
        subscription: subscription(o),
        provider_customer_id: o.customer,
        provider_subscription_id: o.sub,
        member_count: o.members.length,
        history: o.history,
        invoices: o.invoices,
        events: o.events,
        alerts: alerts.filter((a) => a.org_id === o.id),
        active_access: active(o.id, s.user_id),
      });
    },
    async overrides(orgId) {
      who('support', 'support_lead', 'billing_admin');
      orgOf(orgId);
      return delay(overrides.filter((x) => x.org_id === orgId));
    },
    async addOverride(orgId, body) {
      const s = who('billing_admin');
      orgOf(orgId);
      if (body.reason.trim().length < 20) {
        throw new ConsoleError('VALIDATION_FAILED', 'Request failed validation', 422, {
          issues: [{ path: '/reason', message: 'must NOT have fewer than 20 characters' }],
        });
      }
      if (!overrideValueValid(body.scope, body.value)) {
        throw new ConsoleError('VALIDATION_FAILED', 'This value does not fit the override', 422);
      }
      const exp = Date.parse(body.expires_at);
      if (!(exp > Date.now() + MIN) || exp > Date.now() + BILLING_TIMING.overrideMaxDays * DAY) {
        throw new ConsoleError(
          'VALIDATION_FAILED',
          `Overrides expire between a minute and ${BILLING_TIMING.overrideMaxDays} days from now`,
          422,
        );
      }
      const row: Override = {
        id: id('ovr'),
        org_id: orgId,
        scope: body.scope,
        value: body.value,
        reason: body.reason.trim(),
        created_by: s.user_id,
        created_at: iso(Date.now()),
        expires_at: body.expires_at,
        revoked_at: null,
      };
      overrides.unshift(row);
      record('support.override_added', orgId, row.id, { scope: row.scope, value: row.value });
      return delay(row);
    },
    async revokeOverride(oid) {
      who('billing_admin');
      const row = overrides.find((x) => x.id === oid);
      if (!row) throw new ConsoleError('NOT_FOUND', 'Override not found', 404);
      row.revoked_at ??= iso(Date.now());
      record('support.override_revoked', row.org_id, row.id);
      return delay(row);
    },
    async resync(orgId) {
      who('billing_admin');
      const o = orgOf(orgId);
      const queued = Boolean(o.customer);
      o.resyncQueued = queued;
      record('support.resync_requested', orgId);
      return delay(queued);
    },
    async requestAccess(orgId, body) {
      const s = who('support', 'support_lead', 'billing_admin');
      orgOf(orgId);
      if (body.reason.trim().length < 20) {
        throw new ConsoleError('VALIDATION_FAILED', 'Request failed validation', 422, {
          issues: [{ path: '/reason', message: 'must NOT have fewer than 20 characters' }],
        });
      }
      const r: AccessRequest = {
        id: id('sar'),
        org_id: orgId,
        scope: body.scope,
        reason: body.reason.trim(),
        duration_minutes: body.duration_minutes,
        state: 'pending',
        requested_by: s.user_id,
        requested_by_name: s.display_name,
        decided_by: null,
        created_at: iso(Date.now()),
        decided_at: null,
        expires_at: null,
      };
      requests.unshift(r);
      record('support.access_requested', orgId, r.id, { scope: r.scope, minutes: r.duration_minutes });
      return delay(r);
    },
    async accessRequests(pendingOnly) {
      const s = who();
      const lead = s.roles.includes('support_lead');
      return delay(
        requests
          .map(stateOf)
          .filter((r) => (lead || r.requested_by === s.user_id) && (!pendingOnly || r.state === 'pending')),
      );
    },
    async decide(rid, decision) {
      const s = who('support_lead');
      const r = requests.find((x) => x.id === rid);
      if (!r) throw new ConsoleError('NOT_FOUND', 'Request not found', 404);
      if (r.requested_by === s.user_id) {
        throw new ConsoleError('FORBIDDEN', 'A different support lead must decide on your own request', 403, {
          reason: 'own_request',
        });
      }
      if (r.state !== 'pending')
        throw new ConsoleError('VERSION_CONFLICT', 'This request was already decided', 409);
      r.state = decision === 'approve' ? 'approved' : 'denied';
      r.decided_by = s.user_id;
      r.decided_at = iso(Date.now());
      r.expires_at = decision === 'approve' ? iso(Date.now() + r.duration_minutes * MIN) : null;
      record(decision === 'approve' ? 'support.access_approved' : 'support.access_denied', r.org_id, r.id, {
        scope: r.scope,
        requested_by: r.requested_by,
      });
      return delay(r);
    },
    async revokeAccess(rid) {
      const s = who();
      const r = requests.find((x) => x.id === rid);
      if (!r || (r.requested_by !== s.user_id && !s.roles.includes('support_lead'))) {
        throw new ConsoleError('NOT_FOUND', 'Request not found', 404);
      }
      if (r.state === 'pending' || r.state === 'approved') {
        r.state = 'revoked';
        if (r.expires_at) r.expires_at = iso(Math.min(Date.parse(r.expires_at), Date.now()));
        record('support.access_revoked', r.org_id, r.id);
      }
      return delay(stateOf(r));
    },
    async members(orgId) {
      const s = who();
      const o = orgOf(orgId);
      if (!active(orgId, s.user_id).includes('members')) {
        throw new ConsoleError(
          'FORBIDDEN',
          'Request access to this information first; a support lead must approve it',
          403,
          {
            scope: 'members',
            reason: 'access_required',
          },
        );
      }
      record('support.viewed_members', orgId);
      return delay(o.members);
    },
    async activity(orgId) {
      const s = who();
      const o = orgOf(orgId);
      if (!active(orgId, s.user_id).includes('activity')) {
        throw new ConsoleError(
          'FORBIDDEN',
          'Request access to this information first; a support lead must approve it',
          403,
          {
            scope: 'activity',
            reason: 'access_required',
          },
        );
      }
      record('support.viewed_activity', orgId);
      return delay(o.activity);
    },
    async alerts(openOnly) {
      who('billing_admin', 'support_lead');
      return delay(alerts.filter((a) => !openOnly || !a.resolved_at));
    },
    async resolveAlert(aid) {
      const s = who('billing_admin');
      const a = alerts.find((x) => x.id === aid && !x.resolved_at);
      if (!a) throw new ConsoleError('NOT_FOUND', 'No open alert with this id', 404);
      a.resolved_at = iso(Date.now());
      a.resolved_by = s.user_id;
      record('support.alert_resolved', null, a.id);
      return delay(a);
    },
    async audit(orgId) {
      who('support_lead', 'billing_admin');
      return delay(audit.filter((e) => !orgId || e.org_id === orgId).slice(0, 200));
    },
    controls: {
      switchTo(p) {
        current = PERSONAS[p] ?? current;
      },
      expireAccess() {
        for (const r of requests) {
          if (r.state === 'approved') r.expires_at = iso(Date.now() - 1000);
        }
      },
    },
  };
  return api;
}
