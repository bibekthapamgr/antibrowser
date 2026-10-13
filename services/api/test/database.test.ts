/**
 * Milestone 06 database guarantees: the upgrade of milestone 01 data, least-privilege roles, row-level security on
 * every tenant table (including the new ones), an append-only audit log and definer functions reachable only by the
 * API role.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../src/fixtures.ts';
import { type Harness, harness } from './helpers.ts';
import { LEGACY } from './legacy-fixtures.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

/** Runs as the API role (pb_app) inside a rolled-back transaction with the given context. */
async function asApp<T>(
  ctx: { orgId?: string; userId?: string },
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await h.pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
      ctx.orgId ?? '',
      ctx.userId ?? '',
    ]);
    return await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

describe('upgrade of milestone 01 data (migration 0003)', () => {
  it('turns client labels into one client per folded name and the draft manager role into admin', async () => {
    const roles = await h.owner.query(
      'select user_id, role from memberships where org_id = $1 order by user_id',
      [LEGACY.org],
    );
    expect(roles.rows).toEqual([
      { user_id: LEGACY.owner, role: 'owner' },
      { user_id: LEGACY.manager, role: 'admin' },
    ]);
    const clients = await h.owner.query(
      'select id, name, name_key from clients where org_id = $1 order by name_key',
      [LEGACY.org],
    );
    expect(clients.rows.map((r) => r.name_key)).toEqual(['cafe group', 'shared client']);
    const [cafe, shared] = clients.rows;
    const profiles = await h.owner.query('select id, client_id from profiles where org_id = $1', [
      LEGACY.org,
    ]);
    const clientOf = Object.fromEntries(profiles.rows.map((r) => [r.id, r.client_id]));
    const p = LEGACY.profiles;
    expect(clientOf[p.upper]).toBe(shared.id);
    expect(clientOf[p.spaced]).toBe(shared.id);
    expect(clientOf[p.accented]).toBe(cafe.id);
    expect(clientOf[p.plain]).toBe(cafe.id);
    expect(clientOf[p.folderOnly]).toBeNull();
    const columns = await h.owner.query(
      "select column_name from information_schema.columns where table_schema = 'app' and table_name = 'profiles'",
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).not.toContain('client_label');
    expect(names).not.toContain('folder_label');
  });
});

describe('roles', () => {
  it('the API and worker roles are not superusers, cannot bypass row-level security and own nothing', async () => {
    const { rows } = await h.owner.query(
      "select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname in ('pb_app', 'pb_worker') order by rolname",
    );
    expect(rows).toEqual([
      { rolname: 'pb_app', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false },
      {
        rolname: 'pb_worker',
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      },
    ]);
    const owned = await h.owner.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and pg_get_userbyid(c.relowner) in ('pb_app', 'pb_worker')`,
    );
    expect(owned.rows).toEqual([]);
  });

  it('every table has row-level security except the outbox tables the API cannot read', async () => {
    const { rows } = await h.owner.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r' and not c.relrowsecurity order by 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual(['outbox_events', 'processed_events']);
    for (const table of ['outbox_events', 'processed_events', 'rate_limit_counters', 'used_id_tokens']) {
      await expect(asApp({}, (c) => c.query(`select * from ${table}`))).rejects.toThrow(/permission denied/);
    }
  });

  it('definer functions are callable by the API role only (maintenance by the worker only)', async () => {
    const fns = [
      'app.upsert_oidc_user(text,text,text,text,boolean,text)',
      'app.rotate_refresh_token(text,text,text,integer)',
      'app.invitation_by_token(text)',
      'app.accept_invitation(text,text)',
      'app.rate_limit_hit(text,text,integer)',
      'app.claim_id_token(text,timestamptz)',
    ];
    for (const fn of fns) {
      const { rows } = await h.owner.query(
        `select has_function_privilege('pb_app', $1, 'execute') as app,
                has_function_privilege('pb_worker', $1, 'execute') as worker,
                has_function_privilege('public', $1, 'execute') as public`,
        [fn],
      );
      expect({ fn, ...rows[0] }).toEqual({ fn, app: true, worker: false, public: false });
    }
    const purge = await h.owner.query(
      "select has_function_privilege('pb_app', 'app.purge_rate_limits(integer)', 'execute') as app",
    );
    expect(purge.rows[0].app).toBe(false);
  });
});

describe('row-level security on the milestone 06 tables', () => {
  const tables = [
    'clients',
    'invitations',
    'permission_grants',
    'audit_events',
    'devices',
    'device_sessions',
    'users',
  ];

  it('shows nothing without a context', async () => {
    for (const table of tables) {
      const { rows } = await asApp({}, (c) => c.query(`select count(*)::int as n from ${table}`));
      expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
    }
  });

  it('shows only the organization in context, and only the caller’s own devices', async () => {
    const acme = FIXTURES.orgs.acme.id;
    const owner = FIXTURES.users.acmeOwner.id;
    const result = await asApp({ orgId: acme, userId: owner }, async (c) => ({
      clients: (await c.query('select distinct org_id from clients')).rows,
      grants: (await c.query('select distinct org_id from permission_grants')).rows,
      users: (await c.query('select id from users order by id')).rows.map((r) => r.id),
      devices: (await c.query('select distinct user_id from devices')).rows,
    }));
    expect(result.clients).toEqual([{ org_id: acme }]);
    expect(result.grants).toEqual([{ org_id: acme }]);
    expect(result.users).toEqual(
      Object.values(FIXTURES.users)
        .filter((u) => u.org === 'acme')
        .map((u) => u.id)
        .sort(),
    );
    expect(result.devices).toEqual([{ user_id: owner }]);
  });

  it('keeps the audit log append-only for the API', async () => {
    const acme = FIXTURES.orgs.acme.id;
    await expect(
      asApp({ orgId: acme }, (c) => c.query("update audit_events set outcome = 'success'")),
    ).rejects.toThrow(/permission denied/);
    await expect(asApp({ orgId: acme }, (c) => c.query('delete from audit_events'))).rejects.toThrow(
      /permission denied/,
    );
    // And it cannot write entries for another organization.
    await expect(
      asApp({ orgId: acme }, (c) =>
        c.query(
          `insert into audit_events (id, org_id, action, outcome, request_id)
           values ('aud_01J9ZSEED0ZZZZ000000000000', $1, 'x.y', 'success', 'req_01J9ZSEED0ZZZZ000000000000')`,
          [FIXTURES.orgs.beta.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot create memberships in another organization (no self-invitation)', async () => {
    await expect(
      asApp({ orgId: FIXTURES.orgs.acme.id, userId: FIXTURES.users.acmeOwner.id }, (c) =>
        c.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [
          FIXTURES.orgs.beta.id,
          FIXTURES.users.acmeOwner.id,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
