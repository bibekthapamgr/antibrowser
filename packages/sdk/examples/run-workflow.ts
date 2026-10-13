/**
 * Runs a smoke check on one profile and prints the result.
 *
 *   PB_API=https://api.example.com PB_ORG=org_… PB_TOKEN=pbt_… PB_PROFILE=prf_… \
 *   PB_URL=https://app.example.com/login node examples/run-workflow.ts
 *
 * The token needs the automation:run scope; PB_URL must be on the organization's approved sites; a computer that
 * runs jobs (the desktop app with "Run automation jobs on this computer") must be online.
 */
import { writeFileSync } from 'node:fs';
import { ApiError, newIdempotencyKey, ProjectBrowser } from '../src/index.ts';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const pb = new ProjectBrowser({ baseUrl: env('PB_API'), orgId: env('PB_ORG'), token: env('PB_TOKEN') });

// Keep the key with your own record: if this script is restarted, the same key answers the same job.
const key = process.env.PB_IDEMPOTENCY_KEY ?? newIdempotencyKey();
try {
  const { job } = await pb.jobs.create(
    {
      profile_id: env('PB_PROFILE'),
      label: 'Login page smoke check',
      steps: [
        { action: 'open_url', url: env('PB_URL') },
        { action: 'wait_for', condition: { type: 'selector', selector: 'form' }, timeout_ms: 15_000 },
        { action: 'screenshot', label: 'login' },
      ],
      queue_timeout_seconds: 600,
    },
    { idempotencyKey: key },
  );
  console.log(`job ${job.id} queued (key ${key})`);
  const done = await pb.jobs.wait(job.id, { timeoutMs: 15 * 60_000 });
  console.log(`job ${job.id}: ${done.job.state}${done.job.error_code ? ` (${done.job.error_code})` : ''}`);
  for (const s of done.steps)
    console.log(`  ${s.seq} ${s.action}: ${s.state}${s.error_code ? ` ${s.error_code}` : ''}`);
  if (done.job.reconciliation_required) console.log('  a step’s outcome is unknown: check the site by hand');
  for (const a of done.artifacts) {
    writeFileSync(`${a.id}.jpg`, await pb.jobs.screenshot(job.id, a.id));
    console.log(`  saved ${a.id}.jpg`);
  }
} catch (e) {
  if (e instanceof ApiError) console.error(`${e.code}: ${e.message} (request ${e.requestId})`, e.details);
  else throw e;
  process.exitCode = 1;
}
