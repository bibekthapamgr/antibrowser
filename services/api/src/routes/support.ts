/**
 * Internal support console API (milestone 11, ADR-0018). Staff are not a tenant role: `platform_staff` is managed
 * only by `scripts/staff.ts` on the server. Staff sign in to the console with its own OIDC client and get a staff
 * token (30 minutes, no refresh) that works only on these routes.
 *
 * - `support`: find an organization and see its billing overview — numbers, states, invoices, events, alerts. No
 *   member e-mails, profile names, activity details or session data.
 * - Sensitive access (members, activity log) needs a request with a reason and a duration, approved by a different
 *   `support_lead`; it ends by itself. Grants, approvals and every view are written to the platform audit and to the
 *   organization's own activity log.
 * - `billing_admin` alone adds and revokes entitlement overrides (reason, expiry ≤ 90 days), queues resyncs and
 *   resolves alerts.
 * - Browser session data is not reachable through any route here.
 */
import {
  AccessDecision,
  AccessRequest,
  AccessRequestCreate,
  ApiError,
  AuditExport,
  AuditExportQuery,
  BILLING_TIMING,
  BillingAlert,
  ConsoleConfig,
  EmergencyRevokeRequest,
  EmergencyRevokeResult,
  isId,
  newId,
  Override,
  OverrideCreate,
  overrideValueValid,
  PlatformAuditEntry,
  type StaffRole,
  StaffSession,
  StaffSessionRequest,
  type SupportAccessScope,
  SupportActivityEntry,
  SupportMember,
  SupportOrgOverview,
  SupportSearchQuery,
  SupportSearchResult,
} from '@pb/contracts';
import type pg from 'pg';
import Type from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit } from '../audit.ts';
import { auditHead, exportAudit } from '../audit-chain.ts';
import type { Principal } from '../auth.ts';
import { subscriptionView } from '../billing/state.ts';
import { ts, withTx } from '../db.ts';
import { discoverEndpoints } from '../oidc.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { sha256Hex } from '../session.ts';
import { errors, OrgParams } from './common.ts';

const STAFF_SESSION_SECONDS = BILLING_TIMING.staffSessionMinutes * 60;
/** Staff sign in with a fresh authentication (the console asks the provider for max_age=600). */
const STAFF_MAX_AUTH_AGE_SECONDS = 900;

const IdParam = (prefix: 'sar' | 'ovr' | 'alr') =>
  Type.Object(
    { id: Type.String({ pattern: `^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$` }) },
    { additionalProperties: false },
  );

type StaffPrincipal = Principal & { staff: NonNullable<Principal['staff']> };

function staffOf(req: { principal: Principal | null }, ...roles: StaffRole[]): StaffPrincipal {
  const p = principalOf(req);
  if (p.kind !== 'staff' || !p.staff) throw new ApiError('UNAUTHENTICATED', 'Sign in to the support console');
  if (roles.length && !roles.some((r) => p.staff?.roles.includes(r))) {
    throw new ApiError('FORBIDDEN', 'Your support role does not allow this', { required: roles });
  }
  return p as StaffPrincipal;
}

async function platformAudit(
  c: pg.PoolClient,
  e: {
    actor: string | null;
    action: string;
    orgId?: string | null;
    target?: string | null;
    details?: object;
    requestId: string;
  },
): Promise<void> {
  await c.query(
    `insert into platform_audit (id, actor_user_id, action, org_id, target, details, request_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      newId('audit'),
      e.actor,
      e.action,
      e.orgId ?? null,
      e.target ?? null,
      JSON.stringify(e.details ?? {}),
      e.requestId,
    ],
  );
}

/** The organization's own activity log: its owners see that support looked or changed something. */
async function orgAudit(
  c: pg.PoolClient,
  orgId: string,
  actor: string,
  action: string,
  requestId: string,
  details = {},
) {
  await audit(c, {
    orgId,
    actorUserId: actor,
    actorDeviceId: null,
    action,
    targetType: 'organization',
    targetId: orgId,
    outcome: 'success',
    requestId,
    details: { ...details, by: 'support' },
  });
}

async function orgExists(c: pg.PoolClient, orgId: string): Promise<{ name: string; created_at: string }> {
  const { rows } = await c.query<{ name: string; created_at: string }>(
    `select name, ${ts('created_at')} as created_at from organizations where id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Organization not found');
  return row;
}

/** Approved, unexpired access of this staff member for this organization and scope. */
async function activeAccess(c: pg.PoolClient, orgId: string, userId: string): Promise<SupportAccessScope[]> {
  const { rows } = await c.query<{ scope: SupportAccessScope }>(
    `select distinct scope from support_access_requests
      where org_id = $1 and requested_by = $2 and state = 'approved' and expires_at > now()`,
    [orgId, userId],
  );
  return rows.map((r) => r.scope);
}

/** Every use of break-glass access: platform audit, the organization's own activity log, and a console alert. */
async function breakGlassUsed(
  c: pg.PoolClient,
  p: StaffPrincipal,
  orgId: string,
  action: string,
  requestId: string,
  details: object = {},
): Promise<void> {
  const grant = p.staff.breakGlass?.id ?? null;
  await platformAudit(c, { actor: p.userId, action, orgId, target: grant, details, requestId });
  await orgAudit(c, orgId, p.userId, action, requestId, { break_glass: true });
  await c.query(
    `insert into billing_alerts (id, kind, org_id, ref, detail) values ($1, 'break_glass_used', $2, $3, $4)
     on conflict (kind, coalesce(org_id, ''), coalesce(ref, '')) where resolved_at is null
     do update set count = billing_alerts.count + 1, last_seen_at = now()`,
    [newId('billingAlert'), orgId, grant, `Break-glass access used: ${action}`.slice(0, 300)],
  );
}

const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

const ACCESS_COLUMNS = `r.id, r.org_id, r.scope, r.reason, r.duration_minutes,
  case when r.state = 'approved' and r.expires_at <= now() then 'expired' else r.state end as state,
  r.requested_by, coalesce(u.display_name, 'Staff') as requested_by_name, r.decided_by,
  ${ts('r.created_at')} as created_at, ${ts('r.decided_at')} as decided_at, ${ts('r.expires_at')} as expires_at`;

export function supportRoutes(app: App, deps: Deps): void {
  const ctx = (orgId: string | null, userId: string) => ({ orgId, userId });

  // ---------------------------------------------------------------- sign-in
  app.get(
    '/support/auth/config',
    {
      config: { public: true },
      schema: {
        tags: ['support'],
        security: [],
        description: 'The support console’s own OIDC client (Authorization Code + PKCE in the browser).',
        response: { 200: ConsoleConfig, ...errors },
      },
    },
    async () => {
      const oidc = deps.config.oidc;
      const client = deps.config.console.oidcClientId;
      if (!oidc || !client)
        throw new ApiError('UNAVAILABLE', 'The support console is not configured on this server');
      const endpoints = await discoverEndpoints(
        oidc.issuer,
        deps.config.appEnv === 'dev' || deps.config.appEnv === 'test',
      );
      return { issuer: oidc.issuer, client_id: client, ...endpoints, scopes: ['openid', 'email', 'profile'] };
    },
  );

  app.post(
    '/support/sessions',
    {
      config: { public: true },
      schema: {
        tags: ['support'],
        security: [],
        description:
          'Exchanges a fresh ID token of the console client (used once) for a staff token (30 minutes, no refresh). ' +
          'Only active staff; the sign-in must be recent.',
        body: StaffSessionRequest,
        response: { 201: StaffSession, ...errors },
      },
    },
    async (req, reply) => {
      await hit(deps.pool, LIMITS.staffSignInPerIp, req.ip);
      if (!deps.consoleIdTokens) throw new ApiError('UNAVAILABLE', 'The support console is not configured');
      const refuse = async (reason: string, userId: string | null = null) => {
        await withTx(deps.pool, ctx(null, userId ?? ''), (c) =>
          platformAudit(c, {
            actor: userId,
            action: 'staff.sign_in_refused',
            details: { reason },
            requestId: req.id,
          }),
        ).catch(() => undefined);
        return new ApiError('UNAUTHENTICATED', 'This account cannot use the support console', { reason });
      };
      let identity: Awaited<ReturnType<NonNullable<Deps['consoleIdTokens']>['verify']>>;
      try {
        identity = await deps.consoleIdTokens.verify(req.body.id_token, req.body.nonce);
      } catch {
        throw await refuse('id_token_invalid');
      }
      if ((Date.now() - identity.authTime.getTime()) / 1000 > STAFF_MAX_AUTH_AGE_SECONDS) {
        throw await refuse('sign_in_not_recent');
      }
      const user = await withTx(deps.pool, ctx(null, ''), async (c) => {
        const { rows } = await c.query<{ user_id: string; disabled: boolean }>(
          'select * from app.upsert_oidc_user($1, $2, $3, $4, $5, $6)',
          [
            newId('user'),
            identity.issuer,
            identity.subject,
            identity.email,
            identity.emailVerified,
            identity.displayName,
          ],
        );
        return rows[0];
      });
      if (!user || user.disabled) throw await refuse('user_disabled', user?.user_id ?? null);
      const out = await withTx(deps.pool, ctx(null, user.user_id), async (c) => {
        const first = await c.query<{ first: boolean }>('select app.claim_id_token($1, $2) as first', [
          sha256Hex(req.body.id_token),
          identity.expiresAt,
        ]);
        if (!first.rows[0]?.first) return { refused: 'id_token_reused' as const };
        const staff = await c.query<{ roles: StaffRole[]; display_name: string }>(
          `select p.roles, u.display_name from platform_staff p join users u on u.id = p.user_id
            where p.user_id = $1 and p.disabled_at is null`,
          [user.user_id],
        );
        const s = staff.rows[0];
        if (!s) return { refused: 'not_staff' as const };
        const sessionId = newId('staffSession');
        await c.query(
          `insert into staff_sessions (id, user_id, auth_time, expires_at)
           values ($1, $2, $3, now() + make_interval(secs => $4))`,
          [sessionId, user.user_id, identity.authTime, STAFF_SESSION_SECONDS],
        );
        await platformAudit(c, {
          actor: user.user_id,
          action: 'staff.signed_in',
          target: sessionId,
          requestId: req.id,
        });
        return { sessionId, roles: s.roles, name: s.display_name };
      });
      if ('refused' in out) throw await refuse(out.refused, user.user_id);
      const token = await deps.sessions.signStaff(
        { userId: user.user_id, staffSessionId: out.sessionId, authTime: identity.authTime },
        STAFF_SESSION_SECONDS,
      );
      return reply.status(201).send({
        access_token: token,
        token_type: 'Bearer' as const,
        expires_in: STAFF_SESSION_SECONDS,
        staff: { user_id: user.user_id, display_name: out.name, roles: out.roles },
      });
    },
  );

  app.post(
    '/support/sign-out',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description: 'Ends this staff session.',
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const p = staffOf(req);
      await withTx(deps.pool, ctx(null, p.userId), async (c) => {
        await c.query('update staff_sessions set revoked_at = now() where id = $1 and revoked_at is null', [
          p.sessionId,
        ]);
        await platformAudit(c, {
          actor: p.userId,
          action: 'staff.signed_out',
          target: p.sessionId,
          requestId: req.id,
        });
      });
      return reply.status(204).send(null);
    },
  );

  // ---------------------------------------------------------------- finding and looking at an organization
  app.get(
    '/support/orgs',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'Finds organizations by id, payment provider customer id, or a member’s exact e-mail address (audited).',
        querystring: SupportSearchQuery,
        response: { 200: SupportSearchResult, ...errors },
      },
    },
    async (req) => {
      const p = staffOf(req, 'support', 'support_lead', 'billing_admin');
      const q = req.query.q.trim();
      return withTx(deps.pool, ctx(null, p.userId), async (c) => {
        let ids: string[] = [];
        let matched: 'org_id' | 'customer_id' | 'email';
        if (isId('organization', q)) {
          matched = 'org_id';
          ids = [q];
        } else if (/^cus_[A-Za-z0-9]{1,64}$/.test(q)) {
          matched = 'customer_id';
          const r = await c.query<{ org: string | null }>('select app.billing_org_for_customer($1) as org', [
            q,
          ]);
          ids = r.rows[0]?.org ? [r.rows[0].org] : [];
        } else if (/^[^\s@]+@[^\s@]+$/.test(q)) {
          matched = 'email';
          const m = await c.query<{ org_id: string }>('select org_id from app.support_orgs_for_email($1)', [
            q,
          ]);
          ids = m.rows.map((r) => r.org_id);
        } else {
          throw new ApiError(
            'VALIDATION_FAILED',
            'Search by organization id, customer id or an exact e-mail address',
          );
        }
        await platformAudit(c, {
          actor: p.userId,
          action: 'support.searched',
          details: {
            matched_by: matched,
            query: matched === 'email' ? maskEmail(q) : q,
            results: ids.length,
          },
          requestId: req.id,
        });
        const items = [];
        for (const id of [...new Set(ids)].slice(0, 20)) {
          await c.query("select set_config('app.org_id', $1, true)", [id]);
          const r = await c.query<{ id: string; name: string; created_at: string; state: string }>(
            `select o.id, o.name, ${ts('o.created_at')} as created_at, e.state
               from organizations o cross join app.billing_effective(o.id) e where o.id = $1`,
            [id],
          );
          if (r.rows[0]) items.push(r.rows[0]);
        }
        return { items, matched_by: matched } as never;
      });
    },
  );

  app.get(
    '/support/orgs/:orgId',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'Billing overview of one organization: plan, state, dates, limits and usage numbers, provider references, ' +
          'history, invoices, provider events and alerts. No member e-mails, profile names or session data.',
        params: OrgParams,
        response: { 200: SupportOrgOverview, ...errors },
      },
    },
    async (req) => {
      const p = staffOf(req, 'support', 'support_lead', 'billing_admin');
      const orgId = req.params.orgId;
      return withTx(deps.pool, ctx(orgId, p.userId), async (c) => {
        const org = await orgExists(c, orgId);
        const subscription = await subscriptionView(c, orgId, deps.billing.retentionDays);
        const refs = await c.query<{ customer: string | null; sub: string | null; members: number }>(
          `select provider_customer_id as customer, provider_subscription_id as sub,
                  (select count(*) from memberships where org_id = $1)::int as members
             from subscriptions where org_id = $1`,
          [orgId],
        );
        const history = await c.query(
          `select ${ts('at')} as at, from_state, to_state, plan_id, plan_version, cause from subscription_history
            where org_id = $1 order by at desc, id desc limit 50`,
          [orgId],
        );
        const invoices = await c.query(
          `select id, number, status, currency, amount_due::int as amount_due_minor,
                  amount_paid::int as amount_paid_minor, ${ts('provider_created_at')} as created_at,
                  ${ts('period_start')} as period_start, ${ts('period_end')} as period_end,
                  hosted_url is not null as has_hosted_page, pdf_url is not null as has_pdf
             from billing_invoices where org_id = $1 order by provider_created_at desc limit 24`,
          [orgId],
        );
        const events = await c.query(
          `select provider_event_id, type, status, ${ts('received_at')} as received_at,
                  ${ts('processed_at')} as processed_at, attempts, error
             from billing_webhook_events where org_id = $1 order by received_at desc limit 50`,
          [orgId],
        );
        const alerts = await c.query(
          `select id, kind, org_id, ref, detail, ${ts('first_seen_at')} as first_seen_at,
                  ${ts('last_seen_at')} as last_seen_at, count, ${ts('resolved_at')} as resolved_at, resolved_by
             from billing_alerts where org_id = $1 order by resolved_at nulls first, last_seen_at desc limit 50`,
          [orgId],
        );
        await platformAudit(c, {
          actor: p.userId,
          action: 'support.viewed_overview',
          orgId,
          requestId: req.id,
        });
        return {
          id: orgId,
          name: org.name,
          created_at: org.created_at,
          subscription,
          provider_customer_id: refs.rows[0]?.customer ?? null,
          provider_subscription_id: refs.rows[0]?.sub ?? null,
          member_count: refs.rows[0]?.members ?? 0,
          history: history.rows,
          invoices: invoices.rows,
          events: events.rows,
          alerts: alerts.rows,
          active_access: p.staff.breakGlass
            ? (['members', 'activity'] as SupportAccessScope[])
            : await activeAccess(c, orgId, p.userId),
          break_glass_until: p.staff.breakGlass?.expiresAt ?? null,
        } as never;
      });
    },
  );

  // ---------------------------------------------------------------- sensitive access: request, approve, use
  app.post(
    '/support/orgs/:orgId/access-requests',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'Asks for time-bound access to an organization’s members or activity log, with a reason. A different ' +
          'support lead must approve it.',
        params: OrgParams,
        body: AccessRequestCreate,
        response: { 201: AccessRequest, ...errors },
      },
    },
    async (req, reply) => {
      const p = staffOf(req, 'support', 'support_lead', 'billing_admin');
      const orgId = req.params.orgId;
      const row = await withTx(deps.pool, ctx(orgId, p.userId), async (c) => {
        await orgExists(c, orgId);
        const id = newId('accessRequest');
        await c.query(
          `insert into support_access_requests (id, org_id, scope, reason, duration_minutes, requested_by)
           values ($1, $2, $3, $4, $5, $6)`,
          [id, orgId, req.body.scope, req.body.reason.trim(), req.body.duration_minutes, p.userId],
        );
        await platformAudit(c, {
          actor: p.userId,
          action: 'support.access_requested',
          orgId,
          target: id,
          details: { scope: req.body.scope, minutes: req.body.duration_minutes },
          requestId: req.id,
        });
        const r = await c.query(
          `select ${ACCESS_COLUMNS} from support_access_requests r
          left join users u on u.id = r.requested_by where r.id = $1`,
          [id],
        );
        return r.rows[0];
      });
      return reply.status(201).send(row as never);
    },
  );

  app.get(
    '/support/access-requests',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description: 'Support leads see every request; others see their own. Newest first (at most 100).',
        querystring: Type.Object(
          { state: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('all')])) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ items: Type.Array(AccessRequest) }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req) => {
      const p = staffOf(req);
      const lead = p.staff.roles.includes('support_lead');
      return withTx(deps.pool, ctx(null, p.userId), async (c) => {
        const { rows } = await c.query(
          `select ${ACCESS_COLUMNS} from support_access_requests r left join users u on u.id = r.requested_by
            where ($1::boolean or r.requested_by = $2) and ($3::text is null or r.state = 'pending')
            order by r.created_at desc limit 100`,
          [lead, p.userId, req.query.state === 'pending' ? 'pending' : null],
        );
        return { items: rows as never };
      });
    },
  );

  app.post(
    '/support/access-requests/:id/decision',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'A support lead approves or denies a pending request (never their own). Approval starts the clock; the ' +
          'organization’s activity log records it.',
        params: IdParam('sar'),
        body: AccessDecision,
        response: { 200: AccessRequest, ...errors },
      },
    },
    async (req) => {
      const p = staffOf(req, 'support_lead');
      return withTx(deps.pool, ctx(null, p.userId), async (c) => {
        const { rows } = await c.query<{
          org_id: string;
          requested_by: string;
          state: string;
          scope: string;
          duration_minutes: number;
        }>(
          'select org_id, requested_by, state, scope, duration_minutes from support_access_requests where id = $1 for update',
          [req.params.id],
        );
        const r = rows[0];
        if (!r) throw new ApiError('NOT_FOUND', 'Request not found');
        if (r.requested_by === p.userId) {
          throw new ApiError('FORBIDDEN', 'A different support lead must decide on your own request', {
            reason: 'own_request',
          });
        }
        if (r.state !== 'pending') throw new ApiError('VERSION_CONFLICT', 'This request was already decided');
        const approve = req.body.decision === 'approve';
        await c.query(
          `update support_access_requests set state = $2, decided_by = $3, decided_at = now(),
                  expires_at = case when $2 = 'approved' then now() + make_interval(mins => duration_minutes) end
            where id = $1`,
          [req.params.id, approve ? 'approved' : 'denied', p.userId],
        );
        await platformAudit(c, {
          actor: p.userId,
          action: approve ? 'support.access_approved' : 'support.access_denied',
          orgId: r.org_id,
          target: req.params.id,
          details: { scope: r.scope, requested_by: r.requested_by, minutes: r.duration_minutes },
          requestId: req.id,
        });
        if (approve) {
          await c.query("select set_config('app.org_id', $1, true)", [r.org_id]);
          await orgAudit(c, r.org_id, r.requested_by, 'support.access_granted', req.id, {
            scope: r.scope,
            minutes: r.duration_minutes,
            approved_by: p.userId,
          });
        }
        const out = await c.query(
          `select ${ACCESS_COLUMNS} from support_access_requests r
          left join users u on u.id = r.requested_by where r.id = $1`,
          [req.params.id],
        );
        return out.rows[0] as never;
      });
    },
  );

  app.post(
    '/support/access-requests/:id/revoke',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description: 'Ends an approved or pending request early (its requester or a support lead).',
        params: IdParam('sar'),
        response: { 200: AccessRequest, ...errors },
      },
    },
    async (req) => {
      const p = staffOf(req);
      return withTx(deps.pool, ctx(null, p.userId), async (c) => {
        const { rows } = await c.query<{ org_id: string; requested_by: string; state: string }>(
          'select org_id, requested_by, state from support_access_requests where id = $1 for update',
          [req.params.id],
        );
        const r = rows[0];
        if (!r || (r.requested_by !== p.userId && !p.staff.roles.includes('support_lead'))) {
          throw new ApiError('NOT_FOUND', 'Request not found');
        }
        if (r.state === 'pending' || r.state === 'approved') {
          await c.query(
            `update support_access_requests set state = 'revoked',
                    expires_at = case when expires_at is not null then least(expires_at, now()) end
              where id = $1`,
            [req.params.id],
          );
          await platformAudit(c, {
            actor: p.userId,
            action: 'support.access_revoked',
            orgId: r.org_id,
            target: req.params.id,
            requestId: req.id,
          });
        }
        const out = await c.query(
          `select ${ACCESS_COLUMNS} from support_access_requests r
          left join users u on u.id = r.requested_by where r.id = $1`,
          [req.params.id],
        );
        return out.rows[0] as never;
      });
    },
  );

  /**
   * Approved access, or (milestone 12) break-glass access, which needs no approval but is recorded as such in the
   * platform audit and the organization's activity log, and raises a console alert.
   */
  const needAccess = async (
    c: pg.PoolClient,
    orgId: string,
    p: StaffPrincipal,
    scope: SupportAccessScope,
    requestId: string,
  ) => {
    const active = await activeAccess(c, orgId, p.userId);
    if (!active.includes(scope) && p.staff.breakGlass) {
      await breakGlassUsed(c, p, orgId, `support.break_glass_${scope}`, requestId);
      return;
    }
    if (!active.includes(scope)) {
      throw new ApiError(
        'FORBIDDEN',
        'Request access to this information first; a support lead must approve it',
        {
          scope,
          reason: 'access_required',
        },
      );
    }
  };

  app.get(
    '/support/orgs/:orgId/members',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'Members with e-mail and role — only with approved, unexpired `members` access (recorded).',
        params: OrgParams,
        response: {
          200: Type.Object({ items: Type.Array(SupportMember) }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req) => {
      const p = staffOf(req);
      const orgId = req.params.orgId;
      return withTx(deps.pool, ctx(orgId, p.userId), async (c) => {
        await orgExists(c, orgId);
        await needAccess(c, orgId, p, 'members', req.id);
        const { rows } = await c.query(
          `select m.user_id, u.display_name, u.email, m.role, ${ts('m.created_at')} as joined_at
             from memberships m join users u on u.id = m.user_id where m.org_id = $1 order by m.created_at`,
          [orgId],
        );
        await platformAudit(c, {
          actor: p.userId,
          action: 'support.viewed_members',
          orgId,
          requestId: req.id,
        });
        await orgAudit(c, orgId, p.userId, 'support.viewed_members', req.id);
        return { items: rows as never };
      });
    },
  );

  app.get(
    '/support/orgs/:orgId/activity',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'The organization’s last 100 activity entries (action, outcome, actor id, target type — no details) — ' +
          'only with approved, unexpired `activity` access (recorded).',
        params: OrgParams,
        response: {
          200: Type.Object({ items: Type.Array(SupportActivityEntry) }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req) => {
      const p = staffOf(req);
      const orgId = req.params.orgId;
      return withTx(deps.pool, ctx(orgId, p.userId), async (c) => {
        await orgExists(c, orgId);
        await needAccess(c, orgId, p, 'activity', req.id);
        const { rows } = await c.query(
          `select ${ts('created_at')} as at, action, outcome, actor_user_id, target_type from audit_events
            where org_id = $1 order by created_at desc, id desc limit 100`,
          [orgId],
        );
        await platformAudit(c, {
          actor: p.userId,
          action: 'support.viewed_activity',
          orgId,
          requestId: req.id,
        });
        await orgAudit(c, orgId, p.userId, 'support.viewed_activity', req.id);
        return { items: rows as never };
      });
    },
  );

  // ---------------------------------------------------------------- overrides and billing actions (billing_admin)
  const OVERRIDE_COLUMNS = `id, org_id, scope, value, reason, created_by, ${ts('created_at')} as created_at,
    ${ts('expires_at')} as expires_at, ${ts('revoked_at')} as revoked_at`;

  app.get(
    '/support/orgs/:orgId/overrides',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description: 'Entitlement overrides of the organization (newest first).',
        params: OrgParams,
        response: {
          200: Type.Object({ items: Type.Array(Override) }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req) => {
      const p = staffOf(req, 'support', 'support_lead', 'billing_admin');
      return withTx(deps.pool, ctx(req.params.orgId, p.userId), async (c) => {
        await orgExists(c, req.params.orgId);
        const { rows } = await c.query(
          `select ${OVERRIDE_COLUMNS} from entitlement_overrides where org_id = $1 order by created_at desc limit 100`,
          [req.params.orgId],
        );
        return { items: rows as never };
      });
    },
  );

  app.post(
    '/support/orgs/:orgId/overrides',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'Adds an entitlement override (billing admins only): a limit, a feature or unrestricted access, with a ' +
          `reason and an expiry within ${BILLING_TIMING.overrideMaxDays} days. Recorded in the platform audit and the ` +
          'organization’s activity log.',
        params: OrgParams,
        body: OverrideCreate,
        response: { 201: Override, ...errors },
      },
    },
    async (req, reply) => {
      const p = staffOf(req, 'billing_admin');
      const orgId = req.params.orgId;
      const b = req.body;
      if (!overrideValueValid(b.scope, b.value)) {
        throw new ApiError('VALIDATION_FAILED', 'This value does not fit the override', { scope: b.scope });
      }
      const expires = new Date(b.expires_at);
      const maxMs = BILLING_TIMING.overrideMaxDays * 86_400_000;
      if (!(expires.getTime() > Date.now() + 60_000) || expires.getTime() > Date.now() + maxMs) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `Overrides expire between a minute and ${BILLING_TIMING.overrideMaxDays} days from now`,
        );
      }
      const row = await withTx(deps.pool, ctx(orgId, p.userId), async (c) => {
        await orgExists(c, orgId);
        const id = newId('override');
        await c.query(
          `insert into entitlement_overrides (id, org_id, scope, value, reason, created_by, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [id, orgId, b.scope, JSON.stringify(b.value), b.reason.trim(), p.userId, expires],
        );
        await platformAudit(c, {
          actor: p.userId,
          action: 'support.override_added',
          orgId,
          target: id,
          details: { scope: b.scope, value: b.value, expires_at: b.expires_at },
          requestId: req.id,
        });
        await orgAudit(c, orgId, p.userId, 'support.override_added', req.id, {
          scope: b.scope,
          expires_at: b.expires_at,
        });
        const r = await c.query(`select ${OVERRIDE_COLUMNS} from entitlement_overrides where id = $1`, [id]);
        return r.rows[0];
      });
      return reply.status(201).send(row as never);
    },
  );

  app.post(
    '/support/overrides/:id/revoke',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description: 'Ends an override now (billing admins only).',
        params: IdParam('ovr'),
        response: { 200: Override, ...errors },
      },
    },
    async (req) => {
      const p = staffOf(req, 'billing_admin');
      return withTx(deps.pool, ctx(null, p.userId), async (c) => {
        // Its organization first (overrides are organization rows under row-level security).
        const orgRow = await c.query<{ org_id: string | null }>(
          'select app.entitlement_override_org($1) as org_id',
          [req.params.id],
        );
        const orgId = orgRow.rows[0]?.org_id;
        if (!orgId) throw new ApiError('NOT_FOUND', 'Override not found');
        await c.query("select set_config('app.org_id', $1, true)", [orgId]);
        await c.query(
          'update entitlement_overrides set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null',
          [req.params.id, p.userId],
        );
        await platformAudit(c, {
          actor: p.userId,
          action: 'support.override_revoked',
          orgId,
          target: req.params.id,
          requestId: req.id,
        });
        await orgAudit(c, orgId, p.userId, 'support.override_revoked', req.id);
        const r = await c.query(`select ${OVERRIDE_COLUMNS} from entitlement_overrides where id = $1`, [
          req.params.id,
        ]);
        return r.rows[0] as never;
      });
    },
  );

  app.post(
    '/support/orgs/:orgId/billing/resync',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'Asks the worker to confirm this organization’s subscription with the payment provider now.',
        params: OrgParams,
        response: {
          202: Type.Object({ queued: Type.Boolean() }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const p = staffOf(req, 'billing_admin');
      const orgId = req.params.orgId;
      const queued = await withTx(deps.pool, ctx(orgId, p.userId), async (c) => {
        await orgExists(c, orgId);
        const r = await c.query<{ queued: boolean }>('select app.billing_request_resync($1) as queued', [
          orgId,
        ]);
        await platformAudit(c, {
          actor: p.userId,
          action: 'support.resync_requested',
          orgId,
          requestId: req.id,
        });
        return r.rows[0]?.queued ?? false;
      });
      return reply.status(202).send({ queued });
    },
  );

  app.get(
    '/support/alerts',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description: 'Reconciliation alerts (open first).',
        querystring: Type.Object({ open: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
        response: {
          200: Type.Object({ items: Type.Array(BillingAlert) }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req) => {
      const p = staffOf(req, 'billing_admin', 'support_lead');
      return withTx(deps.pool, ctx(null, p.userId), async (c) => {
        const { rows } = await c.query(
          `select id, kind, org_id, ref, detail, ${ts('first_seen_at')} as first_seen_at,
                  ${ts('last_seen_at')} as last_seen_at, count, ${ts('resolved_at')} as resolved_at, resolved_by
             from billing_alerts where ($1::boolean is not true or resolved_at is null)
            order by resolved_at nulls first, last_seen_at desc limit 200`,
          [req.query.open ?? null],
        );
        return { items: rows as never };
      });
    },
  );

  app.post(
    '/support/alerts/:id/resolve',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description: 'Marks an alert handled (billing admins only).',
        params: IdParam('alr'),
        response: { 200: BillingAlert, ...errors },
      },
    },
    async (req) => {
      const p = staffOf(req, 'billing_admin');
      return withTx(deps.pool, ctx(null, p.userId), async (c) => {
        const { rows } = await c.query(
          `update billing_alerts set resolved_at = now(), resolved_by = $2 where id = $1 and resolved_at is null
           returning id, kind, org_id, ref, detail, ${ts('first_seen_at')} as first_seen_at,
                     ${ts('last_seen_at')} as last_seen_at, count, ${ts('resolved_at')} as resolved_at, resolved_by`,
          [req.params.id, p.userId],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'No open alert with this id');
        await platformAudit(c, {
          actor: p.userId,
          action: 'support.alert_resolved',
          target: req.params.id,
          requestId: req.id,
        });
        return row as never;
      });
    },
  );

  app.get(
    '/support/audit',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'The platform audit (staff sign-ins, searches, views, access decisions, overrides): last 200.',
        querystring: Type.Object(
          { org_id: Type.Optional(OrgParams.properties.orgId) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ items: Type.Array(PlatformAuditEntry) }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req) => {
      const p = staffOf(req, 'support_lead', 'billing_admin');
      return withTx(deps.pool, ctx(null, p.userId), async (c) => {
        const { rows } = await c.query(
          `select id, ${ts('at')} as at, actor_user_id, action, org_id, target, details from platform_audit
            where ($1::text is null or org_id = $1) order by seq desc limit 200`,
          [req.query.org_id ?? null],
        );
        return { items: rows as never };
      });
    },
  );

  // ---------------------------------------------------------------- milestone 12: audit export, break-glass
  app.get(
    '/support/audit/export',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'Exports the hash-chained platform audit in chain order (support leads), with the chain head, so a copy ' +
          'kept elsewhere proves later that nothing was changed or removed. The export itself is audited.',
        querystring: AuditExportQuery,
        response: { 200: AuditExport, ...errors },
      },
    },
    async (req) => {
      const p = staffOf(req, 'support_lead');
      return withTx(deps.pool, ctx(null, p.userId), async (c) => {
        const items = await exportAudit(c, BigInt(req.query.after_seq ?? '0'), req.query.limit ?? 1000);
        const head = await auditHead(c);
        await platformAudit(c, {
          actor: p.userId,
          action: 'support.audit_exported',
          details: { after_seq: req.query.after_seq ?? '0', entries: items.length, head_seq: head.seq },
          requestId: req.id,
        });
        return { items, head } as never;
      });
    },
  );

  app.post(
    '/support/orgs/:orgId/emergency/revoke-api-tokens',
    {
      config: { staff: true },
      schema: {
        tags: ['support'],
        description:
          'Break-glass only: revokes every API token of the organization at once (a leaked token). Reason required; ' +
          'recorded in the platform audit and the organization’s activity log, and raises a console alert. Customer ' +
          'data is not touched.',
        params: OrgParams,
        body: EmergencyRevokeRequest,
        response: { 200: EmergencyRevokeResult, ...errors },
      },
    },
    async (req) => {
      const p = staffOf(req);
      if (!p.staff.breakGlass) {
        throw new ApiError('FORBIDDEN', 'Emergency actions need break-glass access (granted on the server)', {
          reason: 'break_glass_required',
        });
      }
      const orgId = req.params.orgId;
      return withTx(deps.pool, ctx(orgId, p.userId), async (c) => {
        await orgExists(c, orgId);
        const r = await c.query(
          'update api_tokens set revoked_at = now() where org_id = $1 and revoked_at is null',
          [orgId],
        );
        const revoked = r.rowCount ?? 0;
        await breakGlassUsed(c, p, orgId, 'support.revoked_api_tokens', req.id, {
          revoked,
          reason: req.body.reason,
        });
        return { revoked_api_tokens: revoked };
      });
    },
  );
}
