/**
 * Organizations and members (milestone 06). Owners manage ownership and billing; admins manage members, clients and
 * grants. Ownership only moves through the transfer endpoint, which needs a recent sign-in and is audited; the last
 * owner can never be removed or demoted (enforced by a deferred database constraint trigger as well).
 */
import {
  ApiError,
  Member,
  MemberUpdate,
  newId,
  Organization,
  OrganizationCreate,
  OrganizationUpdate,
  OwnershipTransfer,
  Page,
  PageQuery,
  type Role,
} from '@pb/contracts';
import type pg from 'pg';
import Type from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { appendEvent } from '../outbox.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { endLeasesOutOfReach } from '../sessions.ts';
import { requirePermission, requireRecentAuth, resolveTenant, type TenantAccess } from '../tenancy.ts';
import {
  errors,
  expectedVersion,
  MemberParams,
  OrgParams,
  pageOf,
  pageWindow,
  versionConflict,
} from './common.ts';

const ORG_COLUMNS = `o.id, o.name, o.version, ${ts('o.created_at')} as created_at`;
const MEMBER_COLUMNS = `m.user_id, u.display_name, u.email, m.role, m.version, ${ts('m.created_at')} as created_at`;

export function organizationRoutes(app: App, deps: Deps): void {
  app.post(
    '/organizations',
    {
      schema: {
        tags: ['organizations'],
        description:
          'Creates an organization with the caller as its owner. Requires a verified e-mail address.',
        body: OrganizationCreate,
        response: { 201: Organization, ...errors },
      },
    },
    async (req, reply) => {
      const principal = principalOf(req);
      await hit(deps.pool, LIMITS.orgCreatePerUser, principal.userId);
      const orgId = newId('organization');
      const org = await withTx(deps.pool, { orgId, userId: principal.userId }, async (c) => {
        const user = await c.query<{ email_verified: boolean }>(
          'select email_verified from users where id = $1',
          [principal.userId],
        );
        if (!user.rows[0]?.email_verified) {
          throw new ApiError(
            'EMAIL_NOT_VERIFIED',
            'Verify your e-mail address with your sign-in provider first',
          );
        }
        await c.query('insert into organizations (id, name) values ($1, $2)', [orgId, req.body.name.trim()]);
        await c.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [
          orgId,
          principal.userId,
        ]);
        const { rows } = await c.query<Omit<Organization, 'role'>>(
          `select ${ORG_COLUMNS} from organizations o where o.id = $1`,
          [orgId],
        );
        const row = rows[0];
        if (!row) throw new ApiError('INTERNAL', 'Organization was not created');
        const access = accessOf(orgId, principal.userId, principal.deviceId, 'owner', req.id);
        await audit(
          c,
          changeEntry(access, 'organization.created', 'organization', orgId, {
            name_length: row.name.length,
          }),
        );
        await appendEvent(c, {
          orgId,
          actorId: principal.userId,
          aggregateId: orgId,
          aggregateVersion: row.version,
          eventType: 'organization.created',
          payload: {},
        });
        await appendEvent(c, {
          orgId,
          actorId: principal.userId,
          aggregateId: principal.userId,
          aggregateVersion: 1,
          eventType: 'membership.created',
          payload: { user_id: principal.userId, role: 'owner' },
        });
        return { ...row, role: 'owner' as const };
      });
      return reply.status(201).header('etag', `"${org.version}"`).send(org);
    },
  );

  app.get(
    '/orgs/:orgId',
    { schema: { tags: ['organizations'], params: OrgParams, response: { 200: Organization, ...errors } } },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'org.read');
      const org = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<Omit<Organization, 'role'>>(
          `select ${ORG_COLUMNS} from organizations o where o.id = $1`,
          [access.orgId],
        );
        return rows[0];
      });
      if (!org) throw new ApiError('NOT_FOUND', 'Organization not found');
      return reply.header('etag', `"${org.version}"`).send({ ...org, role: access.role });
    },
  );

  app.patch(
    '/orgs/:orgId',
    {
      schema: {
        tags: ['organizations'],
        description: 'Rename. Requires If-Match: "<version>" or body.expected_version.',
        params: OrgParams,
        body: OrganizationUpdate,
        response: { 200: Organization, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'org.update');
      const expected = expectedVersion(req.headers['if-match'], req.body.expected_version);
      const org = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<Omit<Organization, 'role'>>(
          `update organizations o set name = $3, version = version + 1, updated_at = now()
            where o.id = $1 and o.version = $2 returning ${ORG_COLUMNS}`,
          [access.orgId, expected, req.body.name.trim()],
        );
        const row = rows[0];
        if (!row) {
          const current = await c.query<{ version: number }>(
            'select version from organizations where id = $1',
            [access.orgId],
          );
          throw versionConflict(current.rows[0]?.version ?? 0);
        }
        await audit(c, changeEntry(access, 'organization.renamed', 'organization', access.orgId));
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: access.orgId,
          aggregateVersion: row.version,
          eventType: 'organization.updated',
          payload: { changed_fields: ['name'] },
        });
        return row;
      });
      return reply.header('etag', `"${org.version}"`).send({ ...org, role: access.role });
    },
  );

  app.get(
    '/orgs/:orgId/members',
    {
      schema: {
        tags: ['members'],
        params: OrgParams,
        querystring: PageQuery,
        response: { 200: Page(Member), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'members.read');
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, access, async (c) => {
        const result = await c.query<Member>(
          `select ${MEMBER_COLUMNS} from memberships m join users u on u.id = m.user_id
            where m.org_id = $1
              and ($2::timestamptz is null or (m.created_at, m.user_id) > ($2::timestamptz, $3::text))
            order by m.created_at, m.user_id limit $4`,
          [access.orgId, window.after?.k ?? null, window.after?.id ?? '', window.limit + 1],
        );
        return result.rows;
      });
      return pageOf(rows, window, (m) => ({ k: m.created_at, id: m.user_id }));
    },
  );

  app.patch(
    '/orgs/:orgId/members/:userId',
    {
      schema: {
        tags: ['members'],
        description:
          'Change a member’s role (admin, operator, viewer or billing). Only owners may change an owner’s role; ' +
          'ownership itself moves through /ownership-transfer. Requires If-Match or expected_version.',
        params: MemberParams,
        body: MemberUpdate,
        response: { 200: Member, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'members.manage');
      const expected = expectedVersion(req.headers['if-match'], req.body.expected_version);
      return withTx(deps.pool, access, async (c) => {
        const target = await lockMember(c, access.orgId, req.params.userId);
        if (target.role === 'owner' && access.role !== 'owner') {
          throw new ApiError('FORBIDDEN', 'Only an owner can change an owner’s role', {
            permission: 'org.transfer_ownership',
          });
        }
        if (target.version !== expected) throw versionConflict(target.version);
        if (target.role === req.body.role) return memberRow(c, access.orgId, req.params.userId);
        await c.query(
          `update memberships set role = $3, version = version + 1, updated_at = now()
            where org_id = $1 and user_id = $2`,
          [access.orgId, req.params.userId, req.body.role],
        );
        // Milestone 08: viewers' grants carry no capabilities; a viewer who becomes an operator gets the defaults.
        if (req.body.role === 'viewer') {
          await c.query(
            `update permission_grants set capabilities = '{}', updated_at = now() where org_id = $1 and user_id = $2`,
            [access.orgId, req.params.userId],
          );
        } else if (req.body.role === 'operator' && target.role === 'viewer') {
          await c.query(
            `update permission_grants set capabilities = '{launch,backup_download}', updated_at = now()
              where org_id = $1 and user_id = $2 and capabilities = '{}'`,
            [access.orgId, req.params.userId],
          );
        }
        // Someone who may no longer open a profile they have open: their session ends (fenced out).
        await endLeasesOutOfReach(c, access, req.params.userId, 'role_changed');
        const row = await memberRow(c, access.orgId, req.params.userId);
        await audit(
          c,
          changeEntry(access, 'membership.role_changed', 'user', req.params.userId, {
            from: target.role,
            to: req.body.role,
          }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: req.params.userId,
          aggregateVersion: row.version,
          eventType: 'membership.updated',
          payload: { user_id: req.params.userId, role: req.body.role },
        });
        return row;
      });
    },
  );

  app.delete(
    '/orgs/:orgId/members/:userId',
    {
      schema: {
        tags: ['members'],
        description:
          'Remove a member (or leave, when it is yourself). Their grants are removed with the membership and their ' +
          'access ends at the next request. The last owner cannot be removed.',
        params: MemberParams,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const leaving = req.params.userId === access.userId;
      if (!leaving) requirePermission(access, 'members.manage');
      await withTx(deps.pool, access, async (c) => {
        const target = await lockMember(c, access.orgId, req.params.userId);
        if (!leaving && target.role === 'owner' && access.role !== 'owner') {
          throw new ApiError('FORBIDDEN', 'Only an owner can remove an owner', {
            permission: 'org.transfer_ownership',
          });
        }
        await c.query('delete from memberships where org_id = $1 and user_id = $2', [
          access.orgId,
          req.params.userId,
        ]);
        // Their open sessions end with the membership (their app closes them at its next heartbeat).
        await endLeasesOutOfReach(
          c,
          access,
          req.params.userId,
          leaving ? 'left_organization' : 'member_removed',
        );
        await audit(
          c,
          changeEntry(access, leaving ? 'membership.left' : 'membership.removed', 'user', req.params.userId, {
            role: target.role,
          }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: req.params.userId,
          aggregateVersion: target.version + 1,
          eventType: 'membership.removed',
          payload: { user_id: req.params.userId },
        });
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/orgs/:orgId/ownership-transfer',
    {
      schema: {
        tags: ['members'],
        description:
          'Makes another member an owner and the caller an admin. Requires a sign-in within the last few minutes ' +
          '(REAUTHENTICATION_REQUIRED otherwise) and the target membership version.',
        params: OrgParams,
        body: OwnershipTransfer,
        response: { 200: Member, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'org.transfer_ownership');
      requireRecentAuth(req.principal, deps.config.session.recentAuthSeconds);
      if (req.body.user_id === access.userId) {
        throw new ApiError('VALIDATION_FAILED', 'Choose another member to receive ownership');
      }
      return withTx(deps.pool, access, async (c) => {
        const target = await lockMember(c, access.orgId, req.body.user_id);
        if (target.version !== req.body.expected_version) throw versionConflict(target.version);
        await c.query(
          `update memberships set role = 'owner', version = version + 1, updated_at = now()
            where org_id = $1 and user_id = $2`,
          [access.orgId, req.body.user_id],
        );
        await c.query(
          `update memberships set role = 'admin', version = version + 1, updated_at = now()
            where org_id = $1 and user_id = $2`,
          [access.orgId, access.userId],
        );
        const row = await memberRow(c, access.orgId, req.body.user_id);
        await audit(
          c,
          changeEntry(access, 'organization.ownership_transferred', 'user', req.body.user_id, {
            previous_role: target.role,
            from_user_id: access.userId,
          }),
        );
        for (const [userId, role] of [
          [req.body.user_id, 'owner'],
          [access.userId, 'admin'],
        ] as const) {
          await appendEvent(c, {
            orgId: access.orgId,
            actorId: access.userId,
            aggregateId: userId,
            aggregateVersion: userId === req.body.user_id ? row.version : 1,
            eventType: 'membership.updated',
            payload: { user_id: userId, role },
          });
        }
        return row;
      });
    },
  );
}

// ---------------------------------------------------------------- helpers

async function lockMember(c: pg.PoolClient, orgId: string, userId: string) {
  const { rows } = await c.query<{ role: Role; version: number }>(
    'select role, version from memberships where org_id = $1 and user_id = $2 for update',
    [orgId, userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Member not found');
  return row;
}

async function memberRow(c: pg.PoolClient, orgId: string, userId: string): Promise<Member> {
  const { rows } = await c.query<Member>(
    `select ${MEMBER_COLUMNS} from memberships m join users u on u.id = m.user_id
      where m.org_id = $1 and m.user_id = $2`,
    [orgId, userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Member not found');
  return row;
}

function accessOf(
  orgId: string,
  userId: string,
  deviceId: string | null,
  role: Role,
  requestId: string,
): TenantAccess {
  return { orgId, userId, deviceId, role, scope: 'organization', requestId };
}
