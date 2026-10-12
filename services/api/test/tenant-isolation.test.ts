/**
 * Exit criterion (milestone 01): wrong-tenant fixture requests fail.
 * Checked at two layers: the HTTP API (server-derived membership) and the database (row-level security).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../src/fixtures.ts';
import { ERROR_KEYS, type Harness, harness } from './helpers.ts';

const { acme, beta } = FIXTURES.orgs;
const betaProfile = FIXTURES.profiles.betaSupport.id;
const acmeProfile = FIXTURES.profiles.acmeShop.id;

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

const auth = async (user: Parameters<Harness['token']>[0]) => ({
  authorization: `Bearer ${await h.token(user)}`,
});

describe('API tenant isolation', () => {
  it('rejects unauthenticated requests with the standard error envelope', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/v1/orgs/${acme.id}/profiles` });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(ERROR_KEYS);
    expect(body.code).toBe('UNAUTHENTICATED');
    expect(body.request_id).toMatch(/^req_/);
    expect(res.headers['x-request-id']).toBe(body.request_id);
  });

  it('rejects forged tokens', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3JfeCJ9.aW52YWxpZHNpZ25hdHVyZQ' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists only the caller memberships in /me', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/me', headers: await auth('acmeOwner') });
    expect(res.statusCode).toBe(200);
    expect(res.json().memberships).toEqual([{ org_id: acme.id, org_name: acme.name, role: 'owner' }]);
  });

  it('reports another tenant as NOT_FOUND (no enumeration)', async () => {
    const headers = await auth('acmeOwner');
    const list = await h.app.inject({ method: 'GET', url: `/v1/orgs/${beta.id}/profiles`, headers });
    expect(list.statusCode).toBe(404);
    expect(list.json().code).toBe('NOT_FOUND');

    const nonexistent = await h.app.inject({
      method: 'GET',
      url: '/v1/orgs/org_01J9ZSEED0ZZZZ000000000000/profiles',
      headers,
    });
    expect(nonexistent.statusCode).toBe(404);
    expect(nonexistent.json().message).toBe(list.json().message);
  });

  it('cannot reach another tenant profile through its own org path', async () => {
    const headers = await auth('acmeOwner');
    const get = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${acme.id}/profiles/${betaProfile}`,
      headers,
    });
    expect(get.statusCode).toBe(404);

    const patch = await h.app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${acme.id}/profiles/${betaProfile}`,
      headers: { ...headers, 'if-match': '"1"' },
      payload: { name: 'hijacked' },
    });
    expect(patch.statusCode).toBe(404);

    const lease = await h.app.inject({
      method: 'POST',
      url: `/v1/orgs/${acme.id}/profiles/${betaProfile}/lease`,
      headers: { ...headers, 'idempotency-key': 'cross-tenant-0001' },
      payload: { device_id: FIXTURES.devices.acmeOwnerLaptop.id },
    });
    expect(lease.statusCode).toBe(404);

    const still = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${beta.id}/profiles/${betaProfile}`,
      headers: await auth('betaOwner'),
    });
    expect(still.json().name).toBe(FIXTURES.profiles.betaSupport.name);
  });

  it('beta owner sees only beta profiles', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/orgs/${beta.id}/profiles?limit=100`,
      headers: await auth('betaOwner'),
    });
    expect(res.statusCode).toBe(200);
    const orgs = new Set(res.json().items.map((p: { org_id: string }) => p.org_id));
    expect([...orgs]).toEqual([beta.id]);
  });
});

describe('database row-level security (defence in depth)', () => {
  const asApp = async <T>(orgId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.org_id', $1, true)", [orgId ?? '']);
      return await fn(c);
    } finally {
      await c.query('rollback');
      c.release();
    }
  };

  it('fails closed when no tenant context is set', async () => {
    const { rows } = await asApp(null, (c) => c.query('select id from profiles'));
    expect(rows).toEqual([]);
  });

  it('returns only the current tenant rows even without a WHERE clause', async () => {
    const { rows } = await asApp(acme.id, (c) => c.query<{ org_id: string }>('select org_id from profiles'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.org_id === acme.id)).toBe(true);
  });

  it('refuses writes into another tenant', async () => {
    await expect(
      asApp(acme.id, (c) =>
        c.query(
          `insert into profiles (id, org_id, name, created_by) values ('prf_01J9ZSEED0XXXX000000000000', $1, 'x', $2)`,
          [beta.id, FIXTURES.users.acmeOwner.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    const moved = await asApp(acme.id, (c) =>
      c.query('update profiles set org_id = $1 where id = $2', [beta.id, acmeProfile]).catch((e: Error) => e),
    );
    expect(moved).toBeInstanceOf(Error);
  });

  it('prevents the API role from reading the outbox', async () => {
    await expect(asApp(acme.id, (c) => c.query('select * from outbox_events'))).rejects.toThrow(
      /permission denied/,
    );
  });
});
