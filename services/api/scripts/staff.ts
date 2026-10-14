/**
 * Support staff (milestone 11, ADR-0018). Staff are not a tenant role and no API route can grant them: this command,
 * run on the server with the schema owner's credentials, is the only way to add, change or remove staff. Every change
 * is written to the platform audit.
 *
 *   node --env-file=/etc/project-browser/api.env scripts/staff.ts list
 *   node --env-file=… scripts/staff.ts add <e-mail or usr_…> --roles support[,support_lead][,billing_admin] [--note "…"]
 *   node --env-file=… scripts/staff.ts remove <e-mail or usr_…>
 *
 * The person must have signed in to Project Browser once (so their account exists). Roles: `support` (find
 * organizations, billing overview, ask for sensitive access), `support_lead` (approve others' access requests, read the
 * platform audit), `billing_admin` (entitlement overrides, resync, alerts).
 */
import { randomBytes } from 'node:crypto';
import { STAFF_ROLES, type StaffRole } from '@pb/contracts';
import pg from 'pg';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function auditId(): string {
  const bytes = randomBytes(16);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD.charAt(Number(value & 31n)) + out;
    value >>= 5n;
  }
  return `aud_${out}`;
}

export interface StaffRow {
  user_id: string;
  email: string | null;
  display_name: string;
  roles: StaffRole[];
  disabled: boolean;
}

async function findUser(c: pg.ClientBase, who: string): Promise<{ id: string; email: string | null } | null> {
  const { rows } = await c.query<{ id: string; email: string | null }>(
    /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(who)
      ? 'select id, email from app.users where id = $1'
      : 'select id, email from app.users where lower(email) = lower($1) and email_verified order by created_at limit 2',
    [who],
  );
  if (rows.length > 1) throw new Error('several accounts use this e-mail address; give the usr_ id instead');
  return rows[0] ?? null;
}

async function record(c: pg.ClientBase, action: string, userId: string, details: object): Promise<void> {
  await c.query(
    `insert into app.platform_audit (id, actor_user_id, action, target, details)
     values ($1, null, $2, $3, $4)`,
    [auditId(), action, userId, JSON.stringify({ ...details, by: 'server_command' })],
  );
}

export async function listStaff(c: pg.ClientBase): Promise<StaffRow[]> {
  const { rows } = await c.query<StaffRow>(
    `select p.user_id, u.email, u.display_name, p.roles, p.disabled_at is not null as disabled
       from app.platform_staff p join app.users u on u.id = p.user_id order by u.email`,
  );
  return rows;
}

export async function addStaff(
  c: pg.ClientBase,
  who: string,
  roles: StaffRole[],
  note: string | null,
): Promise<StaffRow> {
  if (roles.length === 0 || roles.some((r) => !STAFF_ROLES.includes(r))) {
    throw new Error(`roles must be among ${STAFF_ROLES.join(', ')}`);
  }
  const user = await findUser(c, who);
  if (!user) throw new Error('no such account; the person must sign in to Project Browser once first');
  await c.query(
    `insert into app.platform_staff (user_id, roles, note) values ($1, $2, $3)
     on conflict (user_id) do update set roles = excluded.roles, note = excluded.note, disabled_at = null,
            updated_at = now()`,
    [user.id, [...new Set(roles)], note],
  );
  await record(c, 'staff.added', user.id, { roles });
  const row = (await listStaff(c)).find((s) => s.user_id === user.id);
  if (!row) throw new Error('not saved');
  return row;
}

/** Removal disables (the audit keeps who they were) and ends their console sessions at once. */
export async function removeStaff(c: pg.ClientBase, who: string): Promise<void> {
  const user = await findUser(c, who);
  if (!user) throw new Error('no such account');
  const r = await c.query(
    'update app.platform_staff set disabled_at = now(), updated_at = now() where user_id = $1 and disabled_at is null',
    [user.id],
  );
  if (!r.rowCount) throw new Error('this account is not active staff');
  await c.query(
    'update app.staff_sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
    [user.id],
  );
  await record(c, 'staff.removed', user.id, {});
}

if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error('MIGRATION_DATABASE_URL is required (run on the server with the API environment file)');
  const [command, who, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? (rest[i + 1] ?? '') : null;
  };
  const client = new pg.Client({ connectionString: url, options: '-c TimeZone=UTC' });
  await client.connect();
  try {
    await client.query('begin');
    if (command === 'list') {
      for (const s of await listStaff(client)) {
        console.log(
          `${s.user_id}  ${s.email ?? '-'}  ${s.roles.join(',')}${s.disabled ? '  (removed)' : ''}`,
        );
      }
    } else if (command === 'add' && who) {
      const roles = (flag('--roles') ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean) as StaffRole[];
      const s = await addStaff(client, who, roles, flag('--note'));
      console.log(`staff: ${s.email ?? s.user_id} → ${s.roles.join(', ')}`);
    } else if (command === 'remove' && who) {
      await removeStaff(client, who);
      console.log('removed; their console sessions ended');
    } else {
      console.log(
        'usage: staff.ts list | add <e-mail|usr_id> --roles support,support_lead,billing_admin [--note "…"] | remove <e-mail|usr_id>',
      );
      process.exitCode = 2;
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    console.error(`staff: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
