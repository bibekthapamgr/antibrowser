import { migrate } from '@pb/api/migrate';
import { seed } from '@pb/api/seed';

export default async function setup(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url || !/\/pb_test(\?|$)/.test(url))
    throw new Error('Refusing to reset a database that is not pb_test');
  await migrate(url, { reset: true, log: false });
  await seed(url);
}
