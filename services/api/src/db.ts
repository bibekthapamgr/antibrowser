import pg from 'pg';

/** Timestamps are always rendered by the database in UTC with microsecond precision (RFC 3339). */
export const ts = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    options: '-c search_path=app -c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000',
    application_name: 'pb',
  });
}

export interface TenantContext {
  orgId: string | null;
  userId: string | null;
}

/**
 * Runs fn inside a transaction whose row-level-security context is the server-derived tenant.
 * set_config(..., true) is transaction-local, so context can never leak to the next pooled request.
 */
export async function withTx<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
      ctx.orgId ?? '',
      ctx.userId ?? '',
    ]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
