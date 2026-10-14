/**
 * Support staff (milestone 11, ADR-0018). Staff are not a tenant role and no API route can grant them: this command,
 * run on the server with the schema owner's credentials, is the only way to add, change or remove staff. Every change
 * is written to the platform audit.
 *
 *   node --env-file=/etc/project-browser/api.env scripts/staff.ts list
 *   node --env-file=… scripts/staff.ts add <e-mail or usr_…> --roles support[,support_lead][,billing_admin] [--note "…"]
 *   node --env-file=… scripts/staff.ts remove <e-mail or usr_…>
 *   node --env-file=… scripts/staff.ts break-glass <e-mail or usr_…> --org org_…[,org_…] --reason "…" [--minutes 30]
 *   node --env-file=… scripts/staff.ts break-glass-end <e-mail or usr_…>
 *
 * Break-glass (milestone 12, ADR-0019): emergency access for one staff member to the named organizations (1-10) for
 * at most 60 minutes, with a reason of at least 20 characters. While it lasts they see those organizations' members
 * and activity log without a second person's approval and may revoke their API tokens; every use is in the platform
 * audit, in the organization's own activity log, and raises a console alert that another billing admin reviews (the
 * holder cannot resolve it). Only this command creates it (never the API), so it needs someone with server access.
 * The person must have signed in to Project Browser once (so their account exists). Roles: `support` (find
 * organizations, billing overview, ask for sensitive access), `support_lead` (approve others' access requests, read the
 * platform audit), `billing_admin` (entitlement overrides, resync, alerts).
 */
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { STAFF_ROLES, type StaffRole } from '@pb/contracts';
import pg from 'pg';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function auditId(prefix = 'aud'): string {
  const bytes = randomBytes(16);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD.charAt(Number(value & 31n)) + out;
    value >>= 5n;
  }
  return `${prefix}_${out}`;
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

/** Who ran this command on the server (the operating-system account, and the sudo caller when there is one). */
export function serverOperator(): string {
  const os = userInfo().username;
  const sudo = process.env.SUDO_USER;
  return `server:${os}${sudo && sudo !== os ? ` (via ${sudo})` : ''}`.slice(0, 80);
}

/**
 * Break-glass (milestone 12): emergency support access to the named organizations (1-10) for 5-60 minutes, with a
 * reason. Every use is audited and alerted; someone other than the holder reviews the alerts.
 */
export async function grantBreakGlass(
  c: pg.ClientBase,
  who: string,
  orgIds: string[],
  reason: string,
  minutes: number,
  operator: string,
): Promise<{ id: string; user_id: string; expires_at: string }> {
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60) throw new Error('--minutes must be 5-60');
  if (reason.trim().length < 20) throw new Error('--reason must say why in at least 20 characters');
  const orgs = [...new Set(orgIds.map((o) => o.trim()).filter(Boolean))];
  if (orgs.length < 1 || orgs.length > 10) throw new Error('--org must name 1-10 organizations (org_…)');
  const known = await c.query<{ id: string }>('select id from app.organizations where id = any($1)', [orgs]);
  const missing = orgs.filter((o) => !known.rows.some((r) => r.id === o));
  if (missing.length) throw new Error(`no such organization: ${missing.join(', ')}`);
  const user = await findUser(c, who);
  if (!user) throw new Error('no such account');
  const staff = await c.query('select 1 from app.platform_staff where user_id = $1 and disabled_at is null', [
    user.id,
  ]);
  if (!staff.rowCount)
    throw new Error('break-glass is only for active staff (add them with staff.ts add first)');
  const id = auditId('bgg');
  const { rows } = await c.query<{ expires_at: string }>(
    `insert into app.break_glass_grants (id, user_id, org_ids, reason, granted_by, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) returning expires_at::text`,
    [id, user.id, orgs, reason.trim(), operator, minutes],
  );
  await record(c, 'staff.break_glass_granted', user.id, {
    grant: id,
    orgs,
    minutes,
    reason: reason.trim(),
    operator,
  });
  await c.query(
    `insert into app.billing_alerts (id, kind, ref, detail) values ($1, 'break_glass_used', $2, $3)
     on conflict (kind, coalesce(org_id, ''), coalesce(ref, '')) where resolved_at is null
     do update set count = app.billing_alerts.count + 1, last_seen_at = now(), detail = excluded.detail`,
    [
      auditId('alr'),
      id,
      `Break-glass access for ${user.email ?? user.id} to ${orgs.join(', ')} until ${rows[0]?.expires_at}: ${reason.trim()}`.slice(
        0,
        300,
      ),
    ],
  );
  return { id, user_id: user.id, expires_at: rows[0]?.expires_at ?? '' };
}

export async function endBreakGlass(c: pg.ClientBase, who: string, operator: string): Promise<number> {
  const user = await findUser(c, who);
  if (!user) throw new Error('no such account');
  const r = await c.query(
    `update app.break_glass_grants set revoked_at = now()
      where user_id = $1 and revoked_at is null and expires_at > now()`,
    [user.id],
  );
  await record(c, 'staff.break_glass_ended', user.id, { grants: r.rowCount ?? 0, operator });
  return r.rowCount ?? 0;
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
    } else if (command === 'break-glass' && who) {
      const g = await grantBreakGlass(
        client,
        who,
        (flag('--org') ?? '').split(','),
        flag('--reason') ?? '',
        Number(flag('--minutes') ?? '30'),
        serverOperator(),
      );
      console.log(
        `break-glass ${g.id} for ${who} until ${g.expires_at} (audited; a console alert was raised)`,
      );
    } else if (command === 'break-glass-end' && who) {
      const n = await endBreakGlass(client, who, serverOperator());
      console.log(n ? 'break-glass access ended' : 'no active break-glass access');
    } else {
      console.log(
        'usage: staff.ts list | add <e-mail|usr_id> --roles support,support_lead,billing_admin [--note "…"] | remove <e-mail|usr_id>\n' +
          '       | break-glass <e-mail|usr_id> --org org_…[,org_…] --reason "…" [--minutes 5-60]\n' +
          '       | break-glass-end <e-mail|usr_id>',
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
