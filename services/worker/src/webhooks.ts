/**
 * Webhook fan-out and delivery (milestone 10, ADR-0017).
 *
 * Fan-out: an outbox consumer turns each automation.job.* event (and webhook.test) into one delivery per active
 * endpoint subscribed to it, inside the event's transaction (exactly once per endpoint and event: unique key).
 *
 * Delivery: due deliveries are taken fairly across organizations (a few per organization per batch), signed
 * (Standard Webhooks), and sent with these protections against server-side request forgery:
 *  - the address is validated again (HTTPS, public name, allowed port, no credentials);
 *  - the name is resolved here and every resolved address must be public (no private, loopback, link-local,
 *    reserved, multicast or IPv4-in-IPv6 forms of those) — otherwise the attempt fails `blocked_destination`;
 *  - the connection goes to the address that was checked (TLS still verifies the certificate for the name), so a
 *    second DNS answer cannot redirect it (DNS rebinding);
 *  - redirects are never followed (a 3xx is a failed attempt), responses are read up to 4 KiB, 10 s timeout.
 * Production deployments add a network egress policy for the worker (docs/automation/webhooks.md).
 */
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { RootKeyProvider } from '@pb/api/backup/keys';
import { secretContext, signedHeaders, webhookBody } from '@pb/api/webhooks/signing';
import {
  isBlockedAddress,
  newId,
  WEBHOOK_LIMITS,
  WEBHOOK_TEST_EVENT,
  webhookUrlProblem,
} from '@pb/contracts';
import type pg from 'pg';
import type { Consumer } from './outbox.ts';

export const webhookFanoutConsumer: Consumer = {
  name: 'webhook-fanout',
  handles: (type) => type.startsWith('automation.job.') || type === WEBHOOK_TEST_EVENT,
  async handle(client, event) {
    const payload = event.redacted_payload;
    const only = event.event_type === WEBHOOK_TEST_EVENT ? String(payload.endpoint_id ?? '') : null;
    const { rows } = await client.query<{ id: string }>(
      `select id from webhook_endpoints
        where org_id = $1 and state = 'active' and ($2::text is null or id = $2)
          and ($2::text is not null or $3 = any(events))`,
      [event.org_id, only, event.event_type],
    );
    for (const e of rows) {
      await client.query(
        `insert into webhook_deliveries (id, org_id, endpoint_id, event_id, event_type, event_created_at, payload,
                                         state, next_attempt_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'pending', now())
         on conflict (endpoint_id, event_id) do nothing`,
        [
          newId('webhookDelivery'),
          event.org_id,
          e.id,
          event.event_id,
          event.event_type,
          event.created_at,
          JSON.stringify(payload),
        ],
      );
    }
  },
};

export interface DueDelivery {
  id: string;
  org_id: string;
  endpoint_id: string;
  destination: string;
  encrypted_secret: Buffer;
  secret_key_ref: string;
  previous_encrypted_secret: Buffer | null;
  previous_secret_key_ref: string | null;
  event_id: string;
  event_type: string;
  event_created_at: Date;
  payload: Record<string, unknown>;
  attempt: number;
}

export interface AttemptResult {
  ok: boolean;
  status: number | null;
  /** A fixed code (never the receiver's response text). */
  error: string | null;
}

export interface DeliveryOptions {
  /** Development and tests only (configuration refuses it elsewhere). */
  allowPrivate: boolean;
  timeoutMs: number;
  /** Tests resolve names without real DNS. */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}

/** Resolves a destination and checks every address; returns the one to connect to, or why not. */
export async function resolveDestination(
  url: URL,
  opts: DeliveryOptions,
): Promise<{ address: string; family: number } | { error: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = opts.resolve ? await opts.resolve(host) : await lookup(host, { all: true, verbatim: true });
    } catch {
      return { error: 'dns' };
    }
  }
  if (addresses.length === 0) return { error: 'dns' };
  // Every answer must be public: a name that also points somewhere private is refused outright.
  if (!opts.allowPrivate && addresses.some((a) => isBlockedAddress(a.address)))
    return { error: 'blocked_destination' };
  const first = addresses[0];
  return first ? { address: first.address, family: first.family } : { error: 'dns' };
}

/** One attempt: validate, resolve, connect to the checked address, send, read a little, classify. */
export async function attemptDelivery(
  d: Pick<DueDelivery, 'destination' | 'event_id' | 'event_type' | 'event_created_at' | 'payload'>,
  keys: Buffer[],
  opts: DeliveryOptions,
  now: number = Math.floor(Date.now() / 1000),
): Promise<AttemptResult> {
  if (webhookUrlProblem(d.destination, opts.allowPrivate))
    return { ok: false, status: null, error: 'blocked_destination' };
  const url = new URL(d.destination);
  const target = await resolveDestination(url, opts);
  if ('error' in target) return { ok: false, status: null, error: target.error };
  const body = webhookBody(d.event_type, new Date(d.event_created_at), d.payload);
  const headers = {
    ...signedHeaders(keys, d.event_id, now, body),
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'user-agent': 'ProjectBrowser-Webhooks/1',
    host: url.host,
  };
  const secure = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  return new Promise<AttemptResult>((resolve) => {
    let settled = false;
    const done = (r: AttemptResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const options: https.RequestOptions = {
      host: target.address,
      family: target.family,
      port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
      timeout: opts.timeoutMs,
      agent: false,
      ...(secure ? { servername: isIP(url.hostname) ? undefined : url.hostname } : {}),
    };
    const req = (secure ? https : http).request(options, (res) => {
      const status = res.statusCode ?? 0;
      let read = 0;
      res.on('data', (chunk: Buffer) => {
        read += chunk.length;
        if (read > 4096) res.destroy();
      });
      res.on('close', () => {
        if (status >= 200 && status < 300) done({ ok: true, status, error: null });
        else if (status >= 300 && status < 400) done({ ok: false, status, error: 'redirect' });
        else if (status >= 400 && status < 500) done({ ok: false, status, error: 'status_4xx' });
        else done({ ok: false, status, error: 'status_5xx' });
      });
      res.on('error', () => undefined);
    });
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, status: null, error: 'timeout' });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? '';
      done({
        ok: false,
        status: null,
        error: /CERT|SSL|TLS|SELF_SIGNED|ERR_TLS/.test(code) ? 'tls' : 'connection',
      });
    });
    req.end(body);
  });
}

/** Seconds until the next attempt after `attempt` failed ones, or null when the delivery is dead. */
export function nextAttemptSeconds(attempt: number): number | null {
  return WEBHOOK_LIMITS.retrySchedule[attempt] ?? null;
}

export interface WebhookDeps {
  pool: pg.Pool;
  kms: RootKeyProvider;
  options: DeliveryOptions;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

/** Takes due deliveries (fair across organizations) and attempts them, a few at a time. */
export async function processWebhooks(
  d: WebhookDeps,
  limit = 20,
  perOrg = 5,
): Promise<{ delivered: number; failed: number; dead: number }> {
  const { rows } = await d.pool.query<DueDelivery>('select * from app.webhook_claim_due($1, $2)', [
    limit,
    perOrg,
  ]);
  const out = { delivered: 0, failed: 0, dead: 0 };
  const queue = [...rows];
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const r = await deliverOne(d, job);
      if (r === 'delivered') out.delivered++;
      else if (r === 'dead') out.dead++;
      else out.failed++;
    }
  });
  await Promise.all(workers);
  return out;
}

async function deliverOne(d: WebhookDeps, job: DueDelivery): Promise<string> {
  let result: AttemptResult;
  try {
    const keys = [
      await d.kms.unwrap(
        job.secret_key_ref,
        job.encrypted_secret,
        secretContext(job.org_id, job.endpoint_id),
      ),
    ];
    if (job.previous_encrypted_secret && job.previous_secret_key_ref) {
      keys.push(
        await d.kms.unwrap(
          job.previous_secret_key_ref,
          job.previous_encrypted_secret,
          secretContext(job.org_id, job.endpoint_id),
        ),
      );
    }
    result = await attemptDelivery(job, keys, d.options);
  } catch {
    result = { ok: false, status: null, error: 'internal' };
  }
  const next = result.ok ? null : nextAttemptSeconds(job.attempt);
  const { rows } = await d.pool.query<{ state: string }>(
    'select app.webhook_record_attempt($1, $2, $3, $4, $5) as state',
    [job.id, result.ok, result.status, result.error, next],
  );
  return rows[0]?.state ?? 'gone';
}

export interface SweepResult {
  expired: number;
  requeued: number;
  lost: number;
  failed: number;
  stopped: number;
  artifacts_deleted: number;
  jobs_purged: number;
}

/** Claims, lost computers, queue timeouts, keep-open limits and retention (app.automation_sweep). */
export async function sweepAutomation(
  pool: pg.Pool,
  timing: { lostSeconds: number; resumeWindowSeconds: number; maxAttempts: number },
): Promise<SweepResult> {
  const { rows } = await pool.query<{ r: SweepResult }>('select app.automation_sweep(200, $1, $2, $3) as r', [
    timing.lostSeconds,
    timing.resumeWindowSeconds,
    timing.maxAttempts,
  ]);
  return (
    rows[0]?.r ?? {
      expired: 0,
      requeued: 0,
      lost: 0,
      failed: 0,
      stopped: 0,
      artifacts_deleted: 0,
      jobs_purged: 0,
    }
  );
}
