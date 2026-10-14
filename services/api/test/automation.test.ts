/**
 * Milestone 10 exit gate at the API: scoped and revoked tokens, the job state machine with leases and idempotency,
 * one job per shared profile, fair claims, lost computers (safe steps resume, ambiguous outcomes are reported),
 * cancellation, debugging sessions, screenshots, webhook endpoints and destination checks.
 * People sign in through the test identity provider (device-bound sessions, like the desktop app that runs jobs).
 * Secrets in this file are generated at run time.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  type ApiScope,
  type ClaimedJob,
  type GrantCapability,
  type JobDetail,
  newId,
  type Role,
} from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness, idemKey, internalPlan, type SignedIn } from './helpers.ts';

const BROWSER = '155.0.8059.39';
const SITE = 'https://app.example.com';
const org = { id: '' };
let north = '';
let south = '';
let h: Harness;
let owner: Person;
const logLines: string[] = [];

interface Person extends SignedIn {
  device: string;
  user: string;
}

async function member(role: Role, capabilities?: GrantCapability[], client = north): Promise<Person> {
  const p = await h.signIn();
  await h.owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [
    org.id,
    p.session.user.id,
    role,
  ]);
  if (role === 'operator' || role === 'viewer') {
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${org.id}/grants`,
      headers: owner.headers,
      payload: { user_id: p.session.user.id, client_id: client, ...(capabilities ? { capabilities } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  return { ...p, device: p.session.device.id, user: p.session.user.id };
}

async function profile(client = north): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${org.id}/profiles`,
    headers: owner.headers,
    payload: { name: `auto-${randomBytes(4).toString('hex')}`, client_id: client },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

const url = (path: string) => `/v1/orgs/${org.id}${path}`;

async function token(
  p: Person,
  scopes: ApiScope[],
  extra: { client_ids?: string[]; profile_ids?: string[]; expires_in_days?: number } = {},
) {
  const res = await h.app.inject({
    method: 'POST',
    url: url('/api-tokens'),
    headers: p.headers,
    payload: { name: 'integration', scopes, expires_in_days: 30, ...extra },
  });
  expect(res.statusCode, res.body).toBe(201);
  const secret: string = res.json().secret;
  return { id: res.json().token.id as string, secret, headers: { authorization: `Bearer ${secret}` } };
}

const workflow = (steps: unknown[] = [{ action: 'open_url', url: `${SITE}/status` }]) => steps;

function createJob(headers: Record<string, string>, body: Record<string, unknown>, key: string = idemKey()) {
  return h.app.inject({
    method: 'POST',
    url: url('/automation/jobs'),
    headers: { ...headers, 'idempotency-key': key },
    payload: body,
  });
}

async function job(headers: Record<string, string>, body: Record<string, unknown>): Promise<JobDetail> {
  const res = await createJob(headers, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function enroll(p: Person, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: url('/automation/agents'),
    headers: p.headers,
    payload: { device_id: p.device, ...extra },
  });
  expect([200, 201], res.body).toContain(res.statusCode);
  return res.json().id;
}

async function poll(
  p: Person,
  agent: string,
  running: { job_id: string; attempt: number }[] = [],
  capacity = 1,
  debug = false,
) {
  const res = await h.app.inject({
    method: 'POST',
    url: url(`/automation/agents/${agent}/poll`),
    headers: p.headers,
    payload: { running, capacity, debug_allowed: debug, browser_version: BROWSER, platform: 'windows-x64' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { assigned: ClaimedJob[]; cancel: string[]; abandon: string[] };
}

const report = (p: Person, jobId: string, body: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: url(`/automation/jobs/${jobId}/report`),
    headers: p.headers,
    payload: body,
  });

async function takeLease(p: Person, profileId: string, key: string) {
  const res = await h.app.inject({
    method: 'POST',
    url: url(`/profiles/${profileId}/leases`),
    headers: { ...p.headers, 'idempotency-key': key },
    payload: { device_id: p.device, platform: 'windows-x64', browser_version: BROWSER },
  });
  expect([200, 201], res.body).toContain(res.statusCode);
  return { id: res.json().lease.id as string, token: res.json().lease.fencing_token as string };
}

async function step(p: Person, c: ClaimedJob, seq: number, output: Record<string, unknown> = {}) {
  const attempt = c.job.attempt;
  const s = await report(p, c.job.id, { type: 'step_started', attempt, seq });
  expect(s.statusCode, s.body).toBe(200);
  const f = await report(p, c.job.id, { type: 'step_finished', attempt, seq, state: 'succeeded', output });
  expect(f.statusCode, f.body).toBe(200);
  return f.json();
}

/** Runs a claimed job to the end like the desktop app: lease, started, every step, finished, release. */
async function runToEnd(p: Person, c: ClaimedJob) {
  const lease = await takeLease(p, c.job.profile_id, c.lease_key);
  const started = await report(p, c.job.id, {
    type: 'started',
    attempt: c.job.attempt,
    lease_id: lease.id,
    fencing_token: lease.token,
  });
  expect(started.statusCode, started.body).toBe(200);
  for (const s of c.steps) await step(p, c, s.seq);
  const fin = await report(p, c.job.id, { type: 'finished', attempt: c.job.attempt, state: 'SUCCEEDED' });
  expect(fin.statusCode, fin.body).toBe(200);
  await h.app.inject({
    method: 'POST',
    url: url(`/profiles/${c.job.profile_id}/leases/${lease.id}/release`),
    headers: p.headers,
    payload: { fencing_token: lease.token, outcome: 'committed' },
  });
  return fin.json();
}

const detail = async (headers: Record<string, string>, jobId: string): Promise<JobDetail> =>
  (await h.app.inject({ method: 'GET', url: url(`/automation/jobs/${jobId}`), headers })).json();

const sweep = () => h.worker.query('select app.automation_sweep(200, 90, 600, 5) as r');

/** Cancels whatever earlier tests left queued (computers that accept everyone's jobs would take them first). */
async function clearQueue() {
  const res = await h.app.inject({
    method: 'GET',
    url: url('/automation/jobs?state=active&limit=100'),
    headers: owner.headers,
  });
  for (const j of res.json().items as { id: string }[]) {
    await h.app.inject({
      method: 'POST',
      url: url(`/automation/jobs/${j.id}/cancel`),
      headers: owner.headers,
      payload: {},
    });
  }
}

beforeAll(async () => {
  h = await harness({ logLines });
  const o = await h.signIn();
  owner = { ...o, device: o.session.device.id, user: o.session.user.id };
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Automation (test)' },
  });
  expect(res.statusCode, res.body).toBe(201);
  org.id = res.json().id;
  await internalPlan(h.owner, org.id);
  for (const [name, set] of [
    ['Client North', (v: string) => (north = v)],
    ['Client South', (v: string) => (south = v)],
  ] as const) {
    const c = await h.app.inject({
      method: 'POST',
      url: url('/clients'),
      headers: owner.headers,
      payload: { name },
    });
    expect(c.statusCode, c.body).toBe(201);
    set(c.json().id);
  }
  const s = await h.app.inject({
    method: 'PUT',
    url: url('/automation/settings'),
    headers: owner.headers,
    payload: { expected_version: 1, allowed_origins: [SITE, 'https://*.example.org'], max_running_jobs: 20 },
  });
  expect(s.statusCode, s.body).toBe(200);
});
afterAll(async () => {
  await h.close();
});

// ================================================================ API tokens
describe('API tokens', () => {
  it('shows the secret once, stores only its digest and keeps it out of logs', async () => {
    const op = await member('operator');
    const t = await token(op, ['profiles:read']);
    expect(t.secret).toMatch(/^pbt_tok_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$/);
    const raw = t.secret.split('_').slice(3).join('_');
    const { rows } = await h.owner.query(
      'select row_to_json(t)::text as row, token_hash from api_tokens t where id = $1',
      [t.id],
    );
    expect(rows[0].row).not.toContain(raw);
    expect(rows[0].token_hash).toBe(createHash('sha256').update(raw).digest('hex'));
    const list = await h.app.inject({ method: 'GET', url: url('/api-tokens'), headers: op.headers });
    expect(list.body).not.toContain(raw);
    const me = await h.app.inject({ method: 'GET', url: url('/api-tokens/current'), headers: t.headers });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toMatchObject({ id: t.id, scopes: ['profiles:read'], state: 'active', mine: true });
    expect(logLines.join('\n')).not.toContain(raw);
  });

  it('acts as its owner within its scopes and restrictions; everything else answers like it does not exist', async () => {
    const op = await member('operator', ['launch'], north);
    await h.app.inject({
      method: 'POST',
      url: url('/grants'),
      headers: owner.headers,
      payload: { user_id: op.user, client_id: south },
    });
    const inNorth = await profile(north);
    const inSouth = await profile(south);
    const t = await token(op, ['profiles:read'], { client_ids: [north] });
    const list = await h.app.inject({ method: 'GET', url: url('/profiles?limit=100'), headers: t.headers });
    expect(list.statusCode, list.body).toBe(200);
    const ids = list.json().items.map((p: { id: string }) => p.id);
    expect(ids).toContain(inNorth);
    expect(ids).not.toContain(inSouth);
    expect(
      (await h.app.inject({ method: 'GET', url: url(`/profiles/${inSouth}`), headers: t.headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (await h.app.inject({ method: 'GET', url: url(`/clients/${south}`), headers: t.headers })).statusCode,
    ).toBe(404);
    // A scope it does not have.
    const edit = await h.app.inject({
      method: 'PATCH',
      url: url(`/profiles/${inNorth}`),
      headers: t.headers,
      payload: { expected_version: 1, name: 'renamed' },
    });
    expect(edit.statusCode).toBe(403);
    expect(edit.json().code).toBe('TOKEN_SCOPE_MISSING');
    // Routes not meant for tokens.
    for (const [method, path] of [
      ['GET', '/members'],
      ['GET', '/grants'],
      ['GET', '/api-tokens'],
      ['GET', '/webhook-endpoints'],
      ['GET', '/audit-events'],
    ] as const) {
      const r = await h.app.inject({ method, url: url(path), headers: t.headers });
      expect([403, 404], `${method} ${path}`).toContain(r.statusCode);
      if (r.statusCode === 403) expect(r.json().code).toBe('TOKEN_SCOPE_MISSING');
    }
    // Another organization's path.
    const other = await h.app.inject({
      method: 'GET',
      url: '/v1/orgs/org_01J9ZSEED000000000000000Z9',
      headers: t.headers,
    });
    expect(other.statusCode).toBe(404);
  });

  it('never exceeds the creator: scopes beyond the role and unreachable restrictions are refused', async () => {
    const op = await member('operator');
    for (const scope of ['profiles:write', 'automation:debug'] as const) {
      const r = await h.app.inject({
        method: 'POST',
        url: url('/api-tokens'),
        headers: op.headers,
        payload: { name: 'x', scopes: [scope], expires_in_days: 1 },
      });
      expect(r.statusCode, scope).toBe(403);
    }
    const r = await h.app.inject({
      method: 'POST',
      url: url('/api-tokens'),
      headers: op.headers,
      payload: { name: 'x', scopes: ['profiles:read'], client_ids: [south], expires_in_days: 1 },
    });
    expect(r.statusCode).toBe(404);
    const viewer = await member('viewer');
    const v = await h.app.inject({
      method: 'POST',
      url: url('/api-tokens'),
      headers: viewer.headers,
      payload: { name: 'x', scopes: ['profiles:read'], expires_in_days: 1 },
    });
    expect(v.statusCode).toBe(403);
  });

  it('a token cannot create, rotate or revoke tokens, or manage webhooks', async () => {
    const admin = await member('admin');
    const t = await token(admin, ['profiles:read', 'automation:run']);
    const create = await h.app.inject({
      method: 'POST',
      url: url('/api-tokens'),
      headers: t.headers,
      payload: { name: 'escalate', scopes: ['profiles:write'], expires_in_days: 1 },
    });
    expect(create.statusCode).toBe(403);
    const rotate = await h.app.inject({
      method: 'POST',
      url: url(`/api-tokens/${t.id}/rotate`),
      headers: t.headers,
      payload: {},
    });
    expect(rotate.statusCode).toBe(403);
    const hook = await h.app.inject({
      method: 'POST',
      url: url('/webhook-endpoints'),
      headers: t.headers,
      payload: { url: 'https://hooks.example.com/pb', events: ['automation.job.failed'] },
    });
    expect(hook.statusCode).toBe(403);
  });

  it('revoked, expired, narrowed and orphaned tokens stop at once', async () => {
    const op = await member('operator', ['launch']);
    const p = await profile(north);
    const t = await token(op, ['profiles:read']);
    const get = () => h.app.inject({ method: 'GET', url: url(`/profiles/${p}`), headers: t.headers });
    expect((await get()).statusCode).toBe(200);
    // The owner's grant removed: the profile is out of reach for the token too.
    const grants = await h.owner.query(
      'select id from permission_grants where org_id = $1 and user_id = $2',
      [org.id, op.user],
    );
    for (const g of grants.rows) {
      await h.app.inject({ method: 'DELETE', url: url(`/grants/${g.id}`), headers: owner.headers });
    }
    expect((await get()).statusCode).toBe(404);
    // Expired.
    const t2 = await token(owner, ['profiles:read']);
    await h.owner.query(
      "update api_tokens set created_at = now() - interval '2 days', expires_at = now() - interval '1 second' where id = $1",
      [t2.id],
    );
    const exp = await h.app.inject({ method: 'GET', url: url(`/profiles/${p}`), headers: t2.headers });
    expect(exp.statusCode).toBe(401);
    expect(exp.json().safe_details.reason).toBe('token_expired');
    // Revoked by an admin.
    const t3 = await token(op, ['profiles:read']);
    const del = await h.app.inject({
      method: 'DELETE',
      url: url(`/api-tokens/${t3.id}`),
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(204);
    const rev = await h.app.inject({ method: 'GET', url: url('/api-tokens/current'), headers: t3.headers });
    expect(rev.statusCode).toBe(401);
    expect(rev.json().safe_details.reason).toBe('token_revoked');
    // A wrong secret for a real token id answers like any invalid token.
    const forged = t3.secret.slice(0, -4) + (t3.secret.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const bad = await h.app.inject({
      method: 'GET',
      url: url('/api-tokens/current'),
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().safe_details.reason).toBe('token_invalid');
    // The owner leaves: their tokens are revoked.
    const leaver = await member('operator');
    const t4 = await token(leaver, ['profiles:read']);
    const out = await h.app.inject({
      method: 'DELETE',
      url: url(`/members/${leaver.user}`),
      headers: owner.headers,
    });
    expect(out.statusCode, out.body).toBe(204);
    const gone = await h.app.inject({ method: 'GET', url: url('/api-tokens/current'), headers: t4.headers });
    expect(gone.statusCode).toBe(401);
  });

  it('rotation: the new secret works, the old one only during the grace period', async () => {
    const op = await member('operator');
    const t = await token(op, ['profiles:read']);
    const r = await h.app.inject({
      method: 'POST',
      url: url(`/api-tokens/${t.id}/rotate`),
      headers: op.headers,
      payload: { grace_minutes: 10 },
    });
    expect(r.statusCode, r.body).toBe(200);
    const fresh = { authorization: `Bearer ${r.json().secret}` };
    const current = (headers: Record<string, string>) =>
      h.app.inject({ method: 'GET', url: url('/api-tokens/current'), headers });
    expect((await current(fresh)).statusCode).toBe(200);
    expect((await current(t.headers)).statusCode).toBe(200);
    await h.owner.query(
      "update api_tokens set previous_valid_until = now() - interval '1 second' where id = $1",
      [t.id],
    );
    expect((await current(t.headers)).statusCode).toBe(401);
    expect((await current(fresh)).statusCode).toBe(200);
    // Someone else's token cannot be rotated (it would let one act as them).
    const other = await h.app.inject({
      method: 'POST',
      url: url(`/api-tokens/${t.id}/rotate`),
      headers: owner.headers,
      payload: {},
    });
    expect(other.statusCode).toBe(404);
  });

  it('only a deliberate, documented list of routes accepts tokens', () => {
    const spec = h.app.swagger() as { paths: Record<string, Record<string, { description?: string }>> };
    const routes = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([, op]) => op.description?.startsWith('API tokens: yes'))
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(routes.sort()).toEqual(
      [
        'GET /v1/orgs/{orgId}',
        'GET /v1/orgs/{orgId}/clients',
        'GET /v1/orgs/{orgId}/clients/{clientId}',
        'GET /v1/orgs/{orgId}/profiles',
        'POST /v1/orgs/{orgId}/profiles',
        'GET /v1/orgs/{orgId}/profiles/{profileId}',
        'PATCH /v1/orgs/{orgId}/profiles/{profileId}',
        'DELETE /v1/orgs/{orgId}/profiles/{profileId}',
        'GET /v1/orgs/{orgId}/api-tokens/current',
        'GET /v1/orgs/{orgId}/automation/settings',
        'POST /v1/orgs/{orgId}/automation/jobs',
        'GET /v1/orgs/{orgId}/automation/jobs',
        'GET /v1/orgs/{orgId}/automation/jobs/{jobId}',
        'POST /v1/orgs/{orgId}/automation/jobs/{jobId}/cancel',
        'GET /v1/orgs/{orgId}/automation/jobs/{jobId}/artifacts/{artifactId}',
        'GET /v1/orgs/{orgId}/automation/agents',
      ].sort(),
    );
  });

  it('is rate-limited per token', async () => {
    const t = await token(owner, ['profiles:read']);
    expect(
      (await h.app.inject({ method: 'GET', url: url('/api-tokens/current'), headers: t.headers })).statusCode,
    ).toBe(200);
    const key = createHash('sha256').update(`api.token:${t.id}`).digest('hex');
    await h.owner.query(
      "update rate_limit_counters set hits = 600 where bucket = 'api.token' and key_hash = $1",
      [key],
    );
    const limited = await h.app.inject({
      method: 'GET',
      url: url('/api-tokens/current'),
      headers: t.headers,
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

// ================================================================ jobs
describe('jobs: requests', () => {
  it('a duplicate request yields one job: concurrent and sequential replays answer the same job', async () => {
    const p = await profile();
    const key = idemKey();
    const body = { profile_id: p, steps: workflow() };
    const results = await Promise.all(Array.from({ length: 8 }, () => createJob(owner.headers, body, key)));
    const ids = new Set(results.map((r) => r.json().job?.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(7);
    const n = await h.owner.query(
      'select count(*)::int as n from automation_jobs where org_id = $1 and profile_id = $2',
      [org.id, p],
    );
    expect(n.rows[0].n).toBe(1);
    const reused = await createJob(owner.headers, { profile_id: p, steps: workflow(), label: 'other' }, key);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    const missing = await h.app.inject({
      method: 'POST',
      url: url('/automation/jobs'),
      headers: owner.headers,
      payload: body,
    });
    expect(missing.statusCode).toBe(428);
  });

  it('refuses addresses outside the approved sites and steps outside the allowlist', async () => {
    const p = await profile();
    const off = await createJob(owner.headers, {
      profile_id: p,
      steps: [{ action: 'open_url', url: 'https://evil.example.net/' }],
    });
    expect(off.statusCode).toBe(422);
    expect(off.json().code).toBe('URL_NOT_APPROVED');
    const sneaky = await createJob(owner.headers, {
      profile_id: p,
      steps: [{ action: 'open_url', url: 'https://app.example.com@evil.example.net/' }],
    });
    expect(sneaky.statusCode).toBe(422);
    const unknown = await createJob(owner.headers, {
      profile_id: p,
      steps: [{ action: 'click', selector: '#buy' }],
    });
    expect(unknown.statusCode).toBe(400);
    const script = await createJob(owner.headers, {
      profile_id: p,
      steps: [{ action: 'open_url', url: `${SITE}/`, script: 'alert(1)' }],
    });
    expect(script.statusCode).toBe(400);
    const nothing = await createJob(owner.headers, { profile_id: p, steps: [] });
    expect(nothing.statusCode).toBe(400);
    const bad = await h.app.inject({
      method: 'PUT',
      url: url('/automation/settings'),
      headers: owner.headers,
      payload: { expected_version: 2, allowed_origins: ['https://example.com/path'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('needs the launch capability, automation.run and, for debugging, automation.debug', async () => {
    const p = await profile();
    const noLaunch = await member('operator', ['backup_download']);
    const r1 = await createJob(noLaunch.headers, { profile_id: p, steps: workflow() });
    expect(r1.statusCode).toBe(403);
    const viewer = await member('viewer');
    const r2 = await createJob(viewer.headers, { profile_id: p, steps: workflow() });
    expect(r2.statusCode).toBe(403);
    const op = await member('operator', ['launch']);
    const capability_sha256 = createHash('sha256').update(randomBytes(32)).digest('hex');
    const r3 = await createJob(op.headers, {
      profile_id: p,
      steps: [],
      keep_open_minutes: 10,
      debug: { capability_sha256 },
    });
    expect(r3.statusCode).toBe(403);
    const r4 = await createJob(owner.headers, { profile_id: p, steps: [], debug: { capability_sha256 } });
    expect(r4.statusCode).toBe(400);
    // A token with automation:run but restricted to another client.
    const t = await token(op, ['automation:run'], { client_ids: [north] });
    const southProfile = await profile(south);
    const r5 = await createJob(t.headers, { profile_id: southProfile, steps: workflow() });
    expect(r5.statusCode).toBe(404);
    const r6 = await createJob(t.headers, { profile_id: p, steps: workflow() });
    expect(r6.statusCode, r6.body).toBe(201);
    expect(r6.json().job).toMatchObject({ state: 'QUEUED', token_id: t.id, requested_by: op.user });
    // Steps: open the profile, the requested step, close.
    expect(r6.json().steps.map((s: { action: string }) => s.action)).toEqual([
      'open_profile',
      'open_url',
      'close_profile',
    ]);
  });
});

describe('jobs: running on enrolled computers', () => {
  it('milestone 11: a restricted organization’s computers claim nothing; the plan caps concurrency; usage counted once', async () => {
    await clearQueue();
    const op = await member('operator', ['launch']);
    const agent = await enroll(op);
    const p = await profile();
    const t = await token(op, ['automation:run']);
    const created = await job(t.headers, { profile_id: p, steps: [{ action: 'open_url', url: `${SITE}/` }] });
    await h.owner.query(
      "update subscriptions set state = 'restricted', reason = 'grace_ended' where org_id = $1",
      [org.id],
    );
    try {
      expect((await poll(op, agent)).assigned).toHaveLength(0);
      expect((await createJob(t.headers, { profile_id: p, steps: [] })).json().code).toBe(
        'SUBSCRIPTION_RESTRICTED',
      );
    } finally {
      await internalPlan(h.owner, org.id);
    }
    await h.owner.query(
      `insert into entitlement_overrides (id, org_id, scope, value, reason, created_by, expires_at)
       values ($1, $2, 'limit.automation_concurrency', '0', 'test: no automation capacity for now', $3, now() + interval '1 day')`,
      [newId('override'), org.id, owner.user],
    );
    try {
      expect((await poll(op, agent)).assigned).toHaveLength(0);
    } finally {
      await h.owner.query(
        "update entitlement_overrides set revoked_at = now() where org_id = $1 and scope = 'limit.automation_concurrency'",
        [org.id],
      );
    }
    const { assigned } = await poll(op, agent);
    expect(assigned.map((c) => c.job.id)).toEqual([created.job.id]);
    await runToEnd(op, assigned[0] as ClaimedJob);
    const usage = await h.owner.query(
      'select quantity::int as q from usage_events where org_id = $1 and dedupe_key = $2',
      [org.id, `job:${created.job.id}`],
    );
    expect(usage.rows).toEqual([{ q: 1 }]);
  });

  it('runs end to end under a session lease and emits webhook events for each state', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op);
    const p = await profile();
    const t = await token(op, ['automation:run']);
    const created = await job(t.headers, {
      profile_id: p,
      steps: [
        { action: 'open_url', url: `${SITE}/login` },
        { action: 'wait_for', condition: { type: 'selector', selector: '#ready' }, timeout_ms: 5000 },
      ],
      label: 'Smoke check',
    });
    const { assigned } = await poll(op, agent);
    expect(assigned).toHaveLength(1);
    const c = assigned[0] as ClaimedJob;
    expect(c.job.id).toBe(created.job.id);
    expect(c.job.state).toBe('CLAIMED');
    expect(c.allowed_origins).toContain(SITE);
    expect(c.resume_from).toBe(0);
    // Steps cannot start before the lease.
    const early = await report(op, c.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 0 });
    expect(early.statusCode).toBe(409);
    const fin = await runToEnd(op, c);
    expect(fin.job).toMatchObject({ state: 'SUCCEEDED', steps_done: 4, steps_total: 4, error_code: null });
    const events = await h.owner.query(
      `select event_type from outbox_events where aggregate_id = $1 order by created_at, event_id`,
      [c.job.id],
    );
    expect(events.rows.map((e) => e.event_type)).toEqual([
      'automation.job.queued',
      'automation.job.started',
      'automation.job.succeeded',
    ]);
    const payload = await h.owner.query(
      `select redacted_payload from outbox_events where aggregate_id = $1 and event_type = 'automation.job.succeeded'`,
      [c.job.id],
    );
    expect(Object.keys(payload.rows[0].redacted_payload).sort()).toEqual(
      [
        'agent_id',
        'attempt',
        'error_code',
        'job_id',
        'profile_id',
        'reconciliation_required',
        'state',
      ].sort(),
    );
    // A finished job does not change.
    const again = await report(op, c.job.id, { type: 'finished', attempt: c.job.attempt, state: 'FAILED' });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('JOB_FINISHED');
  });

  it('two jobs never work on the same shared profile: the second waits; claims skip profiles open elsewhere', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op, { max_jobs: 3 });
    const p = await profile();
    const j1 = await job(op.headers, { profile_id: p, steps: workflow() });
    const j2 = await job(op.headers, { profile_id: p, steps: workflow() });
    const first = await poll(op, agent, [], 3);
    expect(first.assigned.map((a) => a.job.id)).toEqual([j1.job.id]);
    const c1 = first.assigned[0] as ClaimedJob;
    // The database refuses a second active job on the profile even if something tried.
    await expect(
      h.owner.query(
        `update automation_jobs set state = 'CLAIMED', agent_id = $2, attempt = 1 where id = $1`,
        [j2.job.id, agent],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const second = await poll(op, agent, [{ job_id: c1.job.id, attempt: c1.job.attempt }], 2);
    expect(second.assigned).toHaveLength(0);
    await runToEnd(op, c1);
    const third = await poll(op, agent, [], 2);
    expect(third.assigned.map((a) => a.job.id)).toEqual([j2.job.id]);
    await runToEnd(op, third.assigned[0] as ClaimedJob);
    // A profile someone has open interactively is not claimed.
    const person = await member('operator', ['launch']);
    const busy = await profile();
    const lease = await takeLease(person, busy, idemKey());
    const j3 = await job(op.headers, { profile_id: busy, steps: workflow() });
    expect((await poll(op, agent, [], 2)).assigned).toHaveLength(0);
    await h.app.inject({
      method: 'POST',
      url: url(`/profiles/${busy}/leases/${lease.id}/release`),
      headers: person.headers,
      payload: { fencing_token: lease.token, outcome: 'committed' },
    });
    const fourth = await poll(op, agent, [], 2);
    expect(fourth.assigned.map((a) => a.job.id)).toEqual([j3.job.id]);
    await runToEnd(op, fourth.assigned[0] as ClaimedJob);
  });

  it('a job stops when its lease is taken over: the next step is refused', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op);
    const p = await profile();
    await job(op.headers, { profile_id: p, steps: workflow() });
    const c = (await poll(op, agent)).assigned[0] as ClaimedJob;
    const lease = await takeLease(op, p, c.lease_key);
    expect(
      (
        await report(op, c.job.id, {
          type: 'started',
          attempt: c.job.attempt,
          lease_id: lease.id,
          fencing_token: lease.token,
        })
      ).statusCode,
    ).toBe(200);
    await step(op, c, 0);
    const takeover = await h.app.inject({
      method: 'POST',
      url: url(`/profiles/${p}/force-takeover`),
      headers: owner.headers,
      payload: { reason: 'need it now', confirm: true },
    });
    expect(takeover.statusCode, takeover.body).toBe(200);
    const next = await report(op, c.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 1 });
    expect(next.statusCode).toBe(409);
    expect(next.json().code).toBe('FENCING_TOKEN_STALE');
    // Closing is still recorded (it writes nothing to the profile; the closing backup is fenced by its own lease).
    const closeSeq = c.steps.find((s) => s.action === 'close_profile')?.seq ?? -1;
    const close = await report(op, c.job.id, { type: 'step_started', attempt: c.job.attempt, seq: closeSeq });
    expect(close.statusCode, close.body).toBe(200);
    await report(op, c.job.id, {
      type: 'step_finished',
      attempt: c.job.attempt,
      seq: closeSeq,
      state: 'failed',
      error_code: 'LEASE_LOST',
    });
    const fin = await report(op, c.job.id, {
      type: 'finished',
      attempt: c.job.attempt,
      state: 'FAILED',
      error_code: 'LEASE_LOST',
    });
    expect(fin.json().job).toMatchObject({ state: 'FAILED', error_code: 'LEASE_LOST' });
    const steps = (
      await h.app.inject({ method: 'GET', url: url(`/automation/jobs/${c.job.id}`), headers: owner.headers })
    ).json().steps;
    expect(steps.map((s: { state: string }) => s.state)).toEqual(['succeeded', 'skipped', 'failed']);
  });

  it('retried launches use the same idempotency key: the same lease comes back', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op);
    const p = await profile();
    await job(op.headers, { profile_id: p, steps: workflow() });
    const c = (await poll(op, agent)).assigned[0] as ClaimedJob;
    const a = await takeLease(op, p, c.lease_key);
    const b = await takeLease(op, p, c.lease_key);
    expect(b).toEqual(a);
    expect(c.lease_key).toContain(c.job.id);
    await report(op, c.job.id, {
      type: 'started',
      attempt: c.job.attempt,
      lease_id: a.id,
      fencing_token: a.token,
    });
    for (const s of c.steps) await step(op, c, s.seq);
    await report(op, c.job.id, { type: 'finished', attempt: c.job.attempt, state: 'SUCCEEDED' });
  });

  it('claims are fair across requesters: a token with many queued jobs does not starve another', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op, { max_jobs: 5 });
    const tA = await token(op, ['automation:run']);
    const tB = await token(op, ['automation:run']);
    const a1 = await job(tA.headers, { profile_id: await profile(), steps: workflow() });
    await job(tA.headers, { profile_id: await profile(), steps: workflow() });
    await job(tA.headers, { profile_id: await profile(), steps: workflow() });
    const b1 = await job(tB.headers, { profile_id: await profile(), steps: workflow() });
    const first = await poll(op, agent, [], 1);
    expect(first.assigned.map((x) => x.job.id)).toEqual([a1.job.id]);
    const c1 = first.assigned[0] as ClaimedJob;
    const second = await poll(op, agent, [{ job_id: c1.job.id, attempt: c1.job.attempt }], 1);
    expect(second.assigned.map((x) => x.job.id)).toEqual([b1.job.id]);
    // Clean up: end the rest.
    const rest = await h.owner.query(
      `select id from automation_jobs where org_id = $1 and token_id in ($2, $3) and state in ('QUEUED','CLAIMED')`,
      [org.id, tA.id, tB.id],
    );
    for (const r of rest.rows) {
      await h.app.inject({
        method: 'POST',
        url: url(`/automation/jobs/${r.id}/cancel`),
        headers: op.headers,
        payload: {},
      });
    }
  });

  it('a job whose requester lost access, or whose token was revoked, fails when a computer would take it', async () => {
    await clearQueue();
    const runner = await member('operator', ['launch']);
    const agent = await enroll(runner, { accepts: 'org' });
    const asker = await member('operator', ['launch']);
    const t = await token(asker, ['automation:run']);
    const p = await profile();
    const j = await job(t.headers, { profile_id: p, steps: workflow() });
    await h.app.inject({ method: 'DELETE', url: url(`/api-tokens/${t.id}`), headers: asker.headers });
    expect((await poll(runner, agent)).assigned).toHaveLength(0);
    const d = await detail(owner.headers, j.job.id);
    expect(d.job).toMatchObject({ state: 'FAILED', error_code: 'ACCESS_REMOVED' });
  });

  it('a computer that accepts only its own person’s jobs never takes anyone else’s', async () => {
    const runner = await member('operator', ['launch']);
    const agent = await enroll(runner);
    const other = await member('operator', ['launch']);
    const j = await job(other.headers, { profile_id: await profile(), steps: workflow() });
    expect((await poll(runner, agent, [], 3)).assigned.map((a) => a.job.id)).not.toContain(j.job.id);
    const chosen = await createJob(other.headers, {
      profile_id: await profile(),
      steps: workflow(),
      agent_id: agent,
    });
    expect(chosen.statusCode).toBe(409);
    expect(chosen.json()).toMatchObject({
      code: 'AGENT_UNAVAILABLE',
      safe_details: { reason: 'accepts_own_jobs_only' },
    });
    await h.app.inject({
      method: 'POST',
      url: url(`/automation/jobs/${j.job.id}/cancel`),
      headers: other.headers,
      payload: {},
    });
  });
});

describe('jobs: lost computers, restarts and ambiguous outcomes', () => {
  it('a claim not started in time returns to the queue; the old claim cannot report', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op);
    const p = await profile();
    const j = await job(op.headers, { profile_id: p, steps: workflow() });
    const c = (await poll(op, agent)).assigned[0] as ClaimedJob;
    await h.owner.query(
      "update automation_jobs set claim_expires_at = now() - interval '1 second' where id = $1",
      [j.job.id],
    );
    await sweep();
    expect((await detail(owner.headers, j.job.id)).job.state).toBe('QUEUED');
    const stale = await report(op, j.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 0 });
    expect(stale.statusCode).toBe(404);
    const again = (await poll(op, agent)).assigned[0] as ClaimedJob;
    expect(again.job.attempt).toBe(c.job.attempt + 1);
    const old = await report(op, j.job.id, {
      type: 'released',
      attempt: c.job.attempt,
      error_code: 'PROFILE_IN_USE',
    });
    expect(old.statusCode).toBe(409);
    expect(old.json().code).toBe('JOB_CLAIM_STALE');
    await runToEnd(op, again);
  });

  it('a computer that comes back resumes at the first unfinished step; only safe steps repeat', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op);
    const p = await profile();
    const j = await job(op.headers, {
      profile_id: p,
      steps: [{ action: 'open_url', url: `${SITE}/a` }, { action: 'screenshot' }],
    });
    const c = (await poll(op, agent)).assigned[0] as ClaimedJob;
    const lease = await takeLease(op, p, c.lease_key);
    await report(op, c.job.id, {
      type: 'started',
      attempt: c.job.attempt,
      lease_id: lease.id,
      fencing_token: lease.token,
    });
    await step(op, c, 0);
    // open_url started; the computer lost its connection before reporting the result.
    expect(
      (await report(op, c.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 1 })).statusCode,
    ).toBe(200);
    await h.owner.query(
      "update automation_jobs set heartbeat_at = now() - interval '2 minutes' where id = $1",
      [j.job.id],
    );
    await sweep();
    const lost = await h.owner.query(
      'select lost_at is not null as lost, state from automation_jobs where id = $1',
      [j.job.id],
    );
    expect(lost.rows[0]).toEqual({ lost: true, state: 'RUNNING' });
    // It restarted without its notes: the poll sends the job again with where to continue.
    const back = await poll(op, agent, [], 0);
    const resumed = back.assigned.find((a) => a.job.id === j.job.id) as ClaimedJob;
    expect(resumed.resume_from).toBe(1);
    // A navigation step is safe to repeat.
    const retry = await report(op, j.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 1 });
    expect(retry.statusCode, retry.body).toBe(200);
    const s1 = await h.owner.query('select attempt from job_steps where job_id = $1 and sequence = 1', [
      j.job.id,
    ]);
    expect(s1.rows[0].attempt).toBe(2);
    const cleared = await h.owner.query('select lost_at from automation_jobs where id = $1', [j.job.id]);
    expect(cleared.rows[0].lost_at).toBeNull();
    await report(op, j.job.id, { type: 'step_finished', attempt: c.job.attempt, seq: 1, state: 'succeeded' });
    await report(op, j.job.id, {
      type: 'finished',
      attempt: c.job.attempt,
      state: 'FAILED',
      error_code: 'CANCELED',
    });
  });

  it('a step that would change something on a website is never repeated: lost, its outcome is unknown', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op);
    const p = await profile();
    const j = await job(op.headers, { profile_id: p, steps: workflow() });
    const c = (await poll(op, agent)).assigned[0] as ClaimedJob;
    const lease = await takeLease(op, p, c.lease_key);
    await report(op, c.job.id, {
      type: 'started',
      attempt: c.job.attempt,
      lease_id: lease.id,
      fencing_token: lease.token,
    });
    await step(op, c, 0);
    // No such step exists in v1; the rule is tested by marking a step's effect as an external change.
    await h.owner.query(
      `update job_steps set effect = 'external_mutation' where job_id = $1 and sequence = 1`,
      [j.job.id],
    );
    expect(
      (await report(op, j.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 1 })).statusCode,
    ).toBe(200);
    // The computer restarts and tries the step again: refused.
    const retry = await report(op, j.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 1 });
    expect(retry.statusCode).toBe(400);
    expect(retry.json().safe_details.reason).toBe('outcome_unknown');
    const resumed = (await poll(op, agent, [], 0)).assigned.find((a) => a.job.id === j.job.id) as ClaimedJob;
    expect(resumed.resume_from).toBeNull();
    // It never comes back: the job fails and needs reconciliation.
    await h.owner.query(
      "update automation_jobs set heartbeat_at = now() - interval '20 minutes', lost_at = now() - interval '15 minutes' where id = $1",
      [j.job.id],
    );
    await sweep();
    const d = await detail(owner.headers, j.job.id);
    expect(d.job).toMatchObject({ state: 'FAILED', error_code: 'AGENT_LOST', reconciliation_required: true });
    expect(d.steps.find((s) => s.seq === 1)).toMatchObject({
      state: 'outcome_unknown',
      error_code: 'OUTCOME_UNKNOWN',
    });
    expect(d.steps.find((s) => s.seq === 2)?.state).toBe('skipped');
    const ev = await h.owner.query(
      `select redacted_payload from outbox_events where aggregate_id = $1 and event_type = 'automation.job.failed'`,
      [j.job.id],
    );
    expect(ev.rows[0].redacted_payload).toMatchObject({
      error_code: 'AGENT_LOST',
      reconciliation_required: true,
    });
  });

  it('queued jobs nobody starts in time fail with QUEUE_EXPIRED', async () => {
    const j = await job(owner.headers, {
      profile_id: await profile(),
      steps: workflow(),
      queue_timeout_seconds: 30,
    });
    await h.owner.query(
      "update automation_jobs set queue_expires_at = now() - interval '1 second' where id = $1",
      [j.job.id],
    );
    await sweep();
    expect((await detail(owner.headers, j.job.id)).job).toMatchObject({
      state: 'FAILED',
      error_code: 'QUEUE_EXPIRED',
    });
  });
});

describe('jobs: cancel and stop', () => {
  it('a queued job ends at once; a running one is asked to stop and closes safely', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op);
    const q = await job(op.headers, { profile_id: await profile(), steps: workflow() });
    const c1 = await h.app.inject({
      method: 'POST',
      url: url(`/automation/jobs/${q.job.id}/cancel`),
      headers: op.headers,
      payload: { reason: 'not needed' },
    });
    expect(c1.json()).toMatchObject({ state: 'CANCELED', error_code: 'CANCELED' });
    const twice = await h.app.inject({
      method: 'POST',
      url: url(`/automation/jobs/${q.job.id}/cancel`),
      headers: op.headers,
      payload: {},
    });
    expect(twice.json().code).toBe('JOB_FINISHED');

    const p = await profile();
    const r = await job(op.headers, { profile_id: p, steps: workflow() });
    const c = (await poll(op, agent)).assigned[0] as ClaimedJob;
    const lease = await takeLease(op, p, c.lease_key);
    await report(op, c.job.id, {
      type: 'started',
      attempt: c.job.attempt,
      lease_id: lease.id,
      fencing_token: lease.token,
    });
    await step(op, c, 0);
    // Someone else (not the requester, not an admin) cannot cancel.
    const stranger = await member('operator', ['launch']);
    const no = await h.app.inject({
      method: 'POST',
      url: url(`/automation/jobs/${r.job.id}/cancel`),
      headers: stranger.headers,
      payload: {},
    });
    expect(no.statusCode).toBe(403);
    const asked = await h.app.inject({
      method: 'POST',
      url: url(`/automation/jobs/${r.job.id}/cancel`),
      headers: owner.headers,
      payload: {},
    });
    expect(asked.json()).toMatchObject({ state: 'RUNNING' });
    expect(asked.json().cancel_requested_at).not.toBeNull();
    const told = await poll(op, agent, [{ job_id: c.job.id, attempt: c.job.attempt }], 0);
    expect(told.cancel).toEqual([c.job.id]);
    // The next page step is not started; closing still runs.
    const nope = await report(op, c.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 1 });
    expect(nope.json().cancel_requested).toBe(true);
    await step(op, c, 2, { backup: 'committed' });
    const fin = await report(op, c.job.id, { type: 'finished', attempt: c.job.attempt, state: 'CANCELED' });
    expect(fin.json().job).toMatchObject({ state: 'CANCELED' });
    const d = await detail(owner.headers, r.job.id);
    expect(d.steps.map((s) => s.state)).toEqual(['succeeded', 'skipped', 'succeeded']);
  });

  it('a profile kept open closes when stopped or when its time is up (a stop, not a failure)', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op);
    const p = await profile();
    const j = await job(op.headers, { profile_id: p, steps: workflow(), keep_open_minutes: 5 });
    expect(j.steps.map((s) => s.action)).toEqual(['open_profile', 'open_url', 'hold_open', 'close_profile']);
    const c = (await poll(op, agent)).assigned[0] as ClaimedJob;
    const lease = await takeLease(op, p, c.lease_key);
    await report(op, c.job.id, {
      type: 'started',
      attempt: c.job.attempt,
      lease_id: lease.id,
      fencing_token: lease.token,
    });
    await step(op, c, 0);
    await step(op, c, 1);
    await report(op, c.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 2 });
    expect((await detail(owner.headers, j.job.id)).job.holding).toBe(true);
    await h.owner.query(
      "update automation_jobs set holding_since = now() - interval '6 minutes' where id = $1",
      [j.job.id],
    );
    await sweep();
    const told = await poll(op, agent, [{ job_id: c.job.id, attempt: c.job.attempt }], 0);
    expect(told.cancel).toEqual([c.job.id]);
    await report(op, c.job.id, { type: 'step_finished', attempt: c.job.attempt, seq: 2, state: 'succeeded' });
    await step(op, c, 3, { backup: 'committed' });
    const fin = await report(op, c.job.id, { type: 'finished', attempt: c.job.attempt, state: 'SUCCEEDED' });
    expect(fin.json().job).toMatchObject({ state: 'SUCCEEDED', holding: false });
  });
});

describe('jobs: debugging sessions and screenshots', () => {
  it('a debugging job goes only to a computer that allows it, and reports a loopback endpoint', async () => {
    const admin = await member('admin');
    const agent = await enroll(admin);
    const p = await profile();
    const capability_sha256 = createHash('sha256').update(randomBytes(32)).digest('hex');
    const j = await job(admin.headers, {
      profile_id: p,
      steps: [],
      keep_open_minutes: 30,
      debug: { capability_sha256 },
    });
    expect(j.job.debug).toBe(true);
    expect((await poll(admin, agent, [], 1, false)).assigned).toHaveLength(0);
    const c = (await poll(admin, agent, [], 1, true)).assigned[0] as ClaimedJob;
    expect(c.debug_capability_sha256).toBe(capability_sha256);
    const lease = await takeLease(admin, p, c.lease_key);
    await report(admin, c.job.id, {
      type: 'started',
      attempt: c.job.attempt,
      lease_id: lease.id,
      fencing_token: lease.token,
    });
    await step(admin, c, 0);
    const endpoint = `ws://127.0.0.1:41234/cdp/${c.job.id}`;
    await step(admin, c, 1, { endpoint });
    const d = await detail(admin.headers, j.job.id);
    expect(d.steps[1]?.output).toEqual({ endpoint });
    const elsewhere = await report(admin, c.job.id, {
      type: 'step_finished',
      attempt: c.job.attempt,
      seq: 2,
      state: 'succeeded',
      output: { endpoint: 'ws://10.0.0.5:9222/cdp/x' },
    });
    expect(elsewhere.statusCode).toBe(400);
    await report(admin, c.job.id, { type: 'finished', attempt: c.job.attempt, state: 'CANCELED' });
  });

  it('screenshots: typed upload, retrievable by those who can see the job, outputs restricted by step', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op);
    const p = await profile();
    await job(op.headers, {
      profile_id: p,
      steps: [
        { action: 'open_url', url: `${SITE}/` },
        { action: 'screenshot', label: 'home' },
      ],
    });
    const c = (await poll(op, agent)).assigned[0] as ClaimedJob;
    const lease = await takeLease(op, p, c.lease_key);
    await report(op, c.job.id, {
      type: 'started',
      attempt: c.job.attempt,
      lease_id: lease.id,
      fencing_token: lease.token,
    });
    await step(op, c, 0);
    // open_url may not report a screenshot or arbitrary fields.
    await report(op, c.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 1 });
    const wrong = await report(op, c.job.id, {
      type: 'step_finished',
      attempt: c.job.attempt,
      seq: 1,
      state: 'succeeded',
      output: { width: 10 },
    });
    expect(wrong.statusCode).toBe(400);
    const text = await report(op, c.job.id, {
      type: 'step_finished',
      attempt: c.job.attempt,
      seq: 1,
      state: 'succeeded',
      output: { page_text: 'secret' },
    });
    expect(text.statusCode).toBe(400);
    await report(op, c.job.id, {
      type: 'step_finished',
      attempt: c.job.attempt,
      seq: 1,
      state: 'succeeded',
      output: { final_origin: SITE, http_status: 200 },
    });
    await report(op, c.job.id, { type: 'step_started', attempt: c.job.attempt, seq: 2 });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(500)]);
    const upload = (body: Buffer, type: string) =>
      h.app.inject({
        method: 'PUT',
        url: url(
          `/automation/jobs/${c.job.id}/steps/2/artifact?attempt=${c.job.attempt}&width=1280&height=800`,
        ),
        headers: { ...op.headers, 'content-type': type },
        payload: body,
      });
    expect((await upload(Buffer.from('<svg/>'), 'image/png')).statusCode).toBe(400);
    const up = await upload(jpeg, 'image/jpeg');
    expect(up.statusCode, up.body).toBe(200);
    const artifact = up.json().artifact_id;
    await report(op, c.job.id, {
      type: 'step_finished',
      attempt: c.job.attempt,
      seq: 2,
      state: 'succeeded',
      output: { artifact_id: artifact, width: 1280, height: 800 },
    });
    const get = await h.app.inject({
      method: 'GET',
      url: url(`/automation/jobs/${c.job.id}/artifacts/${artifact}`),
      headers: owner.headers,
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/jpeg');
    expect(get.rawPayload.equals(jpeg)).toBe(true);
    const d = await detail(owner.headers, c.job.id);
    expect(d.artifacts).toHaveLength(1);
    expect(d.artifacts[0]).toMatchObject({
      id: artifact,
      label: 'home',
      width: 1280,
      size_bytes: jpeg.length,
    });
    // Someone who cannot see the profile cannot see the job or its screenshot.
    const outsider = await member('operator', ['launch'], south);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: url(`/automation/jobs/${c.job.id}`),
          headers: outsider.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: url(`/automation/jobs/${c.job.id}/artifacts/${artifact}`),
          headers: outsider.headers,
        })
      ).statusCode,
    ).toBe(404);
    await step(op, c, 3, { backup: 'committed' });
    await report(op, c.job.id, { type: 'finished', attempt: c.job.attempt, state: 'SUCCEEDED' });
  });
});

describe('computers (agents)', () => {
  it('enrolls only the caller’s own device; others cannot poll or report as it', async () => {
    const op = await member('operator', ['launch']);
    const other = await member('operator', ['launch']);
    const steal = await h.app.inject({
      method: 'POST',
      url: url('/automation/agents'),
      headers: other.headers,
      payload: { device_id: op.device },
    });
    expect(steal.statusCode).toBe(403);
    const agent = await enroll(op);
    const p = await h.app.inject({
      method: 'POST',
      url: url(`/automation/agents/${agent}/poll`),
      headers: other.headers,
      payload: { running: [], capacity: 1, debug_allowed: false },
    });
    expect(p.statusCode).toBe(404);
    // A token cannot act as a computer.
    const t = await token(op, ['automation:run']);
    const asToken = await h.app.inject({
      method: 'POST',
      url: url(`/automation/agents/${agent}/poll`),
      headers: t.headers,
      payload: { running: [], capacity: 1, debug_allowed: false },
    });
    expect(asToken.statusCode).toBe(403);
    // Turned off by an admin: no new jobs.
    const off = await h.app.inject({
      method: 'PATCH',
      url: url(`/automation/agents/${agent}`),
      headers: owner.headers,
      payload: { expected_version: 1, enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    const j = await job(op.headers, { profile_id: await profile(), steps: workflow() });
    expect((await poll(op, agent)).assigned).toHaveLength(0);
    await h.app.inject({
      method: 'POST',
      url: url(`/automation/jobs/${j.job.id}/cancel`),
      headers: op.headers,
      payload: {},
    });
  });

  it('removing a computer gives back its claims and ends its running jobs', async () => {
    const op = await member('operator', ['launch']);
    const agent = await enroll(op, { max_jobs: 2 });
    const p1 = await profile();
    const p2 = await profile();
    const j1 = await job(op.headers, { profile_id: p1, steps: workflow() });
    const j2 = await job(op.headers, { profile_id: p2, steps: workflow() });
    const both = (await poll(op, agent, [], 2)).assigned;
    expect(both).toHaveLength(2);
    const running = both.find((b) => b.job.id === j1.job.id) as ClaimedJob;
    const lease = await takeLease(op, p1, running.lease_key);
    await report(op, running.job.id, {
      type: 'started',
      attempt: running.job.attempt,
      lease_id: lease.id,
      fencing_token: lease.token,
    });
    const del = await h.app.inject({
      method: 'DELETE',
      url: url(`/automation/agents/${agent}`),
      headers: owner.headers,
    });
    expect(del.statusCode, del.body).toBe(204);
    expect((await detail(owner.headers, j1.job.id)).job).toMatchObject({
      state: 'FAILED',
      error_code: 'ACCESS_REMOVED',
    });
    expect((await detail(owner.headers, j2.job.id)).job).toMatchObject({ state: 'QUEUED', agent_id: null });
    await h.app.inject({
      method: 'POST',
      url: url(`/automation/jobs/${j2.job.id}/cancel`),
      headers: op.headers,
      payload: {},
    });
  });
});

// ================================================================ webhook endpoints
describe('webhook endpoints', () => {
  it('refuses private, local and non-HTTPS destinations', async () => {
    for (const dest of [
      'http://hooks.example.com/pb',
      'https://127.0.0.1/hook',
      'https://10.0.0.8/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://localhost/hook',
      'https://metadata.google.internal/',
      'https://user:pw@hooks.example.com/',
      'https://hooks.example.com:25/',
      'https://intranet/hook',
    ]) {
      const r = await h.app.inject({
        method: 'POST',
        url: url('/webhook-endpoints'),
        headers: owner.headers,
        payload: { url: dest, events: ['automation.job.failed'] },
      });
      expect(r.statusCode, dest).toBe(422);
      expect(r.json().code).toBe('WEBHOOK_DESTINATION_BLOCKED');
    }
  });

  it('shows the secret once, stores it encrypted, rotates, tests and lists deliveries', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: url('/webhook-endpoints'),
      headers: owner.headers,
      payload: {
        url: 'https://hooks.example.com/pb',
        events: ['automation.job.succeeded', 'automation.job.failed'],
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const secret: string = r.json().secret;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const id = r.json().endpoint.id;
    const row = await h.owner.query(
      'select row_to_json(e)::text as row from webhook_endpoints e where id = $1',
      [id],
    );
    expect(row.rows[0].row).not.toContain(secret.slice(6));
    const get = await h.app.inject({
      method: 'GET',
      url: url(`/webhook-endpoints/${id}`),
      headers: owner.headers,
    });
    expect(get.body).not.toContain(secret.slice(6));
    const rot = await h.app.inject({
      method: 'POST',
      url: url(`/webhook-endpoints/${id}/rotate-secret`),
      headers: owner.headers,
      payload: { grace_minutes: 30 },
    });
    expect(rot.statusCode).toBe(200);
    expect(rot.json().secret).not.toBe(secret);
    const test = await h.app.inject({
      method: 'POST',
      url: url(`/webhook-endpoints/${id}/test`),
      headers: owner.headers,
    });
    expect(test.statusCode).toBe(202);
    const evt = await h.owner.query(
      'select event_type, redacted_payload from outbox_events where event_id = $1',
      [test.json().event_id],
    );
    expect(evt.rows[0]).toMatchObject({ event_type: 'webhook.test', redacted_payload: { endpoint_id: id } });
    const op = await member('operator');
    const no = await h.app.inject({ method: 'GET', url: url('/webhook-endpoints'), headers: op.headers });
    expect(no.statusCode).toBe(403);
    const list = await h.app.inject({
      method: 'GET',
      url: url(`/webhook-endpoints/${id}/deliveries`),
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
  });
});
