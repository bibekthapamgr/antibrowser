/**
 * Client and profile grants (milestone 06). Operators and viewers reach only what they are granted: a whole client
 * (all its profiles, including ones added later) or a single profile. Deny by default; removing a grant or the
 * membership takes effect at the member's next request.
 *
 * Milestone 08: a grant carries capabilities (launch, edit, backup_download). Viewers' grants carry none. Taking away
 * the last grant (or capability) that let someone open a profile they have open ends their session lease: their app
 * is told to close it at its next heartbeat.
 */
import {
  ApiError,
  defaultCapabilities,
  Grant,
  GrantCreate,
  GrantUpdate,
  ID_PATTERN,
  newId,
  Page,
  PageQuery,
  type Role,
} from '@pb/contracts';
import Type from 'typebox';
import type { App, Deps } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { appendEvent } from '../outbox.ts';
import { endLeasesOutOfReach } from '../sessions.ts';
import { clientFor, profileFor, requirePermission, resolveTenant } from '../tenancy.ts';
import { errors, GrantParams, isUniqueViolation, OrgParams, pageOf, pageWindow } from './common.ts';

const GRANT_COLUMNS = `g.id, g.user_id, g.client_id, g.profile_id, g.capabilities,
  ${ts('g.created_at')} as created_at`;

/** Viewers cannot be given capabilities (they never open profiles or download backups). */
function capabilitiesFor(role: Role, asked: string[] | undefined): string[] {
  if (asked === undefined) return defaultCapabilities(role);
  if (role !== 'operator' && asked.length > 0) {
    throw new ApiError('VALIDATION_FAILED', 'Only operators can be given capabilities on granted profiles', {
      role,
    });
  }
  return [...new Set(asked)].sort();
}

const GrantQuery = Type.Object(
  { ...PageQuery.properties, user_id: Type.Optional(Type.String({ pattern: ID_PATTERN('usr') })) },
  { additionalProperties: false },
);

export function grantRoutes(app: App, deps: Deps): void {
  app.get(
    '/orgs/:orgId/grants',
    {
      schema: {
        tags: ['grants'],
        params: OrgParams,
        querystring: GrantQuery,
        response: { 200: Page(Grant), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'grants.manage');
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, access, async (c) => {
        const result = await c.query<Grant>(
          `select ${GRANT_COLUMNS} from permission_grants g
            where g.org_id = $1 and ($5::text is null or g.user_id = $5)
              and ($2::timestamptz is null or (g.created_at, g.id) > ($2::timestamptz, $3::text))
            order by g.created_at, g.id limit $4`,
          [
            access.orgId,
            window.after?.k ?? null,
            window.after?.id ?? '',
            window.limit + 1,
            req.query.user_id ?? null,
          ],
        );
        return result.rows;
      });
      return pageOf(rows, window, (g) => ({ k: g.created_at, id: g.id }));
    },
  );

  app.post(
    '/orgs/:orgId/grants',
    {
      schema: {
        tags: ['grants'],
        description: 'Grant a member one client (with all its profiles) or one profile.',
        params: OrgParams,
        body: GrantCreate,
        response: { 201: Grant, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'grants.manage');
      const body = req.body;
      const clientId = 'client_id' in body ? body.client_id : null;
      const profileId = 'profile_id' in body ? body.profile_id : null;
      const grant = await withTx(deps.pool, access, async (c) => {
        const member = await c.query<{ role: Role }>(
          'select role from memberships where org_id = $1 and user_id = $2',
          [access.orgId, body.user_id],
        );
        const role = member.rows[0]?.role;
        if (!role) throw new ApiError('NOT_FOUND', 'Member not found');
        const capabilities = capabilitiesFor(role, body.capabilities);
        if (clientId) await clientFor(c, access, clientId, 'grants.manage', 'c.id');
        if (profileId) await profileFor(c, access, profileId, 'grants.manage', 'p.id');
        const id = newId('grant');
        let row: Grant | undefined;
        try {
          ({
            rows: [row],
          } = await c.query<Grant>(
            `insert into permission_grants as g (id, org_id, user_id, client_id, profile_id, created_by, capabilities)
             values ($1, $2, $3, $4, $5, $6, $7) returning ${GRANT_COLUMNS}`,
            [id, access.orgId, body.user_id, clientId, profileId, access.userId, capabilities],
          ));
        } catch (err) {
          if (isUniqueViolation(err))
            throw new ApiError('ALREADY_EXISTS', 'This member already has this grant');
          throw err;
        }
        if (!row) throw new ApiError('INTERNAL', 'Grant was not created');
        const details = { user_id: body.user_id, client_id: clientId, profile_id: profileId, capabilities };
        await audit(c, changeEntry(access, 'grant.created', 'grant', id, details));
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: id,
          aggregateVersion: 1,
          eventType: 'grant.created',
          payload: details,
        });
        return row;
      });
      return reply.status(201).send(grant);
    },
  );

  app.patch(
    '/orgs/:orgId/grants/:grantId',
    {
      schema: {
        tags: ['grants'],
        description:
          'Changes what a grant allows: launch (open, including uploading the session), edit (configuration) and ' +
          'backup_download (restore). Removing launch from someone who has a profile open ends that session.',
        params: GrantParams,
        body: GrantUpdate,
        response: { 200: Grant, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'grants.manage');
      return withTx(deps.pool, access, async (c) => {
        const current = await c.query<{ user_id: string; role: Role; capabilities: string[] }>(
          `select g.user_id, m.role, g.capabilities from permission_grants g
             join memberships m on m.org_id = g.org_id and m.user_id = g.user_id
            where g.id = $1 and g.org_id = $2 for update of g`,
          [req.params.grantId, access.orgId],
        );
        const cur = current.rows[0];
        if (!cur) throw new ApiError('NOT_FOUND', 'Grant not found');
        const capabilities = capabilitiesFor(cur.role, req.body.capabilities);
        const { rows } = await c.query<Grant>(
          `update permission_grants g set capabilities = $3, updated_at = now()
            where g.id = $1 and g.org_id = $2 returning ${GRANT_COLUMNS}`,
          [req.params.grantId, access.orgId, capabilities],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Grant not found');
        const ended = await endLeasesOutOfReach(c, access, cur.user_id, 'access_removed');
        const details = {
          user_id: cur.user_id,
          from: cur.capabilities,
          to: capabilities,
          sessions_ended: ended.length,
        };
        await audit(c, changeEntry(access, 'grant.updated', 'grant', req.params.grantId, details));
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: req.params.grantId,
          aggregateVersion: 2,
          eventType: 'grant.updated',
          payload: { user_id: cur.user_id, capabilities },
        });
        return row;
      });
    },
  );

  app.delete(
    '/orgs/:orgId/grants/:grantId',
    {
      schema: {
        tags: ['grants'],
        params: GrantParams,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'grants.manage');
      await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{
          user_id: string;
          client_id: string | null;
          profile_id: string | null;
        }>(
          'delete from permission_grants where id = $1 and org_id = $2 returning user_id, client_id, profile_id',
          [req.params.grantId, access.orgId],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Grant not found');
        const ended = await endLeasesOutOfReach(c, access, row.user_id, 'access_removed');
        await audit(
          c,
          changeEntry(access, 'grant.removed', 'grant', req.params.grantId, {
            ...row,
            sessions_ended: ended.length,
          }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: req.params.grantId,
          aggregateVersion: 2,
          eventType: 'grant.removed',
          payload: row,
        });
      });
      return reply.status(204).send(null);
    },
  );
}
