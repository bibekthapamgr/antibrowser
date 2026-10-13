/** Data in the milestone 01 shape, loaded before migration 0003 runs (see global-setup.ts). */
import pg from 'pg';
import { fx } from '../src/fixtures.ts';

export const LEGACY = {
  org: fx('org', 'MGR'),
  owner: fx('usr', 'M1'),
  manager: fx('usr', 'M2'),
  profiles: {
    upper: fx('prf', 'M01'),
    spaced: fx('prf', 'M02'),
    accented: fx('prf', 'M03'),
    plain: fx('prf', 'M04'),
    folderOnly: fx('prf', 'M05'),
  },
} as const;

export async function seedLegacy(connectionString: string): Promise<void> {
  const c = new pg.Client({ connectionString, options: '-c search_path=app -c TimeZone=UTC' });
  await c.connect();
  try {
    await c.query('begin');
    await c.query("insert into organizations (id, name) values ($1, 'Legacy (fixture)')", [LEGACY.org]);
    await c.query(
      `insert into users (id, oidc_issuer, oidc_subject, display_name)
       values ($1, 'pb-dev', $1, 'Legacy Owner'), ($2, 'pb-dev', $2, 'Legacy Manager')`,
      [LEGACY.owner, LEGACY.manager],
    );
    await c.query(
      `insert into memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'manager')`,
      [LEGACY.org, LEGACY.owner, LEGACY.manager],
    );
    const p = LEGACY.profiles;
    const rows: [string, string | null, string | null][] = [
      [p.upper, 'Shared Client', null],
      [p.spaced, '  shared client ', 'Folder A'],
      [p.accented, 'Café Group', null],
      [p.plain, 'Cafe group', null],
      [p.folderOnly, null, 'Folder B'],
    ];
    for (const [id, client, folder] of rows) {
      await c.query(
        `insert into profiles (id, org_id, name, client_label, folder_label, created_by)
         values ($1, $2, $3, $4, $5, $6)`,
        [id, LEGACY.org, `legacy ${id.slice(-4)}`, client, folder, LEGACY.owner],
      );
    }
    await c.query('commit');
  } catch (err) {
    await c.query('rollback');
    throw err;
  } finally {
    await c.end();
  }
}
