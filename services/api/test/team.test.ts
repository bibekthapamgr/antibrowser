/**
 * R3 simple team sharing (ADR-0022): access chosen in one step with the invitation (all profiles / a folder /
 * selected profiles), previewed first; the Member preset can open and use only; folder grants follow future profiles
 * only when that rule was chosen; moving a profile that changes access needs grants.manage; and one definition of
 * effective access for listing, opening (leases) and the capability checks.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness, idemKey, internalPlan, type SignedIn } from './helpers.ts';

const BROWSER = '155.0.8059.39';
let h: Harness;
let owner: SignedIn;
const org = { id: '' };
const profiles: { id: string; name: string }[] = [];

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  who: SignedIn,
  payload?: object,
  extra: Record<string, string> = {},
) => h.app.inject({ method, url, headers: { ...who.headers, ...extra }, ...(payload ? { payload } : {}) });
const o = (path: string) => `/v1/orgs/${org.id}${path}`;

async function newProfile(name: string): Promise<string> {
  const res = await call('POST', o('/profiles'), owner, { name });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}
async function newFolder(name: string): Promise<string> {
  const res = await call('POST', o('/folders'), owner, { name });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}
const file = (who: SignedIn, profile: string, folder: string | null) =>
  call('PUT', o(`/profiles/${profile}/folder`), who, { folder_id: folder });

/** Invites someone with the given access, they sign in and accept it through onboarding. */
async function teammate(role: 'operator' | 'viewer', access?: object): Promise<SignedIn> {
  const email = `mate-${randomBytes(4).toString('hex')}@team.test`;
  const inv = await call('POST', o('/invitations'), owner, { email, role, ...(access ? { access } : {}) });
  expect(inv.statusCode, inv.body).toBe(201);
  const p = await h.signIn({ email });
  const joined = await call('POST', '/v1/onboarding/complete', p, { invitation_token: inv.json().token });
  expect(joined.json().outcome, joined.body).toBe('joined');
  return p;
}
async function visible(p: SignedIn): Promise<string[]> {
  const res = await call('GET', o('/profiles?limit=100'), p);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { id: string }[]).map((x) => x.id).sort();
}
const openLease = (p: SignedIn, profile: string) =>
  call(
    'POST',
    o(`/profiles/${profile}/leases`),
    p,
    { device_id: p.session.device.id, platform: 'windows-x64', browser_version: BROWSER },
    { 'idempotency-key': idemKey() },
  );

beforeAll(async () => {
  h = await harness();
  owner = await h.signIn();
  const res = await call('POST', '/v1/organizations', owner, { name: 'R3 team (test)' });
  org.id = res.json().id;
  await internalPlan(h.owner, org.id);
  for (let i = 1; i <= 50; i++) {
    const name = `Profile ${String(i).padStart(2, '0')}`;
    profiles.push({ id: await newProfile(name), name });
  }
});
afterAll(async () => {
  await h.close();
});

describe('sharing exactly what was chosen', () => {
  it('owner shares exactly 10 of 50 profiles; the teammate sees and opens only those 10', async () => {
    const chosen = profiles.slice(5, 15).map((p) => p.id);
    const preview = await call('POST', o('/access/preview'), owner, {
      scope: { kind: 'profiles', profile_ids: chosen },
    });
    expect(preview.json()).toMatchObject({
      profile_count: 10,
      includes_future: false,
      capabilities: ['launch'],
    });
    expect(
      preview
        .json()
        .profiles.map((p: { id: string }) => p.id)
        .sort(),
    ).toEqual([...chosen].sort());

    const mate = await teammate('operator', { scope: { kind: 'profiles', profile_ids: chosen } });
    expect(await visible(mate)).toEqual([...chosen].sort());
    // Opens one of the 10 …
    const ok = await openLease(mate, chosen[0] as string);
    expect(ok.statusCode, ok.body).toBe(201);
    // … but none of the other 40 (they do not exist for this person).
    for (const other of [profiles[0], profiles[20], profiles[49]]) {
      expect((await openLease(mate, other?.id as string)).statusCode).toBe(404);
      expect((await call('GET', o(`/profiles/${other?.id}`), mate)).statusCode).toBe(404);
    }

    // R7 integration matrix 3: the other 40 cannot be discovered by any other route either.
    const hidden = profiles.filter((p) => !chosen.includes(p.id));
    const leaks = (body: string) => hidden.filter((p) => body.includes(p.id) || body.includes(p.name));
    // Search by the exact name of an unshared profile.
    for (const p of [hidden[0], hidden[39]]) {
      const found = await call('GET', o(`/profiles?q=${encodeURIComponent(p?.name ?? '')}&limit=100`), mate);
      expect(found.statusCode).toBe(200);
      expect(leaks(found.body)).toEqual([]);
    }
    // Export: not allowed for a Member, and the refusal names nothing.
    const exported = await call('GET', o('/profiles/export'), mate);
    expect([403, 404]).toContain(exported.statusCode);
    expect(leaks(exported.body)).toEqual([]);
    // Workspace list: counts only what this person can see.
    const ws = await call('GET', '/v1/me/workspaces', mate);
    expect(ws.json().items.find((w: { org_id?: string }) => w.org_id === org.id)?.profiles).toBe(10);
    // Automation: a job aimed at an unshared profile answers like the profile does not exist.
    const job = await call(
      'POST',
      o('/automation/jobs'),
      mate,
      { profile_id: hidden[3]?.id, steps: [], keep_open_minutes: 5 },
      { 'idempotency-key': idemKey() },
    );
    expect([403, 404]).toContain(job.statusCode);
    expect(leaks(job.body)).toEqual([]);
    // An API token the Member makes (when the plan and role allow one) reaches only the same 10.
    const token = await call('POST', o('/api-tokens'), mate, {
      name: 'mine',
      scopes: ['profiles:read'],
      expires_in_days: 1,
    });
    if (token.statusCode === 201) {
      const bearer = { authorization: `Bearer ${token.json().secret}` };
      const viaToken = await h.app.inject({ method: 'GET', url: o('/profiles?limit=100'), headers: bearer });
      expect((viaToken.json().items as { id: string }[]).map((x) => x.id).sort()).toEqual([...chosen].sort());
      const one = await h.app.inject({
        method: 'GET',
        url: o(`/profiles/${hidden[7]?.id}`),
        headers: bearer,
      });
      expect(one.statusCode).toBe(404);
    } else {
      expect([403, 404]).toContain(token.statusCode);
    }
  });

  it('a Member can open and use by default, but not edit, export backups, delete, share or manage billing', async () => {
    const target = profiles[30]?.id as string;
    const mate = await teammate('operator', { scope: { kind: 'profiles', profile_ids: [target] } });
    const grants = await call('GET', o(`/grants?user_id=${mate.session.user.id}`), owner);
    expect(grants.json().items.map((g: { capabilities: string[] }) => g.capabilities)).toEqual([['launch']]);
    expect((await openLease(mate, target)).statusCode).toBe(201);
    // Edit settings, restore/export a backup, delete, invite/share, billing: all refused.
    const edit = await call('PATCH', o(`/profiles/${target}`), mate, {
      name: 'Renamed',
      expected_version: 1,
    });
    expect(edit.json()).toMatchObject({ code: 'FORBIDDEN', safe_details: { capability: 'edit' } });
    const restore = await call('POST', o(`/profiles/${target}/restore-plans`), mate, {});
    expect([403, 404]).toContain(restore.statusCode);
    expect((await call('DELETE', o(`/profiles/${target}`), mate)).json().code).toBe('FORBIDDEN');
    const share = await call('POST', o('/invitations'), mate, { email: 'x@team.test', role: 'operator' });
    expect(share.json().code).toBe('FORBIDDEN');
    expect((await call('POST', o('/billing/portal-session'), mate)).json().code).toBe('FORBIDDEN');
    expect((await call('GET', o('/billing/invoices'), mate)).json().code).toBe('FORBIDDEN');
  });

  it('a viewer invited with access sees the profiles but cannot open them', async () => {
    const target = profiles[31]?.id as string;
    const viewer = await teammate('viewer', { scope: { kind: 'profiles', profile_ids: [target] } });
    expect(await visible(viewer)).toEqual([target]);
    expect((await openLease(viewer, target)).json().code).toBe('FORBIDDEN');
    // Capabilities cannot be given to viewers.
    const bad = await call('POST', o('/invitations'), owner, {
      email: 'v2@team.test',
      role: 'viewer',
      access: { scope: { kind: 'all', include_future: true }, capabilities: ['launch'] },
    });
    expect(bad.json().code).toBe('VALIDATION_FAILED');
    // Admins reach everything: access is not chosen for them.
    const admin = await call('POST', o('/invitations'), owner, {
      email: 'a2@team.test',
      role: 'admin',
      access: { scope: { kind: 'all', include_future: true } },
    });
    expect(admin.json().code).toBe('VALIDATION_FAILED');
  });
});

describe('folders and future profiles', () => {
  it('a folder grant follows future profiles only when that rule was chosen', async () => {
    const folder = await newFolder('Shop accounts');
    const first = profiles[40]?.id as string;
    expect((await file(owner, first, folder)).statusCode).toBe(200);
    const snapshot = await call('POST', o('/access/preview'), owner, {
      scope: { kind: 'folder', folder_id: folder, include_future: false },
    });
    expect(snapshot.json()).toMatchObject({ profile_count: 1, includes_future: false });
    const rule = await call('POST', o('/access/preview'), owner, {
      scope: { kind: 'folder', folder_id: folder, include_future: true },
    });
    expect(rule.json()).toMatchObject({ profile_count: 1, includes_future: true });

    const now = await teammate('operator', {
      scope: { kind: 'folder', folder_id: folder, include_future: false },
    });
    const later = await teammate('operator', {
      scope: { kind: 'folder', folder_id: folder, include_future: true },
    });
    expect(await visible(now)).toEqual([first]);
    expect(await visible(later)).toEqual([first]);

    // A new profile filed into the folder: only the "future profiles too" teammate reaches it.
    const added = await newProfile('Shop new');
    expect((await file(owner, added, folder)).statusCode).toBe(200);
    expect(await visible(now)).toEqual([first]);
    expect(await visible(later)).toEqual([first, added].sort());
    expect((await openLease(later, added)).statusCode).toBe(201);
  });

  it('moving a profile shows who gains or loses access; without grants.manage such a move is refused', async () => {
    const folder = await newFolder('Ads accounts');
    const inside = await newProfile('Ads 1');
    await file(owner, inside, folder);
    const ruleMate = await teammate('operator', {
      scope: { kind: 'folder', folder_id: folder, include_future: true },
    });
    // An editor elsewhere: a member with the edit capability on the moved profile but no right to manage access.
    const editor = await teammate('operator', {
      scope: { kind: 'profiles', profile_ids: [inside] },
      capabilities: ['launch', 'edit'],
    });

    const impact = await call('GET', o(`/profiles/${inside}/folder-impact?folder_id=none`), owner);
    expect(impact.json()).toMatchObject({ allowed: true, gains: [] });
    expect(impact.json().losses.map((u: { user_id: string }) => u.user_id)).toEqual([
      ruleMate.session.user.id,
    ]);
    const editorView = await call('GET', o(`/profiles/${inside}/folder-impact?folder_id=none`), editor);
    expect(editorView.json().allowed).toBe(false);
    const refused = await file(editor, inside, null);
    expect(refused.json()).toMatchObject({
      code: 'FORBIDDEN',
      safe_details: { permission: 'grants.manage' },
    });
    expect(await visible(ruleMate)).toEqual([inside]);

    // A move that changes nobody's access is allowed for the editor.
    const neutral = await newFolder('Neutral');
    const other = await newProfile('Ads 2');
    await call('PUT', o(`/members/${editor.session.user.id}/access`), owner, {
      scope: { kind: 'profiles', profile_ids: [inside, other] },
      capabilities: ['launch', 'edit'],
    });
    expect((await file(editor, other, neutral)).statusCode).toBe(200);

    // The owner moves it out: the folder teammate loses it, and their open session ends.
    const lease = await openLease(ruleMate, inside);
    expect(lease.statusCode, lease.body).toBe(201);
    expect((await file(owner, inside, null)).statusCode).toBe(200);
    expect(await visible(ruleMate)).toEqual([]);
    const ended = await h.owner.query('select state from profile_leases where id = $1', [
      lease.json().lease.id,
    ]);
    expect(ended.rows[0]?.state).not.toBe('active');
  });

  it('all profiles, now and later; or only those there now', async () => {
    const all = await teammate('operator', { scope: { kind: 'all', include_future: true } });
    const nowOnly = await teammate('operator', { scope: { kind: 'all', include_future: false } });
    const before = (await visible(owner)).length;
    expect((await visible(all)).length).toBe(before);
    expect((await visible(nowOnly)).length).toBe(before);
    const added = await newProfile('Brand new');
    expect(await visible(all)).toContain(added);
    expect(await visible(nowOnly)).not.toContain(added);
  });

  it('setting a member’s access replaces it and ends sessions they may no longer hold', async () => {
    const a = profiles[44]?.id as string;
    const b = profiles[45]?.id as string;
    const mate = await teammate('operator', { scope: { kind: 'profiles', profile_ids: [a] } });
    const lease = await openLease(mate, a);
    expect(lease.statusCode).toBe(201);
    const set = await call('PUT', o(`/members/${mate.session.user.id}/access`), owner, {
      scope: { kind: 'profiles', profile_ids: [b] },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(await visible(mate)).toEqual([b]);
    const ended = await h.owner.query('select state from profile_leases where id = $1', [
      lease.json().lease.id,
    ]);
    expect(ended.rows[0]?.state).toBe('revoked');
    // Not for owners and admins.
    const own = await call('PUT', o(`/members/${owner.session.user.id}/access`), owner, {
      scope: { kind: 'all', include_future: true },
    });
    expect(own.json().code).toBe('VALIDATION_FAILED');
  });

  it('an invitation never grants a profile deleted in the meantime, and grants nothing to another workspace', async () => {
    const gone = await newProfile('Soon deleted');
    const email = `del-${randomBytes(4).toString('hex')}@team.test`;
    const inv = await call('POST', o('/invitations'), owner, {
      email,
      role: 'operator',
      access: { scope: { kind: 'profiles', profile_ids: [gone] } },
    });
    expect(
      (await call('DELETE', o(`/profiles/${gone}`), owner, undefined, { 'if-match': '"1"' })).statusCode,
    ).toBe(204);
    const p = await h.signIn({ email });
    expect(
      (await call('POST', '/v1/onboarding/complete', p, { invitation_token: inv.json().token })).json()
        .outcome,
    ).toBe('joined');
    expect(await visible(p)).toEqual([]);
    const foreign = await h.signIn();
    const theirs = (await call('POST', '/v1/organizations', foreign, { name: 'Foreign' })).json().id;
    const fp = (await call('POST', `/v1/orgs/${theirs}/profiles`, foreign, { name: 'Theirs' })).json().id;
    const cross = await call('POST', o('/invitations'), owner, {
      email: 'x2@team.test',
      role: 'operator',
      access: { scope: { kind: 'profiles', profile_ids: [fp] } },
    });
    expect(cross.json().code).toBe('NOT_FOUND');
  });
});

describe('profiles and their folder', () => {
  it('creates a profile straight into a folder, shows its folder and filters the list by folder', async () => {
    const folder = await newFolder('Created into');
    const res = await call('POST', o('/profiles'), owner, { name: 'Filed at once', folder_id: folder });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().folder_id).toBe(folder);
    const id = res.json().id as string;
    expect((await call('GET', o(`/profiles/${id}`), owner)).json().folder_id).toBe(folder);
    const inFolder = await call('GET', o(`/profiles?folder_id=${folder}`), owner);
    expect((inFolder.json().items as { id: string }[]).map((p) => p.id)).toEqual([id]);
    const none = await call('GET', o('/profiles?folder_id=none&limit=100'), owner);
    expect(
      (none.json().items as { id: string; folder_id: string | null }[]).every((p) => p.folder_id === null),
    ).toBe(true);
    expect((none.json().items as { id: string }[]).some((p) => p.id === id)).toBe(false);
    // A folder of another workspace (or none at all) is not found, and nothing is created.
    const missing = await call('POST', o('/profiles'), owner, {
      name: 'Nowhere',
      folder_id: `fld_${'0'.repeat(26)}`,
    });
    expect(missing.statusCode).toBe(404);
    const bad = await call('GET', o('/profiles?folder_id=elsewhere'), owner);
    expect(bad.statusCode).toBe(400);
  });
});
