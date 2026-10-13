import { AuditEvent, Page, PageQuery } from '@pb/contracts';
import type { App, Deps } from '../app.ts';
import { ts, withTx } from '../db.ts';
import { requirePermission, resolveTenant } from '../tenancy.ts';
import { errors, OrgParams, pageOf, pageWindow } from './common.ts';

/** The organization's security audit (owners and admins), newest first. Entries are append-only. */
export function auditRoutes(app: App, deps: Deps): void {
  app.get(
    '/orgs/:orgId/audit-events',
    {
      schema: {
        tags: ['audit'],
        params: OrgParams,
        querystring: PageQuery,
        response: { 200: Page(AuditEvent), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'audit.read');
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, access, async (c) => {
        const result = await c.query<AuditEvent>(
          `select a.id, a.actor_user_id, a.actor_device_id, a.action, a.target_type, a.target_id, a.outcome,
                  a.request_id, a.details, ${ts('a.created_at')} as created_at
             from audit_events a
            where a.org_id = $1
              and ($2::timestamptz is null or (a.created_at, a.id) < ($2::timestamptz, $3::text))
            order by a.created_at desc, a.id desc limit $4`,
          [access.orgId, window.after?.k ?? null, window.after?.id ?? '', window.limit + 1],
        );
        return result.rows;
      });
      return pageOf(rows, window, (a) => ({ k: a.created_at, id: a.id }));
    },
  );
}
