import { ApiError, newId, Snapshot, SnapshotCommit } from '@pb/contracts';
import type { Static } from 'typebox';
import { type App, type Deps, principalOf } from '../app.ts';
import { ts, withTx } from '../db.ts';
import { requestDigest, requireIdempotencyKey, runIdempotent } from '../idempotency.ts';
import { appendEvent } from '../outbox.ts';
import { requirePermission, resolveTenant } from '../tenancy.ts';
import { errors, ProfileParams } from './common.ts';
import { leaseFailure } from './leases.ts';

type SnapshotRow = Static<typeof Snapshot>;

/**
 * Snapshot manifest commit (the encrypted bytes are uploaded to object storage in milestone 07).
 * Fencing: the commit is accepted only if the caller presents the token of the live lease. A device whose
 * lease expired and was re-acquired elsewhere can never overwrite newer state.
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
      const access = await resolveTenant(deps.pool, principalOf(req).userId, req.params.orgId);
      requirePermission(access, 'snapshot.commit');
      const key = requireIdempotencyKey(req.headers['idempotency-key']);
      const digest = requestDigest({ user: access.userId, profile: req.params.profileId, body: req.body });

      const result = await withTx(deps.pool, access, (c) =>
        runIdempotent(c, { orgId: access.orgId, operation: 'snapshot.commit', key, digest }, async () => {
          const lease = await c.query(
            `select 1 from profile_leases
              where profile_id = $1 and org_id = $2 and fencing_token = $3::bigint and holder_user_id = $4
                and released_at is null and expires_at > now()
              for share`,
            [req.params.profileId, access.orgId, req.body.fencing_token, access.userId],
          );
          if (lease.rowCount === 0) throw await leaseFailure(c, req.params.profileId, req.body.fencing_token);

          const id = newId('snapshot');
          const objectKey = `orgs/${access.orgId}/profiles/${req.params.profileId}/snapshots/${id}.enc`;
          const { rows } = await c.query<SnapshotRow>(
            `insert into snapshot_manifests (id, org_id, profile_id, fencing_token, object_key, sha256, size_bytes,
                platform, browser_revision, encryption_scheme, key_id, created_by)
             values ($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9, $10, $11, $12)
             returning id, profile_id, object_key, sha256, size_bytes::float8 as size_bytes, platform, browser_revision,
                       fencing_token::text as fencing_token, ${ts('created_at')} as created_at`,
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
          const snapshot = rows[0] as SnapshotRow;
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
        }),
      );
      if (!result.body) throw new ApiError('INTERNAL', 'Snapshot commit returned no body');
      return reply
        .status(result.replayed ? 200 : result.status)
        .header('idempotent-replayed', String(result.replayed))
        .send(result.body);
    },
  );
}
