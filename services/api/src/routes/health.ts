import Type from 'typebox';
import type { App, Deps } from '../app.ts';
import { errors } from './common.ts';

/**
 * R6: the newest database migration this API build needs. Deploys apply migrations before new code (they stay
 * backward compatible), so a database older than this means the deploy order was broken: not ready.
 * A test keeps it equal to the newest file in infra/db/migrations.
 */
export const REQUIRED_SCHEMA = '0018_operations_watch.sql';
/** The worker records a heartbeat about every minute; older than this counts as stale. */
const WORKER_STALE_SECONDS = 300;

const Readiness = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
  checks: Type.Object({
    database: Type.Union([Type.Literal('ok'), Type.Literal('unreachable')]),
    schema: Type.Union([Type.Literal('current'), Type.Literal('behind'), Type.Literal('unknown')]),
    worker: Type.Union([Type.Literal('ok'), Type.Literal('stale'), Type.Literal('unknown')]),
  }),
});

export function healthRoutes(app: App, deps: Deps): void {
  app.get(
    '/health',
    {
      config: { public: true },
      schema: {
        tags: ['ops'],
        security: [],
        response: { 200: Type.Object({ status: Type.Literal('ok') }), ...errors },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  // The one public readiness endpoint (R6): safe status words only, never names, versions, hosts or errors.
  // Ready means the database answers and its schema is at least what this build needs; the worker's state is
  // reported but does not take the API out of rotation.
  app.get(
    '/ready',
    {
      config: { public: true },
      schema: {
        tags: ['ops'],
        security: [],
        response: { 200: Readiness, 503: Readiness, ...errors },
      },
    },
    async (_req, reply) => {
      const checks: {
        database: 'ok' | 'unreachable';
        schema: 'current' | 'behind' | 'unknown';
        worker: 'ok' | 'stale' | 'unknown';
      } = { database: 'unreachable', schema: 'unknown', worker: 'unknown' };
      try {
        await deps.pool.query('select 1');
        checks.database = 'ok';
        const m = await deps.pool
          .query<{ name: string | null }>('select app.schema_version() as name')
          .catch(() => null);
        const newest = m?.rows[0]?.name;
        if (newest) checks.schema = newest >= REQUIRED_SCHEMA ? 'current' : 'behind';
        const w = await deps.pool
          .query<{ age: number | null }>(
            `select extract(epoch from now() - at)::float8 as age from worker_heartbeats where name = 'worker'`,
          )
          .catch(() => null);
        const age = w?.rows[0]?.age;
        if (typeof age === 'number') checks.worker = age <= WORKER_STALE_SECONDS ? 'ok' : 'stale';
      } catch {
        // database unreachable: reported below
      }
      const ready = checks.database === 'ok' && checks.schema !== 'behind';
      return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
    },
  );
}
