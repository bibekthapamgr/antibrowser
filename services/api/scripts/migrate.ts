/**
 * Minimal forward-only migration runner. Migrations are immutable once applied: a changed checksum aborts.
 * Usage: node scripts/migrate.ts [--reset]   (--reset is refused unless APP_ENV is dev or test)
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLAN_CATALOG } from '@pb/contracts';
import pg from 'pg';

const MIGRATIONS_DIR = join(import.meta.dirname, '../../../infra/db/migrations');

export interface MigrateOptions {
  reset?: boolean;
  log?: boolean;
  /** Stop after this migration file (tests use it to load data in an older schema, then upgrade). */
  until?: string;
  /** Another folder of migrations (tests: a failing migration, milestone 12). */
  dir?: string;
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

    const dir = opts.dir ?? MIGRATIONS_DIR;
    const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const applied = new Map(
      (
        await client.query<{ name: string; sha256: string }>(
          'select name, sha256 from public.schema_migrations',
        )
      ).rows.map((r) => [r.name, r.sha256]),
    );

    for (const file of files) {
      if (opts.until && file > opts.until) break;
      const sql = await readFile(join(dir, file), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);
      if (previous) {
        if (previous !== sha)
          throw new Error(`Migration ${file} changed after being applied; add a new migration`);
        continue;
      }
      // Each migration starts from the same settings, whatever ran before it in this session: the app schema first
      // (0001 creates it). A server that updates one milestone at a time must get the same result as a fresh one.
      await client.query('set search_path = app, public');
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
    await syncCatalog(client, opts.log !== false);
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

/** Key-order-independent JSON for comparing catalog rows. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/**
 * Milestone 11 (ADR-0018): the plan catalog in packages/contracts is the source of truth. Missing plan versions are
 * added; a released version that differs from the file stops here (versions are immutable: add a new one). Then any
 * organization without a subscription (created before billing existed) is put on the newest `beta` version, which
 * does not end. Runs after the migrations, once the plans table exists.
 */
export async function syncCatalog(client: pg.Client, log = true): Promise<void> {
  const exists = await client.query("select to_regclass('app.plans') is not null as ok");
  if (!exists.rows[0]?.ok) return;
  await client.query('begin');
  try {
    let added = 0;
    for (const p of PLAN_CATALOG) {
      const row = {
        name: p.name,
        description: p.description,
        purchasable: p.purchasable,
        trial_days: p.trialDays,
        limits: p.limits,
        features: p.features,
      };
      const { rows } = await client.query<typeof row>(
        `select name, description, purchasable, trial_days, limits, features from app.plans
          where id = $1 and version = $2`,
        [p.id, p.version],
      );
      const current = rows[0];
      if (!current) {
        await client.query(
          `insert into app.plans (id, version, name, description, purchasable, trial_days, limits, features)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [p.id, p.version, p.name, p.description, p.purchasable, p.trialDays, p.limits, p.features],
        );
        added++;
      } else if (canonical(current) !== canonical(row)) {
        throw new Error(
          `Plan ${p.id}@${p.version} differs from the database; released plan versions are immutable — add a new version`,
        );
      }
    }
    const beta = PLAN_CATALOG.filter((p) => p.id === 'beta').sort((a, b) => b.version - a.version)[0];
    let backfilled = 0;
    if (beta) {
      const r = await client.query(
        `with missing as (
           insert into app.subscriptions (org_id, plan_id, plan_version, state, reason, observed_state)
           select o.id, $1, $2, 'active', 'complimentary', 'active' from app.organizations o
            where not exists (select 1 from app.subscriptions s where s.org_id = o.id)
           returning org_id)
         insert into app.subscription_history (org_id, from_state, to_state, reason, plan_id, plan_version, cause)
         select org_id, null, 'active', 'complimentary', $1, $2, 'migration' from missing`,
        [beta.id, beta.version],
      );
      backfilled = r.rowCount ?? 0;
    }
    await client.query('commit');
    if (log && (added || backfilled)) {
      console.log(`plan catalog: ${added} plan version(s) added, ${backfilled} organization(s) put on beta`);
    }
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}
