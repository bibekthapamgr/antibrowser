import { Me, ROLE_SCOPE, type Role, Workspaces } from '@pb/contracts';
import { type App, type Deps, principalOf } from '../app.ts';
import { withTx } from '../db.ts';
import { profileVisible, type TenantAccess } from '../tenancy.ts';
import { errors } from './common.ts';

export function meRoutes(app: App, deps: Deps): void {
  app.get(
    '/me',
    { config: { web: true }, schema: { tags: ['identity'], response: { 200: Me, ...errors } } },
    async (req) => {
      const { userId } = principalOf(req);
      return withTx(deps.pool, { orgId: null, userId }, async (c) => {
        const user = await c.query<{ display_name: string; email: string | null; email_verified: boolean }>(
          'select display_name, email, email_verified from users where id = $1',
          [userId],
        );
        const memberships = await c.query<{ org_id: string; org_name: string; role: Role }>(
          `select m.org_id, o.name as org_name, m.role
             from memberships m join organizations o on o.id = m.org_id
            where m.user_id = $1
            order by o.name, m.org_id
            limit 100`,
          [userId],
        );
        const u = user.rows[0];
        return {
          user_id: userId,
          display_name: u?.display_name ?? '',
          email: u?.email ?? null,
          email_verified: u?.email_verified ?? false,
          memberships: memberships.rows,
        };
      });
    },
  );

  app.get(
    '/me/workspaces',
    {
      config: { web: true },
      schema: {
        tags: ['identity'],
        description:
          'Organizations the caller belongs to, with the number of profiles they can see in each. Local workspaces ' +
          'exist only on the device and are not listed.',
        response: { 200: Workspaces, ...errors },
      },
    },
    async (req) => {
      const principal = principalOf(req);
      return withTx(deps.pool, { orgId: null, userId: principal.userId }, async (c) => {
        const { rows } = await c.query<{ org_id: string; name: string; role: Role }>(
          `select m.org_id, o.name, m.role from memberships m join organizations o on o.id = m.org_id
            where m.user_id = $1 order by o.name, m.org_id limit 100`,
          [principal.userId],
        );
        const items = [];
        for (const row of rows) {
          // Each count runs under that organization's own row-level-security context.
          await c.query("select set_config('app.org_id', $1, true)", [row.org_id]);
          const access: TenantAccess = {
            orgId: row.org_id,
            userId: principal.userId,
            deviceId: principal.deviceId,
            role: row.role,
            scope: ROLE_SCOPE[row.role],
            requestId: req.id,
          };
          const count = await c.query<{ n: number }>(
            `select count(*)::int as n from profiles p
              where p.org_id = $1 and p.deleted_at is null and ${profileVisible(access, 'p', '$2')}`,
            [row.org_id, principal.userId],
          );
          items.push({ kind: 'organization' as const, ...row, profiles: count.rows[0]?.n ?? 0 });
        }
        return { items };
      });
    },
  );
}
