/**
 * Clients (milestone 06): an organization's customers. Profiles belong to at most one client of the same organization
 * (composite foreign key). Operators and viewers see only clients they were granted, or that hold a profile they were
 * granted; anything else answers 404.
 */
import { ApiError, Client, ClientCreate, ClientUpdate, newId, Page, PageQuery } from '@pb/contracts';
import type { App, Deps } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { withTx } from '../db.ts';
import { nameKey } from '../names.ts';
import { appendEvent } from '../outbox.ts';
import { clientFor, clientVisible, requirePermission, resolveTenant } from '../tenancy.ts';
import {
  CLIENT_COLUMNS,
  ClientParams,
  type ClientRow,
  errors,
  expectedVersion,
  isUniqueViolation,
  OrgParams,
  pageOf,
  pageWindow,
  versionConflict,
} from './common.ts';

const DUPLICATE = () => new ApiError('ALREADY_EXISTS', 'A client with this name already exists');

export function clientRoutes(app: App, deps: Deps): void {
  app.get(
    '/orgs/:orgId/clients',
    {
      config: { tokens: true },
      schema: {
        tags: ['clients'],
        params: OrgParams,
        querystring: PageQuery,
        response: { 200: Page(Client), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'clients.read');
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, access, async (c) => {
        const result = await c.query<ClientRow>(
          `select ${CLIENT_COLUMNS} from clients c
            where c.org_id = $1 and ${clientVisible(access, 'c', '$5')}
              and ($2::timestamptz is null or (c.created_at, c.id) > ($2::timestamptz, $3::text))
            order by c.created_at, c.id limit $4`,
          [access.orgId, window.after?.k ?? null, window.after?.id ?? '', window.limit + 1, access.userId],
        );
        return result.rows;
      });
      return pageOf(rows, window, (row) => ({ k: row.created_at, id: row.id }));
    },
  );

  app.post(
    '/orgs/:orgId/clients',
    {
      schema: {
        tags: ['clients'],
        params: OrgParams,
        body: ClientCreate,
        response: { 201: Client, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'clients.manage');
      const name = req.body.name.trim();
      const id = newId('client');
      const client = await withTx(deps.pool, access, async (c) => {
        let row: ClientRow | undefined;
        try {
          ({
            rows: [row],
          } = await c.query<ClientRow>(
            `insert into clients as c (id, org_id, name, name_key, colour, created_by)
             values ($1, $2, $3, $4, $5, $6) returning ${CLIENT_COLUMNS}`,
            [id, access.orgId, name, nameKey(name), req.body.colour ?? null, access.userId],
          ));
        } catch (err) {
          if (isUniqueViolation(err, 'clients_org_id_name_key_key')) throw DUPLICATE();
          throw err;
        }
        if (!row) throw new ApiError('INTERNAL', 'Client was not created');
        await audit(c, changeEntry(access, 'client.created', 'client', id));
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: id,
          aggregateVersion: row.version,
          eventType: 'client.created',
          payload: {},
        });
        return row;
      });
      return reply.status(201).header('etag', `"${client.version}"`).send(client);
    },
  );

  app.get(
    '/orgs/:orgId/clients/:clientId',
    {
      config: { tokens: true },
      schema: { tags: ['clients'], params: ClientParams, response: { 200: Client, ...errors } },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const client = await withTx(deps.pool, access, (c) =>
        clientFor<ClientRow>(c, access, req.params.clientId, 'clients.read', CLIENT_COLUMNS),
      );
      return reply.header('etag', `"${client.version}"`).send(client);
    },
  );

  app.patch(
    '/orgs/:orgId/clients/:clientId',
    {
      schema: {
        tags: ['clients'],
        description: 'Rename, recolour or archive. Requires If-Match: "<version>" or body.expected_version.',
        params: ClientParams,
        body: ClientUpdate,
        response: { 200: Client, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const { expected_version: bodyVersion, ...changes } = req.body;
      const expected = expectedVersion(req.headers['if-match'], bodyVersion);
      if (Object.keys(changes).length === 0) throw new ApiError('VALIDATION_FAILED', 'No fields to update');
      const client = await withTx(deps.pool, access, async (c) => {
        const current = await clientFor<{ version: number }>(
          c,
          access,
          req.params.clientId,
          'clients.manage',
          'c.version',
          true,
        );
        if (current.version !== expected) throw versionConflict(current.version);
        const name = changes.name?.trim();
        let row: ClientRow | undefined;
        try {
          ({
            rows: [row],
          } = await c.query<ClientRow>(
            `update clients c set
                name = coalesce($3, c.name),
                name_key = coalesce($4, c.name_key),
                colour = case when $5::boolean then $6 else c.colour end,
                archived_at = case when $7::boolean is null then c.archived_at
                                   when $7::boolean then coalesce(c.archived_at, now())
                                   else null end,
                version = c.version + 1,
                updated_at = now()
              where c.id = $1 and c.org_id = $2
              returning ${CLIENT_COLUMNS}`,
            [
              req.params.clientId,
              access.orgId,
              name ?? null,
              name ? nameKey(name) : null,
              'colour' in changes,
              changes.colour ?? null,
              changes.archived ?? null,
            ],
          ));
        } catch (err) {
          if (isUniqueViolation(err, 'clients_org_id_name_key_key')) throw DUPLICATE();
          throw err;
        }
        if (!row) throw new ApiError('NOT_FOUND', 'Client not found');
        await audit(
          c,
          changeEntry(access, 'client.updated', 'client', row.id, {
            changed_fields: Object.keys(changes).sort(),
          }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: row.id,
          aggregateVersion: row.version,
          eventType: 'client.updated',
          payload: { changed_fields: Object.keys(changes).sort() },
        });
        return row;
      });
      return reply.header('etag', `"${client.version}"`).send(client);
    },
  );
}
