/**
 * Milestone 06 exit gate: organization, client, profile, member, invitation, grant and snapshot ids are swapped across
 * tenants on every endpoint, including bulk, search, export and download paths. Every swap must answer exactly like a
 * nonexistent id (same status, code and message: nothing is disclosed) and must leave the other tenant unchanged.
 * Also: pooled connections never carry one request's tenant context into the next, and same-organization references
 * are enforced by the database itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES, fx } from '../src/fixtures.ts';
import { type Harness, harness, idemKey } from './helpers.ts';
import { backup } from './sync-helpers.ts';

const { acme, beta } = FIXTURES.orgs;
const ACME = {
  org: acme.id,
  client: FIXTURES.clients.acmeNorth.id,
  profile: FIXTURES.profiles.acmeShop.id,
  user: FIXTURES.users.acmeViewer.id,
};
const MISSING = {
  org: fx('org', 'ZZZZ'),
  client: fx('cli', 'ZZZZ'),
  profile: fx('prf', 'ZZZZ'),
  user: fx('usr', 'ZZZZ'),
  invitation: fx('inv', 'ZZZZ'),
  grant: fx('grt', 'ZZZZ'),
  snapshot: fx('snp', 'ZZZZ'),
  operation: fx('syn', 'ZZZZ'),
};
type Ids = typeof MISSING;
const FOREIGN: Ids = {
  org: beta.id,
  client: FIXTURES.clients.betaInternal.id,
  profile: FIXTURES.profiles.betaSupport.id,
  user: FIXTURES.users.betaOwner.id,
  invitation: '',
  grant: '',
  snapshot: '',
  operation: '',
};

let h: Harness;
let attacker: Record<string, string>;
let betaOwner: Record<string, string>;
let acmeSnapshot = '';
let acmeOperation = '';

/** Everything the beta tenant owns, as one digest (any change anywhere changes it). */
async function betaState(): Promise<string> {
  const tables = [
    'organizations o where o.id = $1',
    'memberships o where o.org_id = $1',
    'clients o where o.org_id = $1',
    'profiles o where o.org_id = $1',
    'invitations o where o.org_id = $1',
    'permission_grants o where o.org_id = $1',
    'profile_leases o where o.org_id = $1',
    'snapshot_manifests o where o.org_id = $1',
    'sync_operations o where o.org_id = $1',
    'organization_key_versions o where o.org_id = $1',
  ];
  const parts: string[] = [];
  for (const t of tables) {
    const { rows } = await h.owner.query(
      `select coalesce(md5(string_agg(o::text, '|' order by o::text)), '-') as d from ${t}`,
      [beta.id],
    );
    parts.push(rows[0].d);
  }
  return parts.join(':');
}

const strip = (body: Record<string, unknown>) => ({ ...body, request_id: undefined });

beforeAll(async () => {
  h = await harness();
  attacker = await h.auth('acmeOwner');
  betaOwner = await h.auth('betaOwner');
  // Beta resources that only exist through the API: an invitation, a grant and a snapshot.
  FOREIGN.invitation = (
    await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${beta.id}/invitations`,
      headers: betaOwner,
      payload: { email: 'beta-invitee@people.test', role: 'viewer' },
    })
  ).json().invitation.id;
  FOREIGN.grant = (
    await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${beta.id}/grants`,
      headers: betaOwner,
      payload: { user_id: FIXTURES.users.betaOwner.id, client_id: FIXTURES.clients.betaInternal.id },
    })
  ).json().id;
  const foreign = await snapshotOf(beta.id, FOREIGN.profile, FIXTURES.devices.betaOwnerLaptop.id, betaOwner);
  FOREIGN.snapshot = foreign.snapshot;
  FOREIGN.operation = foreign.operation;
  const own = await snapshotOf(acme.id, ACME.profile, FIXTURES.devices.acmeOwnerLaptop.id, attacker);
  acmeSnapshot = own.snapshot;
  acmeOperation = own.operation;
});
afterAll(async () => {
  await h.close();
});

/** A committed snapshot (the whole device flow, see sync-helpers.ts). */
async function snapshotOf(org: string, profile: string, device: string, headers: Record<string, string>) {
  const current = await h.app.inject({ method: 'GET', url: `/v1/orgs/${org}/profiles/${profile}`, headers });
  const done = await backup(h, { headers, org, profile, device, base: current.json().snapshot_version });
  expect(done.operation.state).toBe('committed');
  return { snapshot: done.init.key.snapshot_id, operation: done.init.operation.id };
}

interface Req {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}

const commitBody = {
  fencing_token: '1',
  digest: 'd'.repeat(64),
  ciphertext_size: 10,
  plaintext_size: 10,
  parts: [{ part_number: 1, etag: 'x' }],
};

/** Every organization-scoped endpoint, addressed at organization `o` (resource ids from that organization). */
function orgEndpoints(o: string, ids: Ids): Req[] {
  const base = `/v1/orgs/${o}`;
  const p = `${base}/profiles/${ids.profile}`;
  return [
    { name: 'get organization', method: 'GET', url: base },
    { name: 'rename organization', method: 'PATCH', url: base, payload: { name: 'x', expected_version: 1 } },
    { name: 'list members', method: 'GET', url: `${base}/members` },
    {
      name: 'change member',
      method: 'PATCH',
      url: `${base}/members/${ids.user}`,
      payload: { role: 'viewer', expected_version: 1 },
    },
    { name: 'remove member', method: 'DELETE', url: `${base}/members/${ids.user}` },
    {
      name: 'transfer ownership',
      method: 'POST',
      url: `${base}/ownership-transfer`,
      payload: { user_id: ids.user, expected_version: 1 },
    },
    {
      name: 'invite',
      method: 'POST',
      url: `${base}/invitations`,
      payload: { email: 'x@people.test', role: 'viewer' },
    },
    { name: 'list invitations', method: 'GET', url: `${base}/invitations` },
    { name: 'revoke invitation', method: 'POST', url: `${base}/invitations/${ids.invitation}/revoke` },
    { name: 'list clients', method: 'GET', url: `${base}/clients` },
    { name: 'create client', method: 'POST', url: `${base}/clients`, payload: { name: 'Hijack' } },
    { name: 'get client', method: 'GET', url: `${base}/clients/${ids.client}` },
    {
      name: 'edit client',
      method: 'PATCH',
      url: `${base}/clients/${ids.client}`,
      payload: { name: 'x', expected_version: 1 },
    },
    { name: 'list grants', method: 'GET', url: `${base}/grants` },
    {
      name: 'grant client',
      method: 'POST',
      url: `${base}/grants`,
      payload: { user_id: ids.user, client_id: ids.client },
    },
    { name: 'remove grant', method: 'DELETE', url: `${base}/grants/${ids.grant}` },
    { name: 'list profiles', method: 'GET', url: `${base}/profiles` },
    { name: 'search profiles', method: 'GET', url: `${base}/profiles?q=Support&client_id=${ids.client}` },
    {
      name: 'create profile',
      method: 'POST',
      url: `${base}/profiles`,
      payload: { name: 'x', client_id: ids.client },
    },
    { name: 'export profiles', method: 'GET', url: `${base}/profiles/export` },
    {
      name: 'bulk delete',
      method: 'POST',
      url: `${base}/profiles/bulk`,
      payload: { action: 'delete', profile_ids: [ids.profile] },
    },
    { name: 'get profile', method: 'GET', url: p },
    { name: 'edit profile', method: 'PATCH', url: p, payload: { name: 'x', expected_version: 1 } },
    { name: 'delete profile', method: 'DELETE', url: p, headers: { 'if-match': '"1"' } },
    { name: 'get lease', method: 'GET', url: `${p}/lease` },
    {
      name: 'acquire lease',
      method: 'POST',
      url: `${p}/lease`,
      headers: { 'idempotency-key': idemKey() },
      payload: { device_id: FIXTURES.devices.acmeOwnerLaptop.id },
    },
    { name: 'renew lease', method: 'POST', url: `${p}/lease/renew`, payload: { fencing_token: '1' } },
    { name: 'release lease', method: 'POST', url: `${p}/lease/release`, payload: { fencing_token: '1' } },
    { name: 'list snapshots', method: 'GET', url: `${p}/snapshots` },
    {
      name: 'start snapshot upload',
      method: 'POST',
      url: `${p}/snapshots/init`,
      headers: { 'idempotency-key': idemKey() },
      payload: { base_version: 0, fencing_token: '1', platform: 'linux-x64', browser_version: '1' },
    },
    {
      name: 'part upload urls',
      method: 'POST',
      url: `${p}/snapshots/${ids.snapshot}/parts`,
      payload: { part_numbers: [1] },
    },
    { name: 'uploaded parts', method: 'GET', url: `${p}/snapshots/${ids.snapshot}/parts` },
    {
      name: 'commit snapshot',
      method: 'POST',
      url: `${p}/snapshots/${ids.snapshot}/commit`,
      payload: commitBody,
    },
    { name: 'cancel upload', method: 'POST', url: `${p}/snapshots/${ids.snapshot}/cancel` },
    { name: 'sync operation', method: 'GET', url: `${base}/sync-operations/${ids.operation}` },
    {
      name: 'restore plan',
      method: 'POST',
      url: `${p}/restore-plans`,
      payload: { snapshot_id: ids.snapshot },
    },
    { name: 'undelete profile', method: 'POST', url: `${p}/undelete` },
    { name: 'backup policy', method: 'GET', url: `${base}/backup-policy` },
    {
      name: 'change backup policy',
      method: 'PATCH',
      url: `${base}/backup-policy`,
      payload: { retention_days: 7 },
    },
    { name: 'trash', method: 'GET', url: `${base}/trash` },
    { name: 'key versions', method: 'GET', url: `${base}/keys` },
    { name: 'rotate key', method: 'POST', url: `${base}/keys/rotate` },
    { name: 'audit log', method: 'GET', url: `${base}/audit-events` },
    {
      name: 'import local workspace',
      method: 'POST',
      url: `${base}/local-import`,
      payload: { dry_run: true, clients: [{ ref: 'a', name: 'A', map_to: ids.client }], profiles: [] },
    },
  ];
}

const send = (req: Req, headers = attacker) =>
  h.app.inject({
    method: req.method,
    url: req.url,
    headers: { ...headers, ...(req.headers ?? {}) },
    ...(req.payload ? { payload: req.payload } : {}),
  });

describe('coverage', () => {
  it('the swap lists include every organization-scoped route of the API', () => {
    const spec = h.app.swagger() as { paths: Record<string, Record<string, unknown>> };
    const routes = Object.entries(spec.paths)
      .filter(([path]) => path.startsWith('/v1/orgs/'))
      .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`));
    const placeholders: Ids = {
      org: '{orgId}',
      client: '{clientId}',
      profile: '{profileId}',
      user: '{userId}',
      invitation: '{invitationId}',
      grant: '{grantId}',
      snapshot: '{snapshotId}',
      operation: '{operationId}',
    };
    const covered = new Set(
      orgEndpoints('{orgId}', placeholders).map((r) => `${r.method} ${r.url.split('?')[0]}`),
    );
    expect(routes.length).toBeGreaterThan(25);
    expect(routes.filter((r) => !covered.has(r))).toEqual([]);
  });
});

describe('another organization in the path', () => {
  const foreign = () => orgEndpoints(FOREIGN.org, FOREIGN);
  const missing = () => orgEndpoints(MISSING.org, MISSING);

  it('answers every endpoint exactly like an organization that does not exist, and changes nothing', async () => {
    const before = await betaState();
    const f = foreign();
    const m = missing();
    expect(f.length).toBeGreaterThanOrEqual(33);
    for (let i = 0; i < f.length; i++) {
      const a = await send(f[i] as Req);
      const b = await send(m[i] as Req);
      expect({ name: f[i]?.name, status: a.statusCode }).toEqual({ name: f[i]?.name, status: 404 });
      expect(strip(a.json())).toEqual(strip(b.json()));
    }
    expect(await betaState()).toBe(before);
  });
});

describe('another organization’s ids inside our own organization', () => {
  /** Endpoints of `acme` where exactly one id (of kind `kind`) is replaced. */
  const variants = (kind: keyof Ids, value: string) =>
    orgEndpoints(acme.id, {
      ...MISSING,
      ...ACME,
      invitation: MISSING.invitation,
      grant: MISSING.grant,
      snapshot: acmeSnapshot,
      operation: acmeOperation,
      [kind]: value,
    } as Ids);

  for (const kind of ['client', 'profile', 'user', 'invitation', 'grant', 'snapshot', 'operation'] as const) {
    it(`${kind} ids answer like nonexistent ids on every endpoint that takes one`, async () => {
      const before = await betaState();
      const f = variants(kind, FOREIGN[kind]);
      const m = variants(kind, MISSING[kind]);
      let compared = 0;
      for (let i = 0; i < f.length; i++) {
        const fr = f[i] as Req;
        const mr = m[i] as Req;
        if (fr.url === mr.url && JSON.stringify(fr.payload) === JSON.stringify(mr.payload)) continue; // id not used
        const a = await send(fr);
        const b = await send(mr);
        compared++;
        expect({ name: fr.name, status: a.statusCode }).toEqual({ name: fr.name, status: b.statusCode });
        if (a.statusCode >= 400) {
          expect(strip(a.json())).toEqual(strip(b.json()));
        } else {
          // Lists, searches and bulk: the same answer as for an id that does not exist (bulk echoes the ids sent).
          const normalized = (body: unknown, id: string) =>
            JSON.stringify(body)
              .replaceAll(id, '<id>')
              .replace(/"exported_at":"[^"]+"/, '');
          expect(normalized(a.json(), FOREIGN[kind])).toBe(normalized(b.json(), MISSING[kind]));
        }
      }
      expect(compared).toBeGreaterThan(0);
      expect(await betaState()).toBe(before);
    });
  }

  it('bulk, search, export and filters never return or touch the other organization', async () => {
    const bulk = await send({
      name: 'bulk',
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles/bulk`,
      payload: { action: 'set_client', client_id: null, profile_ids: [FOREIGN.profile, MISSING.profile] },
    });
    expect(bulk.json().results).toEqual([
      { id: FOREIGN.profile, outcome: 'not_found' },
      { id: MISSING.profile, outcome: 'not_found' },
    ]);
    const search = await send({
      name: 's',
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles?q=Support%20desk`,
    });
    expect(search.json().items).toEqual([]);
    const exported = await send({ name: 'e', method: 'GET', url: `/v1/orgs/${acme.id}/profiles/export` });
    expect(exported.json().profiles.length).toBeGreaterThan(0);
    expect(JSON.stringify(exported.json())).not.toContain(FOREIGN.profile);
    const filtered = await send({
      name: 'f',
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/export?client_id=${FOREIGN.client}`,
    });
    expect(filtered.json().profiles).toEqual([]);
    const grants = await send({
      name: 'g',
      method: 'GET',
      url: `/v1/orgs/${acme.id}/grants?user_id=${FOREIGN.user}`,
    });
    expect(grants.json().items).toEqual([]);
    // (The audit log is left out: it records the ids this caller sent, which disclose nothing.)
    const lists = await Promise.all(
      ['members', 'clients', 'invitations', 'grants', 'profiles'].map((r) =>
        send({ name: r, method: 'GET', url: `/v1/orgs/${acme.id}/${r}?limit=100` }),
      ),
    );
    const all = JSON.stringify(lists.map((l) => l.json()));
    for (const id of Object.values(FOREIGN)) expect(all).not.toContain(id);
  });

  it('cannot move a profile between organizations by editing it', async () => {
    const current = await send({
      name: 'g',
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/${ACME.profile}`,
    });
    const res = await send({
      name: 'move',
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}/profiles/${ACME.profile}`,
      payload: { org_id: beta.id, expected_version: current.json().version },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('pooled database connections', () => {
  it('never carry one request’s tenant into the next (one shared connection)', async () => {
    const single = await harness({ poolMax: 1 });
    try {
      const acmeHeaders = await single.auth('acmeOwner');
      const betaHeaders = await single.auth('betaOwner');
      for (let i = 0; i < 20; i++) {
        const [org, headers] = i % 2 === 0 ? [acme.id, acmeHeaders] : [beta.id, betaHeaders];
        const res = await single.app.inject({
          method: 'GET',
          url: `/v1/orgs/${org}/profiles?limit=100`,
          headers,
        });
        expect(res.statusCode).toBe(200);
        expect(new Set(res.json().items.map((p: { org_id: string }) => p.org_id))).toEqual(new Set([org]));
        // A failing request (rolled back inside its transaction) in between.
        if (i % 5 === 0) {
          const failed = await single.app.inject({
            method: 'PATCH',
            url: `/v1/orgs/${org}/profiles/${org === acme.id ? ACME.profile : FOREIGN.profile}`,
            headers,
            payload: { name: 'x', expected_version: 999 },
          });
          expect(failed.statusCode).toBe(409);
        }
        const c = await single.pool.connect();
        try {
          const { rows } = await c.query(
            "select coalesce(current_setting('app.org_id', true), '') as org, coalesce(current_setting('app.user_id', true), '') as usr, (select count(*)::int from profiles) as visible",
          );
          expect(rows[0]).toEqual({ org: '', usr: '', visible: 0 });
        } finally {
          c.release();
        }
      }
    } finally {
      await single.close();
    }
  });
});

describe('same-organization references in the database', () => {
  const asApp = async (orgId: string, sql: string, params: unknown[]) => {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.org_id', $1, true)", [orgId]);
      return await c.query(sql, params);
    } finally {
      await c.query('rollback');
      c.release();
    }
  };

  it('refuse pointing a profile at another organization’s client', async () => {
    await expect(
      asApp(acme.id, 'update profiles set client_id = $1 where id = $2', [FOREIGN.client, ACME.profile]),
    ).rejects.toThrow(/profiles_client_same_org/);
  });

  it('refuse a grant for another organization’s member, client or profile', async () => {
    const insert = `insert into permission_grants (id, org_id, user_id, client_id, profile_id, created_by)
                    values ($1, $2, $3, $4, $5, $6)`;
    const owner = FIXTURES.users.acmeOwner.id;
    await expect(
      asApp(acme.id, insert, [fx('grt', 'X1'), acme.id, FOREIGN.user, ACME.client, null, owner]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      asApp(acme.id, insert, [fx('grt', 'X2'), acme.id, ACME.user, FOREIGN.client, null, owner]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      asApp(acme.id, insert, [fx('grt', 'X3'), acme.id, ACME.user, null, FOREIGN.profile, owner]),
    ).rejects.toThrow(/foreign key/);
  });
});
