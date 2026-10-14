/**
 * Invitations (milestone 06): bound to one e-mail address, single use, expiring (7 days by default, at most 30).
 * The token is 256 random bits, shown once at creation and stored only as a SHA-256 digest. Accepting requires that
 * the signed-in user's e-mail, as verified by the identity provider, equals the invited address.
 * Invitation tokens appear in URL paths; app.ts masks them before any URL is logged.
 */
import {
  ApiError,
  Invitation,
  InvitationAccepted,
  InvitationCreate,
  InvitationCreated,
  InvitationPreview,
  newId,
  Page,
  PageQuery,
  type Role,
} from '@pb/contracts';
import type pg from 'pg';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, auditAlone, changeEntry } from '../audit.ts';
import { requireBillingAllows } from '../billing/state.ts';
import { ts, withTx } from '../db.ts';
import { appendEvent } from '../outbox.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { newInvitationToken, sha256Hex } from '../session.ts';
import { requirePermission, resolveTenant } from '../tenancy.ts';
import {
  errors,
  InvitationParams,
  isUniqueViolation,
  OrgParams,
  pageOf,
  pageWindow,
  TokenParams,
} from './common.ts';

const STATUS = `case when i.revoked_at is not null then 'revoked'
                     when i.accepted_at is not null then 'accepted'
                     when i.expires_at <= now() then 'expired'
                     else 'open' end`;
const INVITATION_COLUMNS = `i.id, i.email, i.role, ${STATUS} as status, ${ts('i.created_at')} as created_at,
  ${ts('i.expires_at')} as expires_at, ${ts('i.accepted_at')} as accepted_at`;

export function invitationRoutes(app: App, deps: Deps): void {
  app.post(
    '/orgs/:orgId/invitations',
    {
      schema: {
        tags: ['invitations'],
        description:
          'Invite an e-mail address with a role. The token in the response is shown only once; send it to the ' +
          'person. Creating a new invitation for the same address withdraws the previous open one.',
        params: OrgParams,
        body: InvitationCreate,
        response: { 201: InvitationCreated, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requireBillingAllows(access, 'member.invite');
      requirePermission(access, 'members.manage');
      await hit(deps.pool, LIMITS.invitePerOrg, access.orgId);
      await hit(deps.pool, LIMITS.invitePerUser, access.userId);
      const email = req.body.email.trim().toLowerCase();
      const days = req.body.expires_in_days ?? 7;
      const token = newInvitationToken();
      const created = await withTx(deps.pool, access, async (c) => {
        const member = await c.query(
          'select 1 from memberships m join users u on u.id = m.user_id where m.org_id = $1 and u.email = $2',
          [access.orgId, email],
        );
        if ((member.rowCount ?? 0) > 0)
          throw new ApiError('ALREADY_MEMBER', 'This person is already a member');
        const replaced = await c.query<{ id: string }>(
          `update invitations set revoked_at = now(), revoked_by = $3, version = version + 1
            where org_id = $1 and email = $2 and accepted_at is null and revoked_at is null returning id`,
          [access.orgId, email, access.userId],
        );
        for (const old of replaced.rows) {
          await audit(
            c,
            changeEntry(access, 'invitation.revoked', 'invitation', old.id, { reason: 'replaced' }),
          );
        }
        const id = newId('invitation');
        let row: Invitation | undefined;
        try {
          ({
            rows: [row],
          } = await c.query<Invitation>(
            `insert into invitations as i (id, org_id, email, role, token_hash, created_by, expires_at)
             values ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
             returning ${INVITATION_COLUMNS}`,
            [id, access.orgId, email, req.body.role, sha256Hex(token), access.userId, days],
          ));
        } catch (err) {
          if (isUniqueViolation(err, 'invitations_one_open')) {
            throw new ApiError('ALREADY_EXISTS', 'An invitation for this address was just created; reload');
          }
          throw err;
        }
        if (!row) throw new ApiError('INTERNAL', 'Invitation was not created');
        await audit(
          c,
          changeEntry(access, 'invitation.created', 'invitation', id, {
            role: req.body.role,
            expires_in_days: days,
          }),
        );
        return row;
      });
      return reply.status(201).send({ invitation: created, token });
    },
  );

  app.get(
    '/orgs/:orgId/invitations',
    {
      schema: {
        tags: ['invitations'],
        params: OrgParams,
        querystring: PageQuery,
        response: { 200: Page(Invitation), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'members.manage');
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, access, async (c) => {
        const result = await c.query<Invitation>(
          `select ${INVITATION_COLUMNS} from invitations i
            where i.org_id = $1
              and ($2::timestamptz is null or (i.created_at, i.id) > ($2::timestamptz, $3::text))
            order by i.created_at, i.id limit $4`,
          [access.orgId, window.after?.k ?? null, window.after?.id ?? '', window.limit + 1],
        );
        return result.rows;
      });
      return pageOf(rows, window, (i) => ({ k: i.created_at, id: i.id }));
    },
  );

  app.post(
    '/orgs/:orgId/invitations/:invitationId/revoke',
    {
      schema: {
        tags: ['invitations'],
        description: 'Withdraws an open invitation (no effect on one already withdrawn or expired).',
        params: InvitationParams,
        response: { 200: Invitation, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'members.manage');
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<Invitation>(
          `update invitations i set revoked_at = now(), revoked_by = $3, version = version + 1
            where i.id = $1 and i.org_id = $2 and i.accepted_at is null and i.revoked_at is null
            returning ${INVITATION_COLUMNS}`,
          [req.params.invitationId, access.orgId, access.userId],
        );
        if (rows[0]) {
          await audit(c, changeEntry(access, 'invitation.revoked', 'invitation', req.params.invitationId));
          return rows[0];
        }
        const existing = await c.query<Invitation>(
          `select ${INVITATION_COLUMNS} from invitations i where i.id = $1 and i.org_id = $2`,
          [req.params.invitationId, access.orgId],
        );
        const current = existing.rows[0];
        if (!current) throw new ApiError('NOT_FOUND', 'Invitation not found');
        if (current.status === 'accepted')
          throw new ApiError('INVITATION_USED', 'This invitation was already accepted');
        return current;
      });
    },
  );

  app.get(
    '/invitations/:token',
    {
      schema: {
        tags: ['invitations'],
        description: 'What an invitation link leads to, and whether the signed-in account can accept it.',
        params: TokenParams,
        response: { 200: InvitationPreview, ...errors },
      },
    },
    async (req) => {
      const principal = principalOf(req);
      await hit(deps.pool, LIMITS.acceptPerUser, principal.userId);
      await hit(deps.pool, LIMITS.acceptPerIp, req.ip);
      return withTx(deps.pool, { orgId: null, userId: principal.userId }, async (c) => {
        const { rows } = await c.query<{
          org_name: string;
          email: string;
          role: Exclude<Role, 'owner'>;
          expires_at: Date;
          status: 'open' | 'accepted' | 'expired' | 'revoked';
        }>('select org_name, email, role, expires_at, status from app.invitation_by_token($1)', [
          sha256Hex(req.params.token),
        ]);
        const inv = rows[0];
        if (!inv) throw new ApiError('NOT_FOUND', 'Invitation not found');
        const me = await currentUser(c, principal.userId);
        return {
          org_name: inv.org_name,
          role: inv.role,
          expires_at: new Date(inv.expires_at).toISOString(),
          status: inv.status,
          for_this_account: me.email_verified && me.email === inv.email,
        };
      });
    },
  );

  app.post(
    '/invitations/:token/accept',
    {
      schema: {
        tags: ['invitations'],
        description:
          'Join the organization. Single use; refused when expired or withdrawn, and when the signed-in account’s ' +
          'verified e-mail is not the invited address.',
        params: TokenParams,
        response: { 200: InvitationAccepted, ...errors },
      },
    },
    async (req) => {
      const principal = principalOf(req);
      await hit(deps.pool, LIMITS.acceptPerUser, principal.userId);
      await hit(deps.pool, LIMITS.acceptPerIp, req.ip);
      const result = await withTx(deps.pool, { orgId: null, userId: principal.userId }, async (c) => {
        const me = await currentUser(c, principal.userId);
        if (!me.email_verified) {
          throw new ApiError(
            'EMAIL_NOT_VERIFIED',
            'Verify your e-mail address with your sign-in provider first',
          );
        }
        const { rows } = await c.query<{
          outcome: string;
          org_id: string | null;
          role: Role | null;
          invitation_id: string | null;
        }>('select * from app.accept_invitation($1, $2)', [sha256Hex(req.params.token), principal.userId]);
        const r = rows[0];
        if (r?.outcome === 'accepted' && r.org_id && r.role && r.invitation_id) {
          await c.query("select set_config('app.org_id', $1, true)", [r.org_id]);
          const access = {
            orgId: r.org_id,
            userId: principal.userId,
            deviceId: principal.deviceId,
            requestId: req.id,
          };
          await audit(
            c,
            changeEntry(access, 'invitation.accepted', 'invitation', r.invitation_id, { role: r.role }),
          );
          await appendEvent(c, {
            orgId: r.org_id,
            actorId: principal.userId,
            aggregateId: principal.userId,
            aggregateVersion: 1,
            eventType: 'membership.created',
            payload: { user_id: principal.userId, role: r.role, via: 'invitation' },
          });
        }
        return r;
      });
      if (result?.outcome === 'accepted' && result.org_id && result.role) {
        return { org_id: result.org_id, role: result.role };
      }
      const outcome = result?.outcome ?? 'invalid';
      if (outcome !== 'invalid') {
        await auditAlone(deps.pool, {
          orgId: null,
          actorUserId: principal.userId,
          actorDeviceId: principal.deviceId,
          action: 'invitation.accept',
          targetType: 'invitation',
          targetId: result?.invitation_id ?? null,
          outcome: 'denied',
          requestId: req.id,
          details: { reason: outcome },
        });
      }
      throw acceptFailure(outcome);
    },
  );
}

async function currentUser(c: pg.PoolClient, userId: string) {
  const { rows } = await c.query<{ email: string | null; email_verified: boolean }>(
    'select email, email_verified from users where id = $1',
    [userId],
  );
  return rows[0] ?? { email: null, email_verified: false };
}

function acceptFailure(outcome: string): ApiError {
  switch (outcome) {
    case 'expired':
      return new ApiError('INVITATION_EXPIRED', 'This invitation has expired; ask for a new one');
    case 'revoked':
      return new ApiError('INVITATION_EXPIRED', 'This invitation was withdrawn; ask for a new one', {
        reason: 'revoked',
      });
    case 'used':
      return new ApiError('INVITATION_USED', 'This invitation was already used');
    case 'wrong_account':
      return new ApiError(
        'INVITATION_WRONG_ACCOUNT',
        'This invitation is for a different e-mail address; sign in with the invited account',
      );
    case 'already_member':
      return new ApiError('ALREADY_MEMBER', 'You are already a member of this organization');
    default:
      return new ApiError('NOT_FOUND', 'Invitation not found');
  }
}
