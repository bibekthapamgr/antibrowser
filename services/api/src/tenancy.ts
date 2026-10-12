import { ApiError, isId, type Permission, type Role, roleAllows } from '@pb/contracts';
import type pg from 'pg';
import { withTx } from './db.ts';

export interface TenantAccess {
  orgId: string;
  userId: string;
  role: Role;
}

/**
 * Tenant membership is always derived on the server from the authenticated principal.
 * An org_id supplied by the client is only a lookup key: if the caller is not a member, the org is
 * reported as NOT_FOUND so tenants cannot be enumerated.
 */
export async function resolveTenant(pool: pg.Pool, userId: string, orgId: string): Promise<TenantAccess> {
  if (!isId('organization', orgId)) throw new ApiError('NOT_FOUND', 'Organization not found');
  const { rows } = await withTx(pool, { orgId, userId }, (c) =>
    c.query<{ role: Role }>('select role from memberships where org_id = $1 and user_id = $2', [
      orgId,
      userId,
    ]),
  );
  const role = rows[0]?.role;
  if (!role) throw new ApiError('NOT_FOUND', 'Organization not found');
  return { orgId, userId, role };
}

export function requirePermission(access: TenantAccess, permission: Permission): void {
  if (!roleAllows(access.role, permission)) {
    throw new ApiError('FORBIDDEN', 'Your role does not allow this action', { permission });
  }
}
