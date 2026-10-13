import { migrate } from '../scripts/migrate.ts';
import { seed } from '../scripts/seed.ts';
import { seedLegacy } from './legacy-fixtures.ts';

/**
 * Resets pb_test, applies the milestone 01-02 schema, loads data in that older shape (free-text client labels, the
 * draft "manager" role), then applies the remaining migrations so migration.test.ts can check the upgrade.
 */
export default async function setup(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url || !/\/pb_test(\?|$)/.test(url))
    throw new Error('Refusing to reset a database that is not pb_test');
  await migrate(url, { reset: true, log: false, until: '0002_worker_maintenance.sql' });
  await seedLegacy(url);
  await migrate(url, { log: false });
  await seed(url);
}
