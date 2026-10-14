/**
 * Backup policy, trash and organization keys (milestone 07, ADR-0014).
 *
 * - Policy: retention (newest snapshot of each of N days, plus the last 24 hours and the newest) and the trash period
 *   are the organization's to choose (owners and admins). Storage quota and maximum snapshot size are cost limits set
 *   by the service operator and shown read-only.
 * - Trash: deleting a profile keeps it (and its snapshots) restorable for `trash_days`; then the worker erases the
 *   snapshots and the profile for good.
 * - Keys: owners rotate the organization key (recent sign-in required). New snapshots use the new version at once;
 *   the worker re-wraps existing data keys without re-uploading, then destroys the old version after a delay.
 */
import {
  ApiError,
  BackupPolicy,
  BackupPolicyUpdate,
  OrgKeys,
  Page,
  PageQuery,
  Profile,
  TrashedProfile,
} from '@pb/contracts';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { rotateOrgKey } from '../backup/keys.ts';
import { requireBillingAllows } from '../billing/state.ts';
import { ts, withTx } from '../db.ts';
import { appendEvent } from '../outbox.ts';
import { requirePermission, requireRecentAuth, resolveTenant } from '../tenancy.ts';
import { errors, OrgParams, PROFILE_COLUMNS, ProfileParams, pageOf, pageWindow } from './common.ts';

const POLICY_COLUMNS = `backup_retention_days as retention_days, trash_days,
  app.org_backup_quota(organizations.id)::float8 as quota_bytes,
  max_snapshot_bytes::float8 as max_snapshot_bytes,
  coalesce((select sum(size_bytes) from snapshot_manifests s
             where s.org_id = organizations.id and s.status in ('committed', 'deleted')
               and s.object_deleted_at is null), 0)::float8 as used_bytes`;

export function backupRoutes(app: App, deps: Deps): void {
  app.get(
    '/orgs/:orgId/backup-policy',
    {
      schema: {
        tags: ['backups'],
        description: 'Retention, trash period, storage quota and usage of the organization’s snapshots.',
        params: OrgParams,
        response: { 200: BackupPolicy, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'org.read');
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<BackupPolicy>(
          `select ${POLICY_COLUMNS} from organizations where id = $1`,
          [access.orgId],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Organization not found');
        return row;
      });
    },
  );

  app.patch(
    '/orgs/:orgId/backup-policy',
    {
      schema: {
        tags: ['backups'],
        description:
          'Changes retention days and the trash period (owners and admins). Quotas are not editable here.',
        params: OrgParams,
        body: BackupPolicyUpdate,
        response: { 200: BackupPolicy, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'backups.manage');
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<BackupPolicy>(
          `update organizations
              set backup_retention_days = coalesce($2, backup_retention_days),
                  trash_days = coalesce($3, trash_days)
            where id = $1
          returning ${POLICY_COLUMNS}`,
          [access.orgId, req.body.retention_days ?? null, req.body.trash_days ?? null],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Organization not found');
        await audit(
          c,
          changeEntry(access, 'backup_policy.updated', 'organization', access.orgId, {
            retention_days: row.retention_days,
            trash_days: row.trash_days,
          }),
        );
        return row;
      });
    },
  );

  app.get(
    '/orgs/:orgId/trash',
    {
      schema: {
        tags: ['backups'],
        description: 'Deleted profiles that can still be restored, most recently deleted first.',
        params: OrgParams,
        querystring: PageQuery,
        response: { 200: Page(TrashedProfile), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'profile.delete');
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<Profile & { deleted_at: string; purge_after: string }>(
          `select ${PROFILE_COLUMNS}, ${ts('p.deleted_at')} as deleted_at,
                  ${ts('(p.deleted_at + make_interval(days => o.trash_days))')} as purge_after
             from profiles p join organizations o on o.id = p.org_id
            where p.org_id = $1 and p.deleted_at is not null
              and ($2::timestamptz is null or (p.deleted_at, p.id) < ($2::timestamptz, $3::text))
            order by p.deleted_at desc, p.id desc limit $4`,
          [access.orgId, window.after?.k ?? null, window.after?.id ?? '', window.limit + 1],
        );
        return rows;
      });
      const page = pageOf(rows, window, (r) => ({ k: r.deleted_at, id: r.id }));
      return {
        ...page,
        items: page.items.map(({ deleted_at, purge_after, ...profile }) => ({
          profile,
          deleted_at,
          purge_after,
        })),
      };
    },
  );

  app.post(
    '/orgs/:orgId/profiles/:profileId/undelete',
    {
      schema: {
        tags: ['backups'],
        description:
          'Restores a deleted profile from the trash (with its snapshots). Needs a recent sign-in.',
        params: ProfileParams,
        response: { 200: Profile, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requireBillingAllows(access, 'trash.restore');
      requirePermission(access, 'profile.delete');
      // Milestone 12: restoring from the trash needs a recent sign-in.
      requireRecentAuth(principalOf(req), deps.config.session.recentAuthSeconds);
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<Profile>(
          `update profiles p set deleted_at = null, version = version + 1, updated_at = now()
            where p.org_id = $1 and p.id = $2 and p.deleted_at is not null
          returning ${PROFILE_COLUMNS}`,
          [access.orgId, req.params.profileId],
        );
        const profile = rows[0];
        if (!profile) throw new ApiError('NOT_FOUND', 'Profile not found in the trash');
        await audit(c, changeEntry(access, 'profile.restored', 'profile', profile.id));
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: profile.id,
          aggregateVersion: profile.version,
          eventType: 'profile.restored',
          payload: {},
        });
        return profile;
      });
    },
  );

  app.get(
    '/orgs/:orgId/keys',
    {
      schema: {
        tags: ['backups'],
        description:
          'The organization’s key versions (never the keys themselves) and how many snapshots each holds.',
        params: OrgParams,
        response: { 200: OrgKeys, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'backups.manage');
      const keys = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query(
          `select k.id, k.version, k.status,
                  (select count(*)::int from snapshot_manifests s
                    where s.org_id = k.org_id and s.key_version_id = k.id and s.object_deleted_at is null
                      and s.status not in ('legacy')) as snapshots,
                  ${ts('k.created_at')} as created_at, ${ts('k.retired_at')} as retired_at,
                  ${ts('k.destroy_after')} as destroy_after, ${ts('k.destroyed_at')} as destroyed_at
             from organization_key_versions k where k.org_id = $1 order by k.version desc`,
          [access.orgId],
        );
        return rows;
      });
      return { keys, kms_provider: deps.backup?.kms.provider ?? 'none' };
    },
  );

  app.post(
    '/orgs/:orgId/keys/rotate',
    {
      schema: {
        tags: ['backups'],
        description:
          'Rotates the organization key (owners; needs a recent sign-in). Existing snapshots are re-wrapped in the ' +
          'background without re-uploading; the old version is destroyed after it is no longer used.',
        params: OrgParams,
        response: { 200: OrgKeys, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'keys.manage');
      requireRecentAuth(principalOf(req), deps.config.session.recentAuthSeconds);
      const kms = deps.backup?.kms;
      if (!kms)
        throw new ApiError('STORAGE_UNAVAILABLE', 'Snapshot storage is not configured on this server');
      await withTx(deps.pool, access, async (c) => {
        const r = await rotateOrgKey(c, kms, access.orgId);
        await audit(
          c,
          changeEntry(access, 'org_key.rotated', 'org_key', r.active.id, {
            retired: r.retired,
            version: r.active.version,
          }),
        );
        await appendEvent(c, {
          orgId: access.orgId,
          actorId: access.userId,
          aggregateId: r.active.id,
          aggregateVersion: r.active.version,
          eventType: 'org_key.rotated',
          payload: { version: r.active.version },
        });
      });
      const keys = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query(
          `select k.id, k.version, k.status,
                  (select count(*)::int from snapshot_manifests s
                    where s.org_id = k.org_id and s.key_version_id = k.id and s.object_deleted_at is null
                      and s.status not in ('legacy')) as snapshots,
                  ${ts('k.created_at')} as created_at, ${ts('k.retired_at')} as retired_at,
                  ${ts('k.destroy_after')} as destroy_after, ${ts('k.destroyed_at')} as destroyed_at
             from organization_key_versions k where k.org_id = $1 order by k.version desc`,
          [access.orgId],
        );
        return rows;
      });
      return { keys, kms_provider: kms.provider };
    },
  );
}
