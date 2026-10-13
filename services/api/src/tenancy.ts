/**
 * Authorization (milestone 06): role permissions combined with client/profile grants, deny by default.
 *
 * 1. Tenant: membership is always derived on the server from the authenticated principal. An org id from the client
 *    is only a lookup key; a non-member gets the same NOT_FOUND as for an organization that does not exist.
 * 2. Permission: the member's role must allow the operation (ROLE_PERMISSIONS), else FORBIDDEN.
 * 3. Scope: operators and viewers reach only granted clients/profiles (ROLE_SCOPE); anything outside their scope is
 *    reported exactly like a nonexistent id (NOT_FOUND), so ids of other clients or tenants disclose nothing.
 * PostgreSQL row-level security enforces step 1 again underneath (app.org_id is set per transaction).
 */
import {
  ApiError,
  isId,
  PERMISSION_CAPABILITY,
  type Permission,
  type ResourceScope,
  ROLE_SCOPE,
  type Role,
  roleAllows,
} from '@pb/contracts';
import type pg from 'pg';
import { auditAlone } from './audit.ts';
import type { Principal } from './auth.ts';
import { withTx } from './db.ts';

export interface TenantAccess {
  orgId: string;
  userId: string;
  deviceId: string | null;
  role: Role;
  scope: ResourceScope;
  requestId: string;
}

export interface RequestInfo {
  id: string;
  principal: Principal | null;
  tenant?: TenantAccess | null;
}

export async function resolveTenant(pool: pg.Pool, req: RequestInfo, orgId: string): Promise<TenantAccess> {
  const principal = req.principal;
  if (!principal) throw new ApiError('UNAUTHENTICATED', 'Authentication required');
  const notFound = new ApiError('NOT_FOUND', 'Organization not found');
  if (!isId('organization', orgId)) throw notFound;
  const { rows } = await withTx(pool, { orgId, userId: principal.userId }, (c) =>
    c.query<{ role: Role }>('select role from memberships where org_id = $1 and user_id = $2', [
      orgId,
      principal.userId,
    ]),
  );
  const role = rows[0]?.role;
  if (!role) {
    await auditAlone(pool, {
      orgId: null,
      actorUserId: principal.userId,
      actorDeviceId: principal.deviceId,
      action: 'org.access',
      targetType: 'organization',
      targetId: orgId,
      outcome: 'denied',
      requestId: req.id,
    });
    throw notFound;
  }
  const access: TenantAccess = {
    orgId,
    userId: principal.userId,
    deviceId: principal.deviceId,
    role,
    scope: ROLE_SCOPE[role],
    requestId: req.id,
  };
  req.tenant = access;
  return access;
}

export function requirePermission(access: TenantAccess, permission: Permission): void {
  if (!roleAllows(access.role, permission)) {
    throw new ApiError('FORBIDDEN', 'Your role does not allow this action', { permission });
  }
}

/**
 * SQL condition: the profile row `p` is inside the member's scope. `userParam` is the placeholder holding the user id.
 * A client grant covers every profile of that client; a profile grant covers one profile.
 */
export function profileVisible(access: TenantAccess, p: string, userParam: string): string {
  // Every branch references the user parameter so callers can always bind it.
  switch (access.scope) {
    case 'organization':
      return `(${userParam}::text is not null)`;
    case 'none':
      return `(${userParam}::text is null)`;
    case 'granted':
      return `exists (select 1 from permission_grants g
                       where g.org_id = ${p}.org_id and g.user_id = ${userParam}
                         and (g.profile_id = ${p}.id or (g.client_id is not null and g.client_id = ${p}.client_id)))`;
  }
}

/** SQL condition: the client row `c` is inside the member's scope (granted directly, or one of its profiles is). */
export function clientVisible(access: TenantAccess, c: string, userParam: string): string {
  switch (access.scope) {
    case 'organization':
      return `(${userParam}::text is not null)`;
    case 'none':
      return `(${userParam}::text is null)`;
    case 'granted':
      return `exists (select 1 from permission_grants g
                       where g.org_id = ${c}.org_id and g.user_id = ${userParam}
                         and (g.client_id = ${c}.id
                              or g.profile_id in (select pp.id from profiles pp
                                                   where pp.org_id = ${c}.org_id and pp.client_id = ${c}.id
                                                     and pp.deleted_at is null)))`;
  }
}

/**
 * Loads one profile for an operation: NOT_FOUND unless it exists in this organization, is not deleted and is inside
 * the member's scope; then FORBIDDEN unless the role allows `permission` and, for members who reach profiles through
 * grants, a grant covering this profile carries the capability the permission needs (milestone 08: launch, edit,
 * backup_download).
 */
export async function profileFor<T extends Record<string, unknown>>(
  c: pg.PoolClient,
  access: TenantAccess,
  profileId: string,
  permission: Permission,
  columns: string,
  lock = false,
): Promise<T> {
  const { rows } = await c.query<T>(
    `select ${columns} from profiles p
      where p.id = $1 and p.org_id = $2 and p.deleted_at is null and ${profileVisible(access, 'p', '$3')}
      ${lock ? 'for update' : ''}`,
    [profileId, access.orgId, access.userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Profile not found');
  requirePermission(access, permission);
  await requireCapability(c, access, profileId, permission);
  return row;
}

/** For granted-scope members: a grant covering the profile must carry the capability `permission` needs. */
export async function requireCapability(
  c: pg.PoolClient,
  access: TenantAccess,
  profileId: string,
  permission: Permission,
): Promise<void> {
  const capability = PERMISSION_CAPABILITY[permission];
  if (access.scope !== 'granted' || !capability) return;
  const { rowCount } = await c.query(
    `select 1 from permission_grants g join profiles p on p.org_id = g.org_id and p.id = $3
      where g.org_id = $1 and g.user_id = $2
        and (g.profile_id = p.id or (g.client_id is not null and g.client_id = p.client_id))
        and $4 = any(g.capabilities)`,
    [access.orgId, access.userId, profileId, capability],
  );
  if (!rowCount) {
    throw new ApiError('FORBIDDEN', 'Your access to this profile does not include this action', {
      permission,
      capability,
    });
  }
}

/** Same as profileFor for clients. */
export async function clientFor<T extends Record<string, unknown>>(
  c: pg.PoolClient,
  access: TenantAccess,
  clientId: string,
  permission: Permission,
  columns: string,
  lock = false,
): Promise<T> {
  const { rows } = await c.query<T>(
    `select ${columns} from clients c
      where c.id = $1 and c.org_id = $2 and ${clientVisible(access, 'c', '$3')} ${lock ? 'for update' : ''}`,
    [clientId, access.orgId, access.userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'Client not found');
  requirePermission(access, permission);
  return row;
}

/** Operations that need a sign-in within the last few minutes (ownership transfer). */
export function requireRecentAuth(principal: Principal | null, maxAgeSeconds: number): void {
  if (!principal) throw new ApiError('UNAUTHENTICATED', 'Authentication required');
  const age = (Date.now() - principal.authTime.getTime()) / 1000;
  if (principal.kind !== 'session' || age > maxAgeSeconds) {
    throw new ApiError('REAUTHENTICATION_REQUIRED', 'Sign in again to confirm this action', {
      max_age_seconds: maxAgeSeconds,
    });
  }
}
