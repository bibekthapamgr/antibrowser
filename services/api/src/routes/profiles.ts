/**
 * Organization profiles (metadata). Every profile has exactly one owner organization and at most one client of that
 * organization. Reads and writes go through the caller's role and grants (tenancy.ts): ids outside the caller's reach
 * answer 404 exactly like ids that do not exist, in single, bulk, search and export paths alike.
 */
import {
  ApiError,
  BulkResult,
  ID_PATTERN,
  newId,
  Page,
  PageQuery,
  Profile,
  ProfileBulk,
  ProfileCreate,
  ProfileExport,
  ProfileUpdate,
  roleAllows,
  secretHint,
} from '@pb/contracts';
import type pg from 'pg';
import Type from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { withTx } from '../db.ts';
import { likePattern } from '../names.ts';
import { appendEvent } from '../outbox.ts';
import { capabilitiesSql, inUseJson } from '../sessions.ts';
import {
  clientFor,
  profileFor,
  profileVisible,
  requirePermission,
  requireRecentAuth,
  resolveTenant,
  type TenantAccess,
} from '../tenancy.ts';
import {
  errors,
  expectedVersion,
  OrgParams,
  PROFILE_COLUMNS,
  ProfileParams,
  type ProfileRow,
  pageOf,
  pageWindow,
  versionConflict,
} from './common.ts';

const ProfileQuery = Type.Object(
  {
    ...PageQuery.properties,
    q: Type.Optional(
      Type.String({ minLength: 1, maxLength: 120, description: 'Name contains (case-insensitive).' }),
    ),
    client_id: Type.Optional(Type.String({ pattern: ID_PATTERN('cli') })),
  },
  { additionalProperties: false },
);
const ExportQuery = Type.Object(
  { client_id: Type.Optional(Type.String({ pattern: ID_PATTERN('cli') })) },
  { additionalProperties: false },
);
const MAX_EXPORT = 10_000;
/** The configuration export needs a sign-in this recent (milestone 08: sensitive export). */
export const EXPORT_REAUTH_SECONDS = 600;

/** Organization notes are not a place for secrets (same rule as the window, milestone 08). */
function checkNotes(notes: string | undefined): void {
  const hint = notes ? secretHint(notes) : null;
  if (hint) throw new ApiError('NOTE_LOOKS_SECRET', hint, { field: 'notes' });
}

export function profileRoutes(app: App, deps: Deps): void {
  app.get(
    '/orgs/:orgId/profiles',
    {
      config: { tokens: true },
      schema: {
        tags: ['profiles'],
        description: 'Profiles the caller can see, oldest first; optional name search and client filter.',
        params: OrgParams,
        querystring: ProfileQuery,
        response: { 200: Page(Profile), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'profile.read');
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, access, async (c) => {
        const result = await c.query<ProfileRow>(
          `select ${PROFILE_COLUMNS}, ${inUseJson('p', '$5')} as in_use,
                  ${capabilitiesSql(access, 'p', '$5')} as capabilities
             from profiles p
            where p.org_id = $1 and p.deleted_at is null and ${profileVisible(access, 'p', '$5')}
              and ($6::text is null or p.name ilike $6)
              and ($7::text is null or p.client_id = $7)
              and ($2::timestamptz is null or (p.created_at, p.id) > ($2::timestamptz, $3::text))
            order by p.created_at, p.id
            limit $4`,
          [
            access.orgId,
            window.after?.k ?? null,
            window.after?.id ?? '',
            window.limit + 1,
            access.userId,
            req.query.q ? likePattern(req.query.q) : null,
            req.query.client_id ?? null,
          ],
        );
        return result.rows;
      });
      return pageOf(rows, window, (p) => ({ k: p.created_at, id: p.id }));
    },
  );

  app.post(
    '/orgs/:orgId/profiles',
    {
      config: { tokens: true },
      schema: {
        tags: ['profiles'],
        params: OrgParams,
        body: ProfileCreate,
        response: { 201: Profile, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'profile.create');
      checkNotes(req.body.notes);
      const id = newId('profile');
      const profile = await withTx(deps.pool, access, async (c) => {
        const clientId = req.body.client_id ?? null;
        // A token limited to some profiles cannot create more; one limited to clients creates only inside them.
        if (access.token?.profileIds && !access.token.clientIds) {
          throw new ApiError('TOKEN_SCOPE_MISSING', 'This API token is limited to specific profiles', {
            restriction: 'profile_ids',
          });
        }
        if (access.token?.clientIds && !clientId) {
          throw new ApiError('TOKEN_SCOPE_MISSING', 'This API token creates profiles only for its clients', {
            restriction: 'client_ids',
          });
        }
        if (clientId) await activeClient(c, access, clientId);
        const { rows } = await c.query<ProfileRow>(
          `insert into profiles as p (id, org_id, name, client_id, notes, created_by)
           values ($1, $2, $3, $4, $5, $6) returning ${PROFILE_COLUMNS}`,
          [id, access.orgId, req.body.name, clientId, req.body.notes ?? '', access.userId],
        );
        const row = rows[0];
        if (!row) throw new ApiError('INTERNAL', 'Profile was not created');
        await audit(c, changeEntry(access, 'profile.created', 'profile', id));
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: row.id,
          aggregateVersion: row.version,
          eventType: 'profile.created',
          payload: { client_id: row.client_id },
        });
        return row;
      });
      return reply.status(201).header('etag', `"${profile.version}"`).send(profile);
    },
  );

  app.get(
    '/orgs/:orgId/profiles/export',
    {
      schema: {
        tags: ['profiles'],
        description:
          `Configuration export (names, client, notes) of up to ${MAX_EXPORT} profiles. No browser data or session ` +
          `material. Owners and admins only, after a sign-in within ${EXPORT_REAUTH_SECONDS / 60} minutes.`,
        params: OrgParams,
        querystring: ExportQuery,
        response: { 200: ProfileExport, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'profile.export');
      requireRecentAuth(principalOf(req), EXPORT_REAUTH_SECONDS);
      const profiles = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<{ id: string; name: string; client: string | null; notes: string }>(
          `select p.id, p.name, cl.name as client, p.notes from profiles p
             left join clients cl on cl.org_id = p.org_id and cl.id = p.client_id
            where p.org_id = $1 and p.deleted_at is null and ${profileVisible(access, 'p', '$2')}
              and ($3::text is null or p.client_id = $3)
            order by p.created_at, p.id limit $4`,
          [access.orgId, access.userId, req.query.client_id ?? null, MAX_EXPORT + 1],
        );
        if (rows.length > MAX_EXPORT) {
          throw new ApiError(
            'VALIDATION_FAILED',
            `More than ${MAX_EXPORT} profiles; export one client at a time`,
          );
        }
        await audit(
          c,
          changeEntry(access, 'profile.exported', 'organization', access.orgId, {
            count: rows.length,
            client_id: req.query.client_id ?? null,
          }),
        );
        return rows;
      });
      return {
        format: 'pb-profiles-v1' as const,
        org_id: access.orgId,
        exported_at: new Date().toISOString(),
        profiles,
      };
    },
  );

  app.post(
    '/orgs/:orgId/profiles/bulk',
    {
      schema: {
        tags: ['profiles'],
        description:
          'Set the client of, or delete, up to 500 profiles. Each id gets its own outcome; ids outside the caller’s ' +
          'reach report not_found, profiles open on a device report in_use (delete only).',
        params: OrgParams,
        body: ProfileBulk,
        response: { 200: BulkResult, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const body = req.body;
      const permission = body.action === 'set_client' ? 'profile.update' : 'profile.delete';
      return withTx(deps.pool, access, async (c) => {
        const visible = await c.query<{ id: string; client_id: string | null }>(
          `select p.id, p.client_id from profiles p
            where p.org_id = $1 and p.id = any($2::text[]) and p.deleted_at is null
              and ${profileVisible(access, 'p', '$3')}
            for update`,
          [access.orgId, body.profile_ids, access.userId],
        );
        const found = new Map(visible.rows.map((r) => [r.id, r]));
        const outcome = new Map<string, 'changed' | 'unchanged' | 'not_found' | 'forbidden' | 'in_use'>();
        for (const id of body.profile_ids) outcome.set(id, found.has(id) ? 'forbidden' : 'not_found');
        // Bulk changes are for owners and admins (operators edit one granted profile at a time).
        if (!roleAllows(access.role, permission) || access.scope !== 'organization') {
          return { results: body.profile_ids.map((id) => ({ id, outcome: outcome.get(id) ?? 'not_found' })) };
        }

        let changed: { id: string; version: number }[] = [];
        if (body.action === 'set_client') {
          if (body.client_id) await activeClient(c, access, body.client_id);
          const toChange = [...found.values()].filter((r) => r.client_id !== body.client_id).map((r) => r.id);
          for (const r of found.values()) outcome.set(r.id, 'unchanged');
          ({ rows: changed } = await c.query<{ id: string; version: number }>(
            `update profiles set client_id = $3, version = version + 1, updated_at = now()
              where org_id = $1 and id = any($2::text[]) returning id, version`,
            [access.orgId, toChange, body.client_id],
          ));
        } else {
          const leased = await c.query<{ profile_id: string }>(
            `select profile_id from profile_leases
              where org_id = $1 and profile_id = any($2::text[]) and state = 'active'
                and (expires_at > now() or purpose = 'session')`,
            [access.orgId, [...found.keys()]],
          );
          const inUse = new Set(leased.rows.map((r) => r.profile_id));
          for (const id of inUse) outcome.set(id, 'in_use');
          ({ rows: changed } = await c.query<{ id: string; version: number }>(
            `update profiles set deleted_at = now(), version = version + 1, updated_at = now()
              where org_id = $1 and id = any($2::text[]) returning id, version`,
            [access.orgId, [...found.keys()].filter((id) => !inUse.has(id))],
          ));
        }
        for (const row of changed) {
          outcome.set(row.id, 'changed');
          await appendEvent(c, {
            orgId: access.orgId,
            actorId: access.userId,
            aggregateId: row.id,
            aggregateVersion: row.version,
            eventType: body.action === 'set_client' ? 'profile.updated' : 'profile.deleted',
            payload: body.action === 'set_client' ? { changed_fields: ['client_id'] } : {},
          });
        }
        await audit(
          c,
          changeEntry(access, 'profile.bulk', 'organization', access.orgId, {
            action: body.action,
            requested: body.profile_ids.length,
            changed: changed.length,
          }),
        );
        return { results: body.profile_ids.map((id) => ({ id, outcome: outcome.get(id) ?? 'not_found' })) };
      });
    },
  );

  app.get(
    '/orgs/:orgId/profiles/:profileId',
    {
      config: { tokens: true },
      schema: { tags: ['profiles'], params: ProfileParams, response: { 200: Profile, ...errors } },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const profile = await withTx(deps.pool, access, (c) =>
        profileFor<ProfileRow>(
          c,
          access,
          req.params.profileId,
          'profile.read',
          `${PROFILE_COLUMNS}, ${inUseJson('p', '$3')} as in_use, ${capabilitiesSql(access, 'p', '$3')} as capabilities`,
        ),
      );
      return reply.header('etag', `"${profile.version}"`).send(profile);
    },
  );

  app.patch(
    '/orgs/:orgId/profiles/:profileId',
    {
      config: { tokens: true },
      schema: {
        tags: ['profiles'],
        description: 'Requires If-Match: "<version>" or body.expected_version. Stale versions return 409.',
        params: ProfileParams,
        body: ProfileUpdate,
        response: { 200: Profile, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const { expected_version: bodyVersion, ...changes } = req.body;
      const expected = expectedVersion(req.headers['if-match'], bodyVersion);
      if (Object.keys(changes).length === 0) throw new ApiError('VALIDATION_FAILED', 'No fields to update');
      checkNotes(changes.notes);
      // Moving a profile to another client changes who can reach it: owners and admins only.
      if ('client_id' in changes && access.scope !== 'organization') {
        throw new ApiError('FORBIDDEN', 'Only owners and admins move profiles between clients', {
          permission: 'clients.manage',
        });
      }

      const profile = await withTx(deps.pool, access, async (c) => {
        const current = await profileFor<{ version: number }>(
          c,
          access,
          req.params.profileId,
          'profile.update',
          'p.version',
          true,
        );
        if (current.version !== expected) throw versionConflict(current.version);
        if (changes.client_id) await activeClient(c, access, changes.client_id);
        const { rows } = await c.query<ProfileRow>(
          `update profiles p set
              name = coalesce($3, p.name),
              client_id = case when $4::boolean then $5 else p.client_id end,
              notes = coalesce($6, p.notes),
              version = p.version + 1,
              updated_at = now()
            where p.id = $1 and p.org_id = $2
            returning ${PROFILE_COLUMNS}`,
          [
            req.params.profileId,
            access.orgId,
            changes.name ?? null,
            'client_id' in changes,
            changes.client_id ?? null,
            changes.notes ?? null,
          ],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Profile not found');
        const changedFields = Object.keys(changes).sort();
        await audit(
          c,
          changeEntry(access, 'profile.updated', 'profile', row.id, { changed_fields: changedFields }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: row.id,
          aggregateVersion: row.version,
          eventType: 'profile.updated',
          payload: { changed_fields: changedFields },
        });
        return row;
      });
      return reply.header('etag', `"${profile.version}"`).send(profile);
    },
  );

  app.delete(
    '/orgs/:orgId/profiles/:profileId',
    {
      config: { tokens: true },
      schema: {
        tags: ['profiles'],
        description:
          'Requires If-Match: "<version>". Refused while the profile is open on a device (LEASE_HELD).',
        params: ProfileParams,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      await withTx(deps.pool, access, async (c) => {
        const current = await profileFor<{ version: number }>(
          c,
          access,
          req.params.profileId,
          'profile.delete',
          'p.version',
          true,
        );
        const expected = expectedVersion(req.headers['if-match'], undefined);
        if (current.version !== expected) throw versionConflict(current.version);
        const leased = await c.query(
          `select 1 from profile_leases
            where profile_id = $1 and org_id = $2 and state = 'active'
              and (expires_at > now() or purpose = 'session')`,
          [req.params.profileId, access.orgId],
        );
        if ((leased.rowCount ?? 0) > 0) {
          throw new ApiError('LEASE_HELD', 'This profile is open on a device; close it there first');
        }
        const { rows } = await c.query<{ version: number }>(
          `update profiles set deleted_at = now(), version = version + 1, updated_at = now()
            where id = $1 and org_id = $2 returning version`,
          [req.params.profileId, access.orgId],
        );
        await audit(c, changeEntry(access, 'profile.deleted', 'profile', req.params.profileId));
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: req.params.profileId,
          aggregateVersion: rows[0]?.version ?? current.version + 1,
          eventType: 'profile.deleted',
          payload: {},
        });
      });
      return reply.status(204).send(null);
    },
  );
}

/** The client must be reachable by the caller and not archived. */
async function activeClient(c: pg.PoolClient, access: TenantAccess, clientId: string): Promise<void> {
  const client = await clientFor<{ archived: boolean }>(
    c,
    access,
    clientId,
    'clients.read',
    'c.archived_at is not null as archived',
  );
  if (client.archived) throw new ApiError('VALIDATION_FAILED', 'This client is archived');
}
