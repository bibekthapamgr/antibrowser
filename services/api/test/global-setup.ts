import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from '../scripts/migrate.ts';
import { seed } from '../scripts/seed.ts';
import { seedLegacy } from './legacy-fixtures.ts';

/**
 * Resets pb_test, applies the milestone 01-02 schema, loads data in that older shape (free-text client labels, the
 * draft "manager" role), then applies the remaining migrations one session each, so migration.test.ts can check the
 * upgrade and no migration relies on another's session settings.
 */
export default async function setup(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url || !/\/pb_test(\?|$)/.test(url))
    throw new Error('Refusing to reset a database that is not pb_test');
  await migrate(url, { reset: true, log: false, until: '0002_worker_maintenance.sql' });
  await seedLegacy(url);
  // Every later migration in a session of its own, as when a server updates one milestone at a time: none may
  // depend on settings an earlier file left in the session (milestone 12: 0010 failed on the test server so).
  const later = readdirSync(join(import.meta.dirname, '../../../infra/db/migrations'))
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f) && f > '0002_worker_maintenance.sql')
    .sort();
  for (const until of later) await migrate(url, { log: false, until });
  await seed(url);
}
