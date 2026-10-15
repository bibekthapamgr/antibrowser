/**
 * Milestone 06 user journeys: create an organization, invite, accept, change roles, remove members, transfer
 * ownership. Includes the exit-gate checks for expired/used/misdirected invitations, last-owner protection and
 * revoked access taking effect at the next authorization check.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, harness, type SignedIn } from './helpers.ts';
import { nonce } from './idp.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.owner.query('delete from rate_limit_counters');
});

const call = (who: SignedIn, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  h.app.inject({ method, url, headers: who.headers, ...(payload ? { payload } : {}) });

async function newOrg(owner: SignedIn, name = 'Org') {
  const res = await call(owner, 'POST', '/v1/organizations', { name });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function invite(owner: SignedIn, orgId: string, email: string, role = 'operator') {
  const res = await call(owner, 'POST', `/v1/orgs/${orgId}/invitations`, { email, role });
  expect(res.statusCode).toBe(201);
  return res.json() as { invitation: { id: string; status: string }; token: string };
}

async function join(owner: SignedIn, orgId: string, role = 'operator'): Promise<SignedIn> {
  const member = await h.signIn();
  const { token } = await invite(owner, orgId, member.person.email, role);
  const res = await call(member, 'POST', `/v1/invitations/${token}/accept`);
  expect(res.statusCode).toBe(200);
  return member;
}

const memberVersion = async (orgId: string, userId: string) =>
  (await h.owner.query('select version from memberships where org_id = $1 and user_id = $2', [orgId, userId]))
    .rows[0]?.version as number;

describe('organizations', () => {
  it('needs a verified e-mail address to create one; the creator is the owner', async () => {
    const unverified = await h.signIn({ verified: false });
    const refused = await call(unverified, 'POST', '/v1/organizations', { name: 'Nope' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('EMAIL_NOT_VERIFIED');

    const alice = await h.signIn();
    const res = await call(alice, 'POST', '/v1/organizations', { name: '  Alice Agency  ' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Alice Agency', role: 'owner', version: 1 });
    const spaces = await call(alice, 'GET', '/v1/me/workspaces');
    expect(spaces.json().items).toEqual([
      { kind: 'organization', org_id: res.json().id, name: 'Alice Agency', role: 'owner', profiles: 0 },
    ]);
    const audit = await h.owner.query('select action from audit_events where org_id = $1', [res.json().id]);
    expect(audit.rows.map((r) => r.action)).toContain('organization.created');
  });
});

describe('invitations', () => {
  it('are single use, bound to the invited verified address, and stored only as digests', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const bob = await h.signIn();
    const carol = await h.signIn();
    const { invitation, token } = await invite(alice, orgId, bob.person.email.toUpperCase());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation.status).toBe('open');
    const stored = await h.owner.query('select email, token_hash from invitations where id = $1', [
      invitation.id,
    ]);
    expect(stored.rows[0].email).toBe(bob.person.email);
    expect(stored.rows[0].token_hash).not.toContain(token);

    const preview = await call(bob, 'GET', `/v1/invitations/${token}`);
    expect(preview.json()).toMatchObject({
      org_name: 'Org',
      role: 'operator',
      status: 'open',
      for_this_account: true,
    });
    expect((await call(carol, 'GET', `/v1/invitations/${token}`)).json().for_this_account).toBe(false);

    const wrong = await call(carol, 'POST', `/v1/invitations/${token}/accept`);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().code).toBe('INVITATION_WRONG_ACCOUNT');
    const denied = await h.owner.query(
      "select outcome, details from audit_events where action = 'invitation.accept' and request_id = $1",
      [wrong.json().request_id],
    );
    expect(denied.rows).toEqual([{ outcome: 'denied', details: { reason: 'wrong_account' } }]);

    const ok = await call(bob, 'POST', `/v1/invitations/${token}/accept`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ org_id: orgId, role: 'operator' });
    const again = await call(bob, 'POST', `/v1/invitations/${token}/accept`);
    expect(again.statusCode).toBe(410);
    expect(again.json().code).toBe('INVITATION_USED');

    // Revisiting the link after joining: the preview reports the member can continue (the portal shows a
    // friendly "already a member" confirmation rather than an error).
    const afterJoin = (await call(bob, 'GET', `/v1/invitations/${token}`)).json();
    expect(afterJoin).toMatchObject({
      org_id: orgId,
      status: 'accepted',
      for_this_account: true,
      already_member: true,
    });
    // Someone who is not the invited account and not a member still sees a plain, non-member preview.
    expect((await call(carol, 'GET', `/v1/invitations/${token}`)).json().already_member).toBe(false);

    // Joined: the workspace is listed, with no profiles until something is granted.
    const spaces = (await call(bob, 'GET', '/v1/me/workspaces')).json().items;
    expect(spaces).toEqual([
      { kind: 'organization', org_id: orgId, name: 'Org', role: 'operator', profiles: 0 },
    ]);
  });

  it('refuse an unverified address even when it matches', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const email = `unverified-${Date.now()}@people.test`;
    const bob = await h.signIn({ email, verified: false });
    const { token } = await invite(alice, orgId, email);
    const res = await call(bob, 'POST', `/v1/invitations/${token}/accept`);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('expire', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const bob = await h.signIn();
    const { invitation, token } = await invite(alice, orgId, bob.person.email);
    await h.owner.query(
      "update invitations set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1",
      [invitation.id],
    );
    const res = await call(bob, 'POST', `/v1/invitations/${token}/accept`);
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('INVITATION_EXPIRED');
    expect((await call(bob, 'GET', `/v1/invitations/${token}`)).json().status).toBe('expired');
    const list = await call(alice, 'GET', `/v1/orgs/${orgId}/invitations`);
    expect(list.json().items[0].status).toBe('expired');
  });

  it('can be withdrawn, and re-inviting the same address withdraws the earlier one', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const bob = await h.signIn();
    const first = await invite(alice, orgId, bob.person.email);
    const revoke = await call(alice, 'POST', `/v1/orgs/${orgId}/invitations/${first.invitation.id}/revoke`);
    expect(revoke.json().status).toBe('revoked');
    const res = await call(bob, 'POST', `/v1/invitations/${first.token}/accept`);
    expect(res.statusCode).toBe(410);
    expect(res.json().safe_details).toEqual({ reason: 'revoked' });

    const second = await invite(alice, orgId, bob.person.email, 'viewer');
    const third = await invite(alice, orgId, bob.person.email, 'admin');
    expect((await call(bob, 'POST', `/v1/invitations/${second.token}/accept`)).statusCode).toBe(410);
    const ok = await call(bob, 'POST', `/v1/invitations/${third.token}/accept`);
    expect(ok.json()).toEqual({ org_id: orgId, role: 'admin' });
  });

  it('refuse members, unknown tokens and the owner role', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const member = await call(alice, 'POST', `/v1/orgs/${orgId}/invitations`, {
      email: alice.person.email,
      role: 'viewer',
    });
    expect(member.json().code).toBe('ALREADY_MEMBER');
    const owner = await call(alice, 'POST', `/v1/orgs/${orgId}/invitations`, {
      email: 'x@people.test',
      role: 'owner',
    });
    expect(owner.statusCode).toBe(400);
    const unknown = await call(alice, 'POST', `/v1/invitations/${'A'.repeat(43)}/accept`);
    expect(unknown.statusCode).toBe(404);
  });

  it('are rate-limited per organization and inviter', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    let status = 0;
    for (let i = 0; i < 31 && status !== 429; i++) {
      status = (
        await call(alice, 'POST', `/v1/orgs/${orgId}/invitations`, {
          email: `r${i}@people.test`,
          role: 'viewer',
        })
      ).statusCode;
    }
    expect(status).toBe(429);
  });
});

describe('members', () => {
  it('the last owner can neither leave nor be demoted', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const leave = await call(alice, 'DELETE', `/v1/orgs/${orgId}/members/${alice.session.user.id}`);
    expect(leave.statusCode).toBe(409);
    expect(leave.json().code).toBe('LAST_OWNER');
    const demote = await call(alice, 'PATCH', `/v1/orgs/${orgId}/members/${alice.session.user.id}`, {
      role: 'admin',
      expected_version: 1,
    });
    expect(demote.json().code).toBe('LAST_OWNER');
    const { rows } = await h.owner.query('select role from memberships where org_id = $1', [orgId]);
    expect(rows).toEqual([{ role: 'owner' }]);
  });

  it('the database refuses removing the last owner even without the API', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.org_id', $1, true)", [orgId]);
      await c.query('delete from memberships where org_id = $1', [orgId]);
      await expect(c.query('commit')).rejects.toThrow(/LAST_OWNER/);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  });

  it('admins manage members but not owners', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const admin = await join(alice, orgId, 'admin');
    const viewer = await join(alice, orgId, 'viewer');
    const ownerId = alice.session.user.id;

    const demoteOwner = await call(admin, 'PATCH', `/v1/orgs/${orgId}/members/${ownerId}`, {
      role: 'viewer',
      expected_version: await memberVersion(orgId, ownerId),
    });
    expect(demoteOwner.statusCode).toBe(403);
    expect((await call(admin, 'DELETE', `/v1/orgs/${orgId}/members/${ownerId}`)).statusCode).toBe(403);

    const promote = await call(admin, 'PATCH', `/v1/orgs/${orgId}/members/${viewer.session.user.id}`, {
      role: 'operator',
      expected_version: await memberVersion(orgId, viewer.session.user.id),
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json()).toMatchObject({ role: 'operator', version: 2 });

    // Owners can change an admin's role.
    const back = await call(alice, 'PATCH', `/v1/orgs/${orgId}/members/${admin.session.user.id}`, {
      role: 'viewer',
      expected_version: await memberVersion(orgId, admin.session.user.id),
    });
    expect(back.json().role).toBe('viewer');
  });

  it('a removed member, a removed grant or a lowered role loses access at the next request', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const client = (await call(alice, 'POST', `/v1/orgs/${orgId}/clients`, { name: 'North' })).json();
    const profile = (
      await call(alice, 'POST', `/v1/orgs/${orgId}/profiles`, { name: 'p', client_id: client.id })
    ).json();
    const bob = await join(alice, orgId, 'operator');
    const url = `/v1/orgs/${orgId}/profiles/${profile.id}`;
    expect((await call(bob, 'GET', url)).statusCode).toBe(404); // nothing granted yet

    const grant = await call(alice, 'POST', `/v1/orgs/${orgId}/grants`, {
      user_id: bob.session.user.id,
      client_id: client.id,
    });
    expect(grant.statusCode).toBe(201);
    expect((await call(bob, 'GET', url)).statusCode).toBe(200);
    expect((await call(alice, 'DELETE', `/v1/orgs/${orgId}/grants/${grant.json().id}`)).statusCode).toBe(204);
    expect((await call(bob, 'GET', url)).statusCode).toBe(404);

    await call(alice, 'POST', `/v1/orgs/${orgId}/grants`, {
      user_id: bob.session.user.id,
      profile_id: profile.id,
    });
    expect((await call(bob, 'GET', url)).statusCode).toBe(200);
    const lowered = await call(alice, 'PATCH', `/v1/orgs/${orgId}/members/${bob.session.user.id}`, {
      role: 'billing',
      expected_version: await memberVersion(orgId, bob.session.user.id),
    });
    expect(lowered.statusCode).toBe(200);
    expect((await call(bob, 'GET', url)).statusCode).toBe(404);

    expect((await call(alice, 'DELETE', `/v1/orgs/${orgId}/members/${bob.session.user.id}`)).statusCode).toBe(
      204,
    );
    const gone = await call(bob, 'GET', `/v1/orgs/${orgId}`);
    expect(gone.statusCode).toBe(404);
    const grants = await h.owner.query(
      'select count(*)::int as n from permission_grants where org_id = $1 and user_id = $2',
      [orgId, bob.session.user.id],
    );
    expect(grants.rows[0].n).toBe(0);
    const audited = await h.owner.query(
      "select outcome from audit_events where action = 'org.access' and actor_user_id = $1 and target_id = $2",
      [bob.session.user.id, orgId],
    );
    expect(audited.rows).toEqual([{ outcome: 'denied' }]);
  });

  it('members can leave', async () => {
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const bob = await join(alice, orgId, 'viewer');
    expect((await call(bob, 'DELETE', `/v1/orgs/${orgId}/members/${bob.session.user.id}`)).statusCode).toBe(
      204,
    );
    expect((await call(bob, 'GET', '/v1/me/workspaces')).json().items).toEqual([]);
  });
});

describe('ownership transfer', () => {
  it('needs a recent sign-in, moves ownership and is audited', async () => {
    const now = Math.floor(Date.now() / 1000);
    const alice = await h.signIn();
    const orgId = await newOrg(alice);
    const bob = await join(alice, orgId, 'admin');

    // A session whose last real sign-in was an hour ago.
    const n = nonce();
    const stale = await h.idp.idToken({
      sub: alice.person.sub,
      nonce: n,
      email: alice.person.email,
      auth_time: now - 3600,
    });
    const old = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { grant_type: 'id_token', id_token: stale, nonce: n, device_id: alice.session.device.id },
    });
    expect(old.statusCode).toBe(200);
    const oldHeaders = { authorization: `Bearer ${old.json().access_token}` };
    const payload = {
      user_id: bob.session.user.id,
      expected_version: await memberVersion(orgId, bob.session.user.id),
    };
    const refused = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/ownership-transfer`,
      headers: oldHeaders,
      payload,
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
      safe_details: { max_age_seconds: 600 },
    });

    // Sign in again (fresh auth_time) and transfer.
    const n2 = nonce();
    const fresh = await h.idp.idToken({ sub: alice.person.sub, nonce: n2, email: alice.person.email });
    const re = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { grant_type: 'id_token', id_token: fresh, nonce: n2, device_id: alice.session.device.id },
    });
    const freshHeaders = { authorization: `Bearer ${re.json().access_token}` };
    const self = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/ownership-transfer`,
      headers: freshHeaders,
      payload: { user_id: alice.session.user.id, expected_version: 1 },
    });
    expect(self.statusCode).toBe(400);
    const stranger = await h.signIn();
    const notMember = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/ownership-transfer`,
      headers: freshHeaders,
      payload: { user_id: stranger.session.user.id, expected_version: 1 },
    });
    expect(notMember.statusCode).toBe(404);

    const ok = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/ownership-transfer`,
      headers: freshHeaders,
      payload,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ user_id: bob.session.user.id, role: 'owner' });
    const roles = await h.owner.query(
      'select user_id, role from memberships where org_id = $1 order by role',
      [orgId],
    );
    expect(roles.rows).toEqual([
      { user_id: alice.session.user.id, role: 'admin' },
      { user_id: bob.session.user.id, role: 'owner' },
    ]);
    const audit = await h.owner.query(
      "select actor_user_id, target_id, details from audit_events where action = 'organization.ownership_transferred' and org_id = $1",
      [orgId],
    );
    expect(audit.rows).toEqual([
      {
        actor_user_id: alice.session.user.id,
        target_id: bob.session.user.id,
        details: { previous_role: 'admin', from_user_id: alice.session.user.id },
      },
    ]);
    // Alice is an admin now: no second transfer.
    const again = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/ownership-transfer`,
      headers: freshHeaders,
      payload: { user_id: alice.session.user.id, expected_version: 1 },
    });
    expect(again.statusCode).toBe(403);
  });
});
