import { loadConfig } from '@pb/config/env';
import pg from 'pg';
import { devToken } from '../scripts/dev-token.ts';
import { type App, buildApp } from '../src/app.ts';
import { createPool } from '../src/db.ts';
import { FIXTURES, type FixtureUserKey } from '../src/fixtures.ts';

export interface Harness {
  app: App;
  pool: pg.Pool;
  owner: pg.Pool;
  token: (user: FixtureUserKey) => Promise<string>;
  close: () => Promise<void>;
}

export async function harness(): Promise<Harness> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 20);
  const owner = new pg.Pool({
    connectionString: process.env.MIGRATION_DATABASE_URL,
    options: '-c search_path=app',
    max: 2,
  });
  const app = await buildApp(config, pool, { logger: false });
  await app.ready();
  const secret = config.devAuth.enabled ? config.devAuth.secret : '';
  return {
    app,
    pool,
    owner,
    token: (user) => devToken(secret, FIXTURES.users[user].id),
    close: async () => {
      await app.close();
      await pool.end();
      await owner.end();
    },
  };
}

export const ERROR_KEYS = ['code', 'message', 'request_id', 'retryable', 'safe_details'].sort();
