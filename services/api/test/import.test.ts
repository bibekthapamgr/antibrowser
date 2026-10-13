/** Milestone 06 step 8: moving a local workspace into an organization through an explicit preview and mapping. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fx } from '../src/fixtures.ts';
import { type Harness, harness, idemKey, type SignedIn } from './helpers.ts';

let h: Harness;
let alice: SignedIn;
let orgId: string;
let existingClient: string;
beforeAll(async () => {
  h = await harness();
  alice = await h.signIn();
  orgId = (
    await h.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: alice.headers,
      payload: { name: 'Import' },
    })
  ).json().id;
  existingClient = (
    await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${orgId}/clients`,
      headers: alice.headers,
      payload: { name: 'Café North' },
    })
  ).json().id;
});
afterAll(async () => {
  await h.close();
});

const body = (dryRun: boolean) => ({
  dry_run: dryRun,
  clients: [
    { ref: 'north', name: 'cafe north' }, // matches the existing client by folded name
    { ref: 'south', name: 'South', colour: '#00aa00' },
    { ref: 'south-dup', name: ' SOUTH ' }, // same new client as "south"
    { ref: 'mapped', name: 'Old name', map_to: '' },
  ],
  profiles: [
    { local_id: fx('prf', 'D1'), name: 'Shop', client_ref: 'north', notes: 'n' },
    { local_id: fx('prf', 'D2'), name: 'Ads', client_ref: 'south' },
    { local_id: fx('prf', 'D3'), name: 'Mapped', client_ref: 'mapped' },
    { local_id: fx('prf', 'D4'), name: 'No client' },
  ],
});

const crockford = (n: number): string => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  do {
    out = alphabet[n % 32] + out;
    n = Math.floor(n / 32);
  } while (n > 0);
  return out.padStart(16, '0');
};

const run = (payload: object, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/orgs/${orgId}/local-import`,
    headers: { ...alice.headers, ...headers },
    payload,
  });

describe('local workspace import', () => {
  it('previews without changing anything, then commits the same plan atomically and idempotently', async () => {
    const b = body(true);
    (b.clients[3] as { map_to: string }).map_to = existingClient;
    const count = async () =>
      (await h.owner.query('select count(*)::int as n from profiles where org_id = $1', [orgId])).rows[0].n;

    const preview = await run(b);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      dry_run: true,
      clients: [
        { ref: 'north', client_id: existingClient, outcome: 'existing' },
        { ref: 'south', client_id: null, outcome: 'create' },
        { ref: 'south-dup', client_id: null, outcome: 'existing' },
        { ref: 'mapped', client_id: existingClient, outcome: 'mapped' },
      ],
      profiles: b.profiles.map((p) => ({ local_id: p.local_id, profile_id: null, outcome: 'create' })),
    });
    expect(await count()).toBe(0);

    const missingKey = await run({ ...b, dry_run: false });
    expect(missingKey.statusCode).toBe(428);

    const key = idemKey();
    const real = await run({ ...b, dry_run: false }, { 'idempotency-key': key });
    expect(real.statusCode).toBe(201);
    const result = real.json();
    const south = result.clients[1].client_id;
    expect(south).toMatch(/^cli_/);
    expect(result.clients[2].client_id).toBe(south);
    for (const p of result.profiles) {
      expect(p.profile_id).toMatch(/^prf_/);
      expect(p.profile_id).not.toBe(p.local_id);
    }
    expect(await count()).toBe(4);
    const profiles = await h.owner.query(
      'select name, client_id, notes from profiles where org_id = $1 order by name',
      [orgId],
    );
    expect(profiles.rows).toEqual([
      { name: 'Ads', client_id: south, notes: '' },
      { name: 'Mapped', client_id: existingClient, notes: '' },
      { name: 'No client', client_id: null, notes: '' },
      { name: 'Shop', client_id: existingClient, notes: 'n' },
    ]);

    const replay = await run({ ...b, dry_run: false }, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(result);
    expect(await count()).toBe(4);
    const audit = await h.owner.query(
      "select details from audit_events where org_id = $1 and action = 'workspace.imported'",
      [orgId],
    );
    expect(audit.rows).toEqual([{ details: { clients_created: 1, profiles_created: 4 } }]);
  });

  it('refuses unknown client refs, repeated ids and roles that cannot create', async () => {
    const bad = await run({
      dry_run: true,
      clients: [],
      profiles: [{ local_id: fx('prf', 'D9'), name: 'x', client_ref: 'nope' }],
    });
    expect(bad.statusCode).toBe(400);
    const repeated = await run({
      dry_run: true,
      clients: [],
      profiles: [
        { local_id: fx('prf', 'D9'), name: 'x' },
        { local_id: fx('prf', 'D9'), name: 'y' },
      ],
    });
    expect(repeated.statusCode).toBe(400);

    const viewer = await h.app.inject({
      method: 'POST',
      url: '/v1/orgs/org_01J9ZSEED0ACME000000000000/local-import',
      headers: await h.auth('acmeViewer'),
      payload: { dry_run: true, clients: [], profiles: [] },
    });
    expect(viewer.statusCode).toBe(403);
  });

  it('accepts a 10,000-profile workspace in one request', async () => {
    const profiles = Array.from({ length: 10_000 }, (_, i) => ({
      local_id: `prf_01J9ZSEED0${crockford(i)}`,
      name: `Imported ${i}`,
      client_ref: 'bulk',
    }));
    const res = await run(
      { dry_run: false, clients: [{ ref: 'bulk', name: 'Bulk client' }], profiles },
      { 'idempotency-key': idemKey() },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().profiles).toHaveLength(10_000);
  }, 60_000);
});
