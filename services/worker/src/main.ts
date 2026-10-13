import { loadConfig } from '@pb/config/env';
import pg from 'pg';
import { auditIndexConsumer, processBatch, purgeExpiredIdempotencyKeys, purgeRateLimits } from './outbox.ts';

const config = loadConfig();
const pool = new pg.Pool({
  connectionString: config.workerDatabaseUrl,
  max: 4,
  options: '-c search_path=app -c statement_timeout=10000',
  application_name: 'pb-worker',
});

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...extra }));

let running = true;
const stop = () => {
  running = false;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

let lastPurge = 0;
log('info', 'worker started', { env: config.appEnv });
while (running) {
  try {
    const { processed, failed } = await processBatch(pool, [auditIndexConsumer]);
    if (processed || failed) log('info', 'outbox batch', { processed, failed });
    if (Date.now() - lastPurge > 60_000) {
      const purged = await purgeExpiredIdempotencyKeys(pool);
      if (purged) log('info', 'purged idempotency keys', { purged });
      const counters = await purgeRateLimits(pool);
      if (counters) log('info', 'purged rate-limit counters', { counters });
      lastPurge = Date.now();
    }
    if (processed === 0) await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    log('error', 'worker loop error', { error: (err as Error).name });
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await pool.end();
log('info', 'worker stopped');
