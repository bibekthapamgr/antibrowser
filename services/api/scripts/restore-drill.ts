/**
 * The checking half of the restore drill (scripts/deploy/restore-drill.sh, milestone 12): run against the isolated
 * cluster restored from the off-site backups and the snapshot objects restored next to it. Prints a JSON report and
 * exits 1 unless every check passed. See src/backup/restore-check.ts for what is checked.
 *
 * Usage (as the pb user, with the API environment for the root key):
 *   node --env-file=/etc/project-browser/api.env scripts/restore-drill.ts --socket <dir> --port <n> --db <name>
 *        --objects <dir> [--marker <id>] [--orgs org_…,org_…] [--workspace org_…]
 * R6: --workspace rehearses restoring that one workspace (every profile's newest snapshot); the two-organization
 * isolation checks then run only when --orgs names two organizations.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '@pb/config/env';
import pg from 'pg';
import { localKeyProvider } from '../src/backup/keys.ts';
import { checkRestore, checkWorkspace } from '../src/backup/restore-check.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const socket = arg('--socket');
const port = Number(arg('--port') ?? '5499');
const db = arg('--db');
const objects = arg('--objects');
if (!socket || !db || !objects) throw new Error('--socket, --db and --objects are required');
const config = loadConfig();
if (!config.kms) throw new Error('KMS_LOCAL_KEY_FILE is not configured');
const kms = localKeyProvider(config.kms);

const connect = async (user: string) => {
  const c = new pg.Client({
    host: socket,
    port,
    database: db,
    user,
    options: '-c search_path=app -c TimeZone=UTC',
  });
  await c.connect();
  return c;
};
const owner = await connect('pb_owner');
const app = await connect('pb_app');
try {
  const markerId = arg('--marker');
  let marker: { id: string; created_at: string } | null = null;
  if (markerId) {
    const { rows } = await owner.query<{ id: string; created_at: string }>(
      'select id::text, created_at::text from app.recovery_markers where id = $1',
      [markerId],
    );
    marker = rows[0] ?? null;
  }
  const { rows: latest } = await owner.query<{ at: string | null }>(
    'select max(created_at)::text as at from app.recovery_markers',
  );
  const readObject = async (key: string) => {
    if (!/^[A-Za-z0-9_./-]+$/.test(key) || key.split('/').includes('..')) return null;
    try {
      return await readFile(join(objects, key));
    } catch {
      return null;
    }
  };
  const workspaceId = arg('--workspace');
  const orgs = arg('--orgs')?.split(',').filter(Boolean);
  const workspace = workspaceId ? await checkWorkspace({ owner, kms, orgId: workspaceId, readObject }) : null;
  const report =
    !workspace || (orgs && orgs.length >= 2)
      ? await checkRestore({ owner, app, kms, orgs, readObject })
      : { ok: true, tenants: [], isolation: [] };
  const ok = report.ok && (!workspace || workspace.ok) && (!markerId || marker !== null);
  console.log(
    JSON.stringify(
      {
        ...report,
        workspace,
        ok,
        marker_found: markerId ? marker !== null : null,
        latest_marker_at: latest[0]?.at ?? null,
      },
      null,
      2,
    ),
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await owner.end();
  await app.end();
}
