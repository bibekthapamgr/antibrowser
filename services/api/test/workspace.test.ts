/**
 * R1 product model (ADR-0020): folders never grant access, feature settings are per workspace and versioned,
 * onboarding state is derived until recorded, capability negotiation, migration runs are idempotent per manifest,
 * and adopting a local profile twice (local-import with device_id) maps to the same workspace profile.
 */
import { createHash, randomBytes } from 'node:crypto';
import { type GrantCapability, newId, type Role } from '@pb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, harness, idemKey, internalPlan, type SignedIn } from './helpers.ts';

let h: Harness;
let owner: SignedIn;
let admin: Person;
const org = { id: '' };
let client = '';

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

async function newProfile(name = `p-${randomBytes(4).toString('hex')}`, clientId: string | null = client) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${org.id}/profiles`,
    headers: owner.headers,
    payload: { name, ...(clientId ? { client_id: clientId } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

const get = (url: string, who: SignedIn) => h.app.inject({ method: 'GET', url, headers: who.headers });
const post = (url: string, who: SignedIn, payload: object, headers: Record<string, string> = {}) =>
  h.app.inject({ method: 'POST', url, headers: { ...who.headers, ...headers }, payload });
const put = (url: string, who: SignedIn, payload: object) =>
  h.app.inject({ method: 'PUT', url, headers: who.headers, payload });

beforeAll(async () => {
  h = await harness();
  owner = await h.signIn();
  const res = await post('/v1/organizations', owner, { name: 'R1 workspace (test)' });
  expect(res.statusCode, res.body).toBe(201);
  org.id = res.json().id;
  await internalPlan(h.owner, org.id);
  const c = await post(`/v1/orgs/${org.id}/clients`, owner, { name: 'Client One' });
  client = c.json().id;
  admin = await member('admin');
});
afterAll(async () => {
  await h.close();
});

describe('capabilities and onboarding', () => {
  it('the server says what it offers; onboarding is derived from memberships until recorded', async () => {
    const caps = await get('/v1/me/capabilities', owner);
    expect(caps.statusCode).toBe(200);
    expect(caps.json()).toMatchObject({
      api: 'v1',
      features: expect.arrayContaining(['folders', 'migration_runs']),
    });

    const mine = await get('/v1/me/onboarding', owner);
    expect(mine.json()).toMatchObject({ state: 'ready', default_org_id: org.id, recorded: false });
    const nobody = await h.signIn();
    expect((await get('/v1/me/onboarding', nobody)).json()).toMatchObject({
      state: 'new',
      default_org_id: null,
      recorded: false,
    });
    // A recorded row wins (R2 writes it); only the user's own row is visible.
    await h.owner.query(
      "insert into onboarding_state (user_id, state, default_org_id, completed_at) values ($1, 'ready', $2, now())",
      [admin.user, org.id],
    );
    expect((await get('/v1/me/onboarding', admin)).json()).toMatchObject({ state: 'ready', recorded: true });
    expect((await h.pool.query('select count(*)::int as n from app.onboarding_state')).rows[0]?.n).toBe(0); // the app role sees nothing outside a user context
  });
});

describe('folders', () => {
  it('owners and admins manage folders; members only read; names are unique per workspace', async () => {
    const created = await post(`/v1/orgs/${org.id}/folders`, admin, { name: 'Shops', colour: '#336699' });
    expect(created.statusCode, created.body).toBe(201);
    const folder = created.json();
    expect(folder).toMatchObject({ name: 'Shops', colour: '#336699', profile_count: 0, version: 1 });
    expect((await post(`/v1/orgs/${org.id}/folders`, owner, { name: ' shops ' })).statusCode).toBe(409);
    const operator = await member('operator');
    expect((await post(`/v1/orgs/${org.id}/folders`, operator, { name: 'Mine' })).statusCode).toBe(403);
    expect((await get(`/v1/orgs/${org.id}/folders`, operator)).statusCode).toBe(200);

    const renamed = await h.app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${org.id}/folders/${folder.id}`,
      headers: { ...admin.headers, 'if-match': '"1"' },
      payload: { name: 'Shops EU', position: 2 },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'Shops EU', position: 2, version: 2 });
    const stale = await h.app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${org.id}/folders/${folder.id}`,
      headers: { ...admin.headers, 'if-match': '"1"' },
      payload: { archived: true },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('a folder never grants access: a profile moved into a folder stays invisible to someone without a grant on it', async () => {
    const f = (await post(`/v1/orgs/${org.id}/folders`, owner, { name: 'Folder A' })).json();
    const granted = await newProfile('granted one');
    const hidden = await newProfile('hidden one', null);
    const op = await member('operator');
    await grant(op, { profile_id: granted }, ['launch', 'edit']);
    // The operator can file the profile they may edit, not the other.
    expect(
      (await put(`/v1/orgs/${org.id}/profiles/${granted}/folder`, op, { folder_id: f.id })).statusCode,
    ).toBe(200);
    expect(
      (await put(`/v1/orgs/${org.id}/profiles/${hidden}/folder`, op, { folder_id: f.id })).statusCode,
    ).toBe(404);
    // The owner files the hidden profile into the same folder; the operator still sees only their own.
    expect(
      (await put(`/v1/orgs/${org.id}/profiles/${hidden}/folder`, owner, { folder_id: f.id })).statusCode,
    ).toBe(200);
    const byOwner = (await get(`/v1/orgs/${org.id}/folders`, owner))
      .json()
      .items.find((x: { id: string }) => x.id === f.id);
    const byOp = (await get(`/v1/orgs/${org.id}/folders`, op))
      .json()
      .items.find((x: { id: string }) => x.id === f.id);
    expect(byOwner.profile_count).toBe(2);
    expect(byOp.profile_count).toBe(1);
    expect((await get(`/v1/orgs/${org.id}/profiles/${hidden}`, op)).statusCode).toBe(404);
    // Out of the folder again; an archived folder takes no new profiles.
    expect(
      (await put(`/v1/orgs/${org.id}/profiles/${granted}/folder`, op, { folder_id: null })).statusCode,
    ).toBe(200);
    await h.app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${org.id}/folders/${f.id}`,
      headers: { ...owner.headers, 'if-match': '"1"' },
      payload: { archived: true },
    });
    expect(
      (await put(`/v1/orgs/${org.id}/profiles/${granted}/folder`, owner, { folder_id: f.id })).statusCode,
    ).toBe(404);
    // Deleting the profile removes its folder link (same-tenant foreign key), never the folder.
    await h.owner.query('delete from profiles where id = $1', [hidden]);
    expect(
      (await h.owner.query('select 1 from profile_folders where profile_id = $1', [hidden])).rowCount,
    ).toBe(0);
    expect((await h.owner.query('select 1 from folders where id = $1', [f.id])).rowCount).toBe(1);
  });
});

describe('feature settings', () => {
  it('defaults until set; versioned; owners and admins only; the unified UI switch is the rollback switch', async () => {
    const before = (await get(`/v1/orgs/${org.id}/feature-settings`, owner)).json();
    expect(before.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'ui.unified_profiles', value: false, set: false, version: null }),
        expect.objectContaining({ key: 'modules.agency', value: false, set: false }),
      ]),
    );
    const op = await member('operator');
    expect(
      (
        await put(`/v1/orgs/${org.id}/feature-settings`, op, {
          settings: [{ key: 'ui.unified_profiles', value: true }],
        })
      ).statusCode,
    ).toBe(403);
    const on = await put(`/v1/orgs/${org.id}/feature-settings`, admin, {
      settings: [{ key: 'ui.unified_profiles', value: true, expected_version: null }],
    });
    expect(on.statusCode, on.body).toBe(200);
    const row = on.json().settings.find((s: { key: string }) => s.key === 'ui.unified_profiles');
    expect(row).toMatchObject({ value: true, set: true, version: 1 });
    // A stale expected version is refused; a correct one turns it off again (rollback), data untouched.
    expect(
      (
        await put(`/v1/orgs/${org.id}/feature-settings`, admin, {
          settings: [{ key: 'ui.unified_profiles', value: false, expected_version: null }],
        })
      ).statusCode,
    ).toBe(409);
    const off = await put(`/v1/orgs/${org.id}/feature-settings`, admin, {
      settings: [{ key: 'ui.unified_profiles', value: false, expected_version: 1 }],
    });
    expect(off.json().settings.find((s: { key: string }) => s.key === 'ui.unified_profiles')).toMatchObject({
      value: false,
      version: 2,
    });
    expect(
      (
        await put(`/v1/orgs/${org.id}/feature-settings`, admin, {
          settings: [{ key: 'ui.unknown', value: true }],
        })
      ).statusCode,
    ).toBe(400);
    // Operators read the effective settings (the UI needs them) but cannot change them.
    expect((await get(`/v1/orgs/${org.id}/feature-settings`, op)).statusCode).toBe(200);
  });
});

describe('migration runs and the profile identity map', () => {
  const digest = () => createHash('sha256').update(randomBytes(16)).digest('hex');

  it('one run per (device, manifest): re-recording updates it; a completed run never restarts', async () => {
    const d = digest();
    const url = `/v1/orgs/${org.id}/migration-runs`;
    const first = await post(url, owner, {
      device_id: owner.session.device.id,
      manifest_digest: d,
      state: 'planned',
      counts: { profiles: 3 },
    });
    expect(first.statusCode, first.body).toBe(201);
    const run = first.json();
    expect(run).toMatchObject({ state: 'planned', counts: { profiles: 3 }, version: 1 });
    const running = await post(url, owner, {
      device_id: owner.session.device.id,
      manifest_digest: d,
      state: 'running',
      checkpoint: { step: 'adopt', batch: 1 },
    });
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({
      id: run.id,
      state: 'running',
      checkpoint: { step: 'adopt', batch: 1 },
      version: 2,
    });
    const done = await post(url, owner, {
      device_id: owner.session.device.id,
      manifest_digest: d,
      state: 'completed',
      counts: { profiles: 3, adopted: 2 },
    });
    expect(done.json()).toMatchObject({ state: 'completed', counts: { profiles: 3, adopted: 2 } });
    // Re-running the same manifest after completion changes nothing.
    const again = await post(url, owner, {
      device_id: owner.session.device.id,
      manifest_digest: d,
      state: 'running',
    });
    expect(again.json()).toMatchObject({ id: run.id, state: 'completed', version: 3 });
    expect((await get(`${url}/${run.id}`, owner)).json().id).toBe(run.id);
    // Another member's device cannot be recorded by this caller, and another member cannot read this run.
    expect(
      (
        await post(url, owner, {
          device_id: admin.session.device.id,
          manifest_digest: digest(),
          state: 'planned',
        })
      ).statusCode,
    ).toBe(404);
    expect((await get(`${url}/${run.id}`, admin)).statusCode).toBe(404);
    expect(
      (
        await post(url, owner, {
          device_id: owner.session.device.id,
          manifest_digest: d,
          state: 'completed',
          counts: { names: 1, 'bad key!': 2 },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('adopting the same local profiles twice from one device maps to the same workspace profiles', async () => {
    const localA = newId('profile');
    const localB = newId('profile');
    const body = {
      dry_run: false,
      device_id: owner.session.device.id,
      clients: [{ ref: 'c1', name: 'Client One' }],
      profiles: [
        { local_id: localA, name: 'Local A', client_ref: 'c1' },
        { local_id: localB, name: 'Local B' },
      ],
    };
    const url = `/v1/orgs/${org.id}/local-import`;
    const first = await post(url, owner, body, { 'idempotency-key': idemKey() });
    expect(first.statusCode, first.body).toBe(201);
    const mapA = first.json().profiles.find((p: { local_id: string }) => p.local_id === localA);
    expect(mapA.outcome).toBe('create');
    expect(first.json().clients[0].outcome).toBe('existing'); // matched Client One by name
    const map = await h.owner.query(
      'select local_profile_id, cloud_profile_id from profile_identity_map where org_id = $1 and device_id = $2 order by 1',
      [org.id, owner.session.device.id],
    );
    expect(map.rowCount).toBe(2);

    // Later (another idempotency key, e.g. a new migration run after a reinstall): the same local ids map to the
    // existing workspace profiles; nothing new is created.
    const before = (
      await h.owner.query('select count(*)::int as n from profiles where org_id = $1', [org.id])
    ).rows[0]?.n;
    const second = await post(
      url,
      owner,
      { ...body, profiles: [...body.profiles, { local_id: newId('profile'), name: 'Local C' }] },
      { 'idempotency-key': idemKey() },
    );
    expect(second.statusCode, second.body).toBe(201);
    const outcomes = Object.fromEntries(
      second
        .json()
        .profiles.map((p: { local_id: string; outcome: string; profile_id: string }) => [p.local_id, p]),
    );
    expect(outcomes[localA]).toMatchObject({ outcome: 'existing', profile_id: mapA.profile_id });
    expect(outcomes[localB].outcome).toBe('existing');
    const after = (await h.owner.query('select count(*)::int as n from profiles where org_id = $1', [org.id]))
      .rows[0]?.n;
    expect(after).toBe(before + 1);
    // A dry run sees the mapping too, and a device of another person is refused.
    const dry = await post(url, owner, { ...body, dry_run: true });
    expect(dry.json().profiles.every((p: { outcome: string }) => p.outcome === 'existing')).toBe(true);
    expect(
      (await post(url, owner, { ...body, dry_run: true, device_id: admin.session.device.id })).statusCode,
    ).toBe(404);
    // Without a device id the old behaviour stands: every profile is a new copy (no mapping is written).
    const legacy = await post(url, owner, { ...body, device_id: undefined, dry_run: true });
    expect(legacy.json().profiles.every((p: { outcome: string }) => p.outcome === 'create')).toBe(true);
  });

  it('a deleted workspace profile frees its mapping', async () => {
    const local = newId('profile');
    const url = `/v1/orgs/${org.id}/local-import`;
    const res = await post(
      url,
      owner,
      {
        dry_run: false,
        device_id: owner.session.device.id,
        clients: [],
        profiles: [{ local_id: local, name: 'Gone' }],
      },
      { 'idempotency-key': idemKey() },
    );
    const cloud = res.json().profiles[0].profile_id;
    await h.owner.query('delete from profiles where id = $1', [cloud]);
    expect(
      (await h.owner.query('select 1 from profile_identity_map where local_profile_id = $1', [local]))
        .rowCount,
    ).toBe(0);
  });
});
