/**
 * R3 (ADR-0022): access chosen in one step — all profiles, a folder, selected profiles (or, in the agency module, a
 * client) — turned into permission grants, and previewed before anything is granted. A folder or whole-workspace
 * scope follows future profiles only when `include_future` is set; otherwise the profiles there now are granted one by
 * one, so what the preview showed is exactly what is granted.
 */
import { type AccessPreview, type AccessScope, ApiError, type GrantCapability } from '@pb/contracts';
import type pg from 'pg';

export interface ScopeRow {
  client_id: string | null;
  profile_id: string | null;
  folder_id: string | null;
  all_profiles: boolean;
}

const none = { client_id: null, profile_id: null, folder_id: null, all_profiles: false };
/** Above this a snapshot of "all" or a folder is refused: choose "include future profiles" instead. */
export const MAX_EXPANDED = 2000;

async function requireFolder(c: pg.PoolClient, orgId: string, folderId: string): Promise<void> {
  const f = await c.query('select 1 from folders where org_id = $1 and id = $2 and archived_at is null', [
    orgId,
    folderId,
  ]);
  if (!f.rowCount) throw new ApiError('NOT_FOUND', 'Folder not found');
}

/** The SQL condition (on profiles `p`) a scope reaches now; parameters start at $2 ($1 is the organization). */
function reachSql(scope: AccessScope): { sql: string; params: unknown[] } {
  switch (scope.kind) {
    case 'all':
      return { sql: 'true', params: [] };
    case 'folder':
      return {
        sql: 'exists (select 1 from profile_folders pf where pf.org_id = p.org_id and pf.profile_id = p.id and pf.folder_id = $2)',
        params: [scope.folder_id],
      };
    case 'profiles':
      return { sql: 'p.id = any($2::text[])', params: [scope.profile_ids] };
    case 'client':
      return { sql: 'p.client_id = $2', params: [scope.client_id] };
  }
}

/** The grant rows a scope becomes. Validates every target inside the organization. */
export async function scopeRows(c: pg.PoolClient, orgId: string, scope: AccessScope): Promise<ScopeRow[]> {
  if (scope.kind === 'folder') await requireFolder(c, orgId, scope.folder_id);
  if (scope.kind === 'client') {
    const cl = await c.query('select 1 from clients where org_id = $1 and id = $2', [orgId, scope.client_id]);
    if (!cl.rowCount) throw new ApiError('NOT_FOUND', 'Client not found');
    return [{ ...none, client_id: scope.client_id }];
  }
  if (scope.kind === 'all' && scope.include_future) return [{ ...none, all_profiles: true }];
  if (scope.kind === 'folder' && scope.include_future) return [{ ...none, folder_id: scope.folder_id }];
  const reach = reachSql(scope);
  const { rows } = await c.query<{ id: string }>(
    `select p.id from profiles p where p.org_id = $1 and p.deleted_at is null and ${reach.sql}
      order by p.id limit ${MAX_EXPANDED + 1}`,
    [orgId, ...reach.params],
  );
  if (rows.length > MAX_EXPANDED) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Too many profiles to grant one by one; include future profiles instead',
      {
        limit: MAX_EXPANDED,
      },
    );
  }
  if (scope.kind === 'profiles' && rows.length !== scope.profile_ids.length) {
    throw new ApiError('NOT_FOUND', 'A selected profile was not found');
  }
  return rows.map((r) => ({ ...none, profile_id: r.id }));
}

/** What a scope reaches now, by name (at most 50 listed), before anything is granted. */
export async function previewScope(
  c: pg.PoolClient,
  orgId: string,
  scope: AccessScope,
  capabilities: GrantCapability[],
): Promise<AccessPreview> {
  if (scope.kind === 'folder') await requireFolder(c, orgId, scope.folder_id);
  const reach = reachSql(scope);
  const count = await c.query<{ n: number }>(
    `select count(*)::int as n from profiles p where p.org_id = $1 and p.deleted_at is null and ${reach.sql}`,
    [orgId, ...reach.params],
  );
  const named = await c.query<{ id: string; name: string }>(
    `select p.id, p.name from profiles p where p.org_id = $1 and p.deleted_at is null and ${reach.sql}
      order by lower(p.name), p.id limit 50`,
    [orgId, ...reach.params],
  );
  if (scope.kind === 'profiles' && (count.rows[0]?.n ?? 0) !== scope.profile_ids.length) {
    throw new ApiError('NOT_FOUND', 'A selected profile was not found');
  }
  return {
    profile_count: count.rows[0]?.n ?? 0,
    profiles: named.rows,
    includes_future:
      scope.kind === 'client' || ((scope.kind === 'all' || scope.kind === 'folder') && scope.include_future),
    capabilities: [...new Set(capabilities)].sort(),
  };
}
