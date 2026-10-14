/**
 * R1 product model (ADR-0020): folders, per-workspace feature settings, onboarding state, capability negotiation and
 * the device migration record. Additive: every earlier route keeps working; org_id stays the tenant boundary.
 *
 *   GET  /me/capabilities                              what this server offers and requires
 *   GET  /me/onboarding                                where the caller is in onboarding (derived until R2 records it)
 *   GET/POST /orgs/{org}/folders, PATCH …/folders/{id} optional organization of profiles (not a grant scope)
 *   PUT  /orgs/{org}/profiles/{id}/folder              move a profile; access does not change
 *   GET/PUT /orgs/{org}/feature-settings               the new UI switch and optional modules
 *   POST /orgs/{org}/migration-runs, GET …/{id}        a device's migration run (idempotent per manifest)
 */
import {
  ApiError,
  Capabilities,
  FEATURE_KEYS,
  FEATURE_SETTINGS,
  type FeatureKey,
  FeatureSettings,
  type FeatureSettings as FeatureSettingsT,
  FeatureSettingsUpdate,
  Folder,
  FolderCreate,
  FolderUpdate,
  ID_PATTERN,
  MigrationRun,
  MigrationRunUpsert,
  newId,
  OnboardingState,
  ProfileFolder,
  ProfileFolderSet,
  SERVER_FEATURES,
} from '@pb/contracts';
import type pg from 'pg';
import Type from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { nameKey } from '../names.ts';
import {
  profileFor,
  profileVisible,
  requirePermission,
  resolveTenant,
  type TenantAccess,
} from '../tenancy.ts';
import {
  errors,
  expectedVersion,
  isUniqueViolation,
  OrgParams,
  ProfileParams,
  versionConflict,
} from './common.ts';

const SERVER_VERSION = '0.14.0';
const param = (prefix: Parameters<typeof ID_PATTERN>[0]) => Type.String({ pattern: ID_PATTERN(prefix) });
const FolderParams = Type.Object(
  { orgId: param('org'), folderId: param('fld') },
  { additionalProperties: false },
);
const RunParams = Type.Object({ orgId: param('org'), id: param('mgr') }, { additionalProperties: false });
const FOLDER_COLUMNS = `f.id, f.org_id, f.name, f.colour, f.position, ${ts('f.archived_at')} as archived_at,
  f.version, ${ts('f.created_at')} as created_at, ${ts('f.updated_at')} as updated_at`;
const DUPLICATE = () => new ApiError('ALREADY_EXISTS', 'A folder with this name already exists');

type FolderRow = Folder;

/** Profiles in each folder that the caller can see (hidden profiles never show up, not even as a number). */
function countsSql(access: TenantAccess): string {
  return `(select count(*)::int from profile_folders pf join profiles p on p.org_id = pf.org_id and p.id = pf.profile_id
            where pf.org_id = f.org_id and pf.folder_id = f.id and p.deleted_at is null
              and ${profileVisible(access, 'p', '$2')})`;
}

export function workspaceRoutes(app: App, deps: Deps): void {
  // ---------------------------------------------------------------- capabilities and onboarding
  app.get(
    '/me/capabilities',
    {
      config: { tokens: true, web: true },
      schema: {
        tags: ['identity'],
        description:
          'Capability negotiation (R1): the features this server offers and the desktop version it requires. ' +
          'A desktop shows only what the server can do.',
        response: { 200: Capabilities, ...errors },
      },
    },
    async () => ({
      api: 'v1' as const,
      server_version: SERVER_VERSION,
      features: [...SERVER_FEATURES],
      minimum_desktop_version: deps.config.minDesktopVersion,
      latest_desktop_version: null,
    }),
  );

  app.get(
    '/me/onboarding',
    {
      config: { web: true },
      schema: {
        tags: ['identity'],
        description:
          'Where the caller is in onboarding and which workspace the app opens first. Until R2 records it, the ' +
          'state is derived from memberships: the first workspace the caller owns, else the first they belong to.',
        response: { 200: OnboardingState, ...errors },
      },
    },
    async (req) => {
      const { userId } = principalOf(req);
      return withTx(deps.pool, { orgId: null, userId }, async (c) => {
        const recorded = await c.query<{
          state: 'new' | 'invited' | 'ready';
          default_org_id: string | null;
          completed_at: string | null;
        }>(
          `select state, default_org_id, ${ts('completed_at')} as completed_at from onboarding_state where user_id = $1`,
          [userId],
        );
        const row = recorded.rows[0];
        if (row) return { ...row, recorded: true };
        const { rows } = await c.query<{ org_id: string; role: string }>(
          `select org_id, role from memberships where user_id = $1
            order by (role = 'owner') desc, created_at, org_id limit 1`,
          [userId],
        );
        const first = rows[0];
        return {
          state: first ? ('ready' as const) : ('new' as const),
          default_org_id: first?.org_id ?? null,
          recorded: false,
          completed_at: null,
        };
      });
    },
  );

  // ---------------------------------------------------------------- folders
  app.get(
    '/orgs/:orgId/folders',
    {
      config: { tokens: true },
      schema: {
        tags: ['profiles'],
        description:
          'The workspace’s folders (at most 500) with how many visible profiles each holds. Folders organize ' +
          'profiles; they never grant access.',
        params: OrgParams,
        response: {
          200: Type.Object({ items: Type.Array(Folder) }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'profile.read');
      const items = await withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<Folder>(
          `select ${FOLDER_COLUMNS}, ${countsSql(access)} as profile_count
             from folders f where f.org_id = $1 order by f.archived_at nulls first, f.position, f.name, f.id limit 500`,
          [access.orgId, access.userId],
        );
        return rows;
      });
      return { items };
    },
  );

  app.post(
    '/orgs/:orgId/folders',
    {
      schema: {
        tags: ['profiles'],
        params: OrgParams,
        body: FolderCreate,
        response: { 201: Folder, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'folders.manage');
      const name = req.body.name.trim();
      const id = newId('folder');
      const folder = await withTx(deps.pool, access, async (c) => {
        let row: FolderRow | undefined;
        try {
          ({
            rows: [row],
          } = await c.query<FolderRow>(
            `insert into folders as f (id, org_id, name, name_key, colour, position, created_by)
             values ($1, $2, $3, $4, $5, $6, $7) returning ${FOLDER_COLUMNS}, 0 as profile_count`,
            [
              id,
              access.orgId,
              name,
              nameKey(name),
              req.body.colour ?? null,
              req.body.position ?? 0,
              access.userId,
            ],
          ));
        } catch (err) {
          if (isUniqueViolation(err, 'folders_org_id_name_key_key')) throw DUPLICATE();
          throw err;
        }
        if (!row) throw new ApiError('INTERNAL', 'Folder was not created');
        await audit(c, changeEntry(access, 'folder.created', 'folder', id));
        return row;
      });
      return reply.status(201).header('etag', `"${folder.version}"`).send(folder);
    },
  );

  app.patch(
    '/orgs/:orgId/folders/:folderId',
    {
      schema: {
        tags: ['profiles'],
        description:
          'Rename, recolour, reorder or archive. Requires If-Match: "<version>" or body.expected_version.',
        params: FolderParams,
        body: FolderUpdate,
        response: { 200: Folder, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'folders.manage');
      const { expected_version: bodyVersion, ...changes } = req.body;
      const expected = expectedVersion(req.headers['if-match'], bodyVersion);
      const folder = await withTx(deps.pool, access, async (c) => {
        const current = await c.query<{ version: number }>(
          'select version from folders where id = $1 and org_id = $2 for update',
          [req.params.folderId, access.orgId],
        );
        const cur = current.rows[0];
        if (!cur) throw new ApiError('NOT_FOUND', 'Folder not found');
        if (cur.version !== expected) throw versionConflict(cur.version);
        const name = changes.name?.trim();
        let row: FolderRow | undefined;
        try {
          ({
            rows: [row],
          } = await c.query<FolderRow>(
            `update folders f set
                name = coalesce($3, f.name), name_key = coalesce($4, f.name_key),
                colour = case when $5::boolean then $6 else f.colour end,
                position = coalesce($7, f.position),
                archived_at = case when $8::boolean is null then f.archived_at
                                   when $8::boolean then coalesce(f.archived_at, now()) else null end,
                version = f.version + 1, updated_at = now()
              where f.id = $1 and f.org_id = $2
              returning ${FOLDER_COLUMNS}, ${countsSql(access).replace('$2', '$9')} as profile_count`,
            [
              req.params.folderId,
              access.orgId,
              name ?? null,
              name ? nameKey(name) : null,
              'colour' in changes,
              changes.colour ?? null,
              changes.position ?? null,
              changes.archived ?? null,
              access.userId,
            ],
          ));
        } catch (err) {
          if (isUniqueViolation(err, 'folders_org_id_name_key_key')) throw DUPLICATE();
          throw err;
        }
        if (!row) throw new ApiError('NOT_FOUND', 'Folder not found');
        await audit(
          c,
          changeEntry(access, 'folder.updated', 'folder', row.id, { fields: Object.keys(changes) }),
        );
        return row;
      });
      return reply.header('etag', `"${folder.version}"`).send(folder);
    },
  );

  app.put(
    '/orgs/:orgId/profiles/:profileId/folder',
    {
      schema: {
        tags: ['profiles'],
        description:
          'Puts a profile in a folder, or in none. Needs profile.update on the profile (a grant’s edit capability). ' +
          'Moving a profile never changes who can see or open it.',
        params: ProfileParams,
        body: ProfileFolderSet,
        response: { 200: ProfileFolder, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      return withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'profile.update', 'p.id', true);
        if (req.body.folder_id) {
          const f = await c.query(
            'select 1 from folders where id = $1 and org_id = $2 and archived_at is null',
            [req.body.folder_id, access.orgId],
          );
          if (!f.rowCount) throw new ApiError('NOT_FOUND', 'Folder not found');
          await c.query(
            `insert into profile_folders (org_id, profile_id, folder_id) values ($1, $2, $3)
             on conflict (org_id, profile_id) do update set folder_id = excluded.folder_id, updated_at = now()`,
            [access.orgId, req.params.profileId, req.body.folder_id],
          );
        } else {
          await c.query('delete from profile_folders where org_id = $1 and profile_id = $2', [
            access.orgId,
            req.params.profileId,
          ]);
        }
        await audit(
          c,
          changeEntry(access, 'profile.folder_set', 'profile', req.params.profileId, {
            folder_id: req.body.folder_id,
          }),
        );
        return { profile_id: req.params.profileId, folder_id: req.body.folder_id };
      });
    },
  );

  // ---------------------------------------------------------------- feature settings
  const readSettings = async (c: pg.PoolClient, orgId: string): Promise<FeatureSettingsT> => {
    const { rows } = await c.query<{ key: string; value: unknown; version: number; updated_at: string }>(
      `select key, value, version, ${ts('updated_at')} as updated_at from feature_settings where org_id = $1`,
      [orgId],
    );
    const set = new Map(rows.map((r) => [r.key, r]));
    return {
      settings: FEATURE_KEYS.map((key) => {
        const row = set.get(key);
        const def = FEATURE_SETTINGS[key].default;
        return {
          key,
          value: row && typeof row.value === 'boolean' ? row.value : def,
          set: Boolean(row),
          version: row?.version ?? null,
          updated_at: row?.updated_at ?? null,
        };
      }),
    };
  };

  app.get(
    '/orgs/:orgId/feature-settings',
    {
      schema: {
        tags: ['organizations'],
        description: 'Per-workspace feature settings with their effective values (defaults where unset).',
        params: OrgParams,
        response: { 200: FeatureSettings, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'org.read');
      return withTx(deps.pool, access, (c) => readSettings(c, access.orgId));
    },
  );

  app.put(
    '/orgs/:orgId/feature-settings',
    {
      schema: {
        tags: ['organizations'],
        description:
          'Sets feature settings (owners and admins). expected_version per key: null for a key not yet set. ' +
          'ui.unified_profiles is the rollback switch of the R1/R3 migration: turning it off restores the earlier UI ' +
          'without touching any data.',
        params: OrgParams,
        body: FeatureSettingsUpdate,
        response: { 200: FeatureSettings, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'features.manage');
      return withTx(deps.pool, access, async (c) => {
        for (const s of req.body.settings) {
          const key: FeatureKey = s.key;
          const cur = await c.query<{ version: number }>(
            'select version from feature_settings where org_id = $1 and key = $2 for update',
            [access.orgId, key],
          );
          const have = cur.rows[0]?.version ?? null;
          if (s.expected_version !== undefined && s.expected_version !== have) {
            throw versionConflict(have ?? 0);
          }
          await c.query(
            `insert into feature_settings (org_id, key, value, updated_by) values ($1, $2, $3::jsonb, $4)
             on conflict (org_id, key) do update set value = excluded.value, version = feature_settings.version + 1,
               updated_by = excluded.updated_by, updated_at = now()`,
            [access.orgId, key, JSON.stringify(s.value), access.userId],
          );
          await audit(
            c,
            changeEntry(access, 'feature.updated', 'organization', access.orgId, { key, value: s.value }),
          );
        }
        return readSettings(c, access.orgId);
      });
    },
  );

  // ---------------------------------------------------------------- migration runs
  const RUN_COLUMNS = `r.id, r.org_id, r.device_id, r.owner_id, r.manifest_digest, r.state, r.checkpoint, r.counts,
    r.error_code, r.version, ${ts('r.created_at')} as created_at, ${ts('r.updated_at')} as updated_at`;

  app.post(
    '/orgs/:orgId/migration-runs',
    {
      schema: {
        tags: ['profiles'],
        description:
          'Records a device’s migration run (R1). The first call for (device, manifest digest) creates it; later ' +
          'calls update state, checkpoint and counts. The device must be the caller’s own. Counts only, never ' +
          'profile names or secrets.',
        params: OrgParams,
        body: MigrationRunUpsert,
        response: { 200: MigrationRun, 201: MigrationRun, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'profile.create');
      const body = req.body;
      const outcome = await withTx(deps.pool, access, async (c) => {
        const dev = await c.query(
          'select 1 from devices where id = $1 and user_id = $2 and revoked_at is null',
          [body.device_id, access.userId],
        );
        if (!dev.rowCount) throw new ApiError('NOT_FOUND', 'Device not found');
        const existing = await c.query<MigrationRun>(
          `select ${RUN_COLUMNS} from migration_runs r where r.device_id = $1 and r.manifest_digest = $2 and r.org_id = $3
            for update`,
          [body.device_id, body.manifest_digest, access.orgId],
        );
        const cur = existing.rows[0];
        if (cur) {
          if (cur.state === 'completed' && body.state !== 'completed' && body.state !== 'rolled_back') {
            // A completed run is final: re-running the same manifest must not restart it.
            return { status: 200, row: cur };
          }
          const { rows } = await c.query<MigrationRun>(
            `update migration_runs r set state = $3, checkpoint = coalesce($4::jsonb, r.checkpoint),
                    counts = coalesce($5::jsonb, r.counts), error_code = $6, version = r.version + 1, updated_at = now()
              where r.id = $1 and r.org_id = $2 returning ${RUN_COLUMNS}`,
            [
              cur.id,
              access.orgId,
              body.state,
              body.checkpoint ? JSON.stringify(body.checkpoint) : null,
              body.counts ? JSON.stringify(body.counts) : null,
              body.error_code ?? null,
            ],
          );
          return { status: 200, row: rows[0] as MigrationRun };
        }
        const id = newId('migrationRun');
        const { rows } = await c.query<MigrationRun>(
          `insert into migration_runs as r (id, org_id, device_id, owner_id, manifest_digest, state, checkpoint, counts,
                                           error_code)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9) returning ${RUN_COLUMNS}`,
          [
            id,
            access.orgId,
            body.device_id,
            access.userId,
            body.manifest_digest,
            body.state,
            JSON.stringify(body.checkpoint ?? {}),
            JSON.stringify(body.counts ?? {}),
            body.error_code ?? null,
          ],
        );
        await audit(
          c,
          changeEntry(access, 'migration.run_recorded', 'migration_run', id, { device_id: body.device_id }),
        );
        return { status: 201, row: rows[0] as MigrationRun };
      });
      return reply.status(outcome.status).send(outcome.row);
    },
  );

  app.get(
    '/orgs/:orgId/migration-runs/:id',
    {
      schema: { tags: ['profiles'], params: RunParams, response: { 200: MigrationRun, ...errors } },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      requirePermission(access, 'profile.read');
      return withTx(deps.pool, access, async (c) => {
        const { rows } = await c.query<MigrationRun>(
          `select ${RUN_COLUMNS} from migration_runs r where r.id = $1 and r.org_id = $2 and r.owner_id = $3`,
          [req.params.id, access.orgId, access.userId],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Migration run not found');
        return row;
      });
    },
  );
}
