/**
 * A debugging session: asks for a job that keeps a profile open and hands it to Playwright on *this* computer (the
 * one running the job). Needs the automation:debug scope (owners and admins) and "Allow Playwright connections" turned
 * on in the desktop app here.
 *
 *   PB_API=… PB_ORG=org_… PB_TOKEN=pbt_… PB_PROFILE=prf_… PB_AGENT=agt_… node examples/playwright-debug.ts
 */
import { chromium } from 'playwright-core';
import { connectPlaywright, debugEndpoint, newDebugCapability, ProjectBrowser } from '../src/index.ts';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const pb = new ProjectBrowser({ baseUrl: env('PB_API'), orgId: env('PB_ORG'), token: env('PB_TOKEN') });

// The secret stays here; the job carries only its digest.
const cap = await newDebugCapability();
const { job } = await pb.jobs.create({
  profile_id: env('PB_PROFILE'),
  agent_id: env('PB_AGENT'),
  label: 'Playwright debugging',
  steps: [],
  keep_open_minutes: 30,
  debug: { capability_sha256: cap.sha256 },
});
const ready = await pb.jobs.wait(job.id, {
  until: (d) =>
    debugEndpoint(d) !== null ||
    (d.job.state !== 'RUNNING' && d.job.state !== 'QUEUED' && d.job.state !== 'CLAIMED'),
});
const endpoint = debugEndpoint(ready);
if (!endpoint) throw new Error(`no debugging session: ${ready.job.state} ${ready.job.error_code ?? ''}`);

const browser = await connectPlaywright(chromium, endpoint, cap.secret);
const page = browser.contexts()[0]?.pages()[0];
console.log('connected; current page:', page ? page.url() : '(none)');
// … your Playwright steps on sites you are authorized to test …
await browser.close(); // disconnects only
await pb.jobs.cancel(job.id, 'done'); // closes the profile (its closing backup still uploads)
