/**
 * R2 self-service onboarding (ADR-0021): a direct signup gets exactly one workspace and one trial (also when the
 * desktop and the browser finish at the same moment), an interrupted bootstrap leaves nothing half-made and can be
 * retried, invitations take priority and assign only the invited team, the wrong account cannot accept, a full
 * workspace fails cleanly, returning people get their workspace (a choice once when they own several), further
 * workspaces share the trial clock, suspended workspaces and suspended addresses stay closed, and customers never
 * reach staff routes.
 */
import { newId } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness, type SignedIn } from './helpers.ts';

const TERMS = '2026-10-14';
let h: Harness;

beforeAll(async () => {
  h = await harness({ env: { TERMS_VERSION: TERMS } });
});
afterAll(async () => {
  await h.close();
});

const call = (method: 'GET' | 'POST', url: string, who: SignedIn, payload?: object) =>
  h.app.inject({ method, url, headers: who.headers, ...(payload ? { payload } : {}) });
const complete = (who: SignedIn, payload: object = {}) =>
  call('POST', '/v1/onboarding/complete', who, payload);
const status = async (who: SignedIn) => {
  const res = await call('GET', '/v1/onboarding/status', who);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const ownedOrgs = async (userId: string) =>
  (
    await h.owner.query<{ org_id: string }>(
      `select org_id from memberships where user_id = $1 and role = 'owner' order by created_at`,
      [userId],
    )
  ).rows.map((r) => r.org_id);
const resetLimits = () =>
  h.owner.query(
    "delete from rate_limit_counters where bucket in ('onboarding.user', 'onboarding.ip', 'org.create.user')",
  );

async function invite(owner: SignedIn, orgId: string, email: string, role = 'operator') {
  const res = await call('POST', `/v1/orgs/${orgId}/invitations`, owner, { email, role });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { token: string; email_delivery: string };
}

describe('direct signup', () => {
  it('asks for the terms, then creates one personal workspace with an owner membership and a trial', async () => {
    const p = await h.signIn();
    const before = await status(p);
    expect(before).toMatchObject({
      state: 'new',
      default_org_id: null,
      workspaces: [],
      email_verified: true,
      terms: { current_version: TERMS, accepted_version: null },
      trial_available: true,
    });
    const asked = await complete(p);
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json().outcome).toBe('terms_required');
    expect(await ownedOrgs(p.session.user.id)).toEqual([]);

    const stale = await complete(p, { accept_terms_version: '2020-01-01' });
    expect(stale.json().code).toBe('TERMS_REQUIRED');
    expect(stale.json().safe_details).toEqual({ current_version: TERMS });

    const done = await complete(p, { accept_terms_version: TERMS, marketing_consent: false });
    expect(done.statusCode, done.body).toBe(200);
    const r = done.json();
    expect(r.outcome).toBe('created');
    const orgId = r.status.default_org_id as string;
    expect(r.status).toMatchObject({
      state: 'ready',
      bootstrap_org_id: orgId,
      workspaces: [{ org_id: orgId, role: 'owner', suspended: false }],
      terms: { accepted_version: TERMS },
      marketing_consent: false,
      trial_available: false,
    });
    expect(r.status.workspaces[0].name).toBe(`${p.person.name}’s workspace`);
    const sub = await h.owner.query('select state from subscriptions where org_id = $1', [orgId]);
    expect(sub.rows[0]?.state).toBe('trial');
    // The organization screen agrees (billing summary: trial).
    const org = await call('GET', `/v1/orgs/${orgId}`, p);
    expect(org.json()).toMatchObject({ role: 'owner', billing: { state: 'trial' } });

    // Again: nothing new.
    const again = await complete(p);
    expect(again.json().outcome).toBe('existing');
    expect(await ownedOrgs(p.session.user.id)).toEqual([orgId]);
    // Terms and marketing consent are separate records.
    const consents = await h.owner.query(
      'select kind, version, granted from user_consents where user_id = $1 order by id',
      [p.session.user.id],
    );
    expect(consents.rows).toEqual([
      { kind: 'terms', version: TERMS, granted: true },
      { kind: 'marketing', version: TERMS, granted: false },
    ]);
  });

  it('an unverified address is refused before anything is created, and the attempt stays visible', async () => {
    const p = await h.signIn({ verified: false });
    const res = await complete(p, { accept_terms_version: TERMS });
    expect(res.json().code).toBe('EMAIL_NOT_VERIFIED');
    const s = await status(p);
    expect(s).toMatchObject({ state: 'new', email_verified: false, last_error: 'EMAIL_NOT_VERIFIED' });
    expect(s.attempts).toBeGreaterThanOrEqual(1);
    expect(await ownedOrgs(p.session.user.id)).toEqual([]);
    // The e-mail is verified with the provider and the person signs in again (fresh, trusted claims): it works.
    const again = await h.signIn({ ...p.person, verified: true });
    const ok = await complete(again, { accept_terms_version: TERMS });
    expect(ok.json().outcome).toBe('created');
    expect(ok.json().status.last_error).toBeNull();
  });

  it('desktop and browser finishing at the same moment produce one workspace and one trial', async () => {
    await resetLimits();
    const desktop = await h.signIn();
    const browser = await h.signIn({ ...desktop.person });
    expect(browser.session.user.id).toBe(desktop.session.user.id);
    const results = await Promise.all(
      [desktop, browser, desktop, browser, desktop].map((who) =>
        complete(who, { accept_terms_version: TERMS }),
      ),
    );
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    expect(results.map((r) => r.json().outcome).sort()).toEqual([
      'created',
      'existing',
      'existing',
      'existing',
      'existing',
    ]);
    const owned = await ownedOrgs(desktop.session.user.id);
    expect(owned).toHaveLength(1);
    const claims = await h.owner.query('select org_id from trial_claims where user_id = $1', [
      desktop.session.user.id,
    ]);
    expect(claims.rows).toEqual([{ org_id: owned[0] }]);
  });

  it('a bootstrap interrupted half-way leaves nothing behind and the retry completes it', async () => {
    await resetLimits();
    const p = await h.signIn();
    const fn = `fail_${p.session.user.id.toLowerCase()}`;
    // A failure after the workspace row was written (the owner membership refuses): the whole bootstrap rolls back.
    await h.owner.query(
      `create function app.${fn}() returns trigger language plpgsql as $$
       begin if new.user_id = '${p.session.user.id}' then raise exception 'injected'; end if; return new; end $$`,
    );
    await h.owner.query(
      `create trigger ${fn} before insert on app.memberships for each row execute function app.${fn}()`,
    );
    try {
      const failed = await complete(p, { accept_terms_version: TERMS });
      expect(failed.statusCode).toBe(500);
      const orgs = await h.owner.query(`select count(*)::int as n from organizations where name = $1`, [
        `${p.person.name}’s workspace`,
      ]);
      expect(orgs.rows[0]?.n).toBe(0);
      const s = await status(p);
      expect(s).toMatchObject({
        state: 'new',
        default_org_id: null,
        bootstrap_org_id: null,
        last_error: 'INTERNAL',
      });
      // The terms acceptance rolled back with it; the retry sends it again.
      expect(s.terms.accepted_version).toBeNull();
    } finally {
      await h.owner.query(`drop trigger ${fn} on app.memberships`);
      await h.owner.query(`drop function app.${fn}()`);
    }
    const retry = await complete(p, { accept_terms_version: TERMS });
    expect(retry.json().outcome).toBe('created');
    expect(await ownedOrgs(p.session.user.id)).toHaveLength(1);
  });

  it('keeps a valid plan intent and refuses one that is not offered (never a price)', async () => {
    await resetLimits();
    const p = await h.signIn();
    const bad = await complete(p, { plan_intent: 'internal' });
    expect(bad.json().code).toBe('PLAN_NOT_AVAILABLE');
    const unknown = await complete(p, { plan_intent: 'diamond' });
    expect(unknown.json().code).toBe('PLAN_NOT_AVAILABLE');
    const extra = await complete(p, { plan_intent: 'team', price: 1 });
    expect(extra.json().code).toBe('VALIDATION_FAILED');
    const ok = await complete(p, { plan_intent: 'team', accept_terms_version: TERMS });
    expect(ok.json().status.plan_intent).toBe('team');
  });
});

describe('invitations take priority', () => {
  let owner: SignedIn;
  let orgId = '';

  beforeAll(async () => {
    await resetLimits();
    owner = await h.signIn();
    const r = await complete(owner, { accept_terms_version: TERMS });
    orgId = r.json().status.default_org_id;
  });

  it('an invited teammate joins only the invited workspace: no personal workspace, no trial, no payment', async () => {
    const email = `teammate-${newId('user').slice(-8).toLowerCase()}@people.test`;
    const inv = await invite(owner, orgId, email);
    expect(inv.email_delivery).toBe('not_configured');
    const mate = await h.signIn({ email });
    // Without the link: told that invitations are waiting, nothing created.
    const waiting = await complete(mate, { accept_terms_version: TERMS });
    expect(waiting.json().outcome).toBe('invitations_pending');
    expect(waiting.json().status.pending_invitations).toEqual([
      expect.objectContaining({ role: 'operator', org_name: expect.any(String) }),
    ]);
    expect(await ownedOrgs(mate.session.user.id)).toEqual([]);

    const joined = await complete(mate, { invitation_token: inv.token });
    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json()).toMatchObject({
      outcome: 'joined',
      status: { state: 'invited', default_org_id: orgId, bootstrap_org_id: null, pending_invitations: [] },
    });
    expect(joined.json().status.workspaces).toEqual([
      { org_id: orgId, name: expect.any(String), role: 'operator', suspended: false },
    ]);
    // A retry of the same request answers the same (the invitation is used, the membership exists).
    const retry = await complete(mate, { invitation_token: inv.token });
    expect(retry.json().outcome).toBe('joined');
    // Later sign-ins land in the team; still no personal workspace or trial claim.
    expect((await complete(mate)).json().outcome).toBe('existing');
    const claims = await h.owner.query('select 1 from trial_claims where user_id = $1', [
      mate.session.user.id,
    ]);
    expect(claims.rowCount).toBe(0);
  });

  it('existing users keep their other memberships when they accept', async () => {
    await resetLimits();
    const other = await h.signIn();
    const own = (await complete(other, { accept_terms_version: TERMS })).json().status.default_org_id;
    const inv = await invite(owner, orgId, other.person.email, 'admin');
    const joined = await complete(other, { invitation_token: inv.token });
    expect(joined.json().status.default_org_id).toBe(orgId);
    expect(joined.json().status.state).toBe('invited');
    expect(
      joined
        .json()
        .status.workspaces.map((w: { org_id: string }) => w.org_id)
        .sort(),
    ).toEqual([own, orgId].sort());
  });

  it('the wrong account cannot accept; an unverified one is told to verify', async () => {
    const inv = await invite(owner, orgId, `someone-${Date.now()}@people.test`);
    const stranger = await h.signIn();
    const wrong = await complete(stranger, { invitation_token: inv.token });
    expect(wrong.json().code).toBe('INVITATION_WRONG_ACCOUNT');
    const unverified = await h.signIn({ verified: false });
    expect((await complete(unverified, { invitation_token: inv.token })).json().code).toBe(
      'EMAIL_NOT_VERIFIED',
    );
    // Neither got a membership.
    const m = await h.owner.query('select 1 from memberships where org_id = $1 and user_id = any($2)', [
      orgId,
      [stranger.session.user.id, unverified.session.user.id],
    ]);
    expect(m.rowCount).toBe(0);
  });

  it('an expired invitation is refused and nothing is created', async () => {
    const email = `late-${Date.now()}@people.test`;
    const inv = await invite(owner, orgId, email);
    await h.owner.query(
      "update invitations set created_at = now() - interval '8 days', expires_at = now() - interval '1 minute' where email = $1",
      [email],
    );
    const late = await h.signIn({ email });
    expect((await complete(late, { invitation_token: inv.token })).json().code).toBe('INVITATION_EXPIRED');
    expect(await ownedOrgs(late.session.user.id)).toEqual([]);
  });

  it('a workspace whose seats are now full fails cleanly', async () => {
    await resetLimits();
    const boss = await h.signIn();
    const small = (await complete(boss, { accept_terms_version: TERMS })).json().status.default_org_id;
    const email = `seat-${Date.now()}@people.test`;
    const inv = await invite(boss, small, email);
    // The plan shrinks to one seat after the invitation was sent.
    await h.owner.query(
      `insert into entitlement_overrides (id, org_id, scope, value, reason, created_by, expires_at)
       values ($1, $2, 'limit.seats', '1', 'test: the plan shrank after an invitation', $3, now() + interval '1 day')`,
      [newId('override'), small, boss.session.user.id],
    );
    const mate = await h.signIn({ email });
    const full = await complete(mate, { invitation_token: inv.token });
    expect(full.json()).toMatchObject({ code: 'PLAN_LIMIT_REACHED', safe_details: { limit: 'seats' } });
    const m = await h.owner.query('select count(*)::int as n from memberships where org_id = $1', [small]);
    expect(m.rows[0]?.n).toBe(1);
    // The invitation is still open: once there is room it can be accepted.
    await h.owner.query(
      'update entitlement_overrides set revoked_at = now(), revoked_by = created_by where org_id = $1',
      [small],
    );
    expect((await complete(mate, { invitation_token: inv.token })).json().outcome).toBe('joined');
  });

  it('a suspended workspace cannot be joined (an invitation never revives it) or chosen', async () => {
    await resetLimits();
    const boss = await h.signIn();
    const doomed = (await complete(boss, { accept_terms_version: TERMS })).json().status.default_org_id;
    const email = `susp-${Date.now()}@people.test`;
    const inv = await invite(boss, doomed, email);
    await h.owner.query('update organizations set suspended_at = now() where id = $1', [doomed]);
    const mate = await h.signIn({ email });
    expect((await complete(mate, { invitation_token: inv.token })).json().code).toBe('WORKSPACE_SUSPENDED');
    // Through the older accept route as well.
    const old = await call('POST', `/v1/invitations/${inv.token}/accept`, mate);
    expect(old.json().code).toBe('WORKSPACE_SUSPENDED');
    // Its owner is not sent into it by default either.
    const s = await status(boss);
    expect(s.default_org_id).toBeNull();
    expect(s.workspaces).toEqual([expect.objectContaining({ org_id: doomed, suspended: true })]);
    expect((await complete(boss, { choose_org_id: doomed })).json().code).toBe('WORKSPACE_SUSPENDED');
  });
});

describe('returning people and further workspaces', () => {
  it('a returning owner gets their workspace selected, never a fresh trial', async () => {
    await resetLimits();
    const p = await h.signIn();
    const created = await call('POST', '/v1/organizations', p, { name: 'Made before R2' });
    expect(created.statusCode, created.body).toBe(201);
    const r = await complete(p);
    expect(r.json()).toMatchObject({
      outcome: 'selected',
      status: { default_org_id: created.json().id, state: 'ready' },
    });
    expect(await ownedOrgs(p.session.user.id)).toEqual([created.json().id]);
  });

  it('several owned workspaces: the person chooses once, never merged or moved', async () => {
    await resetLimits();
    const p = await h.signIn();
    const a = (await call('POST', '/v1/organizations', p, { name: 'First' })).json().id;
    const b = (await call('POST', '/v1/organizations', p, { name: 'Second' })).json().id;
    const asked = await complete(p);
    expect(asked.json()).toMatchObject({
      outcome: 'choice_required',
      status: { state: 'choose', default_org_id: null },
    });
    expect(asked.json().status.workspaces.map((w: { org_id: string }) => w.org_id)).toEqual([a, b]);
    const stranger = await h.signIn();
    const foreign = (await call('POST', '/v1/organizations', stranger, { name: 'Not yours' })).json().id;
    expect((await complete(p, { choose_org_id: foreign })).json().code).toBe('NOT_FOUND');
    const chosen = await complete(p, { choose_org_id: b });
    expect(chosen.json()).toMatchObject({ outcome: 'chosen', status: { default_org_id: b, state: 'ready' } });
    expect((await complete(p)).json().outcome).toBe('existing');
    // If the chosen one goes away (the person leaves it), a deterministic fallback, without asking again.
    await h.owner.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [
      b,
      stranger.session.user.id,
    ]);
    await h.owner.query('delete from memberships where org_id = $1 and user_id = $2', [b, p.session.user.id]);
    expect((await complete(p)).json()).toMatchObject({ outcome: 'selected', status: { default_org_id: a } });
    expect(await ownedOrgs(p.session.user.id)).toEqual([a]);
  });

  it('an invited-only person can create their own workspace explicitly; further ones share the trial clock', async () => {
    await resetLimits();
    const boss = await h.signIn();
    const team = (await complete(boss, { accept_terms_version: TERMS })).json().status.default_org_id;
    const email = `own-${Date.now()}@people.test`;
    const inv = await invite(boss, team, email);
    const p = await h.signIn({ email });
    await complete(p, { invitation_token: inv.token });
    const terms = await complete(p, { create_own: true });
    expect(terms.json().outcome).toBe('terms_required');
    const own = await complete(p, {
      create_own: true,
      accept_terms_version: TERMS,
      workspace_name: 'Side project',
    });
    expect(own.json().outcome).toBe('created');
    // The team stays the default; the new workspace is listed.
    expect(own.json().status.default_org_id).toBe(team);
    const mine = await ownedOrgs(p.session.user.id);
    expect(mine).toHaveLength(1);
    const first = await h.owner.query<{ trial_ends_at: Date }>(
      'select trial_ends_at from subscriptions where org_id = $1',
      [mine[0]],
    );
    // A second one (through the older route as well) does not start a new trial: same end date.
    const second = await call('POST', '/v1/organizations', p, { name: 'Another' });
    const shared = await h.owner.query<{ trial_ends_at: Date }>(
      'select trial_ends_at from subscriptions where org_id = $1',
      [second.json().id],
    );
    expect(shared.rows[0]?.trial_ends_at.getTime()).toBe(first.rows[0]?.trial_ends_at.getTime());
    expect((await status(p)).trial_available).toBe(false);
  });

  it('a new identity for an address whose trial ended starts restricted, not with a fresh trial', async () => {
    await resetLimits();
    const email = `again-${Date.now()}@people.test`;
    const first = await h.signIn({ email });
    const org1 = (await complete(first, { accept_terms_version: TERMS })).json().status.default_org_id;
    await h.owner.query(
      "update trial_claims set trial_ends_at = now() - interval '1 day' where org_id = $1",
      [org1],
    );
    // The same address at the provider with a new subject (the old account was deleted there).
    const second = await h.signIn({ email });
    expect(second.session.user.id).not.toBe(first.session.user.id);
    const s = await status(second);
    expect(s.trial_available).toBe(false);
    const org2 = (await complete(second, { accept_terms_version: TERMS })).json().status.default_org_id;
    const org = await call('GET', `/v1/orgs/${org2}`, second);
    expect(org.json().billing).toMatchObject({ state: 'restricted', reason: 'trial_ended' });
  });

  it('a suspended account’s address cannot start over with a new identity', async () => {
    await resetLimits();
    const email = `banned-${Date.now()}@people.test`;
    const first = await h.signIn({ email });
    await h.owner.query('update users set disabled_at = now() where id = $1', [first.session.user.id]);
    const second = await h.signIn({ email });
    const res = await complete(second, { accept_terms_version: TERMS });
    expect(res.json().code).toBe('ACCOUNT_SUSPENDED');
    expect(await ownedOrgs(second.session.user.id)).toEqual([]);
    // The disabled account itself cannot even call (sessions end with the account).
    expect((await complete(first)).statusCode).toBe(401);
  });
});

describe('boundaries', () => {
  it('customers cannot reach staff routes, and the body never names a user, role or e-mail', async () => {
    const p = await h.signIn();
    for (const url of [`/v1/support/orgs/${newId('organization')}`, '/v1/support/audit/export']) {
      expect((await call('GET', url, p)).statusCode).toBe(401);
    }
    for (const extra of [
      { user_id: p.session.user.id },
      { role: 'owner' },
      { email: 'x@y.test' },
      { org_id: 'org_x' },
    ]) {
      expect((await complete(p, extra)).json().code).toBe('VALIDATION_FAILED');
    }
  });

  it('is rate limited per person', async () => {
    const p = await h.signIn();
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) limited = (await complete(p)).statusCode === 429;
    expect(limited).toBe(true);
    await resetLimits();
  });
});
