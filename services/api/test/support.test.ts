/**
 * Milestone 11: the internal support console's API (ADR-0018). Staff are added only by the server command; staff
 * tokens work only on support routes and organization credentials never do; sensitive access is requested with a
 * reason, approved by a different support lead, time-bound and visible in the organization's own activity log;
 * overrides need billing_admin, a reason and an expiry; session data is never reachable.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@pb/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addStaff, endBreakGlass, grantBreakGlass, listStaff, removeStaff } from '../scripts/staff.ts';
import { verifyChain } from '../src/audit-chain.ts';
import { type Harness, harness, type SignedIn } from './helpers.ts';
import { nonce } from './idp.ts';

const CONSOLE = 'pb-console-test';
let h: Harness;
let db: pg.PoolClient;

beforeAll(async () => {
  h = await harness({ consoleClientId: CONSOLE });
  db = await h.owner.connect();
});
afterAll(async () => {
  db?.release();
  await h?.close();
});

interface Staff {
  person: SignedIn;
  headers: Record<string, string>;
  token: string;
}

/** A person who signed in to the app once, made staff with the server command, then signed in to the console. */
async function staff(roles: ('support' | 'support_lead' | 'billing_admin')[]): Promise<Staff> {
  const person = await h.signIn();
  await addStaff(db, person.person.email, roles, 'test');
  const token = await consoleSignIn(person.person.sub, person.person.email);
  return { person, token, headers: { authorization: `Bearer ${token}` } };
}

async function consoleSignIn(
  sub: string,
  email: string,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const res = await consoleAttempt(sub, email, claims);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().access_token;
}

async function consoleAttempt(
  sub: string,
  email: string,
  claims: Record<string, unknown> = {},
  idToken?: string,
) {
  await h.owner.query("delete from rate_limit_counters where bucket = 'staff.signin.ip'");
  const n = nonce();
  const token = idToken ?? (await h.idp.idToken({ sub, nonce: n, email, aud: CONSOLE, ...claims }));
  return h.app.inject({
    method: 'POST',
    url: '/v1/support/sessions',
    payload: { id_token: token, nonce: n },
  });
}

async function customerOrg(): Promise<{
  id: string;
  owner: SignedIn;
  member: SignedIn;
  profileName: string;
}> {
  const owner = await h.signIn();
  const org = await h.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: `Customer ${randomBytes(2).toString('hex')}` },
  });
  const id = org.json().id as string;
  const member = await h.signIn();
  await h.owner.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [
    id,
    member.session.user.id,
  ]);
  const profileName = `Private profile ${randomBytes(3).toString('hex')}`;
  await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${id}/profiles`,
    headers: owner.headers,
    payload: { name: profileName },
  });
  return { id, owner, member, profileName };
}

const get = (url: string, headers: Record<string, string>) => h.app.inject({ method: 'GET', url, headers });
const post = (url: string, headers: Record<string, string>, payload?: object) =>
  h.app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });

describe('staff sign-in', () => {
  it('only active staff get a console token; it is short-lived and works only on support routes', async () => {
    const outsider = await h.signIn();
    const refused = await consoleAttempt(outsider.person.sub, outsider.person.email);
    expect(refused.json()).toMatchObject({ code: 'UNAUTHENTICATED', safe_details: { reason: 'not_staff' } });
    const s = await staff(['support']);
    const me = await get('/v1/me', s.headers);
    expect(me.statusCode).toBe(401); // a staff token is not an organization session
    const org = await customerOrg();
    expect((await get(`/v1/support/orgs/${org.id}`, org.owner.headers)).statusCode).toBe(401); // and the reverse
    expect((await get(`/v1/support/orgs/${org.id}`, s.headers)).statusCode).toBe(200);
  });

  it('refuses reused, stale and other-client ID tokens', async () => {
    const s = await staff(['support']);
    const n = nonce();
    const token = await h.idp.idToken({
      sub: s.person.person.sub,
      nonce: n,
      email: s.person.person.email,
      aud: CONSOLE,
    });
    const once = await h.app.inject({
      method: 'POST',
      url: '/v1/support/sessions',
      payload: { id_token: token, nonce: n },
    });
    expect(once.statusCode).toBe(201);
    const twice = await h.app.inject({
      method: 'POST',
      url: '/v1/support/sessions',
      payload: { id_token: token, nonce: n },
    });
    expect(twice.json().safe_details.reason).toBe('id_token_reused');
    const old = await consoleAttempt(s.person.person.sub, s.person.person.email, {
      auth_time: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(old.json().safe_details.reason).toBe('sign_in_not_recent');
    const desktopToken = await consoleAttempt(s.person.person.sub, s.person.person.email, {
      aud: 'pb-desktop-test',
    });
    expect(desktopToken.json().safe_details.reason).toBe('id_token_invalid');
  });

  it('removing staff with the server command ends their console sessions at once', async () => {
    const s = await staff(['support', 'billing_admin']);
    expect((await listStaff(db)).some((r) => r.user_id === s.person.session.user.id && !r.disabled)).toBe(
      true,
    );
    const org = await customerOrg();
    expect((await get(`/v1/support/orgs/${org.id}`, s.headers)).statusCode).toBe(200);
    await removeStaff(db, s.person.session.user.id);
    expect((await get(`/v1/support/orgs/${org.id}`, s.headers)).statusCode).toBe(401);
    const audit = await h.owner.query('select action from platform_audit where target = $1 order by at', [
      s.person.session.user.id,
    ]);
    expect(audit.rows.map((r) => r.action)).toEqual(['staff.added', 'staff.removed']);
    await expect(addStaff(db, s.person.session.user.id, ['owner' as never], null)).rejects.toThrow(/roles/);
  });
});

describe('finding an organization and its overview', () => {
  it('searches by id, customer id or exact e-mail (audited, e-mail masked)', async () => {
    const s = await staff(['support']);
    const org = await customerOrg();
    await h.owner.query(
      "update subscriptions set provider_customer_id = $2, provider = 'stripe' where org_id = $1",
      [org.id, `cus_T${randomBytes(6).toString('hex')}`],
    );
    const customer = (
      await h.owner.query('select provider_customer_id as c from subscriptions where org_id = $1', [org.id])
    ).rows[0].c;
    for (const [q, by] of [
      [org.id, 'org_id'],
      [customer, 'customer_id'],
      [org.member.person.email.toUpperCase(), 'email'],
    ] as const) {
      const res = await get(`/v1/support/orgs?q=${encodeURIComponent(q)}`, s.headers);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ matched_by: by, items: [{ id: org.id, state: 'trial' }] });
    }
    expect((await get('/v1/support/orgs?q=just-a-name', s.headers)).statusCode).toBe(400);
    const audit = await h.owner.query(
      "select details from platform_audit where actor_user_id = $1 and action = 'support.searched' order by at",
      [s.person.session.user.id],
    );
    const emailSearch = audit.rows.find((r) => r.details.matched_by === 'email');
    expect(emailSearch.details.query).toMatch(/^.\*\*\*@people\.test$/i);
    expect(JSON.stringify(audit.rows)).not.toContain(org.member.person.email);
  });

  it('the overview has billing numbers and no e-mails, profile names or session data', async () => {
    const s = await staff(['support']);
    const org = await customerOrg();
    const res = await get(`/v1/support/orgs/${org.id}`, s.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: org.id,
      member_count: 2,
      subscription: { state: 'trial', usage: { profiles: 1, seats: 2 } },
      active_access: [],
    });
    for (const secret of [org.owner.person.email, org.member.person.email, org.profileName]) {
      expect(res.body).not.toContain(secret);
    }
  });
});

describe('sensitive access', () => {
  it('needs a reason, a different support lead’s approval, ends by itself, and shows in the customer’s activity', async () => {
    const agent = await staff(['support']);
    const lead = await staff(['support_lead']);
    const org = await customerOrg();
    const base = `/v1/support/orgs/${org.id}`;
    expect((await get(`${base}/members`, agent.headers)).json().safe_details.reason).toBe('access_required');
    const short = await post(`${base}/access-requests`, agent.headers, {
      scope: 'members',
      reason: 'help',
      duration_minutes: 30,
    });
    expect(short.statusCode).toBe(400);
    const req = await post(`${base}/access-requests`, agent.headers, {
      scope: 'members',
      reason: 'Customer asked us to check why an invitation failed (ticket 1234)',
      duration_minutes: 30,
    });
    expect(req.statusCode, req.body).toBe(201);
    const id = req.json().id as string;
    // The requester (not a lead) cannot decide; a lead cannot approve their own request.
    expect(
      (
        await post(`/v1/support/access-requests/${id}/decision`, agent.headers, { decision: 'approve' })
      ).json().code,
    ).toBe('FORBIDDEN');
    const leadOwn = await post(`${base}/access-requests`, lead.headers, {
      scope: 'activity',
      reason: 'Lead wants to look at the activity log too',
      duration_minutes: 10,
    });
    const own = await post(`/v1/support/access-requests/${leadOwn.json().id}/decision`, lead.headers, {
      decision: 'approve',
    });
    expect(own.json()).toMatchObject({ code: 'FORBIDDEN', safe_details: { reason: 'own_request' } });
    // Pending requests are visible to the lead.
    const pending = (await get('/v1/support/access-requests?state=pending', lead.headers)).json().items;
    expect(pending.map((r: { id: string }) => r.id)).toContain(id);
    const approved = await post(`/v1/support/access-requests/${id}/decision`, lead.headers, {
      decision: 'approve',
    });
    expect(approved.json()).toMatchObject({ state: 'approved', decided_by: lead.person.session.user.id });
    const members = await get(`${base}/members`, agent.headers);
    expect(members.statusCode, members.body).toBe(200);
    expect(
      members
        .json()
        .items.map((m: { email: string }) => m.email)
        .sort(),
    ).toEqual([org.owner.person.email, org.member.person.email].sort());
    // Only members were granted, not the activity log; and only to the requester.
    expect((await get(`${base}/activity`, agent.headers)).json().safe_details.reason).toBe('access_required');
    expect((await get(`${base}/members`, lead.headers)).json().safe_details.reason).toBe('access_required');
    // The customer's owners see it in their activity log.
    const activity = await get(`/v1/orgs/${org.id}/audit-events`, org.owner.headers);
    const actions = (activity.json().items as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['support.access_granted', 'support.viewed_members']));
    // Time is up.
    await h.owner.query(
      "update support_access_requests set expires_at = now() - interval '1 second' where id = $1",
      [id],
    );
    expect((await get(`${base}/members`, agent.headers)).json().safe_details.reason).toBe('access_required');
    expect(
      (await get('/v1/support/access-requests', agent.headers))
        .json()
        .items.find((r: { id: string }) => r.id === id).state,
    ).toBe('expired');
  });

  it('can be revoked early by the requester', async () => {
    const agent = await staff(['support']);
    const lead = await staff(['support_lead']);
    const org = await customerOrg();
    const req = await post(`/v1/support/orgs/${org.id}/access-requests`, agent.headers, {
      scope: 'activity',
      reason: 'Investigating a failed backup the customer reported',
      duration_minutes: 60,
    });
    await post(`/v1/support/access-requests/${req.json().id}/decision`, lead.headers, {
      decision: 'approve',
    });
    expect((await get(`/v1/support/orgs/${org.id}/activity`, agent.headers)).statusCode).toBe(200);
    expect(
      (await post(`/v1/support/access-requests/${req.json().id}/revoke`, agent.headers)).json().state,
    ).toBe('revoked');
    expect((await get(`/v1/support/orgs/${org.id}/activity`, agent.headers)).statusCode).toBe(403);
  });
});

describe('overrides, resync and alerts', () => {
  it('only billing admins add overrides, with a reason and an expiry within 90 days; recorded on both sides', async () => {
    const agent = await staff(['support', 'support_lead']);
    const admin = await staff(['billing_admin']);
    const org = await customerOrg();
    const base = `/v1/support/orgs/${org.id}/overrides`;
    const body = {
      scope: 'limit.profiles',
      value: 250,
      reason: 'Pilot customer needs more profiles while the plan is decided',
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    };
    expect((await post(base, agent.headers, body)).json().code).toBe('FORBIDDEN');
    expect(
      (
        await post(base, admin.headers, {
          ...body,
          expires_at: new Date(Date.now() + 91 * 86_400_000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post(base, admin.headers, { ...body, scope: 'access.unrestricted', value: 5 })).statusCode,
    ).toBe(400);
    expect((await post(base, admin.headers, { ...body, reason: 'too short' })).statusCode).toBe(400);
    const created = await post(base, admin.headers, body);
    expect(created.statusCode, created.body).toBe(201);
    const sub = (await get(`/v1/support/orgs/${org.id}`, agent.headers)).json().subscription;
    expect(sub.limits.profiles).toBe(250);
    expect(sub.overrides).toEqual([{ scope: 'limit.profiles', expires_at: expect.any(String) }]);
    // The customer sees the override in their own subscription (without who or why) and activity.
    const own = (await get(`/v1/orgs/${org.id}/billing/subscription`, org.owner.headers)).json();
    expect(own.limits.profiles).toBe(250);
    expect(JSON.stringify(own)).not.toContain(body.reason);
    const revoked = await post(`/v1/support/overrides/${created.json().id}/revoke`, admin.headers);
    expect(revoked.json().revoked_at).not.toBeNull();
    expect(
      (await get(`/v1/orgs/${org.id}/billing/subscription`, org.owner.headers)).json().limits.profiles,
    ).toBe(100);
    const audit = await h.owner.query(
      "select action from audit_events where org_id = $1 and action like 'support.%' order by created_at",
      [org.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['support.override_added', 'support.override_revoked']);
  });

  it('alerts are for billing admins and support leads; resolving is for billing admins', async () => {
    const agent = await staff(['support']);
    const lead = await staff(['support_lead']);
    const admin = await staff(['billing_admin']);
    const alertId = newId('billingAlert');
    await h.owner.query(
      "insert into billing_alerts (id, kind, ref, detail) values ($1, 'webhook_backlog', $2, 'test backlog')",
      [alertId, `support-test-${randomBytes(4).toString('hex')}`],
    );
    expect((await get('/v1/support/alerts?open=true', agent.headers)).json().code).toBe('FORBIDDEN');
    expect((await get('/v1/support/alerts?open=true', lead.headers)).statusCode).toBe(200);
    expect((await post(`/v1/support/alerts/${alertId}/resolve`, lead.headers)).json().code).toBe('FORBIDDEN');
    const resolved = await post(`/v1/support/alerts/${alertId}/resolve`, admin.headers);
    expect(resolved.json()).toMatchObject({ resolved_by: admin.person.session.user.id });
    const audit = await get('/v1/support/audit', lead.headers);
    expect((audit.json().items as { action: string }[]).map((a) => a.action)).toEqual(
      expect.arrayContaining(['support.alert_resolved', 'staff.signed_in']),
    );
    expect((await get('/v1/support/audit', agent.headers)).json().code).toBe('FORBIDDEN');
  });

  it('resync is queued only by billing admins', async () => {
    const agent = await staff(['support']);
    const admin = await staff(['billing_admin']);
    const org = await customerOrg();
    expect((await post(`/v1/support/orgs/${org.id}/billing/resync`, agent.headers)).json().code).toBe(
      'FORBIDDEN',
    );
    const r = await post(`/v1/support/orgs/${org.id}/billing/resync`, admin.headers);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ queued: false }); // a trial without a provider subscription has nothing to resync
  });
});

describe('break-glass access and the audit export (milestone 12)', () => {
  it('only the server command grants it: reasoned, at most 60 minutes, every use recorded and alerted', async () => {
    const s = await staff(['support']);
    const org = await customerOrg();
    // Without it: the usual approval is needed, and emergency actions are refused.
    expect((await get(`/v1/support/orgs/${org.id}/members`, s.headers)).json().safe_details).toMatchObject({
      reason: 'access_required',
    });
    const refused = await post(`/v1/support/orgs/${org.id}/emergency/revoke-api-tokens`, s.headers, {
      reason: 'A token was posted in a public issue tracker',
    });
    expect(refused.json()).toMatchObject({
      code: 'FORBIDDEN',
      safe_details: { reason: 'break_glass_required' },
    });

    // The grant needs a real reason, a short duration, and an active staff member.
    const reason = 'Customer reports a leaked API token';
    await expect(
      grantBreakGlass(db, s.person.person.email, [org.id], 'too short', 10, 'server:test'),
    ).rejects.toThrow(/reason/);
    await expect(
      grantBreakGlass(db, s.person.person.email, [org.id], reason, 61, 'server:test'),
    ).rejects.toThrow(/5-60/);
    await expect(grantBreakGlass(db, s.person.person.email, [], reason, 10, 'server:test')).rejects.toThrow(
      /1-10 organizations/,
    );
    await expect(
      grantBreakGlass(db, s.person.person.email, [newId('organization')], reason, 10, 'server:test'),
    ).rejects.toThrow(/no such organization/);
    const outsider = await h.signIn();
    await expect(
      grantBreakGlass(db, outsider.person.email, [org.id], reason, 10, 'server:test'),
    ).rejects.toThrow(/only for active staff/);
    await expect(
      db.query(
        `insert into break_glass_grants (id, user_id, org_ids, reason, granted_by, expires_at)
         values ($1, $2, $3, 'A long enough emergency reason here', 'x', now() + interval '2 hours')`,
        [newId('audit').replace('aud_', 'bgg_'), s.person.session.user.id, [org.id]],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query(
        `insert into break_glass_grants (id, user_id, org_ids, reason, granted_by, expires_at)
         values ($1, $2, null, 'A long enough emergency reason here', 'x', now() + interval '20 minutes')`,
        [newId('audit').replace('aud_', 'bgg_'), s.person.session.user.id],
      ),
    ).rejects.toThrow(/check constraint/);
    const other = await customerOrg();
    const grant = await grantBreakGlass(db, s.person.person.email, [org.id], reason, 10, 'server:test');

    // The grant names its organizations: another one still needs the usual approval and refuses emergencies.
    const elsewhere = (await get(`/v1/support/orgs/${other.id}`, s.headers)).json();
    expect(elsewhere.break_glass_until).toBeNull();
    expect((await get(`/v1/support/orgs/${other.id}/members`, s.headers)).statusCode).toBe(403);
    expect(
      (
        await post(`/v1/support/orgs/${other.id}/emergency/revoke-api-tokens`, s.headers, {
          reason: 'A token was posted in a public issue tracker',
        })
      ).json().safe_details,
    ).toMatchObject({ reason: 'break_glass_required' });

    const overview = (await get(`/v1/support/orgs/${org.id}`, s.headers)).json();
    expect(overview.active_access.sort()).toEqual(['activity', 'members']);
    expect(Date.parse(overview.break_glass_until)).toBeGreaterThan(Date.now());
    expect((await get(`/v1/support/orgs/${org.id}/members`, s.headers)).statusCode).toBe(200);

    // Emergency: every API token of the organization stops working at once; nothing else changes.
    const tokenId = newId('apiToken');
    await db.query(
      `insert into api_tokens (id, org_id, user_id, name, token_hash, scopes, expires_at)
       values ($1, $2, $3, 'ci', $4, array['profiles:read'], now() + interval '30 days')`,
      [tokenId, org.id, org.owner.session.user.id, randomBytes(32).toString('hex')],
    );
    const revoked = await post(`/v1/support/orgs/${org.id}/emergency/revoke-api-tokens`, s.headers, {
      reason: 'A token was posted in a public issue tracker',
    });
    expect(revoked.json()).toEqual({ revoked_api_tokens: 1 });
    expect(
      (await db.query('select revoked_at from api_tokens where id = $1', [tokenId])).rows[0]?.revoked_at,
    ).not.toBeNull();
    expect((await get(`/v1/orgs/${org.id}/profiles`, org.owner.headers)).statusCode).toBe(200);

    // Recorded: platform audit, the organization's own log, and an open console alert.
    const actions = (
      await db.query<{ action: string }>('select action from platform_audit where org_id = $1 order by seq', [
        org.id,
      ])
    ).rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['support.break_glass_members', 'support.revoked_api_tokens']),
    );
    const orgLog = (
      await db.query<{ action: string }>('select action from audit_events where org_id = $1', [org.id])
    ).rows.map((r) => r.action);
    expect(orgLog).toEqual(
      expect.arrayContaining(['support.break_glass_members', 'support.revoked_api_tokens']),
    );
    const alerts = await db.query(
      "select count from billing_alerts where kind = 'break_glass_used' and (ref = $1 or org_id = $2) and resolved_at is null",
      [grant.id, org.id],
    );
    expect(alerts.rowCount).toBeGreaterThanOrEqual(2);

    // The holder cannot clear their own break-glass alerts; another billing admin reviews them.
    await db.query('update platform_staff set roles = $2 where user_id = $1', [
      s.person.session.user.id,
      ['support', 'billing_admin'],
    ]);
    const open = await db.query<{ id: string }>(
      "select id from billing_alerts where kind = 'break_glass_used' and ref = $1 and resolved_at is null",
      [grant.id],
    );
    const alertId = open.rows[0]?.id as string;
    const own = await post(`/v1/support/alerts/${alertId}/resolve`, s.headers, {});
    expect(own.json()).toMatchObject({ code: 'FORBIDDEN', safe_details: { reason: 'own_break_glass' } });
    const reviewer = await staff(['billing_admin']);
    expect((await post(`/v1/support/alerts/${alertId}/resolve`, reviewer.headers, {})).statusCode).toBe(200);

    // Ended on the server: back to the usual approval.
    expect(await endBreakGlass(db, s.person.person.email, 'server:test')).toBe(1);
    expect((await get(`/v1/support/orgs/${org.id}/members`, s.headers)).statusCode).toBe(403);
    expect((await get(`/v1/support/orgs/${org.id}`, s.headers)).json().break_glass_until).toBeNull();
  });

  it('support leads export the hash-chained audit; anyone can recompute the chain', async () => {
    const lead = await staff(['support_lead']);
    const support = await staff(['support']);
    expect((await get('/v1/support/audit/export', support.headers)).statusCode).toBe(403);
    const first = await get('/v1/support/audit/export?limit=5000', lead.headers);
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json();
    expect(verifyChain(body.items, '', 1n).ok).toBe(true);
    expect(body.items.at(-1).hash).toBe(body.head.hash);
    // The next export continues from the last hash; the export itself was recorded.
    const next = (await get(`/v1/support/audit/export?after_seq=${body.head.seq}`, lead.headers)).json();
    expect(next.items[0].action).toBe('support.audit_exported');
    expect(verifyChain(next.items, body.head.hash, BigInt(body.head.seq) + 1n).ok).toBe(true);
  });
});
