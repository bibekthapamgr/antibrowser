/**
 * Milestone 10: the TypeScript SDK (packages/sdk) against the real API over HTTP, with an API token: profiles, a job
 * created with an Idempotency-Key and retried, a computer (the desktop agent, driven here through the API) running it,
 * waiting for the result and downloading its screenshot, scope errors and cancellation.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ClaimedJob } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, newIdempotencyKey, ProjectBrowser } from '../../../packages/sdk/src/index.ts';
import { type Harness, harness, idemKey, type SignedIn } from './helpers.ts';

const SITE = 'https://portal.example.com';
let h: Harness;
let owner: SignedIn;
let org = '';
let profile = '';
let base = '';

const url = (p: string) => `/v1/orgs/${org}${p}`;

async function tokenFor(scopes: string[]): Promise<string> {
  const r = await h.app.inject({
    method: 'POST',
    url: url('/api-tokens'),
    headers: owner.headers,
    payload: { name: 'sdk', scopes, expires_in_days: 1 },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().secret;
}

beforeAll(async () => {
  h = await harness();
  owner = await h.signIn();
  const o = await h.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'SDK (test)' },
  });
  org = o.json().id;
  await h.app.inject({
    method: 'PUT',
    url: url('/automation/settings'),
    headers: owner.headers,
    payload: { expected_version: 1, allowed_origins: [SITE] },
  });
  const p = await h.app.inject({
    method: 'POST',
    url: url('/profiles'),
    headers: owner.headers,
    payload: { name: `sdk-${randomBytes(3).toString('hex')}` },
  });
  profile = p.json().id;
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await h.close();
});

/** The desktop agent's side, through the API: claim, lease, steps, screenshot, finish. */
async function runAsComputer(jobId: string) {
  const agent = await h.app.inject({
    method: 'POST',
    url: url('/automation/agents'),
    headers: owner.headers,
    payload: { device_id: owner.session.device.id },
  });
  const agentId = agent.json().id;
  const poll = await h.app.inject({
    method: 'POST',
    url: url(`/automation/agents/${agentId}/poll`),
    headers: owner.headers,
    payload: { running: [], capacity: 1, debug_allowed: false },
  });
  const c = (poll.json().assigned as ClaimedJob[]).find((a) => a.job.id === jobId) as ClaimedJob;
  const lease = await h.app.inject({
    method: 'POST',
    url: url(`/profiles/${c.job.profile_id}/leases`),
    headers: { ...owner.headers, 'idempotency-key': c.lease_key },
    payload: { device_id: owner.session.device.id, platform: 'linux-x64', browser_version: '155.0.8059.39' },
  });
  const l = lease.json().lease;
  const report = (body: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: url(`/automation/jobs/${jobId}/report`),
      headers: owner.headers,
      payload: { attempt: c.job.attempt, ...body },
    });
  await report({ type: 'started', lease_id: l.id, fencing_token: l.fencing_token });
  for (const s of c.steps) {
    await report({ type: 'step_started', seq: s.seq });
    let output: Record<string, unknown> | undefined;
    if (s.action === 'screenshot') {
      const up = await h.app.inject({
        method: 'PUT',
        url: url(
          `/automation/jobs/${jobId}/steps/${s.seq}/artifact?attempt=${c.job.attempt}&width=800&height=600`,
        ),
        headers: { ...owner.headers, 'content-type': 'image/jpeg' },
        payload: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]),
      });
      output = { artifact_id: up.json().artifact_id, width: 800, height: 600 };
    }
    if (s.action === 'open_url') output = { final_origin: SITE, http_status: 200 };
    await report({ type: 'step_finished', seq: s.seq, state: 'succeeded', ...(output ? { output } : {}) });
  }
  await report({ type: 'finished', state: 'SUCCEEDED' });
}

describe('SDK against the API', () => {
  it('reads profiles, creates an idempotent job, waits for it and downloads its screenshot', async () => {
    const pb = new ProjectBrowser({ baseUrl: base, orgId: org, token: await tokenFor(['automation:run']) });
    const me = await pb.token.current();
    expect(me.scopes).toEqual(['automation:run']);
    const profiles = await pb.profiles.list();
    expect(profiles.items.map((p) => p.id)).toContain(profile);
    const settings = await pb.automation.settings();
    expect(settings.allowed_origins).toEqual([SITE]);
    const key = newIdempotencyKey();
    const body = {
      profile_id: profile,
      steps: [
        { action: 'open_url' as const, url: `${SITE}/login` },
        { action: 'screenshot' as const, label: 'login' },
      ],
    };
    const first = await pb.jobs.create(body, { idempotencyKey: key });
    const again = await pb.jobs.create(body, { idempotencyKey: key });
    expect(again.job.id).toBe(first.job.id);
    const waiting = pb.jobs.wait(first.job.id, { intervalMs: 100, timeoutMs: 30_000 });
    await runAsComputer(first.job.id);
    const done = await waiting;
    expect(done.job.state).toBe('SUCCEEDED');
    expect(done.steps.find((s) => s.action === 'open_url')?.output).toEqual({
      final_origin: SITE,
      http_status: 200,
    });
    const art = done.artifacts[0];
    expect(art).toBeDefined();
    const bytes = await pb.jobs.screenshot(first.job.id, art?.id ?? '');
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const list = await pb.jobs.list({ state: 'finished' });
    expect(list.items.map((j) => j.id)).toContain(first.job.id);
  });

  it('reports scope and approval errors as ApiError; cancels its jobs', async () => {
    const readOnly = new ProjectBrowser({
      baseUrl: base,
      orgId: org,
      token: await tokenFor(['profiles:read']),
    });
    const denied = await readOnly.jobs
      .create({ profile_id: profile, steps: [{ action: 'open_url', url: `${SITE}/` }] })
      .catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ApiError);
    expect(denied).toMatchObject({ status: 403, code: 'TOKEN_SCOPE_MISSING' });
    const pb = new ProjectBrowser({ baseUrl: base, orgId: org, token: await tokenFor(['automation:run']) });
    const off = await pb.jobs
      .create({ profile_id: profile, steps: [{ action: 'open_url', url: 'https://elsewhere.example.net/' }] })
      .catch((e: unknown) => e);
    expect(off).toMatchObject({ status: 422, code: 'URL_NOT_APPROVED' });
    const { job } = await pb.jobs.create(
      { profile_id: profile, steps: [], keep_open_minutes: 5 },
      { idempotencyKey: idemKey() },
    );
    const canceled = await pb.jobs.cancel(job.id, 'not needed');
    expect(canceled.state).toBe('CANCELED');
    await expect(pb.jobs.cancel(job.id)).rejects.toMatchObject({ code: 'JOB_FINISHED' });
  });
});
