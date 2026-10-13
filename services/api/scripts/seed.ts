/**
 * Seeds the two fixture tenants (milestone 01, step 3; roles, clients and grants from milestone 06). Idempotent.
 * Refused outside APP_ENV=dev|test. Runs as the schema owner (row-level security is not forced for the owner) because
 * it writes across tenants.
 */
import pg from 'pg';
import { DEV_ISSUER, FIXTURES } from '../src/fixtures.ts';
import { nameKey } from '../src/names.ts';

export async function seed(connectionString: string): Promise<void> {
  const appEnv = process.env.APP_ENV ?? 'dev';
  if (appEnv !== 'dev' && appEnv !== 'test')
    throw new Error(`Seeding fixtures is refused in APP_ENV=${appEnv}`);
  const client = new pg.Client({ connectionString, options: '-c search_path=app' });
  await client.connect();
  try {
    await client.query('begin');
    for (const org of Object.values(FIXTURES.orgs)) {
      await client.query('insert into organizations (id, name) values ($1, $2) on conflict do nothing', [
        org.id,
        org.name,
      ]);
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
    for (const c of Object.values(FIXTURES.clients)) {
      await client.query(
        `insert into clients (id, org_id, name, name_key, created_by) values ($1, $2, $3, $4, $5)
         on conflict do nothing`,
        [c.id, FIXTURES.orgs[c.org].id, c.name, nameKey(c.name), ownerOf(c.org).id],
      );
    }
    for (const profile of Object.values(FIXTURES.profiles)) {
      await client.query(
        `insert into profiles (id, org_id, name, client_id, created_by) values ($1, $2, $3, $4, $5)
         on conflict do nothing`,
        [
          profile.id,
          FIXTURES.orgs[profile.org].id,
          profile.name,
          FIXTURES.clients[profile.client].id,
          ownerOf(profile.org).id,
        ],
      );
    }
    for (const g of Object.values(FIXTURES.grants)) {
      await client.query(
        `insert into permission_grants (id, org_id, user_id, client_id, profile_id, created_by)
         values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
        [
          g.id,
          FIXTURES.orgs[g.org].id,
          FIXTURES.users[g.user].id,
          g.client ? FIXTURES.clients[g.client].id : null,
          g.profile ? FIXTURES.profiles[g.profile].id : null,
          ownerOf(g.org).id,
        ],
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
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
