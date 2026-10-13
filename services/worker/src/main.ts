import {
  applyRetention,
  eraseObjects,
  errorInfo,
  expireRecoveryCopies,
  type JobDeps,
  maintainKeys,
  processSyncWork,
  purgeTrash,
  sweepOrphans,
} from '@pb/api/backup/jobs';
import { localKeyProvider } from '@pb/api/backup/keys';
import { s3ObjectStore } from '@pb/api/backup/objects';
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

// Encrypted snapshots (milestone 07): verification, expiry, erasure, retention, trash and keys.
const jobs: JobDeps | null =
  config.objectStore && config.kms
    ? { pool, objects: s3ObjectStore(config.objectStore), kms: localKeyProvider(config.kms), log }
    : null;

let running = true;
const stop = () => {
  running = false;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/** Runs a periodic task, logging counts and error classes only. */
async function task(name: string, run: () => Promise<number | Record<string, number>>): Promise<void> {
  try {
    const r = await run();
    const busy = typeof r === 'number' ? r > 0 : Object.values(r).some((v) => v > 0);
    if (busy) log('info', name, typeof r === 'number' ? { count: r } : r);
  } catch (err) {
    log('error', `${name} failed`, errorInfo(err));
  }
}

let lastPurge = 0;
let lastSweep = 0;
log('info', 'worker started', { env: config.appEnv, snapshots: jobs ? 'enabled' : 'not configured' });
while (running) {
  try {
    const { processed, failed } = await processBatch(pool, [auditIndexConsumer]);
    if (processed || failed) log('info', 'outbox batch', { processed, failed });
    let synced = 0;
    if (jobs) {
      const r = await processSyncWork(jobs, 5);
      synced = r.committed + r.failed + r.expired;
      if (synced || r.retried) log('info', 'snapshot verification', { ...r });
    }
    if (Date.now() - lastPurge > 60_000) {
      const purged = await purgeExpiredIdempotencyKeys(pool);
      if (purged) log('info', 'purged idempotency keys', { purged });
      const counters = await purgeRateLimits(pool);
      if (counters) log('info', 'purged rate-limit counters', { counters });
      if (jobs) {
        await task('snapshot retention', () => applyRetention(jobs));
        await task('recovery copies expired', () => expireRecoveryCopies(jobs));
        await task('snapshot objects erased', () => eraseObjects(jobs));
        await task('trash purged', () => purgeTrash(jobs));
        await task('key maintenance', () => maintainKeys(jobs));
      }
      lastPurge = Date.now();
    }
    if (jobs && Date.now() - lastSweep > 3_600_000) {
      await task('orphan objects swept', () => sweepOrphans(jobs));
      lastSweep = Date.now();
    }
    if (processed === 0 && synced === 0) await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    log('error', 'worker loop error', errorInfo(err));
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await pool.end();
log('info', 'worker stopped');
