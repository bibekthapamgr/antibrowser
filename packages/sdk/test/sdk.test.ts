import { createHash, randomBytes } from 'node:crypto';
import { newWebhookSecret, secretKey, signedHeaders } from '@pb/api/webhooks/signing';
import { newId } from '@pb/contracts';
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  connectPlaywright,
  newDebugCapability,
  ProjectBrowser,
  parseWebhook,
  verifyWebhook,
} from '../src/index.ts';

/** A token-shaped string built at run time (never a real secret). */
const token = () => `pbt_${newId('apiToken')}_${randomBytes(32).toString('base64url')}`;
const ORG = newId('organization');

function fakeFetch(answers: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers.shift() ?? { status: 500 };
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status,
      headers: { 'content-type': 'application/json', ...(a.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const error = (code: string, status: number) => ({
  status,
  body: {
    code,
    message: code.toLowerCase(),
    request_id: 'req_x',
    retryable: status >= 500,
    safe_details: { a: 1 },
  },
});

describe('client', () => {
  it('refuses anything but an API token', () => {
    expect(
      () => new ProjectBrowser({ baseUrl: 'https://api.test', orgId: ORG, token: 'eyJhbGciOi.x.y' }),
    ).toThrow();
  });

  it('retries job creation with the same Idempotency-Key, so a retry never makes a second job', async () => {
    const detail = { job: { id: newId('job'), state: 'QUEUED' }, steps: [], artifacts: [] };
    const f = fakeFetch([
      error('UNAVAILABLE', 503),
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 201, body: detail },
    ]);
    const pb = new ProjectBrowser({
      baseUrl: 'https://api.test/',
      orgId: ORG,
      token: token(),
      fetch: f.fn,
      retries: 3,
    });
    const out = await pb.jobs.create({ profile_id: newId('profile'), steps: [], keep_open_minutes: 5 });
    expect(out.job.id).toBe(detail.job.id);
    expect(f.calls).toHaveLength(3);
    const keys = f.calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key']);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^sdk-/);
    expect(f.calls[0]?.url).toBe(`https://api.test/v1/orgs/${ORG}/automation/jobs`);
    expect((f.calls[0]?.init.headers as Record<string, string>).authorization).toMatch(/^Bearer pbt_/);
  });

  it('does not retry requests that are not safe to repeat, and surfaces the error envelope', async () => {
    const f = fakeFetch([error('INTERNAL', 500)]);
    const pb = new ProjectBrowser({ baseUrl: 'https://api.test', orgId: ORG, token: token(), fetch: f.fn });
    const err = await pb.jobs.cancel(newId('job')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, code: 'INTERNAL', requestId: 'req_x', details: { a: 1 } });
    expect(f.calls).toHaveLength(1);
    const g = fakeFetch([error('TOKEN_SCOPE_MISSING', 403)]);
    const pb2 = new ProjectBrowser({ baseUrl: 'https://api.test', orgId: ORG, token: token(), fetch: g.fn });
    await expect(pb2.profiles.list()).rejects.toMatchObject({ code: 'TOKEN_SCOPE_MISSING' });
    expect(g.calls).toHaveLength(1);
  });

  it('waits for a job to finish', async () => {
    const id = newId('job');
    const state = (s: string) => ({ status: 200, body: { job: { id, state: s }, steps: [], artifacts: [] } });
    const f = fakeFetch([state('QUEUED'), state('RUNNING'), state('SUCCEEDED')]);
    const pb = new ProjectBrowser({ baseUrl: 'https://api.test', orgId: ORG, token: token(), fetch: f.fn });
    const d = await pb.jobs.wait(id, { intervalMs: 1 });
    expect(d.job.state).toBe('SUCCEEDED');
    expect(f.calls).toHaveLength(3);
  });
});

describe('webhooks', () => {
  it('verifies what the server signs; refuses tampering, other secrets and stale timestamps', async () => {
    const { secret } = newWebhookSecret();
    const id = newId('event');
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: 'automation.job.failed',
      timestamp: new Date().toISOString(),
      data: { x: 1 },
    });
    const headers = signedHeaders([secretKey(secret)], id, now, body);
    expect(await verifyWebhook(secret, headers, body)).toBe(true);
    expect(await verifyWebhook(secret, new Headers(headers), body)).toBe(true);
    expect(await verifyWebhook(secret, headers, `${body} `)).toBe(false);
    expect(await verifyWebhook(newWebhookSecret().secret, headers, body)).toBe(false);
    expect(await verifyWebhook(secret, headers, body, { now: now + 301 })).toBe(false);
    expect(await verifyWebhook(secret, { ...headers, 'webhook-id': newId('event') }, body)).toBe(false);
    expect(parseWebhook(body).type).toBe('automation.job.failed');
  });

  it('during a rotation either secret verifies', async () => {
    const a = newWebhookSecret();
    const b = newWebhookSecret();
    const now = Math.floor(Date.now() / 1000);
    const headers = signedHeaders([a.key, b.key], newId('event'), now, '{}');
    expect(await verifyWebhook(a.secret, headers, '{}')).toBe(true);
    expect(await verifyWebhook(b.secret, headers, '{}')).toBe(true);
  });
});

describe('debugging sessions', () => {
  it('makes a capability whose digest is what the job carries', async () => {
    const c = await newDebugCapability();
    expect(c.secret).toMatch(/^pbcap_[A-Za-z0-9_-]{43}$/);
    expect(c.sha256).toBe(createHash('sha256').update(c.secret).digest('hex'));
  });

  it('connects only to a job endpoint on this computer', async () => {
    const seen: unknown[] = [];
    const chromium = { connectOverCDP: async (e: string, o: unknown) => (seen.push([e, o]), 'browser') };
    await expect(connectPlaywright(chromium, 'ws://10.0.0.2:9222/devtools/browser/x', 's')).rejects.toThrow();
    await expect(
      connectPlaywright(chromium, 'ws://127.0.0.1:9222/devtools/browser/x', 's'),
    ).rejects.toThrow();
    const ep = `ws://127.0.0.1:41234/cdp/${newId('job')}`;
    expect(await connectPlaywright(chromium, ep, 'pbcap_x')).toBe('browser');
    expect(seen).toEqual([[ep, { headers: { authorization: 'Bearer pbcap_x' } }]]);
  });
});
