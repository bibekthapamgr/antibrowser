/**
 * R5 acceptance (ADR-0024): business-owner administration.
 * - customer tokens, workspace owners and portal cookies never reach /v1/admin; support-only staff cannot enumerate
 *   all accounts; business roles need a second factor; the database checks the staff permission itself
 * - the last platform owner is protected; the first one is bootstrapped once on the server
 * - two simultaneous publish requests create one plan version and one price mapping; a failed publication never
 *   reaches pricing; existing subscribers keep their version, limits and price
 * - payment restrictions, security suspensions of workspaces and accounts, and lifting them, across desktop and API
 * - metrics reconcile with controlled provider fixtures, per currency; refunds and cash are separate
 * - case notes are redacted; failed e-mail can be retried; the staff role mapping matches the database
 */
import { randomBytes } from 'node:crypto';
import { newId, STAFF_ROLE_PERMISSIONS, STAFF_ROLES } from '@pb/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, bootstrapOwner, removeStaff } from '../scripts/staff.ts';
import { redactNote } from '../src/admin/redact.ts';
import { processBillingEvents, type ReconcileDeps } from '../src/billing/reconcile.ts';
import { createStripe } from '../src/billing/stripe.ts';
import { sealEmailVars } from '../src/email.ts';
import { type FakeStripe, fakeStripe, stripeEnv } from './fake-stripe.ts';
import { type Harness, harness, idemKey, type SignedIn } from './helpers.ts';
import { nonce } from './idp.ts';

const CONSOLE = 'pb-console-admin-test';
const EMAIL_KEY = randomBytes(32);
let f: FakeStripe;
let h: Harness;
let db: pg.PoolClient;
let deps: ReconcileDeps;
const PLAN = `zz${randomBytes(3).toString('hex')}`;

beforeAll(async () => {
  f = await fakeStripe();
  h = await harness({
    consoleClientId: CONSOLE,
    env: { ...stripeEnv(f), EMAIL_TASK_KEY: EMAIL_KEY.toString('base64') },
  });
  db = await h.owner.connect();
  deps = {
    pool: h.worker,
    stripe: createStripe({ secretKey: f.secretKey, apiBase: f.url }),
    prices: JSON.parse(stripeEnv(f).BILLING_STRIPE_PRICES ?? '{}'),
    log: () => undefined,
    graceDays: 7,
  };
});
afterAll(async () => {
  // Plans published here stop being sold (a non-purchasable newest version), so later test files see the seeds only.
  const owner = await staff(['platform_owner']).catch(() => null);
  if (owner) {
    for (const id of [PLAN, `${PLAN}b`]) {
      const d = await post('/v1/admin/plan-drafts', owner.headers, {
        plan_id: id,
        from_published: true,
        purchasable: false,
        prices: [],
      });
      if (d.statusCode === 201) {
        await post(`/v1/admin/plan-drafts/${d.json().id}/publish`, owner.headers, {
          revision: d.json().revision,
        });
      }
    }
  }
  db?.release();
  await h?.close();
  await f?.close();
});

// ---------------------------------------------------------------- helpers
type Role = (typeof STAFF_ROLES)[number];
interface Staff {
  person: SignedIn;
  headers: Record<string, string>;
}

async function consoleToken(sub: string, email: string, amr: string[] = ['pwd', 'otp']) {
  await h.owner.query("delete from rate_limit_counters where bucket = 'staff.signin.ip'");
  const n = nonce();
  const token = await h.idp.idToken({ sub, nonce: n, email, aud: CONSOLE, amr });
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/support/sessions',
    payload: { id_token: token, nonce: n },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().access_token as string;
}

/** A person made staff on the server, signed in to the console with a one-time code (unless `amr` says otherwise). */
async function staff(roles: Role[], amr?: string[]): Promise<Staff> {
  const person = await h.signIn();
  if (roles.includes('platform_owner')) {
    const exists = await db.query(
      "select 1 from app.platform_staff where 'platform_owner' = any(roles) and disabled_at is null",
    );
    if (!exists.rowCount) await bootstrapOwner(db, person.person.email);
  }
  await addStaff(db, person.person.email, roles, 'admin test');
  const token = await consoleToken(person.person.sub, person.person.email, amr);
  return { person, headers: { authorization: `Bearer ${token}` } };
}

const get = (url: string, headers: Record<string, string>) => h.app.inject({ method: 'GET', url, headers });
const post = (url: string, headers: Record<string, string>, payload?: object) =>
  h.app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });
const put = (url: string, headers: Record<string, string>, payload: object) =>
  h.app.inject({ method: 'PUT', url, headers, payload });

interface Org {
  id: string;
  owner: SignedIn;
}
async function newOrg(name = `Customer ${randomBytes(2).toString('hex')}`): Promise<Org> {
  const owner = await h.signIn();
  const res = await post('/v1/organizations', owner.headers, { name });
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().id, owner };
}

async function deliver(events: Record<string, unknown>[]) {
  for (const ev of events) {
    const { body, header } = f.sign(ev);
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/webhooks/billing',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      payload: body,
    });
    expect(r.statusCode, r.body).toBe(200);
  }
  for (let i = 0; i < 10; i++) {
    const r = await processBillingEvents(deps, 50);
    if (r.processed + r.ignored + r.failed + r.retried === 0) break;
  }
}

/** Checkout and payment of a plan (newest version) for a workspace; returns the provider subscription id. */
async function subscribe(o: Org, plan: string, interval: 'month' | 'year' = 'month'): Promise<string> {
  const res = await post(`/v1/orgs/${o.id}/billing/checkout-session`, o.owner.headers, {
    plan_id: plan,
    interval,
  });
  expect(res.statusCode, res.body).toBe(201);
  const session = new URL(res.json().url).pathname.split('/').pop() as string;
  await deliver(f.completeCheckout(session));
  return f.sessions.get(session)?.subscription as string;
}

const subscription = async (o: Org) =>
  (await get(`/v1/orgs/${o.id}/billing/subscription`, o.owner.headers)).json();

const LIMITS = { profiles: 40, seats: 3, storage_bytes: 1_000_000_000, automation_concurrency: 1 };
const FEATURES = { team_sessions: true, automation: false, api_tokens: false, webhooks: false };

// ---------------------------------------------------------------- who may reach admin
describe('who may use the admin console', () => {
  it('customers, workspace owners and portal cookies never reach admin routes', async () => {
    const o = await newOrg();
    for (const url of [
      '/v1/admin/metrics',
      '/v1/admin/customers',
      `/v1/admin/customers/${o.id}`,
      '/v1/admin/catalog',
    ]) {
      expect((await get(url, o.owner.headers)).statusCode, url).toBe(401);
    }
    expect((await get('/v1/admin/customers', { cookie: 'pb_web=x' })).statusCode).toBe(401);
    expect((await get('/v1/admin/customers', {})).statusCode).toBe(401);
  });

  it('support-only staff cannot list all customers or see metrics; business roles need a second factor', async () => {
    const support = await staff(['support', 'support_lead', 'billing_admin']);
    const listed = await get('/v1/admin/customers', support.headers);
    expect(listed.json()).toMatchObject({
      code: 'FORBIDDEN',
      safe_details: { permission: 'admin.customers.read' },
    });
    expect((await get('/v1/admin/metrics', support.headers)).statusCode).toBe(403);
    // Support keeps the milestone 11 tools.
    const o = await newOrg();
    expect((await get(`/v1/support/orgs/${o.id}`, support.headers)).statusCode).toBe(200);
    const me = (await get('/v1/admin/me', support.headers)).json();
    expect(me.permissions).not.toContain('admin.customers.read');

    const noCode = await staff(['business_admin'], ['pwd']);
    expect((await get('/v1/admin/me', noCode.headers)).json()).toMatchObject({ mfa: false });
    expect((await get('/v1/admin/customers', noCode.headers)).json().code).toBe('MFA_REQUIRED');
    expect((await get(`/v1/support/orgs/${o.id}`, noCode.headers)).json().code).toBe('MFA_REQUIRED');
    const withCode = await staff(['business_admin']);
    expect((await get('/v1/admin/customers', withCode.headers)).statusCode).toBe(200);
  });

  it('the database refuses the cross-workspace readers to anyone who is not staff with the permission', async () => {
    const outsider = await h.signIn();
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.user_id', $1, true), set_config('app.org_id', '', true)", [
        outsider.session.user.id,
      ]);
      await expect(
        c.query('select * from app.admin_customers(null, null, null, null, null, 10, true)'),
      ).rejects.toThrow(/STAFF_FORBIDDEN/);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  it('the role mapping in the database is the one in the contracts', async () => {
    const { rows } = await h.owner.query<{ role: Role; permission: string; mapping_version: number }>(
      'select role, permission, mapping_version from staff_role_permissions',
    );
    for (const role of STAFF_ROLES) {
      expect(
        rows
          .filter((r) => r.role === role)
          .map((r) => r.permission)
          .sort(),
        role,
      ).toEqual([...STAFF_ROLE_PERMISSIONS[role]].sort());
    }
    expect(new Set(rows.map((r) => r.mapping_version))).toEqual(new Set([1]));
  });

  it('the first platform owner is bootstrapped once; the last owner cannot be removed or demoted', async () => {
    const first = await staff(['platform_owner']);
    const someone = await h.signIn();
    await expect(bootstrapOwner(db, someone.person.email)).rejects.toThrow(/already exists/);
    const owners = await db.query<{ user_id: string }>(
      "select user_id from app.platform_staff where 'platform_owner' = any(roles) and disabled_at is null",
    );
    // Remove every other owner (other tests made some), then the last one is protected.
    for (const r of owners.rows.filter((x) => x.user_id !== first.person.session.user.id)) {
      await removeStaff(db, r.user_id);
    }
    await expect(removeStaff(db, first.person.session.user.id)).rejects.toThrow(/LAST_PLATFORM_OWNER/);
    await expect(addStaff(db, first.person.session.user.id, ['support'], null)).rejects.toThrow(
      /LAST_PLATFORM_OWNER/,
    );
    const second = await staff(['platform_owner']);
    await removeStaff(db, first.person.session.user.id);
    const staffList = (await get('/v1/admin/staff', second.headers)).json();
    expect(staffList.mapping_version).toBe(1);
    expect(
      staffList.items.find((s: { user_id: string }) => s.user_id === second.person.session.user.id),
    ).toMatchObject({
      roles: ['platform_owner'],
      disabled: false,
    });
  });
});

// ---------------------------------------------------------------- customers
describe('customers', () => {
  it('lists customers with cursor pages, filters and masked contacts for analysts; every view is audited', async () => {
    const a = await newOrg(`Alpha ${PLAN}`);
    const b = await newOrg(`Alpine ${PLAN}`);
    const admin = await staff(['business_admin']);
    const analyst = await staff(['business_analyst']);
    const first = await get(`/v1/admin/customers?q=Alp&limit=1`, admin.headers);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().items).toHaveLength(1);
    const second = await get(
      `/v1/admin/customers?q=Alp&limit=1&cursor=${first.json().next_cursor}`,
      admin.headers,
    );
    const ids = [first.json().items[0].id, second.json().items[0].id];
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(first.json().items[0].owner_email).toMatch(/@people\.test$/);
    expect(first.json().items[0].owner_email).not.toContain('***');
    const masked = (await get(`/v1/admin/customers?q=${a.id}`, analyst.headers)).json();
    expect(masked.items[0]).toMatchObject({ id: a.id, plan_id: 'trial', state: 'trial', member_count: 1 });
    expect(masked.items[0].owner_email).toMatch(/^.\*\*\*@people\.test$/);
    const byEmail = (
      await get(`/v1/admin/customers?q=${encodeURIComponent(b.owner.person.email)}`, admin.headers)
    ).json();
    expect(byEmail.items.map((i: { id: string }) => i.id)).toEqual([b.id]);
    const { rows } = await h.owner.query(
      "select details from platform_audit where action = 'admin.customers_listed' and actor_user_id = $1 order by at",
      [admin.person.session.user.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(rows.map((r) => r.details))).not.toContain(b.owner.person.email);
  });

  it('a customer’s detail has billing, usage, devices and notes — never member names, sessions or profile data', async () => {
    const o = await newOrg();
    await post(`/v1/orgs/${o.id}/profiles`, o.owner.headers, { name: 'Secret client profile' });
    const admin = await staff(['business_admin']);
    const note = await post(`/v1/admin/customers/${o.id}/notes`, admin.headers, {
      body: 'Customer pasted card 4242 4242 4242 4242 and password: hunter2-x in chat; told them not to.',
    });
    expect(note.statusCode, note.body).toBe(201);
    expect(note.json()).toMatchObject({ redacted: true });
    expect(note.json().body).not.toMatch(/4242|hunter2/);
    const d = await get(`/v1/admin/customers/${o.id}`, admin.headers);
    expect(d.statusCode, d.body).toBe(200);
    const body = d.json();
    expect(body).toMatchObject({
      customer: { id: o.id, profile_count: 1 },
      billing: { state: 'trial', plan_id: 'trial' },
      usage: { profiles: 1, seats: 1 },
      members_by_role: { owner: 1 },
      devices: { active: 1, by_platform: { 'linux-x64': 1 } },
    });
    expect(body.notes[0].body).toContain('[redacted]');
    expect(d.body).not.toContain('Secret client profile');
    expect(d.body).not.toContain(o.owner.person.name);
    const activity = await h.owner.query(
      "select 1 from audit_events where org_id = $1 and action = 'support.viewed_overview'",
      [o.id],
    );
    expect(activity.rowCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- catalog
describe('catalog publishing', () => {
  let owner: Staff;
  let subscriber: Org;
  beforeAll(async () => {
    owner = await staff(['platform_owner']);
  });

  const draft = async (body: object) => {
    const r = await post('/v1/admin/plan-drafts', owner.headers, body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; revision: number };
  };

  it('two simultaneous publish requests create one plan version and one price mapping', async () => {
    const d = await draft({
      plan_id: PLAN,
      name: 'Zeta',
      description: 'Published in a test',
      purchasable: true,
      limits: LIMITS,
      features: FEATURES,
      prices: [
        { interval: 'month', currency: 'usd', amount_minor: 2900 },
        { interval: 'year', currency: 'usd', amount_minor: 29000 },
      ],
    });
    const pricePosts = () => f.requests.filter((r) => r.method === 'POST' && r.path === '/v1/prices').length;
    const before = pricePosts();
    const [x, y] = await Promise.all([
      post(`/v1/admin/plan-drafts/${d.id}/publish`, owner.headers, { revision: d.revision }),
      post(`/v1/admin/plan-drafts/${d.id}/publish`, owner.headers, { revision: d.revision }),
    ]);
    const codes = [x.statusCode, y.statusCode].sort();
    expect(codes[0], `${x.body} ${y.body}`).toBeLessThan(300);
    expect([200, 201, 409]).toContain(codes[1]);
    // The repeat returns the same publication once it is done.
    const again = await post(`/v1/admin/plan-drafts/${d.id}/publish`, owner.headers, {
      revision: d.revision,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ plan_id: PLAN, version: 1, state: 'succeeded' });
    expect(pricePosts() - before).toBe(2);
    const { rows } = await h.owner.query(
      'select interval from plan_prices where plan_id = $1 order by interval',
      [PLAN],
    );
    expect(rows.map((r) => r.interval)).toEqual(['month', 'year']);
    expect((await h.owner.query('select 1 from plans where id = $1', [PLAN])).rowCount).toBe(1);
    // The public pricing page sells it at once (this server's cache was dropped).
    const pub = (await get('/v1/public/plans', {})).json();
    const zeta = pub.items.find((p: { id: string }) => p.id === PLAN);
    expect(zeta).toMatchObject({ version: 1, available: true });
    expect(zeta.prices.map((p: { amount_minor: number }) => p.amount_minor)).toEqual([2900, 29000]);
  });

  it('a workspace that bought a version keeps its limits and price after a new version is published', async () => {
    subscriber = await newOrg();
    const sub = await subscribe(subscriber, PLAN);
    expect(await subscription(subscriber)).toMatchObject({ plan: { id: PLAN, version: 1 }, state: 'active' });
    const d = await draft({ plan_id: PLAN, from_published: true });
    const changed = await put(`/v1/admin/plan-drafts/${d.id}`, owner.headers, {
      revision: d.revision,
      name: 'Zeta',
      description: 'More seats, higher price',
      purchasable: true,
      limits: { ...LIMITS, seats: 6 },
      features: FEATURES,
      prices: [{ interval: 'month', currency: 'usd', amount_minor: 3900 }],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    // An edit with an old revision is refused.
    expect(
      (
        await put(`/v1/admin/plan-drafts/${d.id}`, owner.headers, {
          revision: d.revision,
          name: 'Stale',
          description: '',
          purchasable: true,
          limits: LIMITS,
          features: FEATURES,
          prices: [],
        })
      ).json().code,
    ).toBe('VERSION_CONFLICT');
    const pub = await post(`/v1/admin/plan-drafts/${d.id}/publish`, owner.headers, {
      revision: changed.json().revision,
    });
    expect(pub.statusCode, pub.body).toBe(201);
    expect(pub.json()).toMatchObject({ version: 2, state: 'succeeded' });
    // The subscriber keeps version 1 (3 seats) and its price, even after the provider confirms it again.
    await deliver(f.payRenewal(sub));
    const s = await subscription(subscriber);
    expect(s).toMatchObject({ plan: { id: PLAN, version: 1 }, limits: { seats: 3 }, state: 'active' });
    const items = f.subscriptions.get(sub)?.items as { data: { price: { unit_amount: number } }[] };
    expect(items.data[0]?.price.unit_amount).toBe(2900);
    // New purchases use version 2 at the new price; the yearly price was not carried over.
    const newcomer = await newOrg();
    await subscribe(newcomer, PLAN);
    expect(await subscription(newcomer)).toMatchObject({
      plan: { id: PLAN, version: 2 },
      limits: { seats: 6 },
    });
    const catalog = (await get('/v1/admin/catalog', owner.headers)).json();
    const v1 = catalog.plans.find((p: { id: string; version: number }) => p.id === PLAN && p.version === 1);
    expect(v1).toMatchObject({ current: false, source: 'admin', subscribers: 1 });
    // A stored version never changes, even for the schema owner.
    await expect(
      h.owner.query("update plans set name = 'x' where id = $1 and version = 1", [PLAN]),
    ).rejects.toThrow(/PLAN_VERSION_IMMUTABLE/);
  });

  it('a failed publication publishes nothing and can be retried; the retry reuses the same prices', async () => {
    const d = await draft({
      plan_id: `${PLAN}b`,
      name: 'Zeta B',
      description: '',
      purchasable: true,
      limits: LIMITS,
      features: FEATURES,
      prices: [{ interval: 'month', currency: 'usd', amount_minor: 1500 }],
    });
    const before = (await get('/v1/public/plans', {})).json().catalog_version;
    f.down = true;
    const failed = await post(`/v1/admin/plan-drafts/${d.id}/publish`, owner.headers, {
      revision: d.revision,
    });
    f.down = false;
    expect(failed.json()).toMatchObject({ code: 'PUBLISH_FAILED' });
    expect((await h.owner.query('select 1 from plans where id = $1', [`${PLAN}b`])).rowCount).toBe(0);
    expect((await get('/v1/public/plans', {})).json().catalog_version).toBe(before);
    const catalog = (await get('/v1/admin/catalog', owner.headers)).json();
    expect(catalog.drafts.find((x: { id: string }) => x.id === d.id)).toMatchObject({
      state: 'draft',
      last_error: expect.stringContaining('provider'),
    });
    const alert = await h.owner.query(
      "select 1 from billing_alerts where kind = 'publish_failed' and ref = $1",
      [`${PLAN}b@1`],
    );
    expect(alert.rowCount).toBe(1);
    const ok = await post(`/v1/admin/plan-drafts/${d.id}/publish`, owner.headers, { revision: d.revision });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ version: 1, state: 'succeeded' });
  });

  it('only staff with the publish permission may publish; analysts read the catalog', async () => {
    const analyst = await staff(['business_analyst']);
    expect((await get('/v1/admin/catalog', analyst.headers)).statusCode).toBe(200);
    const d = await draft({ plan_id: PLAN, from_published: true });
    expect(
      (await post(`/v1/admin/plan-drafts/${d.id}/publish`, analyst.headers, { revision: d.revision })).json()
        .code,
    ).toBe('FORBIDDEN');
    expect(
      (await post(`/v1/admin/plan-drafts/${d.id}/discard`, owner.headers, { revision: d.revision }))
        .statusCode,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------- restrictions
describe('restrictions', () => {
  it('a payment restriction stops creating and opening (desktop and API), keeps everything else, and lifts', async () => {
    const o = await newOrg();
    const admin = await staff(['business_admin']);
    const r = await post('/v1/admin/restrictions', admin.headers, {
      kind: 'payment',
      scope: 'workspace',
      org_id: o.id,
      reason: 'Chargeback under review with the payment provider',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ active: true, notified: true });
    expect(await subscription(o)).toMatchObject({ state: 'restricted', reason: 'staff_restriction' });
    const blocked = await post(`/v1/orgs/${o.id}/profiles`, o.owner.headers, { name: 'nope' });
    expect(blocked.json().code).toBe('SUBSCRIPTION_RESTRICTED');
    expect((await get(`/v1/orgs/${o.id}/profiles`, o.owner.headers)).statusCode).toBe(200);
    const mail = await h.owner.query(
      "select 1 from email_tasks where kind = 'restriction_notice' and org_id = $1",
      [o.id],
    );
    expect(mail.rowCount).toBe(1);
    // Security suspensions need the platform owner.
    expect(
      (
        await post('/v1/admin/restrictions', admin.headers, {
          kind: 'security',
          scope: 'workspace',
          org_id: o.id,
          reason: 'Suspected account takeover reported by the owner',
        })
      ).json().code,
    ).toBe('FORBIDDEN');
    const lifted = await post(`/v1/admin/restrictions/${r.json().id}/lift`, admin.headers, {
      reason: 'Dispute resolved in the customer’s favour',
    });
    expect(lifted.json()).toMatchObject({ active: false });
    expect(await subscription(o)).toMatchObject({ state: 'trial' });
    expect((await post(`/v1/orgs/${o.id}/profiles`, o.owner.headers, { name: 'now ok' })).statusCode).toBe(
      201,
    );
  });

  it('a security suspension closes open profiles, revokes API tokens and answers WORKSPACE_SUSPENDED until lifted', async () => {
    const o = await newOrg();
    const p = await post(`/v1/orgs/${o.id}/profiles`, o.owner.headers, { name: 'open one' });
    const lease = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${o.id}/profiles/${p.json().id}/leases`,
      headers: { ...o.owner.headers, 'idempotency-key': idemKey() },
      payload: {
        device_id: o.owner.session.device.id,
        platform: 'windows-x64',
        browser_version: '155.0.8059.39',
      },
    });
    expect(lease.statusCode, lease.body).toBe(201);
    const owner = await staff(['platform_owner']);
    const r = await post('/v1/admin/restrictions', owner.headers, {
      kind: 'security',
      scope: 'workspace',
      org_id: o.id,
      reason: 'Suspected account takeover reported by the owner',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(r.statusCode, r.body).toBe(201);
    const leases = await h.owner.query('select state, end_reason from profile_leases where org_id = $1', [
      o.id,
    ]);
    expect(leases.rows).toEqual([{ state: 'revoked', end_reason: 'workspace_suspended' }]);
    expect((await get(`/v1/orgs/${o.id}/profiles`, o.owner.headers)).json().code).toBe('WORKSPACE_SUSPENDED');
    expect(
      (await h.owner.query('select suspended_at from organizations where id = $1', [o.id])).rows[0]
        .suspended_at,
    ).not.toBeNull();
    await post(`/v1/admin/restrictions/${r.json().id}/lift`, owner.headers, {
      reason: 'Owner confirmed the account is secure again',
    });
    expect((await get(`/v1/orgs/${o.id}/profiles`, o.owner.headers)).statusCode).toBe(200);
  });

  it('an account suspension signs the person out everywhere; lifting lets them sign in again', async () => {
    const o = await newOrg();
    const member = await h.signIn();
    await h.owner.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'operator')", [
      o.id,
      member.session.user.id,
    ]);
    const owner = await staff(['platform_owner']);
    const r = await post('/v1/admin/restrictions', owner.headers, {
      kind: 'security',
      scope: 'account',
      org_id: o.id,
      user_id: member.session.user.id,
      reason: 'Credentials of this account were posted publicly',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect((await get('/v1/me', member.headers)).statusCode).toBe(401);
    expect((await get(`/v1/orgs/${o.id}/profiles`, o.owner.headers)).statusCode).toBe(200); // others unaffected
    expect(
      (
        await post('/v1/admin/restrictions', owner.headers, {
          kind: 'payment',
          scope: 'account',
          user_id: member.session.user.id,
          reason: 'Accounts cannot be payment-restricted',
        })
      ).statusCode,
    ).toBe(400);
    await post(`/v1/admin/restrictions/${r.json().id}/lift`, owner.headers, {
      reason: 'Password changed and sessions reviewed',
    });
    const again = await h.signIn({ sub: member.person.sub, email: member.person.email });
    expect((await get('/v1/me', again.headers)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- metrics and operations
describe('metrics', () => {
  it('recurring revenue, cash and refunds reconcile with provider fixtures, per currency, never converted', async () => {
    const admin = await staff(['business_admin']);
    const before = (await get('/v1/admin/metrics', admin.headers)).json();
    const usd = (m: typeof before) =>
      m.mrr.find((x: { currency: string }) => x.currency === 'usd') ?? { amount_minor: 0, subscriptions: 0 };
    const eur = (m: typeof before) =>
      m.mrr.find((x: { currency: string }) => x.currency === 'eur') ?? { amount_minor: 0, subscriptions: 0 };
    const cash = (m: typeof before, cur: string) =>
      m.cash_collected_30d.find((x: { currency: string }) => x.currency === cur)?.amount_minor ?? 0;
    const refunds = (m: typeof before) =>
      m.refunds_30d.find((x: { currency: string }) => x.currency === 'usd')?.amount_minor ?? 0;

    const monthly = await newOrg();
    await subscribe(monthly, 'team'); // 49.00 USD a month
    const yearly = await newOrg();
    await subscribe(yearly, 'team', 'year'); // 490.00 USD a year → 40.83 a month
    // A EUR subscription created at the provider (another price), applied through its webhook.
    const euro = await newOrg();
    const euroSub = await subscribe(euro, 'team');
    const eurPrice = f.addPrice({ unit_amount: 6000, currency: 'eur', interval: 'month', interval_count: 3 });
    await deliver(f.changePrice(euroSub, eurPrice)); // 60.00 EUR every 3 months → 20.00 a month
    const refundCustomer = (
      await h.owner.query('select provider_customer_id from subscriptions where org_id = $1', [monthly.id])
    ).rows[0].provider_customer_id;
    await deliver(f.refund(refundCustomer));

    const after = (await get('/v1/admin/metrics', admin.headers)).json();
    expect(usd(after).amount_minor - usd(before).amount_minor).toBe(4900 + Math.round(49000 / 12));
    expect(usd(after).subscriptions - usd(before).subscriptions).toBe(2);
    expect(eur(after).amount_minor - eur(before).amount_minor).toBe(2000);
    expect(cash(after, 'usd') - cash(before, 'usd')).toBe(4900 + 49000 + 4900);
    expect(refunds(after) - refunds(before)).toBe(4900);
    expect(after.workspaces.paying - before.workspaces.paying).toBe(3);
    expect(after.gaps).toEqual(expect.arrayContaining([expect.stringContaining('Discounts')]));
    expect(after.freshness.last_webhook_processed).not.toBeNull();
  });

  it('operations show failed e-mail without contents; a failed e-mail can be retried while its contents are kept', async () => {
    const support = await staff(['support_lead']);
    const id = newId('emailTask');
    await h.owner.query(
      `insert into email_tasks (id, kind, to_email, payload_enc, dedupe_key, state, attempts, last_error)
       values ($1, 'welcome', 'someone@people.test', $2, $3, 'failed', 8, 'smtp_rejected')`,
      [id, sealEmailVars(EMAIL_KEY, id, { name: 'x' }), `test:${id}`],
    );
    const ops = await get('/v1/admin/operations', support.headers);
    expect(ops.statusCode, ops.body).toBe(200);
    expect(ops.body).not.toContain('someone@people.test');
    expect(ops.json().email.recent_failures.find((m: { id: string }) => m.id === id)).toMatchObject({
      retryable: true,
      error: 'smtp_rejected',
    });
    const retry = await post(`/v1/admin/email/${id}/retry`, support.headers);
    expect(retry.statusCode, retry.body).toBe(202);
    expect(
      (await h.owner.query('select state, attempts from email_tasks where id = $1', [id])).rows[0],
    ).toEqual({
      state: 'pending',
      attempts: 0,
    });
    expect((await post(`/v1/admin/email/${id}/retry`, support.headers)).json().code).toBe('VERSION_CONFLICT');
    await h.owner.query("update email_tasks set state = 'skipped', payload_enc = null where id = $1", [id]);
  });

  it('release actions are requests only (platform owners); nothing is uploaded or signed here', async () => {
    const owner = await staff(['platform_owner']);
    const r = await post('/v1/admin/release-requests', owner.headers, {
      action: 'pause_channel',
      reason: 'Crash reports after the latest update, pausing',
    });
    expect(r.statusCode, r.body).toBe(201);
    const admin = await staff(['business_admin']);
    expect(
      (
        await post('/v1/admin/release-requests', admin.headers, {
          action: 'pause_channel',
          reason: 'x'.repeat(20),
        })
      ).json().code,
    ).toBe('FORBIDDEN');
    const ops = (await get('/v1/admin/operations', owner.headers)).json();
    expect(ops.release.requests[0]).toMatchObject({ action: 'pause_channel', state: 'requested' });
  });
});

describe('note redaction', () => {
  it('replaces card numbers, secrets after keywords and key-like tokens, and keeps the rest', () => {
    // Secret-looking test strings are built at run time (never a literal in the repository).
    const liveKey = ['sk', 'live', `51H${'abcdefghijklmnop'}`].join('_');
    const r = redactNote(`Card 4111-1111-1111-1111, token=abc123, key ${liveKey}; order 12345.`);
    expect(r.redacted).toBe(true);
    expect(r.text).toBe('Card [redacted], token=[redacted] key [redacted]; order 12345.');
    expect(redactNote('Called the owner about the invoice PB-0001.')).toEqual({
      text: 'Called the owner about the invoice PB-0001.',
      redacted: false,
    });
  });
});
