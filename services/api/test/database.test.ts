/**
 * Milestone 06 database guarantees: the upgrade of milestone 01 data, least-privilege roles, row-level security on
 * every tenant table (including the new ones), an append-only audit log and definer functions reachable only by the
 * API role. Sessions run in UTC whatever the server's default time zone (CI sets a daylight-saving zone).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedWith } from '../scripts/seed.ts';
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

describe('seeding a development database first seeded in milestone 01', () => {
  it('reuses the client that migration 0003 made from a fixture profile label (other id, same name)', async () => {
    const c = await h.owner.connect();
    const acme = FIXTURES.orgs.acme.id;
    const north = FIXTURES.clients.acmeNorth;
    try {
      await c.query('begin');
      // Recreate that server state: "Client North" exists under the id the migration generated, not the fixture id.
      await c.query('update profiles set client_id = null where org_id = $1 and client_id = $2', [
        acme,
        north.id,
      ]);
      await c.query('delete from clients where org_id = $1 and id = $2', [acme, north.id]); // its grants cascade
      const { rows } = await c.query<{ id: string }>(
        `insert into clients (id, org_id, name, name_key, created_by)
         values (app.new_id('cli'), $1, $2, 'client north', $3) returning id`,
        [acme, north.name, FIXTURES.users.acmeOwner.id],
      );
      const migrated = rows[0]?.id;
      expect(migrated).toMatch(/^cli_/);
      expect(migrated).not.toBe(north.id);
      await c.query('update profiles set client_id = $2 where org_id = $1 and id = $3', [
        acme,
        migrated,
        FIXTURES.profiles.acmeShop.id,
      ]);

      await seedWith(c); // failed before with permission_grants_org_id_client_id_fkey

      const grant = await c.query('select client_id from permission_grants where id = $1', [
        FIXTURES.grants.operatorNorth.id,
      ]);
      expect(grant.rows).toEqual([{ client_id: migrated }]);
      const clients = await c.query('select id from clients where org_id = $1 and name_key = $2', [
        acme,
        'client north',
      ]);
      expect(clients.rows).toEqual([{ id: migrated }]);
      // Seeding again changes nothing.
      const count = async () =>
        (await c.query('select count(*)::int as n from clients where org_id = $1', [acme])).rows[0].n;
      const before = await count();
      await seedWith(c);
      expect(await count()).toBe(before);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('time zone', () => {
  it('runs every API session in UTC, so "30 days" is exactly 30 days even across a daylight-saving change', async () => {
    // 2026-11-01 ends daylight saving in the United States: in a zone like America/New_York this sum is 30 days and
    // one hour, which made trash periods and request expiries depend on where the database server runs.
    const { rows } = await h.pool.query(
      `select current_setting('TimeZone') as tz,
              extract(epoch from ('2026-10-14T12:00:00Z'::timestamptz + make_interval(days => 30))
                                 - '2026-10-14T12:00:00Z'::timestamptz)::int as seconds`,
    );
    expect(rows[0]).toEqual({ tz: 'UTC', seconds: 30 * 86400 });
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

  it('every table has row-level security except the outbox tables the API cannot read and the platform tables', async () => {
    const { rows } = await h.owner.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r' and not c.relrowsecurity order by 1`,
    );
    // Milestone 11: platform tables have no organization context (the plan catalog, provider events received
    // before their organization is known, staff, staff sessions, support access requests, alerts and the platform
    // audit). Only the webhook route, the worker and the staff-only support routes use them (ADR-0018).
    // Milestone 12: break-glass grants (staff), the audit chain head and recovery markers (no application access).
    // R2: the e-mail queue (the API inserts, only the worker reads, like the outbox), trial claims and pending web
    // sign-ins (reached only through security-definer functions, no grants to the application).
    // R4: contact requests from the website (the API only inserts; staff tools read them).
    // R5: the catalog (state, published prices, drafts, publications), restrictions, case notes, release requests,
    // the staff role → permission table and worker heartbeats — platform data used by the staff-only admin routes
    // (every cross-workspace reader checks the staff permission in the database too) and the public catalog.
    expect(rows.map((r) => r.relname)).toEqual([
      'account_restrictions',
      'billing_alerts',
      'billing_webhook_events',
      'break_glass_grants',
      'catalog_publications',
      'catalog_state',
      'contact_requests',
      'email_tasks',
      'outbox_events',
      'plan_drafts',
      'plan_prices',
      'plans',
      'platform_audit',
      'platform_audit_head',
      'platform_staff',
      'processed_events',
      'recovery_markers',
      'release_action_requests',
      'staff_role_permissions',
      'staff_sessions',
      'support_access_requests',
      'support_notes',
      'trial_claims',
      'web_auth_requests',
      'worker_heartbeats',
    ]);
    for (const table of [
      'outbox_events',
      'processed_events',
      'rate_limit_counters',
      'used_id_tokens',
      'platform_audit_head',
      'recovery_markers',
      'email_tasks',
      'trial_claims',
      'web_auth_requests',
      'contact_requests',
    ]) {
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
      // R2
      'app.claim_trial(text,text)',
      'app.trial_available(text)',
      'app.invitations_for_user(text)',
      'app.email_suspended(text)',
      'app.web_session_for_auth(text,integer)',
      'app.web_auth_begin(text,text,text,text)',
      'app.web_auth_take(text)',
      'app.email_task_state(text)',
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
