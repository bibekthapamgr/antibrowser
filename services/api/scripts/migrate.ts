/**
 * Minimal forward-only migration runner. Migrations are immutable once applied: a changed checksum aborts.
 * Usage: node scripts/migrate.ts [--reset]   (--reset is refused unless APP_ENV is dev or test)
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = join(import.meta.dirname, '../../../infra/db/migrations');

export interface MigrateOptions {
  reset?: boolean;
  log?: boolean;
  /** Stop after this migration file (tests use it to load data in an older schema, then upgrade). */
  until?: string;
}

export async function migrate(connectionString: string, opts: MigrateOptions = {}) {
  const appEnv = process.env.APP_ENV ?? 'dev';
  const client = new pg.Client({ connectionString, options: '-c TimeZone=UTC' });
  await client.connect();
  try {
    if (opts.reset) {
      if (appEnv !== 'dev' && appEnv !== 'test') throw new Error(`--reset refused in APP_ENV=${appEnv}`);
      await client.query('drop schema if exists app cascade; drop table if exists public.schema_migrations;');
    }
    await client.query(`create table if not exists public.schema_migrations (
      name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const applied = new Map(
      (
        await client.query<{ name: string; sha256: string }>(
          'select name, sha256 from public.schema_migrations',
        )
      ).rows.map((r) => [r.name, r.sha256]),
    );

    for (const file of files) {
      if (opts.until && file > opts.until) break;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);
      if (previous) {
        if (previous !== sha)
          throw new Error(`Migration ${file} changed after being applied; add a new migration`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into public.schema_migrations (name, sha256) values ($1, $2)', [
          file,
          sha,
        ]);
        await client.query('commit');
        if (opts.log !== false) console.log(`applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
  await migrate(url, { reset: process.argv.includes('--reset') });
  console.log('migrations up to date');
}
