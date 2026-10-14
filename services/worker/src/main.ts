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
import {
  checkBacklog,
  observeTransitions,
  processBillingEvents,
  type ReconcileDeps,
  remindTrials,
  resyncSubscriptions,
  sampleUsage,
} from '@pb/api/billing/reconcile';
import { createStripe } from '@pb/api/billing/stripe';
import { loadConfig } from '@pb/config/env';
import { AGENT_TIMING, BILLING_TIMING, WEBHOOK_LIMITS } from '@pb/contracts';
import pg from 'pg';
import { type EmailDeps, processEmailTasks, smtpTransport } from './email.ts';
import { auditIndexConsumer, processBatch, purgeExpiredIdempotencyKeys, purgeRateLimits } from './outbox.ts';
import { processWebhooks, sweepAutomation, type WebhookDeps, webhookFanoutConsumer } from './webhooks.ts';

const config = loadConfig();
const pool = new pg.Pool({
  connectionString: config.workerDatabaseUrl,
  max: 4,
  options: '-c search_path=app -c TimeZone=UTC -c statement_timeout=10000',
  application_name: 'pb-worker',
});

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...extra }));

// Encrypted snapshots (milestone 07): verification, expiry, erasure, retention, trash and keys.
const jobs: JobDeps | null =
  config.objectStore && config.kms
    ? { pool, objects: s3ObjectStore(config.objectStore), kms: localKeyProvider(config.kms), log }
    : null;

// Webhooks (milestone 10): signing secrets are encrypted with the root key, so deliveries need the key provider.
const webhooks: WebhookDeps | null = config.kms
  ? {
      pool,
      kms: localKeyProvider(config.kms),
      options: {
        allowPrivate: config.webhooks.allowPrivateDestinations,
        timeoutMs: WEBHOOK_LIMITS.timeoutMs,
      },
      log,
    }
  : null;

// R4: payment results and trial reminders link to the customer portal's billing page.
function billingNotify(): NonNullable<ReconcileDeps['notify']> {
  return {
    key: config.email.taskKey as Buffer,
    portalUrl: config.web.origin ? `${config.web.origin}/app/#/billing` : null,
  };
}

// Billing reconciliation (milestone 11): provider events, resync, alerts. Time-based transitions and usage samples
// run with or without a provider.
const billing: ReconcileDeps | null = config.billing.stripe
  ? {
      pool,
      stripe: createStripe({
        secretKey: config.billing.stripe.secretKey,
        apiBase: config.billing.stripe.apiBase,
      }),
      prices: config.billing.prices,
      log,
      graceDays: BILLING_TIMING.graceDays,
      ...(config.email.taskKey ? { notify: billingNotify() } : {}),
    }
  : null;

// R2: e-mails the API queued (invitation links, welcome). Without SMTP_URL tasks are marked skipped.
const email: EmailDeps = {
  pool,
  key: config.email.taskKey,
  transport: config.email.smtpUrl ? smtpTransport(config.email.smtpUrl) : null,
  from: config.email.from,
  brand: process.env.EMAIL_BRAND || 'Project Browser',
  log,
};

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
let lastAutomationSweep = 0;
let lastBillingResync = 0;
let lastUsageSample = 0;
let lastTrialReminders = 0;
log('info', 'worker started', {
  env: config.appEnv,
  snapshots: jobs ? 'enabled' : 'not configured',
  webhooks: webhooks ? 'enabled' : 'not configured',
  billing: billing ? 'enabled' : 'not configured',
  email: email.transport ? 'enabled' : 'not configured',
});
while (running) {
  try {
    const { processed, failed } = await processBatch(pool, [auditIndexConsumer, webhookFanoutConsumer]);
    if (processed || failed) log('info', 'outbox batch', { processed, failed });
    let sent = 0;
    if (webhooks) {
      const w = await processWebhooks(webhooks);
      sent = w.delivered + w.failed + w.dead;
      if (sent) log('info', 'webhook deliveries', { ...w });
    }
    if (Date.now() - lastAutomationSweep > 5_000) {
      await task('automation sweep', async () => {
        const r = await sweepAutomation(pool, AGENT_TIMING);
        return { ...r };
      });
      lastAutomationSweep = Date.now();
    }
    const mail = await processEmailTasks(email);
    const mailed = mail.sent + mail.retried + mail.failed + mail.skipped;
    if (mailed) log(mail.failed ? 'warn' : 'info', 'e-mail tasks', { ...mail });
    let billed = 0;
    if (billing) {
      const b = await processBillingEvents(billing, 20);
      billed = b.processed + b.ignored + b.failed;
      if (billed || b.retried) log('info', 'billing events', { ...b });
      if (Date.now() - lastBillingResync > 300_000) {
        await task('billing resync', () => resyncSubscriptions(billing, 50));
        await task('billing backlog', () => checkBacklog(billing));
        lastBillingResync = Date.now();
      }
    }
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
      await task('billing transitions recorded', () => observeTransitions(pool));
      // R4: trial-ending reminders (hourly; each person once per trial end), with or without a provider.
      if (config.email.taskKey && Date.now() - lastTrialReminders > 3_600_000) {
        await task('trial reminders queued', () => remindTrials(pool, billingNotify()));
        lastTrialReminders = Date.now();
      }
      if (Date.now() - lastUsageSample > 3_600_000) {
        await task('usage samples', () => sampleUsage(pool));
        lastUsageSample = Date.now();
      }
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
    if (processed === 0 && synced === 0 && sent === 0 && billed === 0 && mailed === 0)
      await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    log('error', 'worker loop error', errorInfo(err));
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await pool.end();
log('info', 'worker stopped');
