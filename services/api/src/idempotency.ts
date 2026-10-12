import { createHash } from 'node:crypto';
import { ApiError } from '@pb/contracts';
import type pg from 'pg';

/** Operations that require an Idempotency-Key (milestone 01 contract). */
export type IdempotentOperation = 'lease.acquire' | 'snapshot.commit' | 'billing.job' | 'import.run';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function requireIdempotencyKey(header: string | string[] | undefined): string {
  const key = Array.isArray(header) ? header[0] : header;
  if (!key)
    throw new ApiError('PRECONDITION_REQUIRED', 'Idempotency-Key header is required for this operation');
  if (!KEY_PATTERN.test(key)) {
    throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-]');
  }
  return key;
}

/** Digest over everything that defines "the same request": actor, operation target and canonical body. */
export function requestDigest(parts: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(parts)).digest('hex');
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Executes `fn` at most once per (tenant, operation, key) - uniqueness is enforced by the primary key and the
 * stored request digest must match on replay. Runs inside the caller's tenant transaction:
 *  - the key row is inserted first; a concurrent duplicate blocks on the unique index until the first commits,
 *    then replays the stored response;
 *  - if `fn` throws, the whole transaction (including the key row) rolls back, so failures are never cached
 *    and a retry re-executes.
 */
export async function runIdempotent<T>(
  client: pg.PoolClient,
  scope: { orgId: string; operation: IdempotentOperation; key: string; digest: string },
  fn: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const inserted = await client.query(
    `insert into idempotency_keys (org_id, operation, key, request_digest, response_status, response_body)
     values ($1, $2, $3, $4, 0, 'null'::jsonb)
     on conflict (org_id, operation, key) do nothing
     returning key`,
    [scope.orgId, scope.operation, scope.key, scope.digest],
  );

  if (inserted.rowCount === 0) {
    const { rows } = await client.query<{
      request_digest: string;
      response_status: number;
      response_body: T;
    }>(
      `select request_digest, response_status, response_body from idempotency_keys
       where org_id = $1 and operation = $2 and key = $3 and expires_at > now()`,
      [scope.orgId, scope.operation, scope.key],
    );
    const existing = rows[0];
    if (!existing) {
      throw new ApiError(
        'IDEMPOTENCY_IN_PROGRESS',
        'An expired key is being cleaned up; retry with a new key',
      );
    }
    if (existing.request_digest !== scope.digest) {
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used for a different request',
      );
    }
    return { status: existing.response_status, body: existing.response_body, replayed: true };
  }

  const result = await fn();
  await client.query(
    `update idempotency_keys set response_status = $4, response_body = $5
     where org_id = $1 and operation = $2 and key = $3`,
    [scope.orgId, scope.operation, scope.key, result.status, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
