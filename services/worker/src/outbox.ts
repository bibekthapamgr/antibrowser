import { newId } from '@pb/contracts';
import type pg from 'pg';

export interface OutboxEvent {
  event_id: string;
  org_id: string;
  actor_id: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: string;
  created_at: Date;
  redacted_payload: Record<string, unknown>;
  attempts: number;
}

/** A consumer must be idempotent per event; the worker additionally deduplicates on (consumer, event_id). */
export interface Consumer {
  name: string;
  handles: (eventType: string) => boolean;
  /** Runs inside the event's transaction with app.org_id set to the event's tenant. */
  handle: (client: pg.PoolClient, event: OutboxEvent) => Promise<void>;
}

export const auditIndexConsumer: Consumer = {
  name: 'audit-index',
  handles: () => true,
  async handle(client, event) {
    await client.query(
      `insert into audit_entries (id, org_id, actor_id, action, target_id, event_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (event_id) do nothing`,
      [
        newId('audit'),
        event.org_id,
        event.actor_id,
        event.event_type,
        event.aggregate_id,
        event.event_id,
        event.created_at,
      ],
    );
  },
};

export const MAX_ATTEMPTS = 12;

/** Exponential backoff with full jitter, capped at 15 minutes. */
export function backoffSeconds(attempts: number, random: () => number = Math.random): number {
  const cap = 900;
  const base = Math.min(cap, 2 ** Math.min(attempts, 10));
  return Math.max(1, Math.round(base * random()));
}

export interface BatchResult {
  processed: number;
  failed: number;
}

/**
 * Processes up to `limit` due events. Each event runs in its own transaction:
 *   lock (SKIP LOCKED, so several workers can run) -> for each consumer: dedupe + handle -> mark published.
 * A failing event is rolled back and rescheduled with backoff; it never blocks other events.
 */
export async function processBatch(pool: pg.Pool, consumers: Consumer[], limit = 50): Promise<BatchResult> {
  const due = await pool.query<{ event_id: string }>(
    `select event_id from outbox_events
      where published_at is null and next_attempt_at <= now() and attempts < $2
      order by created_at, event_id
      limit $1`,
    [limit, MAX_ATTEMPTS],
  );

  const result: BatchResult = { processed: 0, failed: 0 };
  for (const { event_id } of due.rows) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const locked = await client.query<OutboxEvent>(
        `select event_id, org_id, actor_id, aggregate_id, aggregate_version, event_type, created_at,
                redacted_payload, attempts
           from outbox_events
          where event_id = $1 and published_at is null
          for update skip locked`,
        [event_id],
      );
      const event = locked.rows[0];
      if (!event) {
        await client.query('rollback');
        continue; // another worker owns it, or it was already published
      }
      await client.query("select set_config('app.org_id', $1, true)", [event.org_id]);

      for (const consumer of consumers) {
        if (!consumer.handles(event.event_type)) continue;
        const first = await client.query(
          'insert into processed_events (consumer, event_id) values ($1, $2) on conflict do nothing',
          [consumer.name, event.event_id],
        );
        if (first.rowCount === 0) continue; // duplicate delivery: already applied
        await consumer.handle(client, event);
      }

      await client.query(
        'update outbox_events set published_at = now(), last_error = null where event_id = $1',
        [event.event_id],
      );
      await client.query('commit');
      result.processed++;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      result.failed++;
      await pool.query(
        `update outbox_events
            set attempts = attempts + 1,
                next_attempt_at = now() + make_interval(secs => $2),
                last_error = left($3, 500)
          where event_id = $1`,
        [event_id, backoffSeconds((await attemptsOf(pool, event_id)) + 1), safeMessage(err)],
      );
    } finally {
      client.release();
    }
  }
  return result;
}

async function attemptsOf(pool: pg.Pool, eventId: string): Promise<number> {
  const { rows } = await pool.query<{ attempts: number }>(
    'select attempts from outbox_events where event_id = $1',
    [eventId],
  );
  return rows[0]?.attempts ?? 0;
}

/** Error text stored on the event is limited to the error class and a code, never payload or SQL values. */
function safeMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return `${err.name}${code ? ` (${code})` : ''}`;
  }
  return 'UnknownError';
}

export async function purgeExpiredIdempotencyKeys(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select app.purge_expired_idempotency_keys(1000) as n');
  return rows[0]?.n ?? 0;
}

/** Drops rate-limit counters of windows that ended more than a day ago (milestone 06). */
export async function purgeRateLimits(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select app.purge_rate_limits(86400) as n');
  return rows[0]?.n ?? 0;
}
