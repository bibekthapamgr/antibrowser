/**
 * Seeds the two fixture tenants (milestone 01, step 3). Idempotent. Refused outside APP_ENV=dev|test.
 * Runs as the schema owner (row-level security is not forced for the owner) because it writes across tenants.
 */
import pg from 'pg';
import { DEV_ISSUER, FIXTURES } from '../src/fixtures.ts';

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
        `insert into users (id, oidc_issuer, oidc_subject, display_name) values ($1, $2, $1, $3)
         on conflict do nothing`,
        [user.id, DEV_ISSUER, user.name],
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
    for (const profile of Object.values(FIXTURES.profiles)) {
      const org = FIXTURES.orgs[profile.org];
      const owner = profile.org === 'acme' ? FIXTURES.users.acmeOwner : FIXTURES.users.betaOwner;
      await client.query(
        `insert into profiles (id, org_id, name, client_label, created_by) values ($1, $2, $3, $4, $5)
         on conflict do nothing`,
        [profile.id, org.id, profile.name, profile.client, owner.id],
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
