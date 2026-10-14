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
  AccessPreview,
  AccessSpec,
  ApiError,
  defaultCapabilities,
  Grant,
  GrantCreate,
  GrantUpdate,
  ID_PATTERN,
  MEMBER_DEFAULT_CAPABILITIES,
  newId,
  Page,
  PageQuery,
  type Role,
} from '@pb/contracts';
import Type from 'typebox';
import { previewScope, scopeRows } from '../access.ts';
import type { App, Deps } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { appendEvent } from '../outbox.ts';
import { endLeasesOutOfReach } from '../sessions.ts';
import { clientFor, profileFor, requirePermission, resolveTenant } from '../tenancy.ts';
import {
  errors,
  GrantParams,
  isUniqueViolation,
  MemberParams,
  OrgParams,
  pageOf,
  pageWindow,
} from './common.ts';

const GRANT_COLUMNS = `g.id, g.user_id, g.client_id, g.profile_id, g.folder_id, g.all_profiles, g.capabilities,
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
      config: { web: true },
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
        description:
          'Grant a member one client (with all its profiles), one profile, one folder (every profile in it, now and ' +
          'later: R3) or the whole workspace (every profile, now and later: R3).',
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
      const folderId = 'folder_id' in body ? body.folder_id : null;
      const allProfiles = 'all_profiles' in body && body.all_profiles === true;
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
        if (folderId) {
          const f = await c.query(
            'select 1 from folders where org_id = $1 and id = $2 and archived_at is null',
            [access.orgId, folderId],
          );
          if (!f.rowCount) throw new ApiError('NOT_FOUND', 'Folder not found');
        }
        const id = newId('grant');
        let row: Grant | undefined;
        try {
          ({
            rows: [row],
          } = await c.query<Grant>(
            `insert into permission_grants as g (id, org_id, user_id, client_id, profile_id, folder_id, all_profiles,
                                               created_by, capabilities)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${GRANT_COLUMNS}`,
            [
              id,
              access.orgId,
              body.user_id,
              clientId,
              profileId,
              folderId,
              allProfiles,
              access.userId,
              capabilities,
            ],
          ));
        } catch (err) {
          if (isUniqueViolation(err))
            throw new ApiError('ALREADY_EXISTS', 'This member already has this grant');
          throw err;
        }
        if (!row) throw new ApiError('INTERNAL', 'Grant was not created');
        const details = {
          user_id: body.user_id,
          client_id: clientId,
          profile_id: profileId,
          folder_id: folderId,
          all_profiles: allProfiles,
          capabilities,
        };
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
          folder_id: string | null;
          all_profiles: boolean;
        }>(
          `delete from permission_grants where id = $1 and org_id = $2
           returning user_id, client_id, profile_id, folder_id, all_profiles`,
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
  // ---------------------------------------------------------------- R3: access in one step
  app.post(
    '/orgs/:orgId/access/preview',
    {
      config: { web: true },
      schema: {
        tags: ['grants'],
        description:
          'What an access choice reaches now (count and up to 50 names) and whether it follows future profiles. ' +
          'Nothing is granted. Shown before inviting someone or changing a member’s access.',
        params: OrgParams,
        body: AccessSpec,
        response: { 200: AccessPreview, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'members.manage');
      return withTx(deps.pool, access, (c) =>
        previewScope(c, access.orgId, req.body.scope, req.body.capabilities ?? MEMBER_DEFAULT_CAPABILITIES),
      );
    },
  );

  app.put(
    '/orgs/:orgId/members/:userId/access',
    {
      config: { web: true },
      schema: {
        tags: ['grants'],
        description:
          'Sets a member’s access in one step: their grants are replaced by the chosen scope and capabilities ' +
          '(members and viewers; admins and owners reach everything). Sessions the member may no longer hold end.',
        params: MemberParams,
        body: AccessSpec,
        response: {
          200: Type.Object({ items: Type.Array(Grant) }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'grants.manage');
      return withTx(deps.pool, access, async (c) => {
        const member = await c.query<{ role: Role }>(
          'select role from memberships where org_id = $1 and user_id = $2',
          [access.orgId, req.params.userId],
        );
        const role = member.rows[0]?.role;
        if (!role) throw new ApiError('NOT_FOUND', 'Member not found');
        if (role !== 'operator' && role !== 'viewer') {
          throw new ApiError(
            'VALIDATION_FAILED',
            'Owners and admins reach every profile; access is for members',
            {
              role,
            },
          );
        }
        const capabilities = capabilitiesFor(
          role,
          req.body.capabilities ?? (role === 'operator' ? MEMBER_DEFAULT_CAPABILITIES : []),
        );
        const rows = await scopeRows(c, access.orgId, req.body.scope);
        await c.query('delete from permission_grants where org_id = $1 and user_id = $2', [
          access.orgId,
          req.params.userId,
        ]);
        const items: Grant[] = [];
        for (const r of rows) {
          const { rows: made } = await c.query<Grant>(
            `insert into permission_grants as g (id, org_id, user_id, client_id, profile_id, folder_id, all_profiles,
                                                 created_by, capabilities)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${GRANT_COLUMNS}`,
            [
              newId('grant'),
              access.orgId,
              req.params.userId,
              r.client_id,
              r.profile_id,
              r.folder_id,
              r.all_profiles,
              access.userId,
              capabilities,
            ],
          );
          if (made[0]) items.push(made[0]);
        }
        const ended = await endLeasesOutOfReach(c, access, req.params.userId, 'access_removed');
        const details = {
          user_id: req.params.userId,
          scope: req.body.scope.kind,
          grants: items.length,
          capabilities,
          sessions_ended: ended.length,
        };
        await audit(c, changeEntry(access, 'grant.access_set', 'member', req.params.userId, details));
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: req.params.userId,
          aggregateVersion: 1,
          eventType: 'grant.access_set',
          payload: details,
        });
        return { items };
      });
    },
  );
}
