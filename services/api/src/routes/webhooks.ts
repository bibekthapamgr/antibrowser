/**
 * Webhook endpoints (milestone 10, ADR-0017). Owners and admins (webhooks.manage), interactive sign-in only.
 *
 *   GET/POST          /orgs/{org}/webhook-endpoints
 *   GET/PATCH/DELETE  /orgs/{org}/webhook-endpoints/{whk}
 *   POST              /orgs/{org}/webhook-endpoints/{whk}/rotate-secret
 *   POST              /orgs/{org}/webhook-endpoints/{whk}/test
 *   GET               /orgs/{org}/webhook-endpoints/{whk}/deliveries
 *   POST              /orgs/{org}/webhook-endpoints/{whk}/deliveries/{dlv}/redeliver
 *
 * Destinations: HTTPS, public DNS names or public addresses only (no credentials, fragments, private/loopback/
 * link-local/reserved addresses, intranet names or privileged ports). The worker resolves the name again at every
 * delivery, refuses private results, connects to the address it checked and never follows redirects. The signing
 * secret is generated here, shown once and stored encrypted with the server's root key.
 */
import {
  ApiError,
  DeliveryQuery,
  ID_PATTERN,
  newId,
  Page,
  TOKEN_LIMITS,
  WEBHOOK_LIMITS,
  WEBHOOK_TEST_EVENT,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointCreate,
  WebhookEndpointCreated,
  WebhookEndpointUpdate,
  webhookUrlProblem,
} from '@pb/contracts';
import type pg from 'pg';
import Type, { type Static } from 'typebox';
import type { App, Deps } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { appendEvent } from '../outbox.ts';
import { hit, LIMITS } from '../ratelimit.ts';
import { requireInteractive, requirePermission, resolveTenant, type TenantAccess } from '../tenancy.ts';
import { newWebhookSecret, secretContext } from '../webhooks/signing.ts';
import { errors, expectedVersion, OrgParams, pageOf, pageWindow, versionConflict } from './common.ts';

const param = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const EndpointParams = Type.Object(
  { orgId: param('org'), endpointId: param('whk') },
  { additionalProperties: false },
);
const DeliveryParams = Type.Object(
  { orgId: param('org'), endpointId: param('whk'), deliveryId: param('dlv') },
  { additionalProperties: false },
);
const RotateBody = Type.Object(
  { grace_minutes: Type.Optional(Type.Integer({ minimum: 0, maximum: TOKEN_LIMITS.maxGraceMinutes })) },
  { additionalProperties: false },
);

type EndpointView = Static<typeof WebhookEndpoint>;
type DeliveryView = Static<typeof WebhookDelivery>;

const ENDPOINT_COLUMNS = `e.id, e.org_id, e.destination as url, e.description, e.events, e.state, e.disabled_reason,
  ${ts('e.created_at')} as created_at, ${ts('e.updated_at')} as updated_at,
  ${ts('e.secret_rotated_at')} as secret_rotated_at, ${ts('e.last_success_at')} as last_success_at,
  ${ts('e.last_failure_at')} as last_failure_at,
  (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.state = 'dead') as dead_deliveries,
  (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.state = 'pending')
    as pending_deliveries, e.version`;

const DELIVERY_COLUMNS = `d.id, d.endpoint_id, d.event_id, d.event_type, d.state, d.attempt as attempts,
  ${ts('d.next_attempt_at')} as next_attempt_at, d.last_status, d.last_error, ${ts('d.created_at')} as created_at,
  ${ts('d.delivered_at')} as delivered_at`;

async function endpointView(c: pg.PoolClient, orgId: string, id: string): Promise<EndpointView> {
  const { rows } = await c.query<EndpointView>(
    `select ${ENDPOINT_COLUMNS} from webhook_endpoints e where e.org_id = $1 and e.id = $2`,
    [orgId, id],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Webhook endpoint not found');
  return row;
}

function checkDestination(deps: Deps, url: string): void {
  const problem = webhookUrlProblem(url, deps.config.webhooks.allowPrivateDestinations);
  if (problem) {
    throw new ApiError('WEBHOOK_DESTINATION_BLOCKED', 'This address cannot receive webhooks', {
      reason: problem,
    });
  }
}

function keys(deps: Deps) {
  const kms = deps.backup?.kms;
  if (!kms)
    throw new ApiError('UNAVAILABLE', 'Webhooks need the server’s key store, which is not configured');
  return kms;
}

async function access(deps: Deps, req: Parameters<typeof resolveTenant>[1] & { params: { orgId: string } }) {
  requireInteractive(req.principal);
  const a = await resolveTenant(deps.pool, req, req.params.orgId);
  requirePermission(a, 'webhooks.manage');
  return a;
}

async function lockEndpoint(c: pg.PoolClient, a: TenantAccess, id: string) {
  const { rows } = await c.query<{ version: number; state: string }>(
    'select version, state from webhook_endpoints where org_id = $1 and id = $2 for update',
    [a.orgId, id],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Webhook endpoint not found');
  return row;
}

export function webhookRoutes(app: App, deps: Deps): void {
  app.get(
    '/orgs/:orgId/webhook-endpoints',
    {
      schema: {
        tags: ['webhooks'],
        params: OrgParams,
        response: { 200: Type.Object({ items: Type.Array(WebhookEndpoint) }), ...errors },
      },
    },
    async (req) => {
      const a = await access(deps, req);
      return withTx(deps.pool, a, async (c) => {
        const { rows } = await c.query<EndpointView>(
          `select ${ENDPOINT_COLUMNS} from webhook_endpoints e where e.org_id = $1 order by e.created_at`,
          [a.orgId],
        );
        return { items: rows };
      });
    },
  );

  app.post(
    '/orgs/:orgId/webhook-endpoints',
    {
      schema: {
        tags: ['webhooks'],
        description:
          'Adds an endpoint. The answer contains the signing secret once (`whsec_…`). Deliveries are signed ' +
          '(Standard Webhooks headers webhook-id, webhook-timestamp, webhook-signature), retried with backoff ' +
          `(${WEBHOOK_LIMITS.retrySchedule.length} retries over about a day) and then kept as dead letters you can ` +
          'redeliver. The same event id is sent on every retry: deduplicate on it.',
        params: OrgParams,
        body: WebhookEndpointCreate,
        response: { 201: WebhookEndpointCreated, ...errors },
      },
    },
    async (req, reply) => {
      const a = await access(deps, req);
      const kms = keys(deps);
      checkDestination(deps, req.body.url);
      const id = newId('webhookEndpoint');
      const { secret, key } = newWebhookSecret();
      const wrapped = await kms.wrap(key, secretContext(a.orgId, id));
      const endpoint = await withTx(deps.pool, a, async (c) => {
        const count = await c.query<{ n: number }>(
          'select count(*)::int as n from webhook_endpoints where org_id = $1',
          [a.orgId],
        );
        if ((count.rows[0]?.n ?? 0) >= WEBHOOK_LIMITS.endpointsPerOrg) {
          throw new ApiError('QUOTA_EXCEEDED', 'Too many webhook endpoints', {
            limit: WEBHOOK_LIMITS.endpointsPerOrg,
          });
        }
        await c.query(
          `insert into webhook_endpoints (id, org_id, destination, description, events, encrypted_secret, secret_key_ref,
                                          created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            a.orgId,
            req.body.url,
            req.body.description?.trim() ?? '',
            req.body.events,
            wrapped.blob,
            wrapped.keyId,
            a.userId,
          ],
        );
        await audit(c, changeEntry(a, 'webhook.created', 'webhook', id, { events: req.body.events }));
        return endpointView(c, a.orgId, id);
      });
      return reply.status(201).send({ endpoint, secret });
    },
  );

  app.get(
    '/orgs/:orgId/webhook-endpoints/:endpointId',
    {
      schema: { tags: ['webhooks'], params: EndpointParams, response: { 200: WebhookEndpoint, ...errors } },
    },
    async (req, reply) => {
      const a = await access(deps, req);
      const e = await withTx(deps.pool, a, (c) => endpointView(c, a.orgId, req.params.endpointId));
      return reply.header('etag', `"${e.version}"`).send(e);
    },
  );

  app.patch(
    '/orgs/:orgId/webhook-endpoints/:endpointId',
    {
      schema: {
        tags: ['webhooks'],
        description:
          'Change the address, description or events, or turn it off/on (turning on an endpoint that was turned ' +
          'off for failing resets its failure count). Requires If-Match or expected_version.',
        params: EndpointParams,
        body: WebhookEndpointUpdate,
        response: { 200: WebhookEndpoint, ...errors },
      },
    },
    async (req) => {
      const a = await access(deps, req);
      const b = req.body;
      const expected = expectedVersion(req.headers['if-match'], b.expected_version);
      if (b.url) checkDestination(deps, b.url);
      return withTx(deps.pool, a, async (c) => {
        const current = await lockEndpoint(c, a, req.params.endpointId);
        if (current.version !== expected) throw versionConflict(current.version);
        await c.query(
          `update webhook_endpoints set
              destination = coalesce($2, destination), description = coalesce($3, description),
              events = coalesce($4, events),
              state = coalesce($5, state),
              disabled_reason = case when coalesce($5, state) = 'disabled'
                                     then (case when $5 = 'disabled' then 'manual' else disabled_reason end)
                                     else null end,
              consecutive_dead = case when $5 = 'active' then 0 else consecutive_dead end,
              version = version + 1, updated_at = now()
            where id = $1`,
          [
            req.params.endpointId,
            b.url ?? null,
            b.description?.trim() ?? null,
            b.events ?? null,
            b.state ?? null,
          ],
        );
        await audit(
          c,
          changeEntry(a, 'webhook.updated', 'webhook', req.params.endpointId, {
            changed_fields: Object.keys(b)
              .filter((k) => k !== 'expected_version')
              .sort(),
            state: b.state ?? null,
          }),
        );
        return endpointView(c, a.orgId, req.params.endpointId);
      });
    },
  );

  app.delete(
    '/orgs/:orgId/webhook-endpoints/:endpointId',
    {
      schema: {
        tags: ['webhooks'],
        description: 'Removes the endpoint and its delivery history; nothing more is sent to it.',
        params: EndpointParams,
        response: { 204: Type.Null(), ...errors },
      },
    },
    async (req, reply) => {
      const a = await access(deps, req);
      await withTx(deps.pool, a, async (c) => {
        await lockEndpoint(c, a, req.params.endpointId);
        await c.query('delete from webhook_endpoints where id = $1', [req.params.endpointId]);
        await audit(c, changeEntry(a, 'webhook.deleted', 'webhook', req.params.endpointId));
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/orgs/:orgId/webhook-endpoints/:endpointId/rotate-secret',
    {
      schema: {
        tags: ['webhooks'],
        description:
          'A new signing secret (returned once). For grace_minutes (default 60, at most 1440) every delivery carries ' +
          'two signatures, one per secret, so the receiver can switch without missing events.',
        params: EndpointParams,
        body: RotateBody,
        response: { 200: WebhookEndpointCreated, ...errors },
      },
    },
    async (req) => {
      const a = await access(deps, req);
      const kms = keys(deps);
      const grace = req.body.grace_minutes ?? 60;
      const { secret, key } = newWebhookSecret();
      const wrapped = await kms.wrap(key, secretContext(a.orgId, req.params.endpointId));
      const endpoint = await withTx(deps.pool, a, async (c) => {
        await lockEndpoint(c, a, req.params.endpointId);
        await c.query(
          `update webhook_endpoints set
              previous_encrypted_secret = case when $4 > 0 then encrypted_secret end,
              previous_secret_key_ref = case when $4 > 0 then secret_key_ref end,
              previous_secret_until = case when $4 > 0 then now() + make_interval(mins => $4) end,
              encrypted_secret = $2, secret_key_ref = $3, secret_rotated_at = now(), version = version + 1,
              updated_at = now()
            where id = $1`,
          [req.params.endpointId, wrapped.blob, wrapped.keyId, grace],
        );
        await audit(
          c,
          changeEntry(a, 'webhook.secret_rotated', 'webhook', req.params.endpointId, {
            grace_minutes: grace,
          }),
        );
        return endpointView(c, a.orgId, req.params.endpointId);
      });
      return { endpoint, secret };
    },
  );

  app.post(
    '/orgs/:orgId/webhook-endpoints/:endpointId/test',
    {
      schema: {
        tags: ['webhooks'],
        description: `Queues a \`${WEBHOOK_TEST_EVENT}\` event for this endpoint only (signed like any other).`,
        params: EndpointParams,
        response: { 202: Type.Object({ event_id: Type.String({ pattern: ID_PATTERN('evt') }) }), ...errors },
      },
    },
    async (req, reply) => {
      const a = await access(deps, req);
      await hit(deps.pool, LIMITS.webhookTestPerOrg, a.orgId);
      const eventId = await withTx(deps.pool, a, async (c) => {
        const e = await lockEndpoint(c, a, req.params.endpointId);
        if (e.state !== 'active') throw new ApiError('VALIDATION_FAILED', 'Turn the endpoint on first');
        return appendEvent(c, {
          orgId: a.orgId,
          actorId: a.userId,
          aggregateId: req.params.endpointId,
          aggregateVersion: e.version,
          eventType: WEBHOOK_TEST_EVENT,
          payload: { endpoint_id: req.params.endpointId, message: 'This is a test event' },
        });
      });
      return reply.status(202).send({ event_id: eventId });
    },
  );

  app.get(
    '/orgs/:orgId/webhook-endpoints/:endpointId/deliveries',
    {
      schema: {
        tags: ['webhooks'],
        description:
          'Deliveries to this endpoint, newest first (kept 30 days). state=dead lists the dead letters.',
        params: EndpointParams,
        querystring: DeliveryQuery,
        response: { 200: Page(WebhookDelivery), ...errors },
      },
    },
    async (req) => {
      const a = await access(deps, req);
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, a, async (c) => {
        await lockEndpoint(c, a, req.params.endpointId);
        const { rows } = await c.query<DeliveryView>(
          `select ${DELIVERY_COLUMNS} from webhook_deliveries d
            where d.org_id = $1 and d.endpoint_id = $2 and ($5::text is null or d.state = $5)
              and ($3::timestamptz is null or (d.created_at, d.id) < ($3::timestamptz, $4::text))
            order by d.created_at desc, d.id desc limit $6`,
          [
            a.orgId,
            req.params.endpointId,
            window.after?.k ?? null,
            window.after?.id ?? '',
            req.query.state ?? null,
            window.limit + 1,
          ],
        );
        return rows;
      });
      return pageOf(rows, window, (r) => ({ k: r.created_at, id: r.id }));
    },
  );

  app.post(
    '/orgs/:orgId/webhook-endpoints/:endpointId/deliveries/:deliveryId/redeliver',
    {
      schema: {
        tags: ['webhooks'],
        description:
          'Sends a delivery again (a dead letter, or one already delivered) with the same event id and body: ' +
          'receivers that deduplicate on webhook-id ignore it if they already processed it.',
        params: DeliveryParams,
        response: { 200: WebhookDelivery, ...errors },
      },
    },
    async (req) => {
      const a = await access(deps, req);
      return withTx(deps.pool, a, async (c) => {
        const e = await lockEndpoint(c, a, req.params.endpointId);
        if (e.state !== 'active') throw new ApiError('VALIDATION_FAILED', 'Turn the endpoint on first');
        const { rows } = await c.query<DeliveryView>(
          `update webhook_deliveries d set state = 'pending', next_attempt_at = now(), locked_until = null
            where d.org_id = $1 and d.endpoint_id = $2 and d.id = $3
            returning ${DELIVERY_COLUMNS}`,
          [a.orgId, req.params.endpointId, req.params.deliveryId],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Delivery not found');
        await audit(
          c,
          changeEntry(a, 'webhook.redelivered', 'webhook', req.params.endpointId, { delivery_id: row.id }),
        );
        return row;
      });
    },
  );
}
