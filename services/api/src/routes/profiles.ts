import {
  ApiError,
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  newId,
  Page,
  PageQuery,
  Profile,
  ProfileCreate,
  ProfileUpdate,
} from '@pb/contracts';
import { type App, type Deps, principalOf } from '../app.ts';
import { withTx } from '../db.ts';
import { appendEvent } from '../outbox.ts';
import { requirePermission, resolveTenant } from '../tenancy.ts';
import { errors, OrgParams, PROFILE_COLUMNS, ProfileParams, type ProfileRow } from './common.ts';

export function profileRoutes(app: App, deps: Deps): void {
  app.get(
    '/orgs/:orgId/profiles',
    {
      schema: {
        tags: ['profiles'],
        params: OrgParams,
        querystring: PageQuery,
        response: { 200: Page(Profile), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, principalOf(req).userId, req.params.orgId);
      requirePermission(access, 'profile.read');
      const limit = req.query.limit ?? DEFAULT_PAGE_SIZE;
      const after = req.query.cursor ? decodeCursor(req.query.cursor) : null;
      if (req.query.cursor && !after) throw new ApiError('VALIDATION_FAILED', 'cursor is invalid');

      const rows = await withTx(deps.pool, access, async (c) => {
        const result = await c.query<ProfileRow>(
          `select ${PROFILE_COLUMNS} from profiles
            where org_id = $1 and deleted_at is null
              and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::text))
            order by created_at, id
            limit $4`,
          [access.orgId, after?.k ?? null, after?.id ?? '', limit + 1],
        );
        return result.rows;
      });

      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        next_cursor: rows.length > limit && last ? encodeCursor({ k: last.created_at, id: last.id }) : null,
      };
    },
  );

  app.post(
    '/orgs/:orgId/profiles',
    {
      schema: {
        tags: ['profiles'],
        params: OrgParams,
        body: ProfileCreate,
        response: { 201: Profile, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, principalOf(req).userId, req.params.orgId);
      requirePermission(access, 'profile.create');
      const id = newId('profile');
      const profile = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<ProfileRow>(
          `insert into profiles (id, org_id, name, client_label, folder_label, notes, created_by)
           values ($1, $2, $3, $4, $5, $6, $7) returning ${PROFILE_COLUMNS}`,
          [
            id,
            access.orgId,
            req.body.name,
            req.body.client_label ?? null,
            req.body.folder_label ?? null,
            req.body.notes ?? '',
            access.userId,
          ],
        );
        const row = rows[0] as ProfileRow;
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: row.id,
          aggregateVersion: row.version,
          eventType: 'profile.created',
          payload: { name: row.name, client_label: row.client_label },
        });
        return row;
      });
      return reply.status(201).header('etag', `"${profile.version}"`).send(profile);
    },
  );

  app.get(
    '/orgs/:orgId/profiles/:profileId',
    { schema: { tags: ['profiles'], params: ProfileParams, response: { 200: Profile, ...errors } } },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, principalOf(req).userId, req.params.orgId);
      requirePermission(access, 'profile.read');
      const profile = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<ProfileRow>(
          `select ${PROFILE_COLUMNS} from profiles where id = $1 and org_id = $2 and deleted_at is null`,
          [req.params.profileId, access.orgId],
        );
        return rows[0];
      });
      if (!profile) throw new ApiError('NOT_FOUND', 'Profile not found');
      return reply.header('etag', `"${profile.version}"`).send(profile);
    },
  );

  app.patch(
    '/orgs/:orgId/profiles/:profileId',
    {
      schema: {
        tags: ['profiles'],
        description: 'Requires If-Match: "<version>" or body.expected_version. Stale versions return 409.',
        params: ProfileParams,
        body: ProfileUpdate,
        response: { 200: Profile, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, principalOf(req).userId, req.params.orgId);
      requirePermission(access, 'profile.update');
      const expected = expectedVersion(req.headers['if-match'], req.body.expected_version);
      const { expected_version: _ignored, ...changes } = req.body;
      if (Object.keys(changes).length === 0) throw new ApiError('VALIDATION_FAILED', 'No fields to update');

      const profile = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<ProfileRow>(
          `update profiles set
              name = coalesce($4, name),
              client_label = case when $5::boolean then $6 else client_label end,
              folder_label = case when $7::boolean then $8 else folder_label end,
              notes = coalesce($9, notes),
              version = version + 1,
              updated_at = now()
            where id = $1 and org_id = $2 and deleted_at is null and version = $3
            returning ${PROFILE_COLUMNS}`,
          [
            req.params.profileId,
            access.orgId,
            expected,
            changes.name ?? null,
            'client_label' in changes,
            changes.client_label ?? null,
            'folder_label' in changes,
            changes.folder_label ?? null,
            changes.notes ?? null,
          ],
        );
        const row = rows[0];
        if (!row) {
          const current = await c.query<{ version: number }>(
            'select version from profiles where id = $1 and org_id = $2 and deleted_at is null',
            [req.params.profileId, access.orgId],
          );
          const currentVersion = current.rows[0]?.version;
          if (currentVersion === undefined) throw new ApiError('NOT_FOUND', 'Profile not found');
          throw new ApiError('VERSION_CONFLICT', 'Profile was changed by someone else; reload and retry', {
            current_version: currentVersion,
          });
        }
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: row.id,
          aggregateVersion: row.version,
          eventType: 'profile.updated',
          payload: { changed_fields: Object.keys(changes).sort() },
        });
        return row;
      });
      return reply.header('etag', `"${profile.version}"`).send(profile);
    },
  );
}

/** Accepts If-Match: "3" (or 3) and/or body.expected_version. Exactly one source of truth is required. */
function expectedVersion(ifMatch: string | undefined, bodyVersion: number | undefined): number {
  let headerVersion: number | undefined;
  if (ifMatch !== undefined) {
    const m = /^(?:W\/)?"?([1-9][0-9]{0,9})"?$/.exec(ifMatch.trim());
    if (!m?.[1]) throw new ApiError('VALIDATION_FAILED', 'If-Match must be a version ETag such as "3"');
    headerVersion = Number(m[1]);
  }
  if (headerVersion !== undefined && bodyVersion !== undefined && headerVersion !== bodyVersion) {
    throw new ApiError('VALIDATION_FAILED', 'If-Match and expected_version disagree');
  }
  const version = headerVersion ?? bodyVersion;
  if (version === undefined) {
    throw new ApiError('PRECONDITION_REQUIRED', 'Send If-Match or expected_version to update this resource');
  }
  return version;
}
