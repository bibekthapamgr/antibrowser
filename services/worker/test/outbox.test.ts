import { FIXTURES } from '@pb/api/fixtures';
import { newId } from '@pb/contracts';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditIndexConsumer,
  backoffSeconds,
  type Consumer,
  processBatch,
  purgeExpiredIdempotencyKeys,
} from '../src/outbox.ts';

const { acme, beta } = FIXTURES.orgs;
let worker: pg.Pool;
let owner: pg.Pool;

beforeAll(() => {
  worker = new pg.Pool({ connectionString: process.env.WORKER_DATABASE_URL, options: '-c search_path=app' });
  owner = new pg.Pool({
    connectionString: process.env.MIGRATION_DATABASE_URL,
    options: '-c search_path=app',
  });
});
afterAll(async () => {
  await worker.end();
  await owner.end();
});
beforeEach(async () => {
  await owner.query('update outbox_events set published_at = now() where published_at is null');
});

async function enqueue(orgId: string, eventType = 'profile.updated'): Promise<string> {
  const id = newId('event');
  await owner.query(
    `insert into outbox_events (event_id, org_id, actor_id, aggregate_id, aggregate_version, event_type)
     values ($1, $2, $3, $4, 1, $5)`,
    [id, orgId, FIXTURES.users.acmeOwner.id, FIXTURES.profiles.acmeShop.id, eventType],
  );
  return id;
}

describe('outbox worker', () => {
  it('applies each event once, under the event tenant, and marks it published', async () => {
    const a = await enqueue(acme.id);
    const b = await enqueue(beta.id);
    const res = await processBatch(worker, [auditIndexConsumer]);
    expect(res).toEqual({ processed: 2, failed: 0 });

    const audit = await owner.query(
      'select org_id, event_id from audit_entries where event_id = any($1) order by org_id',
      [[a, b]],
    );
    expect(audit.rows.map((r) => r.org_id).sort()).toEqual([acme.id, beta.id].sort());
    const pending = await owner.query(
      'select count(*)::int as n from outbox_events where published_at is null',
    );
    expect(pending.rows[0].n).toBe(0);
  });

  it('deduplicates redelivered events by event_id', async () => {
    const id = await enqueue(acme.id);
    await processBatch(worker, [auditIndexConsumer]);
    await owner.query('update outbox_events set published_at = null where event_id = $1', [id]); // simulate redelivery
    const res = await processBatch(worker, [auditIndexConsumer]);
    expect(res.processed).toBe(1);
    const count = await owner.query('select count(*)::int as n from audit_entries where event_id = $1', [id]);
    expect(count.rows[0].n).toBe(1);
  });

  it('isolates a failing event, rolls back its side effects and schedules a retry', async () => {
    const bad = await enqueue(acme.id, 'lease.acquired');
    const good = await enqueue(acme.id, 'profile.updated');
    const flaky: Consumer = {
      name: 'flaky',
      handles: (t) => t === 'lease.acquired',
      handle: async () => {
        throw new Error('boom with secret payload');
      },
    };
    const res = await processBatch(worker, [auditIndexConsumer, flaky]);
    expect(res).toEqual({ processed: 1, failed: 1 });

    const row = await owner.query(
      'select attempts, published_at, last_error, next_attempt_at > now() as later from outbox_events where event_id = $1',
      [bad],
    );
    expect(row.rows[0]).toMatchObject({ attempts: 1, published_at: null, last_error: 'Error', later: true });
    const sideEffect = await owner.query('select count(*)::int as n from audit_entries where event_id = $1', [
      bad,
    ]);
    expect(sideEffect.rows[0].n).toBe(0); // audit insert rolled back with the failed event
    const done = await owner.query(
      'select published_at is not null as ok from outbox_events where event_id = $1',
      [good],
    );
    expect(done.rows[0].ok).toBe(true);
  });

  it('cannot read tenant tables without tenant context', async () => {
    const { rows } = await worker.query('select * from audit_entries');
    expect(rows).toEqual([]);
  });

  it('purges expired idempotency keys through the owner-defined function only', async () => {
    await owner.query(
      `insert into idempotency_keys (org_id, operation, key, request_digest, response_status, response_body, expires_at)
       values ($1, 'lease.acquire', 'expired-key-01', $2, 201, '{}', now() - interval '1 hour')`,
      [acme.id, 'b'.repeat(64)],
    );
    expect(await purgeExpiredIdempotencyKeys(worker)).toBeGreaterThanOrEqual(1);
    await expect(worker.query('delete from idempotency_keys')).rejects.toThrow(/permission denied/);
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffSeconds(1, () => 1)).toBe(2);
    expect(backoffSeconds(5, () => 1)).toBe(32);
    expect(backoffSeconds(50, () => 1)).toBe(900);
    expect(backoffSeconds(3, () => 0)).toBe(1);
  });
});
