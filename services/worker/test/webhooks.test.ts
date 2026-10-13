/**
 * Milestone 10: webhook fan-out and delivery. Signed (Standard Webhooks), retried with backoff, dead letters, the same
 * event id on every retry (receivers deduplicate on it), fair batches across organizations, and the destination
 * checks that stop server-side request forgery (SSRF fixtures: private, loopback, metadata and mixed DNS answers,
 * IPv4-in-IPv6, redirects, rebinding). A local receiver stands in for integrators (allowed only in tests).
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localKeyProvider, type RootKeyProvider } from '@pb/api/backup/keys';
import { FIXTURES } from '@pb/api/fixtures';
import { newWebhookSecret, secretContext, verify } from '@pb/api/webhooks/signing';
import { loadConfig } from '@pb/config/env';
import { newId } from '@pb/contracts';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processBatch } from '../src/outbox.ts';
import {
  attemptDelivery,
  type DeliveryOptions,
  processWebhooks,
  resolveDestination,
  type WebhookDeps,
  webhookFanoutConsumer,
} from '../src/webhooks.ts';

const { acme, beta } = FIXTURES.orgs;
let worker: pg.Pool;
let owner: pg.Pool;
let kms: RootKeyProvider;

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  path: string;
}
let server: Server;
let base = '';
const received: Received[] = [];
let respond: (path: string) => { status: number; headers?: Record<string, string> } | 'hang' = () => ({
  status: 204,
});

const local: DeliveryOptions = { allowPrivate: true, timeoutMs: 2000 };
const deps = (): WebhookDeps => ({ pool: worker, kms, options: local, log: () => undefined });

beforeAll(async () => {
  worker = new pg.Pool({
    connectionString: process.env.WORKER_DATABASE_URL,
    options: '-c search_path=app -c TimeZone=UTC',
  });
  owner = new pg.Pool({
    connectionString: process.env.MIGRATION_DATABASE_URL,
    options: '-c search_path=app -c TimeZone=UTC',
  });
  const config = loadConfig();
  if (!config.kms) throw new Error('KMS_LOCAL_KEYS is required for tests');
  kms = localKeyProvider(config.kms);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body, path: req.url ?? '' });
      const r = respond(req.url ?? '');
      if (r === 'hang') return;
      res.writeHead(r.status, r.headers ?? {});
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await worker.end();
  await owner.end();
});
beforeEach(async () => {
  received.length = 0;
  respond = () => ({ status: 204 });
  await owner.query('update outbox_events set published_at = now() where published_at is null');
  await owner.query(
    "update webhook_deliveries set state = 'delivered', next_attempt_at = null where state = 'pending'",
  );
  // Each test works with its own endpoints.
  await owner.query(
    "update webhook_endpoints set state = 'disabled', disabled_reason = 'manual' where state = 'active'",
  );
});

/** An endpoint row as the API would create it (destination checks are the API's; this receiver is local). */
async function endpoint(
  orgId: string,
  events: string[],
  opts: { state?: 'active' | 'disabled'; path?: string; rotateFrom?: Buffer } = {},
) {
  const id = newId('webhookEndpoint');
  const { secret, key } = newWebhookSecret();
  const wrapped = await kms.wrap(key, secretContext(orgId, id));
  let previous: { blob: Buffer; keyId: string } | null = null;
  let previousSecret: string | null = null;
  if (opts.rotateFrom) {
    previous = await kms.wrap(opts.rotateFrom, secretContext(orgId, id));
    previousSecret = `whsec_${opts.rotateFrom.toString('base64')}`;
  }
  await owner.query(
    `insert into webhook_endpoints (id, org_id, destination, events, state, disabled_reason, encrypted_secret,
                                    secret_key_ref, previous_encrypted_secret, previous_secret_key_ref,
                                    previous_secret_until, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      orgId,
      `${base}${opts.path ?? '/hook'}`,
      events,
      opts.state ?? 'active',
      opts.state === 'disabled' ? 'manual' : null,
      wrapped.blob,
      wrapped.keyId,
      previous?.blob ?? null,
      previous?.keyId ?? null,
      previous ? new Date(Date.now() + 600_000) : null,
      orgId === acme.id ? FIXTURES.users.acmeOwner.id : FIXTURES.users.betaOwner.id,
    ],
  );
  return { id, secret, previousSecret };
}

async function event(orgId: string, type: string, payload: Record<string, unknown>): Promise<string> {
  const id = newId('event');
  await owner.query(
    `insert into outbox_events (event_id, org_id, actor_id, aggregate_id, aggregate_version, event_type,
                                redacted_payload)
     values ($1, $2, $3, $4, 1, $5, $6)`,
    [id, orgId, FIXTURES.users.acmeOwner.id, newId('job'), type, JSON.stringify(payload)],
  );
  return id;
}

const jobPayload = (state = 'FAILED') => ({
  job_id: newId('job'),
  profile_id: FIXTURES.profiles.acmeShop.id,
  state,
  agent_id: null,
  error_code: state === 'FAILED' ? 'AGENT_LOST' : null,
  reconciliation_required: false,
  attempt: 1,
});

const deliveries = async (endpointId: string) =>
  (
    await owner.query(
      `select id, event_id, state, attempt, last_status, last_error,
              extract(epoch from next_attempt_at - now())::int as next_in
         from webhook_deliveries where endpoint_id = $1 order by created_at`,
      [endpointId],
    )
  ).rows;

const due = (endpointId: string) =>
  owner.query(
    `update webhook_deliveries set next_attempt_at = now() - interval '1 second' where endpoint_id = $1 and state = 'pending'`,
    [endpointId],
  );

describe('fan-out', () => {
  it('one delivery per subscribed active endpoint of the event’s organization, exactly once', async () => {
    const e1 = await endpoint(acme.id, ['automation.job.failed', 'automation.job.succeeded']);
    const e2 = await endpoint(acme.id, ['automation.job.succeeded']);
    const e3 = await endpoint(acme.id, ['automation.job.failed'], { state: 'disabled' });
    const e4 = await endpoint(beta.id, ['automation.job.failed']);
    const id = await event(acme.id, 'automation.job.failed', jobPayload());
    expect(await processBatch(worker, [webhookFanoutConsumer])).toEqual({ processed: 1, failed: 0 });
    expect((await deliveries(e1.id)).map((d) => d.event_id)).toEqual([id]);
    expect(await deliveries(e2.id)).toEqual([]);
    expect(await deliveries(e3.id)).toEqual([]);
    expect(await deliveries(e4.id)).toEqual([]);
    // The same event handled again (a worker crash after commit) adds nothing.
    await owner.query('update outbox_events set published_at = null where event_id = $1', [id]);
    await owner.query("delete from processed_events where consumer = 'webhook-fanout' and event_id = $1", [
      id,
    ]);
    await processBatch(worker, [webhookFanoutConsumer]);
    expect(await deliveries(e1.id)).toHaveLength(1);
    // A test event goes to its endpoint only.
    await event(acme.id, 'webhook.test', { endpoint_id: e2.id, message: 'This is a test event' });
    await processBatch(worker, [webhookFanoutConsumer]);
    expect(await deliveries(e2.id)).toHaveLength(1);
    expect(await deliveries(e1.id)).toHaveLength(1);
  });
});

describe('delivery', () => {
  it('signs every attempt (Standard Webhooks) and the receiver can verify it', async () => {
    const e = await endpoint(acme.id, ['automation.job.succeeded'], { path: '/signed?x=1' });
    const payload = jobPayload('SUCCEEDED');
    const id = await event(acme.id, 'automation.job.succeeded', payload);
    await processBatch(worker, [webhookFanoutConsumer]);
    const r = await processWebhooks(deps());
    expect(r.delivered).toBeGreaterThanOrEqual(1);
    const got = received.find((x) => x.headers['webhook-id'] === id) as Received;
    expect(got.path).toBe('/signed?x=1');
    expect(got.headers['content-type']).toBe('application/json');
    const body = JSON.parse(got.body);
    expect(body.type).toBe('automation.job.succeeded');
    expect(body.data).toEqual(payload);
    const h = got.headers as Record<string, string>;
    expect(verify(e.secret, h, got.body)).toBe(true);
    // Tampered body, wrong secret, or an old timestamp: refused by the receiver.
    expect(verify(e.secret, h, `${got.body} `)).toBe(false);
    expect(verify(newWebhookSecret().secret, h, got.body)).toBe(false);
    expect(verify(e.secret, h, got.body, Number(h['webhook-timestamp']) + 3600)).toBe(false);
    const [d] = await deliveries(e.id);
    expect(d).toMatchObject({ state: 'delivered', attempt: 1, last_status: 204, last_error: null });
    // The body contains identifiers and states only.
    expect(got.body).not.toMatch(/secret|token|password|cookie/i);
  });

  it('during a secret rotation each delivery carries two signatures; either verifies', async () => {
    const old = randomBytes(32);
    const e = await endpoint(acme.id, ['automation.job.failed'], { rotateFrom: old });
    await event(acme.id, 'automation.job.failed', jobPayload());
    await processBatch(worker, [webhookFanoutConsumer]);
    await processWebhooks(deps());
    const got = received.at(-1) as Received;
    const sigs = String(got.headers['webhook-signature']).split(' ');
    expect(sigs).toHaveLength(2);
    expect(verify(e.secret, got.headers as Record<string, string>, got.body)).toBe(true);
    expect(verify(e.previousSecret as string, got.headers as Record<string, string>, got.body)).toBe(true);
  });

  it('retries with backoff, keeps the same event id, and ends as a dead letter', async () => {
    const e = await endpoint(acme.id, ['automation.job.failed']);
    const id = await event(acme.id, 'automation.job.failed', jobPayload());
    await processBatch(worker, [webhookFanoutConsumer]);
    respond = () => ({ status: 503 });
    await processWebhooks(deps());
    let [d] = await deliveries(e.id);
    expect(d).toMatchObject({ state: 'pending', attempt: 1, last_status: 503, last_error: 'status_5xx' });
    expect(d.next_in).toBeGreaterThan(20);
    expect(d.next_in).toBeLessThanOrEqual(30);
    // Not due yet: nothing is sent.
    received.length = 0;
    await processWebhooks(deps());
    expect(received).toHaveLength(0);
    await due(e.id);
    await processWebhooks(deps());
    [d] = await deliveries(e.id);
    expect(d).toMatchObject({ state: 'pending', attempt: 2 });
    expect(d.next_in).toBeGreaterThan(100);
    // Every retry carries the same webhook-id (receivers deduplicate on it).
    expect(new Set(received.map((r) => r.headers['webhook-id']))).toEqual(new Set([id]));
    // The last scheduled attempt fails: dead letter.
    await owner.query('update webhook_deliveries set attempt = 7 where endpoint_id = $1', [e.id]);
    await due(e.id);
    await processWebhooks(deps());
    [d] = await deliveries(e.id);
    expect(d).toMatchObject({ state: 'dead', attempt: 8, next_in: null });
    // Redelivered (the API sets it pending again): same id and body.
    await owner.query(
      "update webhook_deliveries set state = 'pending', next_attempt_at = now() where endpoint_id = $1",
      [e.id],
    );
    respond = () => ({ status: 200 });
    received.length = 0;
    await processWebhooks(deps());
    expect(received[0]?.headers['webhook-id']).toBe(id);
    expect((await deliveries(e.id))[0]).toMatchObject({ state: 'delivered' });
  });

  it('an endpoint whose deliveries keep dying is turned off', async () => {
    const e = await endpoint(acme.id, ['automation.job.failed']);
    await owner.query('update webhook_endpoints set consecutive_dead = 19 where id = $1', [e.id]);
    await event(acme.id, 'automation.job.failed', jobPayload());
    await processBatch(worker, [webhookFanoutConsumer]);
    await owner.query('update webhook_deliveries set attempt = 7 where endpoint_id = $1', [e.id]);
    respond = () => ({ status: 500 });
    await processWebhooks(deps());
    const { rows } = await owner.query('select state, disabled_reason from webhook_endpoints where id = $1', [
      e.id,
    ]);
    expect(rows[0]).toEqual({ state: 'disabled', disabled_reason: 'failing' });
    const audit = await owner.query(
      "select 1 from audit_events where action = 'webhook.disabled' and target_id = $1",
      [e.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('batches are fair: one organization’s backlog does not crowd out another', async () => {
    const a = await endpoint(acme.id, ['automation.job.failed']);
    const b = await endpoint(beta.id, ['automation.job.failed']);
    for (let i = 0; i < 12; i++) await event(acme.id, 'automation.job.failed', jobPayload());
    for (let i = 0; i < 2; i++) await event(beta.id, 'automation.job.failed', jobPayload());
    await processBatch(worker, [webhookFanoutConsumer]);
    const claimed = await worker.query<{ org_id: string }>('select org_id from app.webhook_claim_due(6, 3)');
    const counts: Record<string, number> = {};
    for (const r of claimed.rows) counts[r.org_id] = (counts[r.org_id] ?? 0) + 1;
    expect(counts[acme.id]).toBe(3);
    expect(counts[beta.id]).toBe(2);
    // Locked for this worker: another one does not take them again.
    const again = await worker.query(
      'select id from app.webhook_claim_due(50, 50) where endpoint_id = any($1)',
      [[a.id, b.id]],
    );
    expect(again.rows.length).toBe(14 - 5);
  });
});

describe('destinations (SSRF fixtures)', () => {
  const strict: DeliveryOptions = { allowPrivate: false, timeoutMs: 1000 };
  const fixture = (url: string) => ({
    destination: url,
    event_id: newId('event'),
    event_type: 'automation.job.failed',
    event_created_at: new Date(),
    payload: jobPayload(),
  });
  const key = [randomBytes(32)];

  it('refuses names that resolve to private, loopback, link-local or metadata addresses (any answer)', async () => {
    const cases: [string, string[]][] = [
      ['loopback', ['127.0.0.1']],
      ['private', ['10.1.2.3']],
      ['metadata', ['169.254.169.254']],
      ['cgnat', ['100.64.1.1']],
      ['mixed answers', ['93.184.216.34', '192.168.1.5']],
      ['ipv6 loopback', ['::1']],
      ['ipv4-mapped ipv6', ['::ffff:169.254.169.254']],
      ['ipv6 unique local', ['fd00::1']],
      ['nat64 of private', ['64:ff9b::a00:1']],
    ];
    for (const [name, addresses] of cases) {
      const opts: DeliveryOptions = {
        ...strict,
        resolve: async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      };
      const r = await attemptDelivery(fixture('https://hooks.integrator.example/pb'), key, opts);
      expect(r, name).toEqual({ ok: false, status: null, error: 'blocked_destination' });
    }
    expect(received).toHaveLength(0);
  });

  it('refuses private address literals, plain http, credentials and privileged ports before resolving', async () => {
    let lookups = 0;
    const opts: DeliveryOptions = {
      ...strict,
      resolve: async () => {
        lookups++;
        return [{ address: '93.184.216.34', family: 4 }];
      },
    };
    for (const url of [
      'https://169.254.169.254/latest/meta-data/',
      'https://[::ffff:127.0.0.1]/',
      'https://10.0.0.1/hook',
      'http://hooks.integrator.example/pb',
      'https://user:pw@hooks.integrator.example/',
      'https://hooks.integrator.example:22/',
      'https://localhost/hook',
      'https://kubernetes.default.svc.cluster.local/',
    ]) {
      const r = await attemptDelivery(fixture(url), key, opts);
      expect(r.error, url).toBe('blocked_destination');
    }
    expect(lookups).toBe(0);
  });

  it('a name that does not resolve fails cleanly', async () => {
    const opts: DeliveryOptions = {
      ...strict,
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    };
    expect((await attemptDelivery(fixture('https://nowhere.integrator.example/'), key, opts)).error).toBe(
      'dns',
    );
  });

  it('connects to the address it checked (no second lookup), sending the name in Host', async () => {
    let lookups = 0;
    const port = (server.address() as AddressInfo).port;
    const opts: DeliveryOptions = {
      allowPrivate: true,
      timeoutMs: 2000,
      resolve: async () => {
        lookups++;
        return [{ address: '127.0.0.1', family: 4 }];
      },
    };
    const r = await attemptDelivery(fixture(`http://rebind.integrator.example:${port}/pinned`), key, opts);
    expect(r.ok).toBe(true);
    expect(lookups).toBe(1);
    expect(received.at(-1)?.headers.host).toBe(`rebind.integrator.example:${port}`);
    expect(await resolveDestination(new URL('https://[::1]/'), strict)).toEqual({
      error: 'blocked_destination',
    });
  });

  it('never follows redirects and gives up on slow receivers', async () => {
    respond = (path) =>
      path === '/redirect' ? { status: 302, headers: { location: `${base}/landed` } } : { status: 200 };
    const r = await attemptDelivery(fixture(`${base}/redirect`), key, local);
    expect(r).toEqual({ ok: false, status: 302, error: 'redirect' });
    expect(received.map((x) => x.path)).not.toContain('/landed');
    respond = () => 'hang';
    const slow = await attemptDelivery(fixture(`${base}/slow`), key, { allowPrivate: true, timeoutMs: 300 });
    expect(slow).toEqual({ ok: false, status: null, error: 'timeout' });
  });
});
