/**
 * Milestone 09 at the API: client dashboards (counts never include hidden profiles), app-owned tasks, shared bookmarks
 * (http/https only), the organization extension policy, device extension reports and the inventory. People sign in
 * through the test identity provider and join an organization created for this file.
 */
import { randomBytes } from 'node:crypto';
import { type GrantCapability, newId, type Role } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness, idemKey, internalPlan, type SignedIn } from './helpers.ts';

let h: Harness;
let owner: SignedIn;
let admin: Person;
const org = { id: '' };
let north = '';
let south = '';

interface Person extends SignedIn {
  user: string;
  device: string;
}

async function member(role: Role): Promise<Person> {
  const p = await h.signIn();
  await h.owner.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [
    org.id,
    p.session.user.id,
    role,
  ]);
  return { ...p, user: p.session.user.id, device: p.session.device.id };
}

async function grant(
  p: Person,
  target: { client_id: string } | { profile_id: string },
  capabilities?: GrantCapability[],
) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${org.id}/grants`,
    headers: owner.headers,
    payload: { user_id: p.user, ...target, ...(capabilities ? { capabilities } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function newClient(name: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${org.id}/clients`,
    headers: owner.headers,
    payload: { name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

async function newProfile(client: string, name = `p-${randomBytes(4).toString('hex')}`): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${org.id}/profiles`,
    headers: owner.headers,
    payload: { name, client_id: client },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

const dashboard = (who: SignedIn, client: string) =>
  h.app.inject({
    method: 'GET',
    url: `/v1/orgs/${org.id}/clients/${client}/dashboard`,
    headers: who.headers,
  });

const tasksUrl = (client: string) => `/v1/orgs/${org.id}/clients/${client}/tasks`;
const addTask = (who: SignedIn, client: string, payload: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: tasksUrl(client), headers: who.headers, payload });
const editTask = (who: SignedIn, client: string, task: { id: string; version: number }, payload: object) =>
  h.app.inject({
    method: 'PATCH',
    url: `${tasksUrl(client)}/${task.id}`,
    headers: { ...who.headers, 'if-match': `"${task.version}"` },
    payload,
  });
const listTasks = async (who: SignedIn, client: string, query = '') => {
  const res = await h.app.inject({ method: 'GET', url: `${tasksUrl(client)}${query}`, headers: who.headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: { id: string; title: string; status: string }[]; next_cursor: string | null };
};

beforeAll(async () => {
  h = await harness();
  owner = await h.signIn();
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Agency workspace (test)' },
  });
  expect(res.statusCode, res.body).toBe(201);
  org.id = res.json().id;
  await internalPlan(h.owner, org.id);
  north = await newClient('Client North');
  south = await newClient('Client South');
  admin = await member('admin');
});
afterAll(async () => {
  await h.close();
});

describe('client dashboard', () => {
  it('counts only the profiles the caller can see and never names hidden ones', async () => {
    const client = await newClient(`Dash ${randomBytes(3).toString('hex')}`);
    const visible = await newProfile(client, 'Storefront admin');
    const hidden = await newProfile(client, 'Payroll portal (confidential)');
    await newProfile(client, 'Ads manager (confidential)');
    const op = await member('operator');
    await grant(op, { profile_id: visible });

    const mine = await dashboard(op, client);
    expect(mine.statusCode, mine.body).toBe(200);
    const d = mine.json();
    expect(d.profiles).toMatchObject({
      total: 1,
      in_use: 0,
      never_backed_up: 1,
      stale_backups: 0,
      more: false,
    });
    expect(d.profiles.items.map((p: { id: string }) => p.id)).toEqual([visible]);
    // Owners' views (who works on it, recent activity) are not shown to operators.
    expect(d.people).toBeNull();
    expect(d.activity).toBeNull();
    expect(mine.body).not.toContain('confidential');
    expect(mine.body).not.toContain(hidden);

    const all = (await dashboard(owner, client)).json();
    expect(all.profiles.total).toBe(3);
    expect(all.people).toEqual([
      expect.objectContaining({
        user_id: op.user,
        access: 'profiles',
        profiles: 1,
        capabilities: ['backup_download', 'launch'],
      }),
    ]);
    expect(all.activity.map((a: { action: string }) => a.action)).toContain('profile.created');

    // A member without any grant on the client cannot tell it exists.
    const stranger = await member('operator');
    expect((await dashboard(stranger, client)).statusCode).toBe(404);
    const viewer = await member('viewer');
    await grant(viewer, { profile_id: visible });
    expect((await dashboard(viewer, client)).json().profiles.total).toBe(1);
  });

  it('shows who has a profile open (an app session, not website activity)', async () => {
    const client = await newClient(`Open ${randomBytes(3).toString('hex')}`);
    const profile = await newProfile(client);
    await newProfile(client);
    const open = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${org.id}/profiles/${profile}/leases`,
      headers: { ...owner.headers, 'idempotency-key': idemKey() },
      payload: {
        device_id: owner.session.device.id,
        platform: 'windows-x64',
        browser_version: '155.0.8059.39',
      },
    });
    expect(open.statusCode, open.body).toBe(201);
    const d = (await dashboard(owner, client)).json();
    expect(d.profiles.in_use).toBe(1);
    expect(d.profiles.items[0]).toMatchObject({
      id: profile,
      in_use: { holder_user_id: owner.session.user.id, mine: true },
    });
    expect(d.profiles.items[0].last_opened_at).not.toBeNull();
    expect(d.profiles.items[1].last_opened_at).toBeNull();
  });
});

describe('tasks', () => {
  it('lets owners assign anyone who can see the client, and refuses anyone else', async () => {
    const op = await member('operator');
    await grant(op, { client_id: north });
    const res = await addTask(owner, north, {
      title: '  Check the  weekly‮ orders ',
      assignee_id: op.user,
      due_at: '2030-01-02T09:00:00.000Z',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers.etag).toBe('"1"');
    expect(res.json()).toMatchObject({
      title: 'Check the weekly orders',
      status: 'open',
      assignee_id: op.user,
      assignee_name: op.person.name,
      profile_id: null,
      overdue: false,
      completed_at: null,
    });
    const outsider = await member('operator');
    const refused = await addTask(owner, north, { title: 'x', assignee_id: outsider.user });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().safe_details).toMatchObject({ field: 'assignee_id' });
  });

  it('scopes tasks to what a member can see and lets them assign only themselves', async () => {
    const client = await newClient(`Tasks ${randomBytes(3).toString('hex')}`);
    const mineP = await newProfile(client);
    const otherP = await newProfile(client);
    const op = await member('operator');
    await grant(op, { profile_id: mineP });
    const peer = await member('operator');
    await grant(peer, { client_id: client });

    // Profile tasks of profiles they can see; not whole-client tasks without a client grant; never hidden profiles.
    const own = await addTask(op, client, {
      title: 'Refresh listings',
      profile_id: mineP,
      assignee_id: op.user,
    });
    expect(own.statusCode, own.body).toBe(201);
    expect((await addTask(op, client, { title: 'Whole client' })).statusCode).toBe(403);
    expect((await addTask(op, client, { title: 'Hidden', profile_id: otherP })).statusCode).toBe(404);
    const other = await addTask(op, client, { title: 'For peer', profile_id: mineP, assignee_id: peer.user });
    expect(other.statusCode).toBe(403);

    // Owner tasks: one on the hidden profile, one on the whole client, one on the whole client assigned to op
    // (they work on part of the client, so they can be assigned; they then see that task).
    await addTask(owner, client, { title: 'Secret profile task', profile_id: otherP });
    await addTask(owner, client, { title: 'Client-wide review' });
    const assigned = await addTask(owner, client, { title: 'Yours', profile_id: null, assignee_id: op.user });
    expect(assigned.statusCode, assigned.body).toBe(201);

    const seen = (await listTasks(op, client)).items.map((t) => t.title).sort();
    expect(seen).toEqual(['Refresh listings', 'Yours']);
    const peerSees = (await listTasks(peer, client)).items.map((t) => t.title).sort();
    expect(peerSees).toEqual(['Client-wide review', 'Refresh listings', 'Secret profile task', 'Yours']);
    const d = await dashboard(op, client);
    expect(d.json().tasks).toMatchObject({ open: 2, mine: 2 });
    expect(d.body).not.toContain('Secret profile task');
    expect(d.body).not.toContain('Client-wide review');

    // Someone else's task stays theirs: op may tick it off but not take it.
    const peerTask = (
      await addTask(peer, client, { title: 'Peer job', profile_id: mineP, assignee_id: peer.user })
    ).json();
    expect((await editTask(op, client, peerTask, { assignee_id: op.user })).statusCode).toBe(403);
    const ticked = await editTask(op, client, peerTask, { status: 'done' });
    expect(ticked.statusCode, ticked.body).toBe(200);
    expect(ticked.json()).toMatchObject({
      status: 'done',
      completed_by: op.user,
      assignee_id: peer.user,
      version: 2,
    });

    // Deleting: the creator or an owner/admin.
    expect(
      (
        await h.app.inject({
          method: 'DELETE',
          url: `${tasksUrl(client)}/${peerTask.id}`,
          headers: op.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'DELETE',
          url: `${tasksUrl(client)}/${peerTask.id}`,
          headers: peer.headers,
        })
      ).statusCode,
    ).toBe(204);
  });

  it('records completion as an app record with a version check, and can reopen', async () => {
    const created = (await addTask(owner, north, { title: 'Publish the March report' })).json();
    expect((await editTask(owner, north, { ...created, version: 9 }, { status: 'done' })).statusCode).toBe(
      409,
    );
    const done = await editTask(owner, north, created, { status: 'done' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().completed_at).not.toBeNull();
    const reopened = await editTask(owner, north, done.json(), {
      status: 'open',
      due_at: '2001-01-01T00:00:00.000Z',
    });
    expect(reopened.json()).toMatchObject({
      status: 'open',
      completed_at: null,
      completed_by: null,
      overdue: true,
    });
    const { rows } = await h.owner.query<{ action: string; details: { task_id?: string } }>(
      "select action, details from audit_events where org_id = $1 and action like 'task.%' order by created_at, id",
      [org.id],
    );
    const forTask = rows.filter((r) => r.details.task_id === created.id).map((r) => r.action);
    expect(forTask).toEqual(['task.created', 'task.completed', 'task.updated']);
  });

  it('pages soonest due first, keeps finished tasks apart and refuses secrets in notes', async () => {
    const client = await newClient(`Paging ${randomBytes(3).toString('hex')}`);
    for (const [title, due] of [
      ['later', '2031-01-01T00:00:00.000Z'],
      ['no date', null],
      ['soon', '2030-06-01T00:00:00.000Z'],
      ['sooner', '2030-01-01T00:00:00.000Z'],
    ] as const) {
      expect((await addTask(owner, client, { title, due_at: due })).statusCode).toBe(201);
    }
    await addTask(owner, client, { title: 'finished', status: 'done' });
    const first = await listTasks(owner, client, '?limit=2');
    expect(first.items.map((t) => t.title)).toEqual(['sooner', 'soon']);
    const next = await listTasks(
      owner,
      client,
      `?limit=2&cursor=${encodeURIComponent(first.next_cursor ?? '')}`,
    );
    expect(next.items.map((t) => t.title)).toEqual(['later', 'no date']);
    expect(next.next_cursor).toBeNull();
    expect((await listTasks(owner, client, '?status=done')).items.map((t) => t.title)).toEqual(['finished']);
    expect((await listTasks(owner, client, '?status=all')).items).toHaveLength(5);

    const secret = ['pass', 'word: ', 'x'.repeat(4), '9'.repeat(4)].join('');
    const refused = await addTask(owner, client, { title: 'Log in', notes: secret });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe('NOTE_LOOKS_SECRET');
    expect(refused.body).not.toContain(secret);
  });

  it('refuses profiles of another client, archived clients and viewers', async () => {
    const southProfile = await newProfile(south);
    const res = await addTask(owner, north, { title: 'Wrong client', profile_id: southProfile });
    expect(res.statusCode).toBe(400);
    const archived = await newClient(`Archived ${randomBytes(3).toString('hex')}`);
    const c = await h.app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${org.id}/clients/${archived}`,
      headers: owner.headers,
      payload: { archived: true, expected_version: 1 },
    });
    expect(c.statusCode, c.body).toBe(200);
    expect((await addTask(owner, archived, { title: 'x' })).statusCode).toBe(400);
    const viewer = await member('viewer');
    await grant(viewer, { client_id: north });
    expect((await addTask(viewer, north, { title: 'x' })).statusCode).toBe(403);
    expect((await listTasks(viewer, north)).items.length).toBeGreaterThan(0);
  });
});

describe('shared bookmarks', () => {
  const url = (client: string) => `/v1/orgs/${org.id}/clients/${client}/bookmarks`;
  const add = (who: SignedIn, client: string, payload: object) =>
    h.app.inject({ method: 'POST', url: url(client), headers: who.headers, payload });

  it('accepts http and https links only and cleans labels', async () => {
    const ok = await add(owner, north, {
      title: 'Orders‮ \u0007dashboard',
      url: 'https://admin.shop.example/orders',
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ title: 'Orders dashboard', url: 'https://admin.shop.example/orders' });
    for (const bad of [
      'javascript:alert(document.cookie)',
      'JavaScript://%0aalert(1)',
      'data:text/html;base64,PGI+eDwvYj4=',
      'file:///etc/passwd',
      'chrome://settings/passwords',
      'https://user:pw@shop.example/',
      'https://shop.example/a b',
    ]) {
      const res = await add(owner, north, { title: 'Bad', url: bad });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().code, bad).toBe('VALIDATION_FAILED');
    }
    const list = await h.app.inject({ method: 'GET', url: url(north), headers: owner.headers });
    expect(list.json().items.every((b: { url: string }) => /^https?:\/\//.test(b.url))).toBe(true);
  });

  it('is managed by owners and admins, read by anyone who sees the client', async () => {
    const op = await member('operator');
    await grant(op, { client_id: north });
    expect((await add(op, north, { title: 'x', url: 'https://x.example/' })).statusCode).toBe(403);
    const created = (await add(admin, north, { title: 'Help desk', url: 'https://help.example/' })).json();
    const read = await h.app.inject({ method: 'GET', url: url(north), headers: op.headers });
    expect(read.json().items.map((b: { id: string }) => b.id)).toContain(created.id);
    const edited = await h.app.inject({
      method: 'PATCH',
      url: `${url(north)}/${created.id}`,
      headers: { ...admin.headers, 'if-match': '"1"' },
      payload: { url: 'http://help.example/new', position: 3 },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ url: 'http://help.example/new', position: 3, version: 2 });
    const relinked = await h.app.inject({
      method: 'PATCH',
      url: `${url(north)}/${created.id}`,
      headers: { ...admin.headers, 'if-match': '"2"' },
      payload: { url: 'javascript:alert(1)' },
    });
    expect(relinked.statusCode).toBe(400);
    const stale = await h.app.inject({
      method: 'PATCH',
      url: `${url(north)}/${created.id}`,
      headers: { ...admin.headers, 'if-match': '"1"' },
      payload: { title: 'Old' },
    });
    expect(stale.statusCode).toBe(409);
    const gone = await h.app.inject({
      method: 'DELETE',
      url: `${url(north)}/${created.id}`,
      headers: admin.headers,
    });
    expect(gone.statusCode).toBe(204);
  });

  it(`stops at the per-client limit`, async () => {
    const client = await newClient(`Bookmarks ${randomBytes(3).toString('hex')}`);
    await h.owner.query(
      `insert into client_bookmarks (id, org_id, client_id, title, url, position, created_by)
       select 'bkm_' || lpad(upper(to_hex(n)), 26, '0'), $1, $2, 'b' || n, 'https://b.example/' || n, n, $3
         from generate_series(1, 50) n`,
      [org.id, client, owner.session.user.id],
    );
    const res = await add(owner, client, { title: 'one more', url: 'https://b.example/51' });
    expect(res.statusCode).toBe(400);
  });
});

describe('extension policy', () => {
  const ID = (c: string) => c.repeat(32);
  const policyUrl = () => `/v1/orgs/${org.id}/extension-policy`;
  const put = (who: SignedIn, version: number, body: object) =>
    h.app.inject({
      method: 'PUT',
      url: policyUrl(),
      headers: { ...who.headers, 'if-match': `"${version}"` },
      payload: body,
    });

  it('starts off and empty, is readable by members and changed by owners and admins', async () => {
    const op = await member('operator');
    const read = await h.app.inject({ method: 'GET', url: policyUrl(), headers: op.headers });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ mode: 'off', version: 1, extensions: [] });
    const body = {
      mode: 'enforce',
      extensions: [
        {
          extension_id: ID('a'),
          name: 'Grammar‮ helper',
          decision: 'allowed',
          source: 'web_store',
          approved_version_range: '>=4 <5',
          permissions: ['activeTab'],
        },
        {
          extension_id: ID('b'),
          name: 'Coupon finder',
          decision: 'blocked',
          source: 'any',
          approved_version_range: null,
          permissions: [],
        },
      ],
    };
    expect((await put(op, 1, body)).statusCode).toBe(403);
    expect((await put(admin, 7, body)).statusCode).toBe(409);
    const ok = await put(admin, 1, body);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({ mode: 'enforce', version: 2 });
    expect(ok.json().extensions.map((e: { name: string }) => e.name)).toEqual([
      'Coupon finder',
      'Grammar helper',
    ]);

    // Malformed rules are refused as a whole.
    const twice = { mode: 'warn', extensions: [body.extensions[0], body.extensions[0]] };
    expect((await put(admin, 2, twice)).statusCode).toBe(400);
    const badRange = { mode: 'warn', extensions: [{ ...body.extensions[0], approved_version_range: '^4' }] };
    expect((await put(admin, 2, badRange)).statusCode).toBe(400);
    const badId = { mode: 'warn', extensions: [{ ...body.extensions[0], extension_id: 'z'.repeat(32) }] };
    expect((await put(admin, 2, badId)).statusCode).toBe(400);
    expect(
      (await h.app.inject({ method: 'GET', url: policyUrl(), headers: op.headers })).json().version,
    ).toBe(2);
    const { rows } = await h.owner.query(
      "select details from audit_events where org_id = $1 and action = 'extension_policy.updated'",
      [org.id],
    );
    expect(rows).toEqual([{ details: { mode: 'enforce', allowed: 1, blocked: 1 } }]);
  });

  it('collects device reports into an inventory for admins', async () => {
    const client = await newClient(`Ext ${randomBytes(3).toString('hex')}`);
    const p1 = await newProfile(client);
    const p2 = await newProfile(client);
    const hidden = await newProfile(client);
    const op = await member('operator');
    await grant(op, { profile_id: p1 });
    const report = (who: Person, profile: string, device: string, extensions: object[]) =>
      h.app.inject({
        method: 'PUT',
        url: `/v1/orgs/${org.id}/profiles/${profile}/extension-report`,
        headers: who.headers,
        payload: { device_id: device, extensions },
      });
    const grammar = (version: string, permissions: string[]) => ({
      id: ID('c'),
      name: 'Grammar \u0007helper',
      version,
      source: 'web_store',
      enabled: true,
      permissions,
    });
    expect((await report(op, p1, op.device, [grammar('4.1', ['storage'])])).statusCode).toBe(204);
    // Reports replace the previous one of that device.
    expect((await report(op, p1, op.device, [grammar('4.2', ['storage', 'cookies'])])).statusCode).toBe(204);
    expect((await report(op, hidden, op.device, [])).statusCode).toBe(404);
    expect((await report(op, p1, owner.session.device.id, [])).statusCode).toBe(403);
    const ownerPerson = { ...owner, user: owner.session.user.id, device: owner.session.device.id };
    expect(
      (
        await report(ownerPerson, p2, ownerPerson.device, [
          grammar('4.2', ['storage', '<all_urls>']),
          {
            id: ID('d'),
            name: 'Dev tool',
            version: '0.1',
            source: 'unpacked',
            enabled: false,
            permissions: [],
          },
        ])
      ).statusCode,
    ).toBe(204);

    const inventoryUrl = `/v1/orgs/${org.id}/extension-inventory`;
    expect((await h.app.inject({ method: 'GET', url: inventoryUrl, headers: op.headers })).statusCode).toBe(
      403,
    );
    const inv = await h.app.inject({ method: 'GET', url: inventoryUrl, headers: admin.headers });
    expect(inv.statusCode, inv.body).toBe(200);
    const items = inv.json().items as { id: string }[];
    expect(items.find((i) => i.id === ID('c'))).toMatchObject({
      name: 'Grammar helper',
      versions: ['4.2'],
      sources: ['web_store'],
      permissions: ['<all_urls>', 'cookies', 'storage'],
      sensitive: ['<all_urls>', 'cookies'],
      profiles: 2,
      devices: 2,
    });
    expect(items.find((i) => i.id === ID('d'))).toMatchObject({ sources: ['unpacked'], profiles: 1 });
  });
});

describe('at 10,000 profiles', () => {
  it('keeps the dashboard responsive for owners and for members with a few grants', async () => {
    const client = await newClient('Large client');
    const ids = Array.from({ length: 10_000 }, () => newId('profile'));
    const user = owner.session.user.id;
    const device = owner.session.device.id;
    await h.owner.query(
      `insert into profiles (id, org_id, name, client_id, created_by)
       select id, $1, 'Profile ' || n, $2, $3 from unnest($4::text[]) with ordinality as u(id, n)`,
      [org.id, client, user, ids],
    );
    // A past session for every profile, and 30,000 audit events about them.
    await h.owner.query(
      `insert into lease_history (id, org_id, profile_id, purpose, holder_user_id, holder_device_id, fencing_token,
                                  acquired_at, ended_at, end_state)
       select $5 || lpad(n::text, 16, '0'), $1, id, 'session', $2, $3, nextval('lease_fencing_seq'),
              now() - (n || ' minutes')::interval, now() - (n || ' minutes')::interval + interval '1 minute', 'released'
         from unnest($4::text[]) with ordinality as u(id, n)`,
      [org.id, user, device, ids, 'lse_01J9ZBENCH'],
    );
    await h.owner.query(
      `insert into audit_events (id, org_id, actor_user_id, action, target_type, target_id, outcome, request_id,
                                 created_at)
       select 'aud_01J9ZBENCH' || lpad(n::text, 16, '0'), $1, $2, 'profile.updated', 'profile',
              ($3::text[])[(n % 10000) + 1], 'success', 'req_01J9ZBENCH' || lpad(n::text, 16, '0'),
              now() - (n || ' seconds')::interval
         from generate_series(1, 30000) n`,
      [org.id, user, ids],
    );
    await h.owner.query('analyze profiles, lease_history, audit_events, permission_grants');
    const op = await member('operator');
    for (const id of ids.slice(0, 5)) await grant(op, { profile_id: id });

    const time = async (who: SignedIn) => {
      const samples: number[] = [];
      for (let i = 0; i < 15; i++) {
        const start = performance.now();
        const res = await dashboard(who, client);
        samples.push(performance.now() - start);
        expect(res.statusCode, res.body).toBe(200);
      }
      samples.sort((a, b) => a - b);
      return { median: samples[7] ?? 0, p95: samples[14] ?? 0 };
    };
    const ownerView = (await dashboard(owner, client)).json();
    expect(ownerView.profiles).toMatchObject({ total: 10_000, more: true });
    expect(ownerView.profiles.items).toHaveLength(50);
    expect(ownerView.activity).toHaveLength(20);
    expect((await dashboard(op, client)).json().profiles.total).toBe(5);
    const o = await time(owner);
    const m = await time(op);
    console.log(
      `dashboard at 10,000 profiles: owner median ${o.median.toFixed(0)} ms / max ${o.p95.toFixed(0)} ms; ` +
        `operator median ${m.median.toFixed(0)} ms / max ${m.p95.toFixed(0)} ms`,
    );
    // A regression guard that also holds on shared CI runners and the small test server (1 CPU); the measured figures
    // are recorded in docs/agency/README.md.
    expect(o.median).toBeLessThan(1000);
    expect(m.median).toBeLessThan(1000);
  }, 120_000);
});
