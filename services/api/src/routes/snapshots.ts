import { ApiError, newId, Page, PageQuery, Snapshot, SnapshotCommit, SnapshotDownload } from '@pb/contracts';
import { type App, type Deps, principalOf } from '../app.ts';
import { audit, changeEntry } from '../audit.ts';
import { ts, withTx } from '../db.ts';
import { requestDigest, requireIdempotencyKey, runIdempotent } from '../idempotency.ts';
import { appendEvent } from '../outbox.ts';
import { profileFor, resolveTenant } from '../tenancy.ts';
import { errors, ProfileParams, pageOf, pageWindow, SnapshotParams } from './common.ts';
import { leaseFailure } from './leases.ts';

const SNAPSHOT_COLUMNS = `s.id, s.profile_id, s.object_key, s.sha256, s.size_bytes::float8 as size_bytes, s.platform,
  s.browser_revision, s.fencing_token::text as fencing_token, ${ts('s.created_at')} as created_at`;

/** Download descriptors are valid this long (the signed storage URL itself arrives with milestone 07). */
const DOWNLOAD_TTL_SECONDS = 300;

/**
 * Snapshot manifests (the encrypted bytes are uploaded to object storage in milestone 07).
 * Fencing: a commit is accepted only with the token of the live lease held by the caller's device. A device whose
 * lease expired and was re-acquired elsewhere can never overwrite newer state.
 * Reading or downloading snapshots needs snapshot.read (owners, admins, operators with a grant); viewers cannot.
 */
export function snapshotRoutes(app: App, deps: Deps): void {
  app.post(
    '/orgs/:orgId/profiles/:profileId/snapshots',
    {
      schema: {
        tags: ['snapshots'],
        description:
          'Commit an encrypted snapshot manifest. Requires Idempotency-Key and the live fencing token.',
        params: ProfileParams,
        body: SnapshotCommit,
        response: { 201: Snapshot, 200: Snapshot, ...errors },
      },
    },
    async (req, reply) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const device = principalOf(req).deviceId;
      const key = requireIdempotencyKey(req.headers['idempotency-key']);
      const digest = requestDigest({ user: access.userId, profile: req.params.profileId, body: req.body });

      const result = await withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'snapshot.commit', 'p.id');
        return runIdempotent(
          c,
          { orgId: access.orgId, operation: 'snapshot.commit', key, digest },
          async () => {
            const lease = await c.query(
              `select 1 from profile_leases
              where profile_id = $1 and org_id = $2 and fencing_token = $3::bigint and holder_user_id = $4
                and ($5::text is null or holder_device_id = $5)
                and released_at is null and expires_at > now()
              for share`,
              [req.params.profileId, access.orgId, req.body.fencing_token, access.userId, device],
            );
            if (lease.rowCount === 0)
              throw await leaseFailure(c, req.params.profileId, req.body.fencing_token);

            const id = newId('snapshot');
            const objectKey = `orgs/${access.orgId}/profiles/${req.params.profileId}/snapshots/${id}.enc`;
            const { rows } = await c.query<Snapshot>(
              `insert into snapshot_manifests as s (id, org_id, profile_id, fencing_token, object_key, sha256, size_bytes,
                platform, browser_revision, encryption_scheme, key_id, created_by)
             values ($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9, $10, $11, $12)
             returning ${SNAPSHOT_COLUMNS}`,
              [
                id,
                access.orgId,
                req.params.profileId,
                req.body.fencing_token,
                objectKey,
                req.body.sha256,
                req.body.size_bytes,
                req.body.platform,
                req.body.browser_revision,
                req.body.encryption.scheme,
                req.body.encryption.key_id,
                access.userId,
              ],
            );
            const snapshot = rows[0];
            if (!snapshot) throw new ApiError('INTERNAL', 'Snapshot commit returned no row');
            await appendEvent(c, {
              orgId: access.orgId,
              actorId: access.userId,
              aggregateId: snapshot.id,
              aggregateVersion: 1,
              eventType: 'snapshot.committed',
              payload: {
                profile_id: snapshot.profile_id,
                size_bytes: snapshot.size_bytes,
                platform: snapshot.platform,
                fencing_token: snapshot.fencing_token,
              },
            });
            return { status: 201, body: snapshot };
          },
        );
      });
      if (!result.body) throw new ApiError('INTERNAL', 'Snapshot commit returned no body');
      return reply
        .status(result.replayed ? 200 : result.status)
        .header('idempotent-replayed', String(result.replayed))
        .send(result.body);
    },
  );

  app.get(
    '/orgs/:orgId/profiles/:profileId/snapshots',
    {
      schema: {
        tags: ['snapshots'],
        description: 'Snapshot manifests of one profile, newest first.',
        params: ProfileParams,
        querystring: PageQuery,
        response: { 200: Page(Snapshot), ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      const window = pageWindow(req.query);
      const rows = await withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'snapshot.read', 'p.id');
        const result = await c.query<Snapshot>(
          `select ${SNAPSHOT_COLUMNS} from snapshot_manifests s
            where s.org_id = $1 and s.profile_id = $2
              and ($3::timestamptz is null or (s.created_at, s.id) < ($3::timestamptz, $4::text))
            order by s.created_at desc, s.id desc limit $5`,
          [
            access.orgId,
            req.params.profileId,
            window.after?.k ?? null,
            window.after?.id ?? '',
            window.limit + 1,
          ],
        );
        return result.rows;
      });
      return pageOf(rows, window, (s) => ({ k: s.created_at, id: s.id }));
    },
  );

  app.post(
    '/orgs/:orgId/profiles/:profileId/snapshots/:snapshotId/download',
    {
      schema: {
        tags: ['snapshots'],
        description:
          'Authorizes downloading one snapshot for a few minutes. Until milestone 07 adds storage this returns the ' +
          'object key and expiry only; every request is authorized and audited.',
        params: SnapshotParams,
        response: { 200: SnapshotDownload, ...errors },
      },
    },
    async (req) => {
      const access = await resolveTenant(deps.pool, req, req.params.orgId);
      return withTx(deps.pool, access, async (c) => {
        await profileFor(c, access, req.params.profileId, 'snapshot.read', 'p.id');
        const { rows } = await c.query<Snapshot & { expires_at: string }>(
          `select ${SNAPSHOT_COLUMNS}, ${ts(`now() + make_interval(secs => ${DOWNLOAD_TTL_SECONDS})`)} as expires_at
             from snapshot_manifests s
            where s.id = $1 and s.org_id = $2 and s.profile_id = $3`,
          [req.params.snapshotId, access.orgId, req.params.profileId],
        );
        const row = rows[0];
        if (!row) throw new ApiError('NOT_FOUND', 'Snapshot not found');
        await audit(
          c,
          changeEntry(access, 'snapshot.download_authorized', 'snapshot', row.id, {
            profile_id: row.profile_id,
          }),
        );
        const { expires_at, ...snapshot } = row;
        return { snapshot, object_key: snapshot.object_key, expires_at };
      });
    },
  );
}
