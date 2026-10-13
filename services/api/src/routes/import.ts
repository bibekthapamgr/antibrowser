/**
 * Moving a local workspace into an organization (milestone 06, step 8). Metadata only: names, clients and notes.
 * The desktop first sends dry_run=true and shows the plan (which clients are created, matched by name or mapped to an
 * existing client); the real run needs an Idempotency-Key and commits everything in one transaction. Organization
 * profiles always get new server ids; the desktop keeps its local records untouched until this commit succeeds and
 * then records the mapping (local id -> organization profile id).
 */
import {
  ApiError,
  type LocalWorkspaceImport,
  LocalWorkspaceImportResult,
  LocalWorkspaceImport as LocalWorkspaceImportSchema,
  newId,
} from '@pb/contracts';
import type pg from 'pg';
import type { Static } from 'typebox';
import type { App, Deps } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { withTx } from '../db.ts';
import { requestDigest, requireIdempotencyKey, runIdempotent } from '../idempotency.ts';
import { nameKey } from '../names.ts';
import { clientFor, requirePermission, resolveTenant, type TenantAccess } from '../tenancy.ts';
import { errors, OrgParams } from './common.ts';

type ImportResult = Static<typeof LocalWorkspaceImportResult>;

export function importRoutes(app: App, deps: Deps): void {
  app.post(
    '/orgs/:orgId/local-import',
    {
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        tags: ['profiles'],
        description:
          'Import a local workspace’s clients and profiles (metadata). dry_run=true returns the plan without ' +
          'changes; dry_run=false requires Idempotency-Key and creates everything atomically.',
        params: OrgParams,
        body: LocalWorkspaceImportSchema,
        response: { 200: LocalWorkspaceImportResult, 201: LocalWorkspaceImportResult, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'profile.create');
      requirePermission(access, 'clients.manage');
      validateReferences(req.body);

      if (req.body.dry_run) {
        const plan = await withTx(deps.pool, access, (c) => planImport(c, access, req.body, false));
        return reply.status(200).send(plan.result);
      }

      const key = requireIdempotencyKey(req.headers['idempotency-key']);
      const digest = requestDigest({ user: access.userId, body: req.body });
      const outcome = await withTx(deps.pool, access, (c) =>
        runIdempotent(c, { orgId: access.orgId, operation: 'import.run', key, digest }, async () => {
          const plan = await planImport(c, access, req.body, true);
          await commitImport(c, access, plan);
          return { status: 201, body: plan.result };
        }),
      );
      return reply
        .status(outcome.replayed ? 200 : outcome.status)
        .header('idempotent-replayed', String(outcome.replayed))
        .send(outcome.body);
    },
  );
}

function validateReferences(body: LocalWorkspaceImport): void {
  const refs = new Set<string>();
  for (const client of body.clients) {
    if (refs.has(client.ref))
      throw new ApiError('VALIDATION_FAILED', `Client ref "${client.ref}" is repeated`);
    refs.add(client.ref);
  }
  const ids = new Set<string>();
  for (const profile of body.profiles) {
    if (ids.has(profile.local_id)) throw new ApiError('VALIDATION_FAILED', 'A local profile id is repeated');
    ids.add(profile.local_id);
    if (profile.client_ref && !refs.has(profile.client_ref)) {
      throw new ApiError('VALIDATION_FAILED', `Unknown client ref "${profile.client_ref}"`);
    }
  }
}

interface Plan {
  result: ImportResult;
  newClients: { id: string; name: string; key: string; colour: string | null }[];
  newProfiles: { id: string; name: string; clientId: string | null; notes: string }[];
}

async function planImport(
  c: pg.PoolClient,
  access: TenantAccess,
  body: LocalWorkspaceImport,
  assignIds: boolean,
): Promise<Plan> {
  const keys = body.clients.filter((cl) => !cl.map_to).map((cl) => nameKey(cl.name));
  const existing = await c.query<{ id: string; name_key: string }>(
    'select id, name_key from clients where org_id = $1 and name_key = any($2::text[])',
    [access.orgId, keys],
  );
  const byKey = new Map(existing.rows.map((r) => [r.name_key, r.id]));
  const planned = new Map<string, string | null>(); // name key -> id planned in this request
  const refToId = new Map<string, string | null>();
  const plan: Plan = {
    result: { dry_run: !assignIds, clients: [], profiles: [] },
    newClients: [],
    newProfiles: [],
  };

  for (const client of body.clients) {
    if (client.map_to) {
      await clientFor(c, access, client.map_to, 'clients.manage', 'c.id');
      refToId.set(client.ref, client.map_to);
      plan.result.clients.push({ ref: client.ref, client_id: client.map_to, outcome: 'mapped' });
      continue;
    }
    const key = nameKey(client.name);
    const found = byKey.get(key);
    if (found) {
      refToId.set(client.ref, found);
      plan.result.clients.push({ ref: client.ref, client_id: found, outcome: 'existing' });
      continue;
    }
    if (planned.has(key)) {
      const id = planned.get(key) ?? null;
      refToId.set(client.ref, id);
      plan.result.clients.push({ ref: client.ref, client_id: id, outcome: 'existing' });
      continue;
    }
    const id = assignIds ? newId('client') : null;
    planned.set(key, id);
    refToId.set(client.ref, id);
    if (id) plan.newClients.push({ id, name: client.name.trim(), key, colour: client.colour ?? null });
    plan.result.clients.push({ ref: client.ref, client_id: id, outcome: 'create' });
  }

  for (const profile of body.profiles) {
    const id = assignIds ? newId('profile') : null;
    const clientId = profile.client_ref ? (refToId.get(profile.client_ref) ?? null) : null;
    if (id) plan.newProfiles.push({ id, name: profile.name, clientId, notes: profile.notes ?? '' });
    plan.result.profiles.push({ local_id: profile.local_id, profile_id: id, outcome: 'create' });
  }
  return plan;
}

async function commitImport(c: pg.PoolClient, access: TenantAccess, plan: Plan): Promise<void> {
  if (plan.newClients.length > 0) {
    await c.query(
      `insert into clients (id, org_id, name, name_key, colour, created_by)
       select x.id, $1, x.name, x.key, x.colour, $2
         from unnest($3::text[], $4::text[], $5::text[], $6::text[]) as x(id, name, key, colour)`,
      [
        access.orgId,
        access.userId,
        plan.newClients.map((x) => x.id),
        plan.newClients.map((x) => x.name),
        plan.newClients.map((x) => x.key),
        plan.newClients.map((x) => x.colour),
      ],
    );
  }
  if (plan.newProfiles.length > 0) {
    await c.query(
      `insert into profiles (id, org_id, name, client_id, notes, created_by)
       select x.id, $1, x.name, x.client_id, x.notes, $2
         from unnest($3::text[], $4::text[], $5::text[], $6::text[]) as x(id, name, client_id, notes)`,
      [
        access.orgId,
        access.userId,
        plan.newProfiles.map((x) => x.id),
        plan.newProfiles.map((x) => x.name),
        plan.newProfiles.map((x) => x.clientId),
        plan.newProfiles.map((x) => x.notes),
      ],
    );
  }
  // One outbox event per created row, written in one statement.
  const events = [
    ...plan.newClients.map((x) => ({ aggregate: x.id, type: 'client.created', payload: {} })),
    ...plan.newProfiles.map((x) => ({
      aggregate: x.id,
      type: 'profile.created',
      payload: { client_id: x.clientId },
    })),
  ];
  if (events.length > 0) {
    await c.query(
      `insert into outbox_events (event_id, org_id, actor_id, aggregate_id, aggregate_version, event_type,
                                  redacted_payload)
       select x.event_id, $1, $2, x.aggregate_id, 1, x.event_type, x.payload::jsonb
         from unnest($3::text[], $4::text[], $5::text[], $6::text[]) as x(event_id, aggregate_id, event_type, payload)`,
      [
        access.orgId,
        access.userId,
        events.map(() => newId('event')),
        events.map((e) => e.aggregate),
        events.map((e) => e.type),
        events.map((e) => JSON.stringify(e.payload)),
      ],
    );
  }
  await audit(
    c,
    changeEntry(access, 'workspace.imported', 'organization', access.orgId, {
      clients_created: plan.newClients.length,
      profiles_created: plan.newProfiles.length,
    }),
  );
}
