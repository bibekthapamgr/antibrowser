/**
 * Seeds the two fixture tenants (milestone 01, step 3; roles, clients and grants from milestone 06). Idempotent.
 * Refused outside APP_ENV=dev|test. Runs as the schema owner (row-level security is not forced for the owner) because
 * it writes across tenants.
 */

import { defaultCapabilities, latestPlan } from '@pb/contracts';
import pg from 'pg';
import { DEV_ISSUER, FIXTURES } from '../src/fixtures.ts';
import { nameKey } from '../src/names.ts';

export async function seed(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString, options: '-c search_path=app -c TimeZone=UTC' });
  await client.connect();
  try {
    await client.query('begin');
    await seedWith(client);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

/** The seed itself, inside the caller's transaction (search_path app, schema owner). */
export async function seedWith(client: pg.ClientBase): Promise<void> {
  const appEnv = process.env.APP_ENV ?? 'dev';
  if (appEnv !== 'dev' && appEnv !== 'test')
    throw new Error(`Seeding fixtures is refused in APP_ENV=${appEnv}`);
  for (const org of Object.values(FIXTURES.orgs)) {
    await client.query('insert into organizations (id, name) values ($1, $2) on conflict do nothing', [
      org.id,
      org.name,
    ]);
  }
  // Milestone 11: fixture organizations are on the internal plan (no limits, no expiry), before members are added.
  const internal = latestPlan('internal');
  if (internal) {
    await client.query(
      `with moved as (
         update subscriptions set plan_id = $2, plan_version = $3, state = 'active', reason = 'complimentary',
                trial_ends_at = null, observed_state = 'active', updated_at = now(), version = version + 1
          where org_id = any($1::text[]) and (plan_id <> $2 or plan_version <> $3 or state <> 'active')
          returning org_id)
       insert into subscription_history (org_id, from_state, to_state, reason, plan_id, plan_version, cause)
       select org_id, null, 'active', 'complimentary', $2, $3, 'staff' from moved`,
      [Object.values(FIXTURES.orgs).map((o) => o.id), internal.id, internal.version],
    );
  }
  for (const user of Object.values(FIXTURES.users)) {
    await client.query(
      `insert into users (id, oidc_issuer, oidc_subject, display_name, email, email_verified)
         values ($1, $2, $1, $3, $4, true)
         on conflict do nothing`,
      [user.id, DEV_ISSUER, user.name, user.email],
    );
    await client.query(
      'insert into memberships (org_id, user_id, role) values ($1, $2, $3) on conflict do nothing',
      [FIXTURES.orgs[user.org].id, user.id, user.role],
    );
  }
  for (const device of Object.values(FIXTURES.devices)) {
    await client.query(
      'insert into devices (id, user_id, name, platform) values ($1, $2, $3, $4) on conflict do nothing',
      [device.id, FIXTURES.users[device.user].id, device.name, device.platform],
    );
  }
  const ownerOf = (org: 'acme' | 'beta') =>
    org === 'acme' ? FIXTURES.users.acmeOwner : FIXTURES.users.betaOwner;
  // Fixture clients are matched by organization and folded name, not by id: on a development database first seeded
  // in milestone 01, migration 0003 already turned the fixture profiles' client labels into clients with new ids.
  const clientIds = new Map<string, string>();
  for (const [key, c] of Object.entries(FIXTURES.clients)) {
    const orgId = FIXTURES.orgs[c.org].id;
    await client.query(
      `insert into clients (id, org_id, name, name_key, created_by) values ($1, $2, $3, $4, $5)
         on conflict do nothing`,
      [c.id, orgId, c.name, nameKey(c.name), ownerOf(c.org).id],
    );
    const { rows } = await client.query<{ id: string }>(
      'select id from clients where org_id = $1 and name_key = $2',
      [orgId, nameKey(c.name)],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`fixture client "${c.name}" could not be created`);
    clientIds.set(key, id);
  }
  const clientId = (key: string): string => {
    const id = clientIds.get(key);
    if (!id) throw new Error(`unknown fixture client ${key}`);
    return id;
  };
  for (const profile of Object.values(FIXTURES.profiles)) {
    await client.query(
      `insert into profiles (id, org_id, name, client_id, created_by) values ($1, $2, $3, $4, $5)
         on conflict do nothing`,
      [
        profile.id,
        FIXTURES.orgs[profile.org].id,
        profile.name,
        clientId(profile.client),
        ownerOf(profile.org).id,
      ],
    );
  }
  for (const g of Object.values(FIXTURES.grants)) {
    await client.query(
      `insert into permission_grants (id, org_id, user_id, client_id, profile_id, created_by, capabilities)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
      [
        g.id,
        FIXTURES.orgs[g.org].id,
        FIXTURES.users[g.user].id,
        g.client ? clientId(g.client) : null,
        g.profile ? FIXTURES.profiles[g.profile].id : null,
        ownerOf(g.org).id,
        defaultCapabilities(FIXTURES.users[g.user].role),
      ],
    );
  }
}

if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
  await seed(url);
  console.log(
    'seeded fixture tenants:',
    Object.values(FIXTURES.orgs)
      .map((o) => o.name)
      .join(', '),
  );
}
